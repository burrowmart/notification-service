import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Identity guard — extraction and propagation only, deliberately WITHOUT
 * signature verification (ADR: ARCHITECTURE.md "Auth & Authz").
 *
 * Authentication lives at the trust boundary, not in every service: the
 * Cloudflare OAuth worker validates the id_token at the edge, and each pod's
 * Envoy PEP sidecar re-verifies the signature via OPA ext_authz before a
 * request reaches this container. The cluster has no public inbound
 * (Cloudflare Tunnel only), so a request arriving here has already been
 * cryptographically checked — verifying a third time in-process was pure
 * overhead. Accepted trade-off: identity headers CAN be forged by an
 * in-cluster caller; anything inside the private cluster is trusted by the
 * platform's threat model, and every hop still passes the callee's own PEP.
 *
 * What the guard does:
 *  1. Resolves the caller — x-user-email / x-user-roles headers when an
 *     upstream service already resolved them, else the JWT payload decoded
 *     without verification.
 *  2. Exposes the result as req.claims (for @Claims()).
 *  3. Stamps x-user-email / x-user-roles onto req.headers so outbound calls
 *     (forwardAuthHeaders) propagate the resolved identity downstream —
 *     alongside the original bearer token, which the callee's Envoy PEP
 *     still requires for its own signature check.
 */
@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string>;
      claims?: jwt.JwtPayload;
    }>();

    // Test environments skip identity extraction entirely; the test header
    // lets each test act as a different user. Real traffic never sets this.
    if (process.env.AUTH_DISABLED === 'true') {
      req.claims = { email: req.headers['x-test-user-email'] ?? 'test@example.com' } as jwt.JwtPayload;
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    req.claims = this.resolveIdentity(req.headers);
    // Propagated form — forwardAuthHeaders picks these up on outbound calls,
    // so downstream services reuse the resolved identity instead of
    // re-decoding the token.
    req.headers['x-user-email'] = String(req.claims.email);
    req.headers['x-user-roles'] = this.rolesOf(req.claims).join(',');
    return true;
  }

  private resolveIdentity(headers: Record<string, string>): jwt.JwtPayload {
    // An upstream service already resolved the caller — reuse its headers.
    const propagated = headers['x-user-email'];
    if (propagated) {
      return {
        email: propagated,
        'cognito:groups': (headers['x-user-roles'] ?? '').split(',').filter(Boolean),
      } as jwt.JwtPayload;
    }

    const token = this.extractToken(headers);
    if (!token) throw new UnauthorizedException('Missing caller identity');

    const decoded = jwt.decode(token);
    if (!decoded || typeof decoded === 'string' || !decoded.email) {
      throw new UnauthorizedException('Malformed identity token');
    }
    return decoded;
  }

  private rolesOf(claims: jwt.JwtPayload): string[] {
    const roles = claims['cognito:groups'];
    return Array.isArray(roles) ? roles.map(String) : [];
  }

  private extractToken(headers: Record<string, string>): string | null {
    // Priority: Cloudflare-injected id_token → ALB OIDC header → standard Bearer
    if (headers['cf-token']) return headers['cf-token'];
    if (headers['x-amzn-oidc-data']) return headers['x-amzn-oidc-data'];
    const auth = headers['authorization'];
    if (auth?.startsWith('Bearer ')) return auth.slice(7);
    return null;
  }
}
