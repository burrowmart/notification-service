import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Histogram, register } from 'prom-client';

// Guard against duplicate registration during hot-reload in dev
const METRIC_NAME = 'http_request_duration_seconds';
const httpDuration =
  (register.getSingleMetric(METRIC_NAME) as Histogram<string> | undefined) ??
  new Histogram({
    name: METRIC_NAME,
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  });

@Injectable()
export class MetricsDurationInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<{ method: string; route?: { path: string }; url: string }>();
    const endTimer = httpDuration.startTimer();

    return next.handle().pipe(
      tap({
        next: () => {
          const res = ctx.switchToHttp().getResponse<{ statusCode: number }>();
          endTimer({
            method: req.method,
            route: req.route?.path ?? req.url,
            status_code: String(res.statusCode),
          });
        },
        error: (err: { status?: number }) => {
          endTimer({
            method: req.method,
            route: req.route?.path ?? req.url,
            status_code: String(err?.status ?? 500),
          });
        },
      }),
    );
  }
}
