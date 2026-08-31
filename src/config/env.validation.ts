import * as Joi from 'joi';
import { SERVICE_NAME } from '../constants';

export const envValidationSchema = Joi.object({
  PORT: Joi.number().default(3000),
  MONGO_URI: Joi.string().required(),
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  // Test-only identity bypass — the guard only extracts identity, never
  // verifies signatures (that is the Envoy PEP's job; see jwt.guard.ts)
  AUTH_DISABLED: Joi.string().valid('true', 'false').default('false'),
  // Observability
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().uri().optional(),
  OTEL_SERVICE_NAME: Joi.string().default(SERVICE_NAME),
  // Async messaging — optional with sensible defaults for local dev
  RABBITMQ_URL: Joi.string().default('amqp://guest:guest@localhost:5672'),
  REDIS_URL: Joi.string().default('redis://localhost:6379'),
  // Set to 'false' in test environments that don't have RabbitMQ/Redis running
  OUTBOX_PUBLISHER_ENABLED: Joi.string().valid('true', 'false').default('true'),
});
