import { AsyncLocalStorage } from 'async_hooks';

export interface CorrelationContext {
  correlationId: string;
}

/** Single ALS instance shared across the entire process. */
export const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

/** Reads the current correlation id — safe to call anywhere (returns undefined outside a request). */
export const getCorrelationId = (): string | undefined =>
  correlationStorage.getStore()?.correlationId;
