import { ApiProperty } from '@nestjs/swagger';
import type {
  Notification,
  NotificationPage,
  NotificationType,
  UnreadCountResponse as UnreadCountContract,
} from '@demo/contracts';

// Runtime mirror of the contract's NotificationType union, which is a pure
// type and so has no values to enumerate at runtime. The `satisfies` clause
// makes this object fail to compile if the union gains or loses a member,
// so the Swagger enum can never silently drift from the type.
const NOTIFICATION_TYPE_VALUES = {
  ORDER_CONFIRMED: true,
  ORDER_CANCELLED: true,
  PAYMENT_SUCCEEDED: true,
  PAYMENT_FAILED: true,
} satisfies Record<NotificationType, true>;

const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_TYPE_VALUES) as NotificationType[];

// Implements the contract interface — the interface is the source of truth;
// these classes only add the Swagger decoration layer. They are never
// instantiated: their sole job is to give SwaggerModule real response schemas
// to emit, since the contract types erase at compile time.
export class NotificationResponse implements Notification {
  @ApiProperty({ example: '665f1c0e5b1a4c0012a3b4c5' })
  id!: string;

  @ApiProperty({
    format: 'email',
    example: 'alice@example.com',
    description: 'Recipient — the durable Mongo field name',
  })
  userEmail!: string;

  @ApiProperty({ enum: NOTIFICATION_TYPES, example: 'ORDER_CONFIRMED' })
  type!: NotificationType;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { orderId: 'ord_123', sagaId: 'saga_456' },
    description: 'Event-specific data, shaped by the consumed event (orderId, reason, …)',
  })
  payload!: Record<string, unknown>;

  @ApiProperty({
    example: false,
    description:
      'Per-notification read state — Mongo is the source of truth; Redis holds only the aggregate unread count',
  })
  read!: boolean;

  @ApiProperty({ format: 'date-time', example: '2026-08-19T12:34:56.000Z' })
  createdAt!: string;
}

export class NotificationPageResponse implements NotificationPage {
  @ApiProperty({ type: [NotificationResponse] })
  data!: NotificationResponse[];

  // type: 'integer' is explicit throughout — TS `number` would otherwise emit
  // `type: number`, which is wider than the design contract in
  // ../contracts/openapi/notification-service.yaml.
  @ApiProperty({ type: 'integer', example: 137, description: 'Total notifications for this user across all pages' })
  total!: number;

  @ApiProperty({ type: 'integer', example: 1 })
  page!: number;

  @ApiProperty({ type: 'integer', example: 20 })
  limit!: number;
}

export class UnreadCountResponse implements UnreadCountContract {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    example: 3,
    description: 'Served from the Redis counter, rebuilt from Mongo on a cache miss',
  })
  count!: number;
}
