import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JwtPayload } from 'jsonwebtoken';

/** Injects the verified Cognito JWT claims into a controller parameter. */
export const Claims = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    return ctx.switchToHttp().getRequest<{ claims: JwtPayload }>().claims;
  },
);
