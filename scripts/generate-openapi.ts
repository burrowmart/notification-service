/**
 * Generates openapi.yaml from the NestJS Swagger module metadata.
 *
 * Prerequisites:
 *   - MongoDB must be reachable at MONGO_URI (or set env before running).
 *     The default below assumes the platform-infra compose stack, whose mongo
 *     runs as replica set rs0; point MONGO_URI at a standalone mongod if that
 *     is what you have locally, otherwise the driver blocks on topology
 *     discovery until the server-selection timeout.
 *   - Run from the notification-service directory: npm run generate:openapi
 *
 * The emitted openapi.yaml is committed to the repo as the as-built view of
 * what this service actually serves. It is NOT the client-generator input:
 * contracts' generate-clients.ts reads the hand-authored design specs in
 * contracts/openapi/, never a service's own file — keep the two in agreement.
 */
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

// Defaults so the script is runnable without compose. These MUST be assigned
// before app.module is loaded: its ConfigModule.forRoot() call runs Joi at
// module-evaluation time, and a static `import { AppModule }` would be hoisted
// above these lines — leaving MONGO_URI unset and failing validation. Hence
// the dynamic import inside generate() below.
process.env.MONGO_URI ??= 'mongodb://localhost:27017/notifications?replicaSet=rs0';
process.env.AUTH_DISABLED ??= 'true';
process.env.OUTBOX_PUBLISHER_ENABLED ??= 'false';

async function generate(): Promise<void> {
  const { AppModule } = await import('../src/app.module');

  // abortOnError: false — the default (true) makes Nest swallow the cause and
  // exit(1), which combined with `logger: false` produces a silent failure.
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });

  const config = new DocumentBuilder()
    .setTitle('Notification Service API')
    .setDescription('Persist-then-push notifications: Mongo durable journal + Redis hot layer (unread counter, recent list) + pub/sub fan-out to ws-gateway.')
    .setVersion('0.1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  const outPath = join(__dirname, '..', 'openapi.yaml');
  writeFileSync(outPath, yaml.dump(document, { lineWidth: 120, noRefs: true }));
  console.log(`openapi.yaml written to ${outPath}`);

  await app.close();
  // Force exit in case Mongoose connection is still pending
  process.exit(0);
}

generate().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
