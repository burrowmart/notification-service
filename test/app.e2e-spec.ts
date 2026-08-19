/**
 * MongoMemoryServer is started by test/global-setup.ts before any file is
 * imported, so MONGO_URI is already in process.env when ConfigModule.forRoot
 * validates the schema at app.module.ts parse time.
 *
 * Unlike user-service's plain e2e suite, this one also needs a real Redis —
 * every REST endpoint here reads/writes the hot layer directly (it's not an
 * optional dependency gated by OUTBOX_PUBLISHER_ENABLED like the outbox is).
 * Prerequisite: docker compose -f ../platform-infra/docker-compose.yml up -d redis
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import Redis from 'ioredis';
import { AppModule } from '../src/app.module';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NOTIFICATION_REDIS_CLIENT } from '../src/notifications/redis/redis.tokens';

describe('NotificationsController (e2e)', () => {
  let app: INestApplication;
  let notifications: NotificationsService;
  let redis: Redis;

  const EMAIL = 'e2e-notify@example.com';
  const OTHER_EMAIL = 'someone-else@example.com';
  const authed = (email = EMAIL) => ({ 'x-test-user-email': email });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    notifications = moduleFixture.get(NotificationsService);
    redis = moduleFixture.get(NOTIFICATION_REDIS_CLIENT);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health — returns ok', () =>
    request(app.getHttpServer()).get('/health').expect(200).expect({ status: 'ok' }));

  it('GET /notifications/unread-count — 0 for a user with no notifications yet', () =>
    request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set(authed())
      .expect(200)
      .expect({ count: 0 }));

  let firstId: string;
  let secondId: string;

  it('seed: recordEvent persists to Mongo then INCRs Redis (simulates a consumed choreography event)', async () => {
    const n1 = await notifications.recordEvent(EMAIL, 'ORDER_CONFIRMED', { orderId: 'order-1', sagaId: 'saga-1' });
    const n2 = await notifications.recordEvent(EMAIL, 'PAYMENT_SUCCEEDED', { orderId: 'order-1', sagaId: 'saga-1', paymentId: 'pay-1' });
    firstId = n1.id;
    secondId = n2.id;
    expect(n1.read).toBe(false);
    expect(n2.userEmail).toBe(EMAIL);
  });

  it('GET /notifications/unread-count — reflects both, reading only Redis', () =>
    request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set(authed())
      .expect(200)
      .expect({ count: 2 }));

  it("GET /notifications/unread-count — a different user's count is unaffected", () =>
    request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set(authed(OTHER_EMAIL))
      .expect(200)
      .expect({ count: 0 }));

  it('GET /notifications — paginated from Mongo, newest first', () =>
    request(app.getHttpServer())
      .get('/notifications')
      .set(authed())
      .expect(200)
      .expect((res: request.Response) => {
        expect(res.body.total).toBe(2);
        expect(res.body.data).toHaveLength(2);
        expect(res.body.page).toBe(1);
        expect(res.body.data[0].id).toBe(secondId); // newest first
        expect(res.body.data[0].type).toBe('PAYMENT_SUCCEEDED');
        expect(res.body.data[0].read).toBe(false);
      }));

  it('POST /notifications/:id/read — marks read, DECRs the counter', async () => {
    await request(app.getHttpServer()).post(`/notifications/${firstId}/read`).set(authed()).expect(204);

    const { body } = await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set(authed())
      .expect(200);
    expect(body.count).toBe(1);
  });

  it('POST /notifications/:id/read — idempotent: a second mark-as-read does not double-decrement', async () => {
    await request(app.getHttpServer()).post(`/notifications/${firstId}/read`).set(authed()).expect(204);

    const { body } = await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set(authed())
      .expect(200);
    expect(body.count).toBe(1); // still 1, not -1 or negative
  });

  it("POST /notifications/:id/read — cannot mark another user's notification (ownership scoping)", async () => {
    await request(app.getHttpServer()).post(`/notifications/${secondId}/read`).set(authed(OTHER_EMAIL)).expect(204);

    // secondId is still unread for its real owner — the call above was a no-op
    const { body } = await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set(authed())
      .expect(200);
    expect(body.count).toBe(1);
  });

  it('Redis FLUSHALL → unread-count and recent list are rebuilt from Mongo (acceptance #6)', async () => {
    await redis.flushall();

    // Sanity: the key really is gone right after the flush
    expect(await redis.get(`notif:unread:${EMAIL}`)).toBeNull();

    const { body } = await request(app.getHttpServer())
      .get('/notifications/unread-count')
      .set(authed())
      .expect(200);
    // One of the two seeded notifications is read, one isn't → rebuilt count is 1
    expect(body.count).toBe(1);

    // The lazy rebuild must have repopulated the key, not just returned a one-off value
    expect(await redis.get(`notif:unread:${EMAIL}`)).toBe('1');
    const recent = await redis.lrange(`notif:recent:${EMAIL}`, 0, -1);
    expect(recent).toHaveLength(2);

    // Mongo (the durable journal) was never touched by the flush
    const { body: page } = await request(app.getHttpServer()).get('/notifications').set(authed()).expect(200);
    expect(page.total).toBe(2);
  });
});
