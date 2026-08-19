import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import { getCorrelationId } from '../correlation/correlation.context';
import type { IncomingMessage, ServerResponse } from 'http';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        // pino-pretty in dev for readable local output; raw JSON in production
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
            : undefined,
        // genReqId extracts the correlation id from Cloudflare/upstream headers;
        // pino-http includes it as reqId on the req/res log lines automatically.
        genReqId: (req: IncomingMessage) =>
          (req.headers['cf-ray'] as string) ??
          (req.headers['x-correlation-id'] as string) ??
          randomUUID(),
        // customProps adds correlationId to the pino-http req/res log entries;
        // String() cast: ReqId is string|number|symbol depending on genReqId return.
        customProps: (req: IncomingMessage, _res: ServerResponse): object => ({
          correlationId: String((req as IncomingMessage & { id: unknown }).id),
        }),
        // mixin runs on EVERY log line — reads from ALS for service-level logger calls
        mixin: () => {
          const id = getCorrelationId();
          return id ? { correlationId: id } : {};
        },
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers["cf-token"]',
            'req.headers["x-amzn-oidc-data"]',
          ],
          censor: '[REDACTED]',
        },
      },
    }),
  ],
})
export class AppLoggingModule {}
