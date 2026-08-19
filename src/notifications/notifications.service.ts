import { Injectable } from '@nestjs/common';
import type { Notification, NotificationPage, NotificationType, UnreadCountResponse } from '@demo/contracts';
import { NotificationsRepository } from './notifications.repository';
import { NotificationsRedisService } from './redis/notifications-redis.service';
import { NotificationDocument } from './schemas/notification.schema';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly repo: NotificationsRepository,
    private readonly redis: NotificationsRedisService,
  ) {}

  /**
   * Persist-then-push, in the exact order the architecture mandates:
   * (1) Mongo is the durable source of truth — written first;
   * (2) the Redis hot layer (unread counter + recent list) is derived from it;
   * (3) only once both are committed does ws-gateway get told to fan it out,
   *     so a subscriber can never observe a push before REST/Mongo has the data.
   */
  async recordEvent(
    userEmail: string,
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Promise<Notification> {
    const doc = await this.repo.create(userEmail, type, payload);
    const notification = this.toResponse(doc);

    await this.redis.recordUnread(userEmail, notification);
    await this.redis.publish(userEmail, notification);

    return notification;
  }

  async getUnreadCount(userEmail: string): Promise<UnreadCountResponse> {
    const count = await this.redis.getUnreadCount(userEmail);
    return { count };
  }

  async list(userEmail: string, page: number, limit: number): Promise<NotificationPage> {
    const { data, total } = await this.repo.findPage(userEmail, page, limit);
    return { data: data.map((d) => this.toResponse(d)), total, page, limit };
  }

  async markAsRead(id: string, userEmail: string): Promise<void> {
    const flipped = await this.repo.markRead(id, userEmail);
    // Idempotent: a duplicate/racing mark-as-read on an already-read
    // notification must not DECR the counter a second time.
    if (flipped) await this.redis.decrementUnread(userEmail);
  }

  private toResponse(doc: NotificationDocument | any): Notification {
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
