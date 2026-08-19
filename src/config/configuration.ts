export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  // Validated by Joi at startup — assertion is safe
  mongoUri: process.env.MONGO_URI as string,
  cognito: {
    issuer: process.env.COGNITO_ISSUER ?? '',
    audience: process.env.COGNITO_AUDIENCE ?? '',
  },
  rabbitmqUrl: process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  // Set OUTBOX_PUBLISHER_ENABLED=false to disable the RabbitMQ+Redis-dependent
  // publisher (used in unit/integration test environments without that infra)
  outboxPublisherEnabled: process.env.OUTBOX_PUBLISHER_ENABLED !== 'false',
});
