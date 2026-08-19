import type { MessageEnvelope } from '@demo/contracts';
import { getCorrelationId } from './correlation.context';

/**
 * Stamps the current request's correlationId onto a MessageEnvelope before
 * it is written to the outbox collection.  Pass-through if no context is set.
 */
export function withCorrelation<T>(envelope: MessageEnvelope<T>): MessageEnvelope<T> {
  const correlationId = getCorrelationId();
  if (!correlationId) return envelope;
  return { ...envelope, correlationId };
}
