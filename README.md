# notification-service

Persist-then-push notifications for the @demo platform: every notification is
written to MongoDB first (durable source of truth), then mirrored into a
Redis hot layer (unread counter + recent list) and fanned out over Redis
pub/sub for `ws-gateway` to push in real time.

## Architecture

- Owns the `notifications` MongoDB collection, keyed by `userEmail`.
- **Does not publish domain events.** It only *consumes* choreography events —
  it has no outbox rows of its own, so `OutboxPublisherService`'s change-stream
  watcher stays idle in this service; `OutboxModule` is imported solely for
  `IdempotentConsumerService` (dedup by `messageId`).
- Consumes from the `domain.events` RabbitMQ topic exchange via four
  dedicated queues (one per event), each with its own DLQ:

  | Routing key | Notification type |
  |---|---|
  | `order.confirmed` | `ORDER_CONFIRMED` |
  | `order.cancelled` | `ORDER_CANCELLED` |
  | `payment.succeeded` | `PAYMENT_SUCCEEDED` |
  | `payment.failed` | `PAYMENT_FAILED` |

  A handler failure is ack'd and republished with an incremented
  `x-retry-count` header (classic RabbitMQ queues don't expose a reliable
  delivery count); `IdempotentConsumerService` returning `dlq` nacks without
  requeue, which the queue's `x-dead-letter-exchange` routes to
  `<queue>.dlq`.

### Request flow

```
Recipient identified via JWT claims (Claims().email) — never a path param.

GET /notifications/unread-count  → NotificationsService → Redis only
GET /notifications               → NotificationsService → Mongo only (paginated)
POST /notifications/:id/read     → NotificationsService → Mongo update, then Redis DECR (floored at 0)
```

```
RabbitMQ domain.events (order/payment events)
         ↓
NotificationEventsConsumerService  (dedup via IdempotentConsumerService)
         ↓
NotificationsService.recordEvent
    1. NotificationsRepository.create   — Mongo, durable
    2. NotificationsRedisService.recordUnread  — INCR unread, LPUSH/LTRIM recent (cap 50)
    3. NotificationsRedisService.publish       — Redis pub/sub → ws-gateway
```

Order matters: Mongo is written first, Redis is derived from it, and the
pub/sub fan-out fires last — a subscriber can never observe a push before
the REST API/Mongo has the data. If a Redis unread key is missing (cold
start or `FLUSHALL`), it's rebuilt from Mongo on the next read instead of
returning a false zero.

### What this service owns

| Resource | Type | Notes |
|---|---|---|
| `notifications` | MongoDB collection | indexed on `userEmail`, `{userEmail, createdAt: -1}` |
| `notif:unread:{email}` | Redis string | unread counter, floored at 0 |
| `notif:recent:{email}` | Redis list | last 50 notifications, newest first |
| `notifications:{email}` | Redis pub/sub channel | consumed by `ws-gateway` |
| 4 queues on `domain.events` | RabbitMQ | order-confirmed/-cancelled, payment-succeeded/-failed, each with a `.dlq` |

### Auth

JWT verification (`JwtGuard`) is applied globally via `APP_GUARD`; opt out
per-route with `@Public()` (used by `/health` and `/metrics`). Tokens are
read in priority order: `cf-token` (Cloudflare) → `x-amzn-oidc-data` (ALB
OIDC) → standard `Authorization: Bearer`, then verified against Cognito's
JWKS. Set `AUTH_DISABLED=true` locally/in tests to bypass verification —
requests are treated as `x-test-user-email` (default `test@example.com`),
since every route derives its recipient from the JWT claims rather than a
path param.

In production, `/api` (Swagger) is blocked by the Envoy PEP sidecar's OPA
path allow-list.

---

## Running locally

### Prerequisites

```bash
# 1. Build the shared contracts package (provides DTOs + types)
cd ../contracts && npm install && npm run build && cd -

# 2. Install service dependencies
npm install

# 3. Copy env and start the Mongo + Redis + RabbitMQ compose stack
cp .env.example .env
docker compose -f ../platform-infra/docker-compose.yml up -d
```

### Start in dev mode

```bash
npm run start:dev
# Service listens on http://localhost:3000
# Swagger UI at    http://localhost:3000/api
```

### Build

```bash
npm run build
# Output in dist/
```

### Tests

