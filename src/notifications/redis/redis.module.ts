import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { NOTIFICATION_REDIS_CLIENT } from './redis.tokens';

// Global within this service: the hot layer (unread counter, recent list,
// pub/sub) is read/written from the REST controller and every choreography
// consumer, so a single shared connection avoids reconnect overhead per module.
@Global()
@Module({
  providers: [
    {
      provide: NOTIFICATION_REDIS_CLIENT,
      useFactory: (config: ConfigService): Redis => {
        const url = config.get<string>('redisUrl')!;
        return new Redis(url);
      },
      inject: [ConfigService],
    },
  ],
  exports: [NOTIFICATION_REDIS_CLIENT],
})
export class NotificationRedisModule {}
