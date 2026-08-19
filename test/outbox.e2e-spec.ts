/**
 * Choreography consumer integration tests — the 4 scenarios called for in
 * the acceptance checklist: event → Mongo + Redis counter + pub/sub;
 * duplicate messageId → one notification. (mark-as-read → 0 and the
 * FLUSHALL/rebuild scenario are covered against a lighter Mongo-memory +
 * real-Redis setup in app.e2e-spec.ts; this suite is the one that needs the
 * full Mongo-replset + Redis + RabbitMQ stack because it exercises the real
 * NotificationEventsConsumerService over AMQP.)
 *
 * Prerequisites (run once before this suite):
 *   docker compose -f ../platform-infra/docker-compose.yml up -d redis rabbitmq
 *
 * Mongo RS is started automatically by outbox-global-setup.ts.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'crypto';
import * as amqplib from 'amqplib';
import Redis from 'ioredis';
import { createEnvelope, EXCHANGES, ROUTING_KEYS } from '@demo/contracts';
import type { OrderConfirmedPayload, PaymentFailedEventPayload } from '@demo/contracts';
import { AppModule } from '../src/app.module';
import { IdempotentConsumerService } from '../src/common/outbox/idempotent-consumer.service';
import {
  ProcessedMessageEntity,
  ProcessedMessageDocument,
} from '../src/common/outbox/schemas/processed-message.schema';
import { NotificationEntity, NotificationDocument } from '../src/notifications/schemas/notification.schema';
import { NOTIFICATION_REDIS_CLIENT } from '../src/notifications/redis/redis.tokens';

const AMQP_URL = process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for exactly one pub/sub message on `channel`, or rejects on timeout. */
function waitForPubSubMessage(sub: Redis, channel: string, timeoutMs = 7_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for pub/sub message on ${channel}`)), timeoutMs);
    sub.subscribe(channel, (err) => {
      if (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
    sub.on('message', (ch, message) => {
      if (ch !== channel) return;
      clearTimeout(timer);
      resolve(message);
    });
  });
}

describe('Notification choreography consumers (e2e)', () => {
  let app: INestApplication;
  let idempotentConsumer: IdempotentConsumerService;
  let notificationModel: Model<NotificationDocument>;
  let processedModel: Model<ProcessedMessageDocument>;
  let redis: Redis;
  let amqpConn: amqplib.ChannelModel;
  let amqpCh: amqplib.Channel;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    // Give NotificationEventsConsumerService time to assert/bind its queues
    // (it connects to AMQP asynchronously from onApplicationBootstrap).
    await delay(1_000);

    idempotentConsumer = module.get(IdempotentConsumerService);
    notificationModel = module.get(getModelToken(NotificationEntity.name));
    processedModel = module.get(getModelToken(ProcessedMessageEntity.name));
    redis = module.get(NOTIFICATION_REDIS_CLIENT);

    amqpConn = await amqplib.connect(AMQP_URL);
    amqpCh = await amqpConn.createChannel();
    await amqpCh.assertExchange(EXCHANGES.DOMAIN_EVENTS, 'topic', { durable: true });
  });

  afterAll(async () => {
    await amqpCh?.close().catch(() => undefined);
    await amqpConn?.close().catch(() => undefined);
    await app.close();
  });

  afterEach(async () => {
    await notificationModel.deleteMany({}).catch(() => undefined);
    await processedModel.deleteMany({}).catch(() => undefined);
  });

  it('order-confirmed → Mongo doc + Redis counter=1 + pub/sub message observed', async () => {
    const email = `order-confirmed-${randomUUID()}@e2e.test`;
    const sub = new Redis(REDIS_URL);
    const waitMsg = waitForPubSubMessage(sub, `notifications:${email}`);

    const envelope = createEnvelope<OrderConfirmedPayload>(ROUTING_KEYS.ORDER_CONFIRMED, {
      orderId: 'order-42',
      userId: email,
      sagaId: 'saga-42',
    });
    amqpCh.publish(
      EXCHANGES.DOMAIN_EVENTS,
      ROUTING_KEYS.ORDER_CONFIRMED,
      Buffer.from(JSON.stringify(envelope)),
      { messageId: envelope.messageId, contentType: 'application/json', persistent: true },
    );

    const pushed = JSON.parse(await waitMsg);
    expect(pushed.type).toBe('ORDER_CONFIRMED');
    expect(pushed.userEmail).toBe(email);
    expect(pushed.payload.orderId).toBe('order-42');
    await sub.quit();

    // (1) persisted to Mongo
    await delay(200);
    const doc = await notificationModel.findOne({ userEmail: email }).lean();
    expect(doc?.type).toBe('ORDER_CONFIRMED');
    expect(doc?.read).toBe(false);

    // (2) Redis unread counter
    expect(await redis.get(`notif:unread:${email}`)).toBe('1');
    const recent = await redis.lrange(`notif:recent:${email}`, 0, -1);
    expect(recent).toHaveLength(1);
  });

  it('payment-failed → Mongo doc + Redis counter=1 + pub/sub message observed', async () => {
    const email = `payment-failed-${randomUUID()}@e2e.test`;
    const sub = new Redis(REDIS_URL);
    const waitMsg = waitForPubSubMessage(sub, `notifications:${email}`);

    const envelope = createEnvelope<PaymentFailedEventPayload>(ROUTING_KEYS.PAYMENT_FAILED, {
      orderId: 'order-43',
      userId: email,
      sagaId: 'saga-43',
      reason: 'card declined',
    });
    amqpCh.publish(
      EXCHANGES.DOMAIN_EVENTS,
      ROUTING_KEYS.PAYMENT_FAILED,
      Buffer.from(JSON.stringify(envelope)),
      { messageId: envelope.messageId, contentType: 'application/json', persistent: true },
    );

    const pushed = JSON.parse(await waitMsg);
    expect(pushed.type).toBe('PAYMENT_FAILED');
    expect(pushed.payload.reason).toBe('card declined');
    await sub.quit();

    await delay(200);
    const doc = await notificationModel.findOne({ userEmail: email }).lean();
    expect(doc?.type).toBe('PAYMENT_FAILED');
    expect(await redis.get(`notif:unread:${email}`)).toBe('1');
  });

  it('duplicate messageId (same event redelivered) → exactly one notification', async () => {
    const email = `dedup-${randomUUID()}@e2e.test`;
    const envelope = createEnvelope<OrderConfirmedPayload>(ROUTING_KEYS.ORDER_CONFIRMED, {
      orderId: 'order-44',
      userId: email,
      sagaId: 'saga-44',
    });

    const publishOnce = () =>
      amqpCh.publish(
        EXCHANGES.DOMAIN_EVENTS,
        ROUTING_KEYS.ORDER_CONFIRMED,
        Buffer.from(JSON.stringify(envelope)),
        { messageId: envelope.messageId, contentType: 'application/json', persistent: true },
      );

    // Publish the exact same envelope (same messageId) three times
    publishOnce();
    await delay(300);
    publishOnce();
    publishOnce();
    await delay(500);

    const docs = await notificationModel.find({ userEmail: email }).lean();
    expect(docs).toHaveLength(1);
    expect(await redis.get(`notif:unread:${email}`)).toBe('1'); // not 3

    // Direct-handler check too — the consumer's own dedup path
    let calls = 0;
    const r1 = await idempotentConsumer.handle(envelope, async () => { calls++; });
    const r2 = await idempotentConsumer.handle(envelope, async () => { calls++; });
    expect(r1).toBe('ack');
    expect(r2).toBe('ack');
    expect(calls).toBe(0); // already processed by the AMQP path above
  });
});
