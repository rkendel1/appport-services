# Notifications

## Primitive

Notifications are durable application events routed through one or more delivery channels.

An application says *what happened* and *who should hear about it*. AppPort Services persists the
notification, routes it to channels, tracks every delivery attempt, retries failures, and records
read and acknowledgement state. Every one of those facts is durable FeltDB state.

## Separation of concerns

```
Application       = meaning      ("the healthcare application status changed")
AppPort Services  = delivery     ("deliver this through browser + email")
FeltDB            = durable state and evidence
Attn              = attention and judgment ("how much attention does this deserve?")
```

AppPort Services never interprets a notification's `type`. `monitor.triggered`,
`quote.status_changed`, `deployment.failed`, `appointment.available`, and
`support.ticket_changed` are all opaque to it. There is no monitor-specific, healthcare-specific, or
Attn-specific notification code in this package; producers are consumers of one primitive.

## Example

```
monitor.triggered
        │
        ▼
AppPort Notification  (durable, one record)
        │
┌───────┼────────┐
▼       ▼        ▼
Browser Email   Attn
```

```ts
const { notification, deliveries, created } = await app.notifications.notify({
  tenantId: 'tenant-a',
  recipient: 'user-1',
  type: 'monitor.triggered',
  title: 'Status changed',
  body: 'The healthcare application status changed.',
  data: { status: 'degraded' },
  source: { type: 'monitor', id: 'monitor-7', eventId: 'observation-123' },
  channels: ['browser', 'in-app'],
  expiresAt: '2026-09-22T13:00:00.000Z',
}, principal);
```

The monitor decides the condition was satisfied. The browser is only a delivery channel: it never
evaluates monitor conditions, never becomes the source of truth, and keeps no notification state of
its own.

## Resources

### Notification

| Field | Meaning |
| --- | --- |
| `id` | Notification identity. Deterministic when an idempotency key applies. |
| `tenantId` | Ownership boundary. Every read and write is checked against it. |
| `recipient` | Principal the notification is addressed to. |
| `type` | Producer-defined semantic event type. |
| `title`, `body` | Human-readable content. |
| `data` | Structured application data (JSON object, 64 KiB max). |
| `source` | Provenance reference: `{ type, id?, eventId? }`. |
| `channels` | Channels requested at creation. |
| `status` | `pending` · `delivered` · `failed` · `read` · `acknowledged` · `expired` |
| `idempotencyKey` | Logical identity used to collapse producer retries. |
| `createdAt`, `createdBy`, `expiresAt` | Creation facts. |
| `deliveredAt`, `failedAt`, `expiredAt`, `readAt`, `acknowledgedAt`, `dismissedAt` | Lifecycle timestamps. |

### Notification delivery

One record per `notificationId + channel`. Channel state never overwrites notification state.

| Field | Meaning |
| --- | --- |
| `channel` | Channel type, for example `browser`. |
| `status` | `pending` · `delivered` · `failed` · `retrying` |
| `idempotencyKey` | `<notificationId>:<channel>`; forwarded to channels that de-duplicate. |
| `attemptCount`, `maxAttempts` | Attempt budget. |
| `lastAttemptAt`, `nextAttemptAt` | Retry timing. |
| `deliveredAt`, `failedAt`, `failureReason`, `externalId` | Outcome. |

A notification can be `delivered` while its email delivery is `failed` and its webhook delivery is
`retrying`. The notification is `delivered` once any channel delivers; it is `failed` only when every
channel has failed permanently.

## Lifecycle

```
Notification:  pending ──► delivered ──► read ──► acknowledged
                  │            ▲
                  ▼            │ (a later retry succeeds)
                failed ────────┘
   pending / delivered / failed ──► expired   (once expiresAt passes)

Delivery:      pending ──► delivered
                  │
                  ▼
               retrying ──► delivered
                  │
                  ▼
                failed ──(retryDelivery)──► retrying
```

