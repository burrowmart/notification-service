import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type OutboxStateDocument = HydratedDocument<OutboxStateEntity>;

/**
 * Single-row collection (id='default') storing the change-stream resumeToken.
 * Persisted after every successful publish so a restart can replay from exactly
 * the last unprocessed event rather than rescanning the full backlog.
 */
@Schema({ collection: 'outbox_state' })
export class OutboxStateEntity {
  @Prop({ required: true })
  _id!: string;

  // mongodb ResumeToken is an opaque object — stored as BSON subdocument
  @Prop({ type: Object })
  resumeToken?: object;
}

export const OutboxStateSchema = SchemaFactory.createForClass(OutboxStateEntity);
