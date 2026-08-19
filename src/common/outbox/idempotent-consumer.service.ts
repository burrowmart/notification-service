import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { MessageEnvelope } from '@demo/contracts';
import {
  ProcessedMessageEntity,
  ProcessedMessageDocument,
} from './schemas/processed-message.schema';

export type ConsumerResult = 'ack' | 'nack' | 'dlq';

@Injectable()
export class IdempotentConsumerService {
  private readonly logger = new Logger(IdempotentConsumerService.name);

  constructor(
    @InjectModel(ProcessedMessageEntity.name)
    private readonly model: Model<ProcessedMessageDocument>,
  ) {}

  /**
   * Runs `handler` exactly once per `envelope.messageId`.
   *
   * Returns:
   *   'ack'  — success (or idempotent skip: already processed)
   *   'nack' — transient failure; caller should requeue (retry)
   *   'dlq'  — retries exhausted; caller should dead-letter
   *
   * The caller is responsible for wiring the result into the transport
   * ack/nack/reject mechanics (e.g. channel.ack / channel.nack / channel.reject).
   */
  async handle<T>(
    envelope: MessageEnvelope<T>,
    handler: (payload: T) => Promise<void>,
    opts: { maxRetries?: number; retryCount?: number } = {},
  ): Promise<ConsumerResult> {
    const { messageId } = envelope;
    const maxRetries = opts.maxRetries ?? 3;
    const retryCount = opts.retryCount ?? 0;

    // Fast-path: skip if already processed (TTL-indexed lookup)
    const already = await this.model.exists({ messageId });
    if (already) {
      this.logger.debug({ messageId }, 'Duplicate message — skipping');
      return 'ack';
    }

    try {
      await handler(envelope.payload);
      // Persist dedup record — unique index prevents a concurrent duplicate from
      // also persisting, but both would safely return 'ack' afterwards.
      await this.model.create({ messageId });
      return 'ack';
    } catch (err) {
      this.logger.warn({ messageId, err, retryCount }, 'Message handler failed');
      if (retryCount >= maxRetries) {
        this.logger.error({ messageId }, 'Max retries exceeded — dead-letter');
        return 'dlq';
      }
      return 'nack';
    }
  }
}
