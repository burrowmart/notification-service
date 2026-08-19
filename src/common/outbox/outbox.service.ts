import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { ClientSession } from 'mongoose';
import { randomUUID } from 'crypto';
import type { MessageEnvelope } from '@demo/contracts';
import { getCorrelationId } from '../correlation/correlation.context';
import { OutboxEntity, OutboxDocument } from './schemas/outbox.schema';

@Injectable()
export class OutboxService {
  constructor(
    @InjectModel(OutboxEntity.name)
    private readonly model: Model<OutboxDocument>,
  ) {}

  /**
   * Writes one outbox row inside the caller's already-open Mongo session.
   * Must be called before the caller commits the session so that the domain
   * write and the outbox insert are atomic.
   *
   * correlationId is auto-populated from the AsyncLocalStorage request context
   * when not explicitly set on the envelope.
   */
  async writeInTx(
    session: ClientSession,
    envelope: MessageEnvelope,
    exchange: string,
    routingKey: string,
  ): Promise<void> {
    const enriched: MessageEnvelope = {
      ...envelope,
      correlationId:
        envelope.correlationId || getCorrelationId() || randomUUID(),
    };
    await this.model.create(
      [{ envelope: enriched, exchange, routingKey, published: false }],
      { session },
    );
  }
}
