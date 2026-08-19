import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import type { MessageEnvelope } from '@demo/contracts';

export type OutboxDocument = HydratedDocument<OutboxEntity>;

@Schema({ timestamps: true, collection: 'outbox' })
export class OutboxEntity {
  @Prop({ type: Object, required: true })
  envelope!: MessageEnvelope;

  /** RabbitMQ exchange name (from EXCHANGES constants) */
  @Prop({ required: true })
  exchange!: string;

  /** RabbitMQ routing key (from ROUTING_KEYS constants) */
  @Prop({ required: true })
  routingKey!: string;

  @Prop({ default: false, index: true })
  published!: boolean;

  @Prop()
  publishedAt?: Date;
}

export const OutboxSchema = SchemaFactory.createForClass(OutboxEntity);
// Compound index: efficient backlog drain query (published: false, sorted by age)
OutboxSchema.index({ published: 1, createdAt: 1 });
