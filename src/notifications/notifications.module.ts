import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsController } from './notifications.controller';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';
import { NotificationEntity, NotificationSchema } from './schemas/notification.schema';
import { NotificationRedisModule } from './redis/redis.module';
import { NotificationsRedisService } from './redis/notifications-redis.service';
import { NotificationEventsConsumerService } from './consumers/notification-events.consumer';
import { OutboxModule } from '../common/outbox/outbox.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: NotificationEntity.name, schema: NotificationSchema }]),
    NotificationRedisModule,
    // Provides IdempotentConsumerService (dedup by messageId) for the choreography consumers.
    // This service writes no outbox rows of its own — it never publishes RabbitMQ messages,
    // only Redis pub/sub — so OutboxPublisherService's change-stream watcher stays idle here.
    OutboxModule,
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsRepository,
    NotificationsRedisService,
    NotificationEventsConsumerService,
  ],
})
export class NotificationsModule {}
