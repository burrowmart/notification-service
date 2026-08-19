import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { randomUUID } from 'crypto';
import { correlationStorage } from './correlation.context';

@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{
      headers: Record<string, string>;
      id?: unknown; // pino-http sets req.id via genReqId before interceptors run
    }>();
    const res = ctx.switchToHttp().getResponse<{ setHeader(k: string, v: string): void }>();

    // Prefer the req.id already stamped by pino-http's genReqId so both the
    // request log line and the ALS context share the exact same value.
    const correlationId: string =
      String(req.id) !== 'undefined'
        ? String(req.id)
        : (req.headers['cf-ray'] ?? req.headers['x-correlation-id'] ?? randomUUID());

    // Echo back so clients can correlate their own logs
    res.setHeader('x-correlation-id', correlationId);

    // Wrap the handler inside an ALS run() so every downstream async call
    // (including service awaits) inherits the context automatically.
    return new Observable(observer => {
      correlationStorage.run({ correlationId }, () => {
        next.handle().subscribe(observer);
      });
    });
  }
}
