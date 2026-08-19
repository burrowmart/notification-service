// Must be the FIRST import in main.ts — instruments http/express/mongoose/amqplib
// before any other module loads so all spans are captured.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { ExportResultCode, W3CTraceContextPropagator } from '@opentelemetry/core';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';
import { SERVICE_NAME } from '../../constants';

const noopExporter: SpanExporter = {
  export: (_spans: ReadableSpan[], done) => done({ code: ExportResultCode.SUCCESS }),
  shutdown: () => Promise.resolve(),
};

const sdk = new NodeSDK({
  resource: new Resource({
    // 'service.name' avoids importing semantic-conventions for a single string
    'service.name': process.env.OTEL_SERVICE_NAME ?? SERVICE_NAME,
  }),
  traceExporter: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? new OTLPTraceExporter()
    : noopExporter,
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs instrumentation produces thousands of spans per request — always off
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
  textMapPropagator: new W3CTraceContextPropagator(),
});

sdk.start();

process.on('SIGTERM', () => sdk.shutdown().finally(() => process.exit(0)));
