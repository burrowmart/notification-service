import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import type { Notification } from '@demo/contracts';
import { NOTIFICATION_REDIS_CLIENT } from './redis.tokens';
import { NotificationsRepository } from '../notifications.repository';

/** Recent-list cap — mirrors LTRIM N from the architecture spec. */
const RECENT_LIST_SIZE = 50;

const unreadKey = (email: string) => `notif:unread:${email}`;
const recentKey = (email: string) => `notif:recent:${email}`;
const channel = (email: string) => `notifications:${email}`;

// Atomic floor-at-0 decrement: a bare DECR can go negative if a duplicate
// mark-as-read races a rebuild, which would under-report unread count.
const DECR_FLOORED_AT_ZERO = `
local v = redis.call('DECR', KEYS[1])
if v < 0 then
  redis.call('SET', KEYS[1], 0)
  return 0
end
return v
`;

@Injectable()
export class NotificationsRedisService {
  private readonly logger = new Logger(NotificationsRedisService.name);

  constructor(
    @Inject(NOTIFICATION_REDIS_CLIENT) private readonly redis: Redis,
    private readonly repo: NotificationsRepository,
  ) {}

  /** Step 2 of persist-then-push: INCR unread + LPUSH/LTRIM recent list. */
  async recordUnread(userEmail: string, notification: Notification): Promise<void> {
    await this.redis
      .multi()
      .incr(unreadKey(userEmail))
      .lpush(recentKey(userEmail), JSON.stringify(notification))
      .ltrim(recentKey(userEmail), 0, RECENT_LIST_SIZE - 1)
      .exec();
  }

  /** Step 3 of persist-then-push: fan-out to ws-gateway via pub/sub. */
  async publish(userEmail: string, notification: Notification): Promise<void> {
    await this.redis.publish(channel(userEmail), JSON.stringify(notification));
  }

  async decrementUnread(userEmail: string): Promise<void> {
    await this.redis.eval(DECR_FLOORED_AT_ZERO, 1, unreadKey(userEmail));
  }

  /**
   * Redis is a disposable cache over Mongo's durable journal: if the unread
   * key is missing (cold start or `FLUSHALL`), rebuild it — and the recent
   * list — from Mongo before serving, instead of returning a false zero.
   */
  async getUnreadCount(userEmail: string): Promise<number> {
    const cached = await this.redis.get(unreadKey(userEmail));
    if (cached !== null) return Number(cached);

    this.logger.log({ userEmail }, 'Redis unread key missing — rebuilding from Mongo');
    return this.rebuildFromMongo(userEmail);
  }

  private async rebuildFromMongo(userEmail: string): Promise<number> {
    const [count, recent] = await Promise.all([
      this.repo.countUnread(userEmail),
      this.repo.findRecent(userEmail, RECENT_LIST_SIZE),
    ]);

    const pipeline = this.redis.multi().set(unreadKey(userEmail), count).del(recentKey(userEmail));
    // findRecent is newest-first; push oldest-first so the final LPUSH order
    // matches the live path (each new notification ends up at index 0).
    for (const doc of [...recent].reverse()) {
      pipeline.lpush(recentKey(userEmail), JSON.stringify(this.toNotification(doc)));
    }
    await pipeline.exec();

    return count;
  }

  private toNotification(doc: any): Notification {
    return {
      id: String(doc._id),
      userEmail: doc.userEmail,
      type: doc.type,
      payload: doc.payload,
      read: doc.read,
      createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
    };
  }
}
