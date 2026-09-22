import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { Job } from '../jobs/models.js';
import type { JobService } from '../jobs/service.js';
import type { NotificationAuditSink, NotificationDeliveryStore, NotificationStore } from '../storage/notifications.js';
import { InAppNotificationChannel, NotificationChannelRegistry, type NotificationChannel, type NotificationDeliveryResult } from './channels.js';
import type {
  CreateNotificationInput, Notification, NotificationAuditType, NotificationDelivery, NotificationListOptions,
  NotificationPage, NotificationPriority, NotificationResult, NotificationSource, NotificationStatus,
} from './models.js';
import { assertNoCredentials, isSensitiveValue, NotificationSensitiveDataError } from './sensitive.js';

export class NotificationAuthorizationError extends Error {
  constructor() { super('Notification operation is not authorized'); this.name = 'NotificationAuthorizationError'; }
}
export class NotificationValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'NotificationValidationError'; }
}
export class NotificationNotFoundError extends Error {
  constructor() { super('Notification not found'); this.name = 'NotificationNotFoundError'; }
}
export { NotificationSensitiveDataError };

/** AppPort-owned job type that carries delivery retries on the existing job infrastructure. */
export const NOTIFICATION_DELIVERY_JOB = 'appport.notifications.deliver';

const DEFAULT_MAX_DELIVERY_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1_000;
const ATTEMPT_LEASE_MS = 30_000;
const MAX_DATA_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 4_096;
const PRIORITIES: readonly NotificationPriority[] = ['low', 'normal', 'high', 'urgent'];
const STATUSES: readonly NotificationStatus[] = ['pending', 'delivered', 'failed', 'read', 'acknowledged', 'expired'];
const INPUT_FIELDS = new Set(['tenantId', 'recipient', 'type', 'title', 'body', 'data', 'source', 'priority', 'channels', 'channel', 'idempotencyKey', 'expiresAt']);

export interface NotificationServiceOptions {
  readonly store: NotificationStore;
  readonly deliveryStore: NotificationDeliveryStore;
  readonly auditSink: NotificationAuditSink;
  /** Registered delivery channels. Defaults to the durable in-app inbox only. */
  readonly channels?: NotificationChannelRegistry | readonly NotificationChannel[];
  /** Channels used when a request names none. Defaults to `['in-app']`. */
  readonly defaultChannels?: readonly string[];
  readonly defaultPriority?: NotificationPriority;
  /**
   * Existing AppPort job service. When present, failed deliveries are retried
   * through it; when absent, a failed delivery stays failed until retried
   * explicitly with retryDelivery().
   */
  readonly jobs?: JobService;
  readonly maxDeliveryAttempts?: number;
  readonly retryDelayMs?: number;
  /** Attempt first delivery during notify(). When false, first attempts are queued as jobs. Defaults to true. */
  readonly deliverInline?: boolean;
  readonly now?: () => Date;
}

type AttemptMode = 'initial' | 'scheduled' | 'manual';