**Read is not acknowledgement.** `read` records that the recipient has seen the notification.
`acknowledge` records that they have acted on it (and sets `readAt` if it was missing). Attn relies
on the difference.

## HTTP API

The router uses the host's existing authentication (`req.auth`, an `AuthenticatedPrincipal`); there
is no notification-specific authentication. Mounted by `createNotificationRouter(service)`, and by
the AppPort runtime under `/_appport/notifications`.

| Method | Path | Result |
| --- | --- | --- |
| `POST` | `/notifications` | `{ notification, deliveries }`, `201` when created, `200` when an idempotent replay |
| `GET` | `/notifications` | `{ items, nextCursor? }` |
| `GET` | `/notifications/:id` | Notification |
| `GET` | `/notifications/:id/deliveries` | `{ items }` |
| `POST` | `/notifications/:id/read` | Notification |
| `POST` | `/notifications/:id/acknowledge` | Notification |
| `POST` | `/notifications/:id/dismiss` | Notification |
| `POST` | `/notifications/:id/deliveries/:channel/retry` | Delivery (`notifications.admin`) |
| `DELETE` | `/notifications/:id` | `204` |

List query parameters: `recipient`, `status`, `type`, `priority`, `sourceType`, `createdAfter`,
`createdBefore`, `unread=true`, `unacknowledged=true`, `cursor`, `limit` (1–100, default 50).

Errors: `400` validation or credential content, `403` authorization, `404` not found.

## Idempotency

Creation is idempotent. The key is `idempotencyKey` when supplied, otherwise
`source.type:source.eventId:type` when `source.eventId` is present. The notification id is derived
from `tenantId + recipient + key`, and the notification and its delivery records are committed in
one FeltDB transaction that requires the id to be absent. A repeated request for the same logical
event returns the existing notification with `created: false`, whether it comes from a scheduled
job, a retry, a browser reconnect, a service restart, an agent retry, or a webhook retry.

Delivery is idempotent too. A delivery's identity is `notificationId + channel`. Each attempt first
claims the delivery with a version-checked write, so concurrent workers cannot both attempt it, and
a delivered or permanently failed delivery is never attempted again. Channels that support
de-duplication receive `delivery.idempotencyKey`; the browser channel includes it in its message
for use as the browser notification tag, so a repeated push replaces rather than duplicates.

## Retry

Retries run on the existing AppPort job infrastructure (`JobService`), not a separate scheduler.
When a channel throws or returns a retryable failure, the delivery moves to `retrying` with
exponential backoff (`nextAttemptAt`), and a system job of type `appport.notifications.deliver` is
scheduled for that time. The job reads the delivery from durable state, so a restarted worker
resumes where the last one stopped. Job types under the `appport.` prefix are reserved: application
code cannot enqueue or register them.

Without the jobs capability, a failed delivery stays `failed` until an operator calls
`retryDelivery`. `recoverDeliveries(tenantId)` re-attempts deliveries that were committed but never
attempted (for example, when a process stopped between commit and first attempt); the AppPort
runtime calls it for the default tenant in `start()`.

A failed delivery never removes or invalidates the notification.

## Expiration

`expiresAt` bounds a notification's useful lifetime, for example "Appointment slot available". Once
it passes, no channel is newly attempted: pending and retrying deliveries fail with
`failureReason: "notification_expired"` and the notification becomes `expired`. The record itself
is kept as evidence of what happened and when.

## Channels

```ts
interface NotificationChannel {
  readonly type: string;
  deliver(notification: Notification, delivery: NotificationDelivery): Promise<NotificationDeliveryResult>;
}
```

An adapter receives the authoritative notification and returns
`{ status: 'delivered', externalId? }` or `{ status: 'failed', reason, retryable? }`. A thrown error
is a retryable failure. Adapters do not persist notification state.

Built in:

- `in-app`: the durable inbox. A committed notification is available through the API, so delivery
  is immediate.