```bash
# Unit tests (no external deps — repository/Redis are mocked)
npm test

# E2E tests (uses mongodb-memory-server — no compose required)
npm run test:e2e

# Outbox/consumer E2E tests — needs Redis + RabbitMQ running (Mongo is a
# throwaway single-node replica set spun up on port 27018 by the test itself,
# since change streams require a replica set):
docker compose -f ../platform-infra/docker-compose.yml up -d redis rabbitmq
npm run test:outbox
```

### Generate openapi.yaml

```bash
# MongoDB must be reachable at MONGO_URI
npm run generate:openapi
```

The script's default URI (`...?replicaSet=rs0`) matches the compose stack's
mongo. If your local mongod on 27017 is a plain standalone instead, the driver
will block on topology discovery — override it for the run:

```bash
MONGO_URI='mongodb://localhost:27017/notifications' npm run generate:openapi
```

The emitted spec is derived from Swagger decorators, so anything undecorated is
silently absent. Response bodies come from the classes in
[src/notifications/dto/notification.response.ts](src/notifications/dto/notification.response.ts):
the contract types in `@demo/contracts` are TypeScript interfaces that erase at
compile time, so each one has a companion class that `implements` it and carries
the `@ApiProperty` decorations. The interface stays the source of truth — the
class only adds the Swagger layer, and `implements` makes the compiler catch any
drift between the two.

Two specs coexist, deliberately:

| Spec | Role |
|---|---|
| `../contracts/openapi/notification-service.yaml` | hand-authored **design** contract; the only input to the contracts client generator (`generate-clients.ts` reads `contracts/openapi/`, never this service's file) |
| `./openapi.yaml` | generated **as-built** view of what the code actually serves |

They should agree. Schema *names* differ by suffix (`NotificationResponse` here
vs `Notification` there) because the generated names come from the class names;
since nothing downstream consumes this file, that divergence is cosmetic.

### curl round-trip

```bash
BASE=http://localhost:3000
AUTH='-H x-test-user-email:alice@example.com'   # requires AUTH_DISABLED=true

# Unread count
curl -s $AUTH $BASE/notifications/unread-count | jq

# List (paginated)
curl -s $AUTH "$BASE/notifications?page=1&limit=20" | jq

# Mark as read
curl -s $AUTH -X POST $BASE/notifications/<id>/read -o /dev/null -w "%{http_code}\n"
```

### Triggering a notification end-to-end

Notifications are created by consuming domain events, not via a direct
write endpoint. Publish an event onto `domain.events` with a matching
routing key (e.g. `order.confirmed`) and a body shaped like
`{ userId, orderId, sagaId }` — `order-service` does this naturally when an
order flow reaches that state. To check delivery:

**1. Check MongoDB**

```bash
mongosh "mongodb://localhost:27017/notifications?replicaSet=rs0&directConnection=true" \
  --eval 'db.notifications.find({}, {userEmail:1, type:1, read:1, createdAt:1}).sort({createdAt:-1}).limit(5).pretty()'
```

**2. Check Redis**

```bash
redis-cli GET notif:unread:alice@example.com
redis-cli LRANGE notif:recent:alice@example.com 0 -1
```

**3. Check the service logs**

If you see `Notification event consumer disabled via OUTBOX_PUBLISHER_ENABLED`
on startup, set `OUTBOX_PUBLISHER_ENABLED=true` in `.env` (this flag also
gates the RabbitMQ consumer, not just an outbox publisher).

---

## Configuration

See [.env.example](.env.example) for the full list. Notable ones:

| Var | Purpose |
|---|---|
| `MONGO_URI` | must point at a replica set — required for Mongoose transactions/change streams used elsewhere in the stack |
| `RABBITMQ_URL` | connection for the four choreography consumers |
| `REDIS_URL` | unread counter, recent list, pub/sub |
| `AUTH_DISABLED` | bypass Cognito JWT verification (local/test only) |
| `OUTBOX_PUBLISHER_ENABLED` | gates the RabbitMQ event consumer startup (default `true`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | blank = spans print to stdout via `ConsoleSpanExporter` |

## Deployment

Built via the multi-stage [Dockerfile](Dockerfile) (build context is the
`backend/` repo root, since it also compiles the `@demo/contracts` package).
Deployed with the Helm chart in [helm/](helm/), layered on `base-service`
with an Envoy PEP sidecar in front (OPA `ext_authz`, `failure_mode_allow:
false`). CI (`.github/workflows/ci.yml`) delegates to
`platform-infra`'s reusable `service-ci.yml`.
