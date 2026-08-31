import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from 'jsonwebtoken';

/** Injects the caller's identity claims (resolved by JwtGuard; signature
 * verification happens in the Envoy PEP, not in-process). */
export const Claims = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    return ctx.switchToHttp().getRequest<{ claims: JwtPayload }>().claims;
  },
);