- `browser`: pushes a pointer message (`BROWSER_NOTIFICATION_EVENT`, `appport.notification`) onto
  the AppPort event stream (`/_appport/events`) that browsers and extensions subscribe to. The message
  carries ids, the recipient, the type, and the idempotency key, but no title, body, or data. The
  browser fetches content through the authorized API, so a shared stream never exposes one
  recipient's notification to another.

Email, mobile push, SMS, and webhook are adapters that you register independently, with no change to
application event models:

```ts
app.notifications.registerChannel({
  type: 'email',
  async deliver(notification, delivery) {
    await mailer.send({ to: lookup(notification.recipient), subject: notification.title, idempotencyKey: delivery.idempotencyKey });
    return { status: 'delivered' };
  },
});
```

Channels are registered by the host in code, so configuring a channel requires the authority to
deploy the host. No API lets a principal add or reconfigure a channel or destination.

**Closing a browser does not destroy notifications.** The browser is one delivery channel. The
notification, its read and acknowledgement state, and every delivery record live in FeltDB. A new
browser session, another device, or a restarted extension catches up with
`GET /notifications?unread=true`.

## Authorization

Notification operations use the existing principal and scope model (`AuthenticatedPrincipal`):

| Operation | Requirement |
| --- | --- |
| Create | Same tenant and `notifications.create` |
| Get, list, deliveries | Same tenant and `notifications.read`, and recipient is the principal, unless it holds `notifications.read:any` |
| Read, acknowledge, dismiss | Same tenant and `notifications.write`, and recipient is the principal, unless it holds `notifications.admin` |
| Delete | Same tenant and `notifications.delete`, and recipient is the principal, unless it holds `notifications.admin` |
| Retry a delivery | Same tenant and `notifications.admin` |

`notifications.read:any` grants reading only. Acknowledgement requires authority over the
notification itself. A missing, empty, or malformed principal is rejected (fail closed). There is no
environment-variable bypass.

## Tenant isolation

Every notification and delivery record carries `tenantId`, and every store read checks it. Tenant
comes from the authenticated principal, never from process memory, a current-user global, or
browser-local state. Idempotency ids include the tenant, so identical events in two tenants never
collide.

## Sensitive data boundary

Infrastructure credentials cannot enter notifications. `title`, `body`, `data`, `source`, and the
idempotency key are checked before anything is persisted, and a request is **rejected**
(`NotificationSensitiveDataError`, HTTP 400) when it contains:

- credential-named keys at any depth, for example `password`, `cookie`/`cookies`, `session_id`,
  `authorization`, `refresh_token`, `access_token`, `api_key`, `client_secret`, `private_key`,
  `signing_secret`, or any key ending in `password`, `token`, `secret`, `apikey`, `cookie`, or
  `credentials`;
- credential-shaped values anywhere: `Bearer …` and `Basic …` authorization values, PEM private
  keys, JWTs, AppPort API keys, common provider tokens, and session-cookie fragments.

Content is rejected, not silently scrubbed. The error names the offending path but never echoes the
value. Channel failure reasons are also checked before they are stored. Monitoring integrations can
rely on this: browser authentication material cannot become notification data, and the test suite
verifies it.

## Provenance

The chain is `Source Event → Notification → Delivery`. A notification references its origin with
`source` (`type`, `id`, `eventId`) and does not copy the source record. For monitoring, that chain is
`Monitor → Observation → Condition evaluation → MonitorTriggered → Notification → Delivery`, and
"why did I receive this?" is answered by following `source`. Each creation, delivery outcome, read,
acknowledgement, and expiry is also written to `notification_audit_events`.

## Configuration

```toml
use notifications
use jobs            # enables durable delivery retries

[notifications]
default_channel = "in-app"   # or "browser"
default_priority = "normal"

[notifications.delivery]
max_attempts = 5
```

## Preferences

AppPort Services does not yet have a principal or user preference resource, so this change adds no
notification preference model. When one exists, notification preferences (enabled channels,
channel-specific settings, quiet hours) belong on it. Importance ("healthcare matters more than
shopping") will never live here; it belongs to the application and to Attn.
