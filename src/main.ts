// tracing MUST be the first import — instruments http/express/mongoose before any module loads
import './common/tracing/tracing';

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  // Swagger UI + doc generation — always on for demo; the `/api` path is
  // blocked in prod by the Envoy PEP sidecar (path allow-list in OPA policy).
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Notification Service API')
    .setDescription('Persist-then-push notifications: Mongo durable journal + Redis hot layer (unread counter, recent list) + pub/sub fan-out to ws-gateway.')
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, document);

  const port = process.env.PORT ?? '3000';
  await app.listen(port);
}

bootstrap();
