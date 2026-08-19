import * as Joi from 'joi';
import { SERVICE_NAME } from '../constants';

export const envValidationSchema = Joi.object({
  PORT: Joi.number().default(3000),
  MONGO_URI: Joi.string().required(),
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  // Auth — required unless AUTH_DISABLED=true (used in tests)
  AUTH_DISABLED: Joi.string().valid('true', 'false').default('false'),
  COGNITO_ISSUER: Joi.string().when('AUTH_DISABLED', {
    is: 'true',
    then: Joi.string().optional().allow(''),
    otherwise: Joi.string().required(),
  }),
  COGNITO_AUDIENCE: Joi.string().when('AUTH_DISABLED', {
    is: 'true',
    then: Joi.string().optional().allow(''),
    otherwise: Joi.string().required(),
  }),
  // Observability
  OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string().uri().optional(),
  OTEL_SERVICE_NAME: Joi.string().default(SERVICE_NAME),
  // Async messaging — optional with sensible defaults for local dev
  RABBITMQ_URL: Joi.string().default('amqp://guest:guest@localhost:5672'),
  REDIS_URL: Joi.string().default('redis://localhost:6379'),
  // Set to 'false' in test environments that don't have RabbitMQ/Redis running
  OUTBOX_PUBLISHER_ENABLED: Joi.string().valid('true', 'false').default('true'),
});
