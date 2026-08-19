import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { OutboxEntity, OutboxSchema } from './schemas/outbox.schema';
import {
  OutboxStateEntity,
  OutboxStateSchema,
} from './schemas/outbox-state.schema';
import {
  ProcessedMessageEntity,
  ProcessedMessageSchema,
} from './schemas/processed-message.schema';
import { OutboxService } from './outbox.service';
import { OutboxPublisherService } from './outbox-publisher.service';
import { LeaderLockService } from './leader-lock.service';
import { IdempotentConsumerService } from './idempotent-consumer.service';
import { OUTBOX_REDIS_CLIENT } from './outbox.tokens';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: OutboxEntity.name, schema: OutboxSchema },
      { name: OutboxStateEntity.name, schema: OutboxStateSchema },
      { name: ProcessedMessageEntity.name, schema: ProcessedMessageSchema },
    ]),
  ],
  providers: [
    {
      provide: OUTBOX_REDIS_CLIENT,
      useFactory: (config: ConfigService): Redis | null => {
        // Return null when the publisher is disabled so Redis connection
        // is never attempted (e.g. in unit/integration test environments)
        if (!config.get<boolean>('outboxPublisherEnabled')) return null;
        const url = config.get<string>('redisUrl')!;
        // lazyConnect: don't connect until the first command — LeaderLock.acquire() triggers it
        return new Redis(url, { lazyConnect: false });
      },
      inject: [ConfigService],
    },
    LeaderLockService,
    OutboxService,
    OutboxPublisherService,
    IdempotentConsumerService,
  ],
  exports: [OutboxService, IdempotentConsumerService],
})
export class OutboxModule {}
