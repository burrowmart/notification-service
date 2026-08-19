import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqplib from 'amqplib';
import {
  EXCHANGES,
  QUEUES,
  ROUTING_KEYS,
  type MessageEnvelope,
  type NotificationType,
  type OrderConfirmedPayload,
  type OrderCancelledPayload,
  type PaymentSucceededEventPayload,
  type PaymentFailedEventPayload,
} from '@demo/contracts';
import { NotificationsService } from '../notifications.service';
import { IdempotentConsumerService } from '../../common/outbox/idempotent-consumer.service';
import { correlationStorage } from '../../common/correlation/correlation.context';

/** Dead-letter exchange for all four choreography event queues. */
const NOTIFICATIONS_DLX = 'notifications.events.dlx';

interface EventBinding {
  queue: string;
  routingKey: string;
  type: NotificationType;
  /** Extracts {userEmail, payload} from the event's own payload shape. */
  toNotification: (payload: unknown) => { userEmail: string; payload: Record<string, unknown> };
}

const EVENT_BINDINGS: EventBinding[] = [
  {
    queue: QUEUES.NOTIFICATION_ORDER_CONFIRMED,
    routingKey: ROUTING_KEYS.ORDER_CONFIRMED,
    type: 'ORDER_CONFIRMED',
    toNotification: (p) => {
      const { userId, orderId, sagaId } = p as OrderConfirmedPayload;
      return { userEmail: userId, payload: { orderId, sagaId } };
    },
  },
  {
    queue: QUEUES.NOTIFICATION_ORDER_CANCELLED,
    routingKey: ROUTING_KEYS.ORDER_CANCELLED,
    type: 'ORDER_CANCELLED',
    toNotification: (p) => {
      const { userId, orderId, sagaId, reason } = p as OrderCancelledPayload;
      return { userEmail: userId, payload: { orderId, sagaId, reason } };
    },
  },
  {
    queue: QUEUES.NOTIFICATION_PAYMENT_SUCCEEDED,
    routingKey: ROUTING_KEYS.PAYMENT_SUCCEEDED,
    type: 'PAYMENT_SUCCEEDED',
    toNotification: (p) => {
      const { userId, orderId, sagaId, paymentId } = p as PaymentSucceededEventPayload;
      return { userEmail: userId, payload: { orderId, sagaId, paymentId } };
    },
  },
  {
    queue: QUEUES.NOTIFICATION_PAYMENT_FAILED,
    routingKey: ROUTING_KEYS.PAYMENT_FAILED,
    type: 'PAYMENT_FAILED',
    toNotification: (p) => {
      const { userId, orderId, sagaId, reason } = p as PaymentFailedEventPayload;
      return { userEmail: userId, payload: { orderId, sagaId, reason } };
    },
  },
];

/**
 * Choreography consumers: subscribe directly to the DOMAIN_EVENTS topic
 * exchange for order-confirmed / order-cancelled / payment-succeeded /
 * payment-failed. Deliberately NOT routed through the order-orchestrator —
 * each event has its own dedicated queue here, fanned out by RabbitMQ
 * alongside whatever the publishing service's own queues are (e.g.
 * order-orchestrator's reply queues), so this consumer can never steal a
 * message meant for another subscriber.
 *
 * Retry/DLQ mechanics mirror order-service's SagaRepliesConsumerService:
 * a handler failure is ack'd + republished with an incremented
 * x-retry-count rather than nack'd-with-requeue (classic queues don't
 * expose a reliable delivery count), and IdempotentConsumerService's 'dlq'
 * result nacks without requeue so the queue's x-dead-letter-exchange
 * argument routes it to `<queue>.dlq` automatically.
 */
@Injectable()
export class NotificationEventsConsumerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(NotificationEventsConsumerService.name);
  private conn?: amqplib.ChannelModel;
  private ch?: amqplib.Channel;

  constructor(
    private readonly notifications: NotificationsService,
    private readonly idempotentConsumer: IdempotentConsumerService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get<boolean>('outboxPublisherEnabled')) {
      this.logger.log('Notification event consumer disabled via OUTBOX_PUBLISHER_ENABLED');
      return;
    }
    await this.connect();
  }

  private async connect(): Promise<void> {
    const url = this.config.get<string>('rabbitmqUrl')!;
    this.conn = await amqplib.connect(url);
    // amqplib rethrows unhandled connection-level errors (e.g. a missed
    // heartbeat) as an uncaught exception that kills the process — log
    // instead so a transient network blip doesn't take the whole service down.
    this.conn.on('error', (err: Error) => this.logger.error({ err }, 'AMQP connection error'));
    this.ch = await this.conn.createChannel();

    await this.ch.assertExchange(EXCHANGES.DOMAIN_EVENTS, 'topic', { durable: true });
    await this.ch.assertExchange(NOTIFICATIONS_DLX, 'direct', { durable: true });

    for (const binding of EVENT_BINDINGS) {
      await this.ch.assertQueue(binding.queue, {
        durable: true,
        arguments: { 'x-dead-letter-exchange': NOTIFICATIONS_DLX },
      });
      await this.ch.bindQueue(binding.queue, EXCHANGES.DOMAIN_EVENTS, binding.routingKey);

      const dlq = `${binding.queue}.dlq`;
      await this.ch.assertQueue(dlq, { durable: true });
      await this.ch.bindQueue(dlq, NOTIFICATIONS_DLX, binding.routingKey);

      await this.ch.consume(
        binding.queue,
        (msg) => {
          if (!msg) return;
          this.onMessage(msg, binding).catch((err: Error) => {
            this.logger.error({ err, queue: binding.queue }, 'Unhandled error processing event — nacking without requeue');
            this.ch!.nack(msg, false, false);
          });
        },
        { noAck: false },
      );
    }

    this.logger.log('Notification event consumer connected and bound to domain.events');
  }

  private async onMessage(msg: amqplib.ConsumeMessage, binding: EventBinding): Promise<void> {
    const envelope = JSON.parse(msg.content.toString()) as MessageEnvelope;
    const retryCount = Number(msg.properties.headers?.['x-retry-count'] ?? 0);

    const result = await correlationStorage.run({ correlationId: envelope.correlationId }, () =>
      this.idempotentConsumer.handle(
        envelope,
        async (payload) => {
          const { userEmail, payload: notifPayload } = binding.toNotification(payload);
          await this.notifications.recordEvent(userEmail, binding.type, notifPayload);
        },
        { retryCount },
      ),
    );

    switch (result) {
      case 'ack':
        this.ch!.ack(msg);
        return;
      case 'nack':
        this.ch!.ack(msg);
        this.ch!.publish(EXCHANGES.DOMAIN_EVENTS, msg.fields.routingKey, msg.content, {
          ...msg.properties,
          headers: { ...msg.properties.headers, 'x-retry-count': retryCount + 1 },
        });
        return;
      case 'dlq':
        this.ch!.nack(msg, false, false);
        return;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.ch?.close();
      await this.conn?.close();
    } catch {
      // Ignore errors during shutdown
    }
  }
}
