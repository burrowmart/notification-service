import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ProcessedMessageDocument = HydratedDocument<ProcessedMessageEntity>;

@Schema({ collection: 'processed_messages' })
export class ProcessedMessageEntity {
  /** The deduplication key — same value as MessageEnvelope.messageId */
  @Prop({ required: true, unique: true })
  messageId!: string;

  @Prop({ default: () => new Date() })
  processedAt!: Date;
}

export const ProcessedMessageSchema =
  SchemaFactory.createForClass(ProcessedMessageEntity);

// TTL: expire records after 7 days — long enough to cover any replay window
ProcessedMessageSchema.index(
  { processedAt: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60 },
);
