/**
 * Jest globalSetup — runs once before any test file is loaded.
 * Starts a single-node MongoMemoryReplSet and exposes MONGO_URI via
 * process.env so that ConfigModule's Joi validation finds the variable when
 * app.module.ts is first imported (which happens at module-load time, before
 * beforeAll). Works because --runInBand keeps everything in the same process.
 *
 * Kept as a replica set (not a plain MongoMemoryServer) for parity with the
 * other services' template even though this service's own Mongo writes
 * don't use transactions — OutboxModule is still wired in (for
 * IdempotentConsumerService) and its change-stream watcher requires an oplog
 * if OUTBOX_PUBLISHER_ENABLED were ever true here.
 *
 * Unlike user-service, this tier also needs a REAL Redis reachable at
 * REDIS_URL (default redis://localhost:6379) — every REST endpoint in
 * app.e2e-spec.ts hits the hot layer directly. AUTH_DISABLED=true makes
 * JwtGuard populate req.claims.email from the x-test-user-email header
 * instead of verifying a real Cognito JWT (see jwt.guard.ts).
 */
import { MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function globalSetup(): Promise<void> {
  const mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  // getUri() already ends in "/?replicaSet=..." — the db name must be passed
  // as its argument (not string-concatenated) or it gets glued onto the query
  // string instead of the path, producing an unparseable replica set name.
  process.env.MONGO_URI = mongod.getUri('notification-service-test');
  process.env.PORT = '3001';
  process.env.AUTH_DISABLED = 'true';
  // Disable the RabbitMQ-dependent outbox publisher + choreography consumer
  // in unit & standard e2e tests — this tier never asserts on either.
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  // Stash for globalTeardown (same process, same global object)
  (global as any).__MONGOD__ = mongod;
}