export class NotificationService {
  private readonly now: () => Date;
  private readonly channels: NotificationChannelRegistry;
  private readonly defaultChannels: readonly string[];
  private readonly maxDeliveryAttempts: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: NotificationServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.channels = options.channels instanceof NotificationChannelRegistry
      ? options.channels
      : new NotificationChannelRegistry(options.channels ?? [new InAppNotificationChannel()]);
    this.defaultChannels = options.defaultChannels ?? ['in-app'];
    this.maxDeliveryAttempts = options.maxDeliveryAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    options.jobs?.registerSystem(NOTIFICATION_DELIVERY_JOB, (job) => this.runDeliveryJob(job));
  }

  /** Register an additional delivery channel adapter. */
  registerChannel(channel: NotificationChannel): void { this.channels.register(channel); }
  channelTypes(): readonly string[] { return this.channels.types(); }

  /**
   * Create a durable notification and route it to its channels.
   *
   * Idempotent: the same idempotency key (explicit, or derived from
   * `source.type + source.eventId + type`) for the same recipient resolves to
   * the same notification, and never creates a second one.
   */
  async notify(input: CreateNotificationInput, principal: AuthenticatedPrincipal): Promise<NotificationResult> {
    this.authorizeTenant(principal, input?.tenantId, 'notifications.create');
    const normalized = this.normalizeInput(input);
    const createdAt = this.now().toISOString();
    if (normalized.expiresAt && normalized.expiresAt <= createdAt) throw new NotificationValidationError('expiresAt must be in the future');

    const id = normalized.idempotencyKey ? stableUuid('notification', normalized.tenantId, normalized.recipient, normalized.idempotencyKey) : randomUUID();
    const notification: Notification = {
      ...normalized, id, status: 'pending', createdAt, createdBy: principal.principalId, __version: 1,
    };
    const deliveries = notification.channels.map((channel): NotificationDelivery => ({
      id: stableUuid('delivery', id, channel),
      tenantId: notification.tenantId,
      notificationId: id,
      recipient: notification.recipient,
      channel,
      status: 'pending',
      idempotencyKey: `${id}:${channel}`,
      attemptCount: 0,
      maxAttempts: this.maxDeliveryAttempts,
      createdAt,
      __version: 1,
    }));

    const created = await this.options.store.createWithDeliveries(notification, deliveries);
    if (created) await this.audit('notification.created', notification, principal.principalId);
    else {
      const existing = await this.options.store.get(notification.tenantId, id);
      if (!existing) throw new NotificationAuthorizationError();
    }
    // Replays resume deliveries that never got a first attempt (for example after a crash).
    await this.dispatchPending(notification.tenantId, id);
    const [current, currentDeliveries] = await Promise.all([
      this.options.store.get(notification.tenantId, id),
      this.options.deliveryStore.list(notification.tenantId, id),
    ]);
    return { notification: this.view(current!), deliveries: sortDeliveries(currentDeliveries), created };
  }

  /** Create a notification and return only the notification. See notify(). */
  async create(input: CreateNotificationInput, principal: AuthenticatedPrincipal): Promise<Notification> {
    return (await this.notify(input, principal)).notification;
  }

  async get(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<Notification> {
    this.authorizeTenant(principal, tenantId, 'notifications.read');
    const item = await this.options.store.get(tenantId, id);
    if (!item) throw new NotificationNotFoundError();
    this.authorizeRead(principal, item);
    return this.view(item);
  }

  async list(tenantId: string, options: NotificationListOptions = {}, principal: AuthenticatedPrincipal): Promise<NotificationPage> {
    this.authorizeTenant(principal, tenantId, 'notifications.read');
    const readsAny = hasScope(principal, 'notifications.read:any');
    if (options.recipient && options.recipient !== principal.principalId && !readsAny) throw new NotificationAuthorizationError();
    if (options.status && !STATUSES.includes(options.status)) throw new NotificationValidationError('Invalid status');
    const limit = Math.min(Math.max(Number.isFinite(options.limit) ? Number(options.limit) : 50, 1), 100);
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    const recipient = readsAny ? options.recipient : principal.principalId;
    const items = (await this.options.store.list(tenantId))
      .map((item) => this.view(item))
      .filter((item) =>
        (!recipient || item.recipient === recipient) &&
        (!options.unread || !item.readAt) &&
        (!options.unacknowledged || !item.acknowledgedAt) &&
        (!options.status || item.status === options.status) &&
        (!options.type || item.type === options.type) &&
        (!options.priority || item.priority === options.priority) &&
        (!options.sourceType || item.source?.type === options.sourceType) &&
        (!options.createdAfter || item.createdAt > options.createdAfter) &&
        (!options.createdBefore || item.createdAt < options.createdBefore) &&
        (!cursor || afterCursor(item, cursor)),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const page = items.slice(0, limit);
    return { items: page, ...(items.length > limit ? { nextCursor: encodeCursor(page.at(-1)!) } : {}) };
  }

  /** Record that the recipient has seen the notification. Does not acknowledge it. */
  async markRead(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<Notification> {
    return this.mutate('notification.read', tenantId, id, principal, (item, now) =>
      item.readAt ? null : { readAt: now, ...(item.status === 'acknowledged' ? {} : { status: 'read' as const }) });
  }

  /** Record that the recipient has acted on the notification. Implies read. */
  async acknowledge(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<Notification> {
    return this.mutate('notification.acknowledged', tenantId, id, principal, (item, now) =>
      item.acknowledgedAt ? null : { acknowledgedAt: now, readAt: item.readAt ?? now, status: 'acknowledged' });
  }

  async dismiss(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<Notification> {
    return this.mutate('notification.dismissed', tenantId, id, principal, (item, now) => item.dismissedAt ? null : { dismissedAt: now });
  }

  async delete(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<void> {
    this.authorizeTenant(principal, tenantId, 'notifications.delete');
    const item = await this.options.store.get(tenantId, id);
    if (!item) return;
    this.authorizeOwner(principal, item);
    await this.options.store.delete(id);
    await this.audit('notification.deleted', item, principal.principalId);
  }

  async deliveries(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<readonly NotificationDelivery[]> {
    const item = await this.get(tenantId, id, principal);
    return sortDeliveries(await this.options.deliveryStore.list(item.tenantId, item.id));
  }

  /**
   * Retry a failed delivery for one channel. Moves the delivery from `failed`
   * to `retrying` with a fresh attempt budget; requires `notifications.admin`.
   */
  async retryDelivery(tenantId: string, id: string, channel: string, principal: AuthenticatedPrincipal): Promise<NotificationDelivery> {
    this.authorizeTenant(principal, tenantId, 'notifications.admin');
    const item = await this.options.store.get(tenantId, id);
    if (!item) throw new NotificationNotFoundError();
    const delivery = await this.options.deliveryStore.get(tenantId, stableUuid('delivery', id, channel));
    if (!delivery) throw new NotificationNotFoundError();
    if (delivery.status !== 'failed') return delivery;
    const now = this.now().toISOString();
    const retrying = await this.options.deliveryStore.update(tenantId, delivery.id, delivery.__version, {
      status: 'retrying', maxAttempts: delivery.attemptCount + this.maxDeliveryAttempts, nextAttemptAt: now, failedAt: undefined,
    });
    if (!retrying) return (await this.options.deliveryStore.get(tenantId, delivery.id))!;
    await this.audit('notification.delivery.retrying', item, principal.principalId, retrying);
    if (this.options.jobs) await this.scheduleAttempt(retrying, now);
    else await this.attemptDelivery(tenantId, retrying.id, 'manual');
    return (await this.options.deliveryStore.get(tenantId, delivery.id))!;
  }

  /**
   * Resume deliveries that were persisted but never attempted, for example
   * after a process restart. Safe to run repeatedly and from several workers.
   */
  async recoverDeliveries(tenantId: string): Promise<number> {
    // An attempt claimed within the lease window may still be in flight elsewhere.
    const leaseCutoff = new Date(this.now().getTime() - ATTEMPT_LEASE_MS).toISOString();
    const pending = (await this.options.deliveryStore.list(tenantId))
      .filter((delivery) => delivery.status === 'pending' && (!delivery.lastAttemptAt || delivery.lastAttemptAt <= leaseCutoff));
    await Promise.all(pending.map((delivery) => this.dispatch(delivery)));
    return pending.length;
  }

  private async dispatchPending(tenantId: string, notificationId: string): Promise<void> {
    const pending = (await this.options.deliveryStore.list(tenantId, notificationId)).filter((delivery) => delivery.status === 'pending' && delivery.attemptCount === 0);
    // Channels are isolated: one channel's failure never blocks or fails another.
    await Promise.all(pending.map((delivery) => this.dispatch(delivery)));
  }

  private async dispatch(delivery: NotificationDelivery): Promise<void> {
    if (this.options.deliverInline === false && this.options.jobs) await this.scheduleAttempt(delivery, this.now().toISOString());
    else await this.attemptDelivery(delivery.tenantId, delivery.id, 'initial').catch(() => undefined);
  }

  private async runDeliveryJob(job: Job): Promise<void> {
    const payload = job.payload as { deliveryId?: unknown } | null;
    if (!payload || typeof payload.deliveryId !== 'string') throw new NotificationValidationError('Delivery job payload is invalid');
    await this.attemptDelivery(job.tenantId, payload.deliveryId, 'scheduled');
  }

  private async scheduleAttempt(delivery: NotificationDelivery, runAt: string): Promise<void> {
    await this.options.jobs!.enqueueSystem({ tenantId: delivery.tenantId, type: NOTIFICATION_DELIVERY_JOB, payload: { deliveryId: delivery.id }, runAt, maxAttempts: 3 });
  }

  /** Make one delivery attempt. Every outcome is written durably before returning. */
  private async attemptDelivery(tenantId: string, deliveryId: string, mode: AttemptMode): Promise<NotificationDelivery | null> {
    const delivery = await this.options.deliveryStore.get(tenantId, deliveryId);
    if (!delivery || delivery.status === 'delivered' || delivery.status === 'failed') return delivery;
    const nowDate = this.now();
    const now = nowDate.toISOString();
    // A duplicate or early job must not attempt ahead of the recorded retry time.
    if (mode === 'scheduled' && delivery.status === 'retrying' && delivery.nextAttemptAt && delivery.nextAttemptAt > now) return delivery;

    const notification = await this.options.store.get(tenantId, delivery.notificationId);
    if (!notification) return this.finishDelivery(delivery, null, { status: 'failed', reason: 'notification_deleted', retryable: false });
    if (notification.expiresAt && notification.expiresAt <= now) {
      const failed = await this.finishDelivery(delivery, notification, { status: 'failed', reason: 'notification_expired', retryable: false });
      await this.transitionNotification(tenantId, notification.id, (item) =>
        ['pending', 'delivered', 'failed'].includes(item.status) ? { status: 'expired', expiredAt: now } : null, 'notification.expired');
      return failed;
    }
    const channel = this.channels.get(delivery.channel);
    if (!channel) return this.finishDelivery(delivery, notification, { status: 'failed', reason: 'channel_unavailable', retryable: false });

    // Claim the attempt; a concurrent attempt on the same delivery loses here.
    const claimed = await this.options.deliveryStore.update(tenantId, delivery.id, delivery.__version, { attemptCount: delivery.attemptCount + 1, lastAttemptAt: now });
    if (!claimed) return this.options.deliveryStore.get(tenantId, delivery.id);

    let result: NotificationDeliveryResult;
    try {
      result = await channel.deliver(this.view(notification), claimed);
    } catch (error) {
      result = { status: 'failed', reason: error instanceof Error ? error.message : String(error), retryable: true };
    }
    return this.finishDelivery(claimed, notification, result);
  }

  private async finishDelivery(delivery: NotificationDelivery, notification: Notification | null, result: NotificationDeliveryResult): Promise<NotificationDelivery | null> {
    const now = this.now().toISOString();
    let updates: Partial<NotificationDelivery>;
    let audit: NotificationAuditType;
    if (result.status === 'delivered') {
      updates = { status: 'delivered', deliveredAt: now, nextAttemptAt: undefined, failureReason: undefined, ...(result.externalId ? { externalId: result.externalId } : {}) };
      audit = 'notification.delivery.delivered';
    } else {
      const failureReason = safeReason(result.reason);
      const canRetry = result.retryable !== false && this.options.jobs !== undefined && delivery.attemptCount < delivery.maxAttempts;
      if (canRetry) {
        const delay = Math.min(this.retryDelayMs * 2 ** Math.max(delivery.attemptCount - 1, 0), MAX_RETRY_DELAY_MS);
        updates = { status: 'retrying', failureReason, nextAttemptAt: new Date(this.now().getTime() + delay).toISOString() };
        audit = 'notification.delivery.retrying';
      } else {
        updates = { status: 'failed', failureReason, failedAt: now, nextAttemptAt: undefined };
        audit = 'notification.delivery.failed';
      }
    }
    const updated = await this.options.deliveryStore.update(delivery.tenantId, delivery.id, delivery.__version, updates);
    if (!updated) return this.options.deliveryStore.get(delivery.tenantId, delivery.id);
    if (updated.status === 'retrying') await this.scheduleAttempt(updated, updated.nextAttemptAt!);
    if (notification) {
      await this.audit(audit, notification, 'system', updated);
      await this.refreshStatus(notification.tenantId, notification.id);
    }
    return updated;
  }

  /** Summarize channel outcomes onto the notification without overriding read/ack/expiry. */
  private async refreshStatus(tenantId: string, id: string): Promise<void> {
    const deliveries = await this.options.deliveryStore.list(tenantId, id);
    const now = this.now().toISOString();
    await this.transitionNotification(tenantId, id, (item) => {
      if (item.status !== 'pending' && item.status !== 'failed') return null;
      if (deliveries.some((delivery) => delivery.status === 'delivered')) return { status: 'delivered', deliveredAt: now, failedAt: undefined };
      if (item.status === 'pending' && deliveries.length > 0 && deliveries.every((delivery) => delivery.status === 'failed')) return { status: 'failed', failedAt: now };
      return null;
    });
  }

  private async transitionNotification(tenantId: string, id: string, change: (item: Notification) => Partial<Notification> | null, audit?: NotificationAuditType): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const item = await this.options.store.get(tenantId, id);
      if (!item) return;
      const updates = change(item);
      if (!updates) return;
      const updated = await this.options.store.update(item.id, item.__version, updates);
      if (updated) {
        if (audit) await this.audit(audit, updated, 'system');
        return;
      }
    }
  }

  private async mutate(
    type: 'notification.read' | 'notification.acknowledged' | 'notification.dismissed',
    tenantId: string, id: string, principal: AuthenticatedPrincipal,
    change: (item: Notification, now: string) => Partial<Notification> | null,
  ): Promise<Notification> {
    this.authorizeTenant(principal, tenantId, 'notifications.write');
    for (let attempt = 0; attempt < 5; attempt++) {
      const item = await this.options.store.get(tenantId, id);
      if (!item) throw new NotificationNotFoundError();
      this.authorizeOwner(principal, item);
      const updates = change(item, this.now().toISOString());
      if (!updates) return this.view(item);
      const updated = await this.options.store.update(item.id, item.__version, updates);
      if (updated) {
        await this.audit(type, updated, principal.principalId);
        return this.view(updated);
      }
    }
    throw new NotificationValidationError('Notification was modified concurrently');
  }

  /** Present the effective lifecycle state: an unread notification past expiresAt is expired. */
  private view(item: Notification): Notification {
    const legacy = item as Partial<Notification> & Notification;
    const status: NotificationStatus = legacy.status ?? (legacy.acknowledgedAt ? 'acknowledged' : legacy.readAt ? 'read' : 'pending');
    const channels = legacy.channels ?? [];
    const expired = item.expiresAt !== undefined && item.expiresAt <= this.now().toISOString() && ['pending', 'delivered', 'failed'].includes(status);
    return { ...item, channels, status: expired ? 'expired' : status };
  }

  private normalizeInput(input: CreateNotificationInput): Omit<Notification, 'id' | 'status' | 'createdAt' | 'createdBy' | '__version'> {
    if (!input || typeof input !== 'object') throw new NotificationValidationError('Notification input is required');
    for (const key of Object.keys(input)) if (!INPUT_FIELDS.has(key)) throw new NotificationValidationError(`Unknown field: ${key}`);
    const recipient = requiredText(input.recipient, 'recipient', 256);
    const type = requiredText(input.type, 'type', 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(type)) throw new NotificationValidationError('type must contain only letters, digits, ".", "_", ":", or "-"');
    const title = requiredText(input.title, 'title', MAX_TEXT_LENGTH);
    if (input.body !== undefined && typeof input.body !== 'string') throw new NotificationValidationError('body must be a string');
    if (input.body !== undefined && input.body.length > MAX_TEXT_LENGTH * 4) throw new NotificationValidationError('body is too long');
    if (input.data !== undefined && (!input.data || typeof input.data !== 'object' || Array.isArray(input.data))) throw new NotificationValidationError('data must be an object');
    if (input.data !== undefined && Buffer.byteLength(JSON.stringify(input.data), 'utf8') > MAX_DATA_BYTES) throw new NotificationValidationError('data is too large');
    const source = normalizeSource(input.source);
    const priority = input.priority ?? this.options.defaultPriority ?? 'normal';
    if (!PRIORITIES.includes(priority)) throw new NotificationValidationError('Invalid priority');
    const requested = input.channels ?? (input.channel !== undefined ? [input.channel] : this.defaultChannels);
    if (!Array.isArray(requested) || requested.length === 0 || requested.some((channel) => typeof channel !== 'string')) throw new NotificationValidationError('channels must be a non-empty array of strings');
    const channels = [...new Set(requested)];
    for (const channel of channels) if (!this.channels.has(channel)) throw new NotificationValidationError(`Unknown notification channel: ${channel}`);
    let expiresAt: string | undefined;
    if (input.expiresAt !== undefined) {
      const parsed = typeof input.expiresAt === 'string' ? new Date(input.expiresAt) : new Date(Number.NaN);
      if (Number.isNaN(parsed.getTime())) throw new NotificationValidationError('expiresAt must be an ISO-8601 timestamp');
      expiresAt = parsed.toISOString();
    }
    if (input.idempotencyKey !== undefined) requiredText(input.idempotencyKey, 'idempotencyKey', 256);
    const idempotencyKey = input.idempotencyKey ?? (source?.eventId ? `${source.type}:${source.eventId}:${type}` : undefined);

    // Credential boundary: nothing credential-shaped is ever stored or delivered.
    assertNoCredentials(title, 'title');
    if (input.body !== undefined) assertNoCredentials(input.body, 'body');
    if (input.data !== undefined) assertNoCredentials(input.data, 'data');
    if (source) assertNoCredentials(source, 'source');
    if (idempotencyKey) assertNoCredentials(idempotencyKey, 'idempotencyKey');

    return {
      tenantId: input.tenantId, recipient, type, title, priority, channels,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.data !== undefined ? { data: structuredClone(input.data) } : {}),
      ...(source ? { source } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  /** Fails closed: a missing or malformed principal is never authorized. */
  private authorizeTenant(principal: AuthenticatedPrincipal | null | undefined, tenantId: unknown, scope: string): asserts principal is AuthenticatedPrincipal {
    if (!principal || typeof principal.principalId !== 'string' || !principal.principalId || typeof principal.tenantId !== 'string' || !principal.tenantId || !Array.isArray(principal.scopes)) throw new NotificationAuthorizationError();
    if (typeof tenantId !== 'string' || principal.tenantId !== tenantId) throw new NotificationAuthorizationError();
    if (!hasScope(principal, scope)) throw new NotificationAuthorizationError();
  }
  private authorizeRead(principal: AuthenticatedPrincipal, item: Notification): void {
    if (item.tenantId !== principal.tenantId) throw new NotificationAuthorizationError();
    if (item.recipient !== principal.principalId && !hasScope(principal, 'notifications.read:any')) throw new NotificationAuthorizationError();
  }
  /** Read, acknowledge, dismiss, and delete require authority over the notification itself. */
  private authorizeOwner(principal: AuthenticatedPrincipal, item: Notification): void {
    if (item.tenantId !== principal.tenantId) throw new NotificationAuthorizationError();
    if (item.recipient !== principal.principalId && !principal.scopes.includes('notifications.admin')) throw new NotificationAuthorizationError();
  }
  private async audit(type: NotificationAuditType, item: Notification, principalId: string, delivery?: NotificationDelivery): Promise<void> {
    await this.options.auditSink.record({
      id: randomUUID(), type, notificationId: item.id, tenantId: item.tenantId, recipient: item.recipient, principalId,
      timestamp: this.now().toISOString(), result: type === 'notification.delivery.failed' || type === 'notification.delivery.retrying' ? 'failure' : 'success',
      ...(delivery ? { channel: delivery.channel, deliveryId: delivery.id } : {}),
    });
  }
}

function hasScope(principal: AuthenticatedPrincipal, scope: string): boolean {
  if (principal.scopes.includes('notifications.admin')) return true;
  if (principal.scopes.includes(scope)) return true;
  return scope === 'notifications.read' && principal.scopes.includes('notifications.read:any');
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new NotificationValidationError(`${name} is required`);
  if (value.length > max) throw new NotificationValidationError(`${name} is too long`);
  return value;
}

function normalizeSource(value: unknown): NotificationSource | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NotificationValidationError('source must be an object');
  const source = value as Record<string, unknown>;
  for (const key of Object.keys(source)) if (!['type', 'id', 'eventId'].includes(key)) throw new NotificationValidationError(`Unknown source field: ${key}`);
  const type = requiredText(source.type, 'source.type', 128);
  if (source.id !== undefined) requiredText(source.id, 'source.id', 256);
  if (source.eventId !== undefined) requiredText(source.eventId, 'source.eventId', 256);
  return { type, ...(source.id !== undefined ? { id: source.id as string } : {}), ...(source.eventId !== undefined ? { eventId: source.eventId as string } : {}) };
}

/** Deterministic UUID-formatted identity for a logical notification or delivery. */
function stableUuid(...parts: readonly string[]): string {
  const hex = createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function safeReason(reason: string): string {
  const trimmed = (reason || 'delivery_failed').slice(0, 500);
  return isSensitiveValue(trimmed) ? 'delivery_failed (details withheld: contained credential material)' : trimmed;
}

function sortDeliveries(deliveries: readonly NotificationDelivery[]): readonly NotificationDelivery[] {
  return [...deliveries].sort((a, b) => a.channel.localeCompare(b.channel));
}
function encodeCursor(item: Notification): string { return Buffer.from(JSON.stringify({ createdAt: item.createdAt, id: item.id }), 'utf8').toString('base64url'); }
function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { createdAt?: unknown; id?: unknown };
    if (typeof value.createdAt !== 'string' || typeof value.id !== 'string') throw new Error();
    return { createdAt: value.createdAt, id: value.id };
  } catch { throw new NotificationValidationError('Invalid cursor'); }
}
function afterCursor(item: Notification, cursor: { createdAt: string; id: string }): boolean {
  return item.createdAt < cursor.createdAt || (item.createdAt === cursor.createdAt && item.id < cursor.id);
}
