/** Single source of truth for all strings that change when cloning this template. */

/** Slug used for OTEL service.name, Helm release name, and image tag prefix. */
export const SERVICE_NAME = 'notification-service';

/** MongoDB collection this service owns. */
export const MONGO_COLLECTION = 'notifications';

/** RabbitMQ queue this service binds (mirrors helm/values.yaml app.env.RABBITMQ_QUEUE). */
export const RABBITMQ_QUEUE = 'notification-service.queue';
