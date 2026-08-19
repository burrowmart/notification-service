import { Injectable, NestMiddleware } from '@nestjs/common';
import { trace } from '@opentelemetry/api';

/**
 * Express middleware — runs inside the OTel HTTP span context (closer to the
 * http.Server event loop than NestJS interceptors).  Sets rayId here so the
 * span attribute is reliably visible when trace.getActiveSpan() is called.
 */
@Injectable()
export class RayIdMiddleware implements NestMiddleware {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  use(req: any, _res: any, next: () => void): void {
    const rayId: string | undefined =
      req.headers['cf-ray'] ?? req.headers['x-correlation-id'];
    if (rayId) {
      trace.getActiveSpan()?.setAttribute('rayId', rayId);
    }
    next();
  }
}
