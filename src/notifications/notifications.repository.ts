import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { NotificationType } from '@demo/contracts';
import { NotificationEntity, NotificationDocument } from './schemas/notification.schema';

@Injectable()
export class NotificationsRepository {
  constructor(
    @InjectModel(NotificationEntity.name)
    private readonly model: Model<NotificationDocument>,
  ) {}

  create(
    userEmail: string,
    type: NotificationType,
    payload: Record<string, unknown>,
  ): Promise<NotificationDocument> {
    return this.model.create({ userEmail, type, payload, read: false });
  }

  async findPage(
    userEmail: string,
    page: number,
    limit: number,
  ): Promise<{ data: NotificationDocument[]; total: number }> {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.model.find({ userEmail }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean().exec(),
      this.model.countDocuments({ userEmail }).exec(),
    ]);
    return { data: data as unknown as NotificationDocument[], total };
  }

  /** Most recent N, newest first — used to rebuild the Redis recent list after a flush. */
  findRecent(userEmail: string, n: number): Promise<NotificationDocument[]> {
    return this.model
      .find({ userEmail })
      .sort({ createdAt: -1 })
      .limit(n)
      .lean()
      .exec() as unknown as Promise<NotificationDocument[]>;
  }

  countUnread(userEmail: string): Promise<number> {
    return this.model.countDocuments({ userEmail, read: false }).exec();
  }

  /**
   * Marks one notification read, scoped to its owner so a caller can never
   * flip another user's notification. Returns false if it was already read
   * (or didn't exist) — the caller uses this to skip a duplicate Redis DECR.
   */
  async markRead(id: string, userEmail: string): Promise<boolean> {
    const res = await this.model
      .updateOne({ _id: id, userEmail, read: false }, { $set: { read: true } })
      .exec();
    return res.modifiedCount === 1;
  }
}
