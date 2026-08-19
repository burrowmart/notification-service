import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { NotificationType } from '@demo/contracts';
import { MONGO_COLLECTION } from '../../constants';

export type NotificationDocument = HydratedDocument<NotificationEntity>;

// Durable journal — source of truth. Redis (unread counter + recent list) is
// a disposable hot layer rebuilt from this collection on a cache miss.
@Schema({ timestamps: { createdAt: true, updatedAt: false }, collection: MONGO_COLLECTION })
export class NotificationEntity {
  @Prop({ required: true, index: true })
  userEmail!: string;

  @Prop({ required: true })
  type!: NotificationType;

  @Prop({ type: Object, required: true })
  payload!: Record<string, unknown>;

  @Prop({ required: true, default: false })
  read!: boolean;

  createdAt!: Date;
}

export const NotificationSchema = SchemaFactory.createForClass(NotificationEntity);

// Supports both GET /notifications (userEmail, createdAt desc) and the
// Redis-flush rebuild query (userEmail, read, most-recent-N).
NotificationSchema.index({ userEmail: 1, createdAt: -1 });
