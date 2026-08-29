import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import jwksClient, { JwksClient } from 'jwks-rsa';
import { IS_PUBLIC_KEY } from './public.decorator';

@Injectable()
export class JwtGuard implements CanActivate {
  private readonly jwks: JwksClient;

  constructor(
    private readonly config: ConfigService,
    private readonly reflector: Reflector,
  ) {
    const issuer = config.get<string>('cognito.issuer') ?? '';
    this.jwks = jwksClient({
      jwksUri: `${issuer}/.well-known/jwks.json`,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 10 * 60 * 1000,  // 10 min — avoids JWKS fetch on every request
      rateLimit: true,
    });
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    // Allow test environments to bypass signature verification entirely.
    // Unlike user-service (whose routes take email as a path param),
    // notification-service's routes derive the recipient from @Claims(),
    // so the bypass must still populate req.claims — otherwise every
    // handler would crash reading `claims.email` of undefined. The test
    // header lets each test authenticate as a different user; real traffic
    // never sets AUTH_DISABLED so this path never runs against Cognito.
    if (process.env.AUTH_DISABLED === 'true') {
      const req = ctx.switchToHttp().getRequest<{
        headers: Record<string, string>;
        claims?: jwt.JwtPayload;
      }>();
      req.claims = { email: req.headers['x-test-user-email'] ?? 'test@example.com' } as jwt.JwtPayload;
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string>;
      claims?: jwt.JwtPayload;
    }>();
    const token = this.extractToken(req.headers);
    if (!token) throw new UnauthorizedException('Missing authentication token');

    req.claims = await this.verify(token);
    return true;
  }

  private extractToken(headers: Record<string, string>): string | null {
    // Priority: Cloudflare-injected id_token → ALB OIDC header → standard Bearer
    if (headers['cf-token']) return headers['cf-token'];
    if (headers['x-amzn-oidc-data']) return headers['x-amzn-oidc-data'];
    const auth = headers['authorization'];
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    return null;
  }

  private verify(token: string): Promise<jwt.JwtPayload> {
    const issuer = this.config.get<string>('cognito.issuer')!;
    const audience = this.config.get<string>('cognito.audience');
    // Verifying without an audience check would accept a token minted for any
    // other app client — a leaked token from one surface must not be valid
    // everywhere. Fail closed if the deployment forgot to configure it.
    if (!audience) {
      return Promise.reject(
        new UnauthorizedException('cognito.audience is not configured'),
      );
    }

    return new Promise((resolve, reject) => {
      const getKey: jwt.GetPublicKeyOrSecret = (header, callback) => {
        this.jwks.getSigningKey(header.kid, (err, key) => {
          if (err) return callback(err);
          callback(null, key?.getPublicKey());
        });
      };

      const opts: jwt.VerifyOptions = {
        issuer,
        audience,
        algorithms: ['RS256'],
      };

      jwt.verify(token, getKey, opts, (err, decoded) => {
        if (err || !decoded || typeof decoded === 'string') {
          return reject(new UnauthorizedException('Invalid or expired token'));
        }
        resolve(decoded as jwt.JwtPayload);
      });
    });
  }
}
