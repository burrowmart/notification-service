import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Mark a route or controller as publicly accessible (skips JwtGuard). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
