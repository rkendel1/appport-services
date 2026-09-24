import { randomUUID } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { NotificationAuditSink, NotificationDeliveryStore, NotificationStore } from '../storage/notifications.js';
import type { CreateNotificationInput, Notification, NotificationDelivery, NotificationListOptions, NotificationPage } from './models.js';
import type { ServiceResource } from '../authority/context.js';
import { ServiceAuthorityError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { rejectCallerActor, requireVerifiedPrincipal, resolveTenant } from '../authority/principal.js';

/** @deprecated Denials are reported as ServiceAuthorityError with code DENIED. */
export class NotificationAuthorizationError extends Error {
  constructor() { super('Notification operation is not authorized'); this.name = 'NotificationAuthorizationError'; }
}
export class NotificationValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'NotificationValidationError'; }
}
export class NotificationNotFoundError extends Error {
  constructor() { super('Notification not found'); this.name = 'NotificationNotFoundError'; }
}

export interface NotificationServiceOptions {
  readonly store: NotificationStore;
  readonly deliveryStore?: NotificationDeliveryStore;
  readonly auditSink: NotificationAuditSink;
  /** Policy Enforcement Point. Without it every notification operation fails closed. */
  readonly authority?: ServiceGateway;
  readonly now?: () => Date;
}

export class NotificationService {
  private readonly now: () => Date;
  constructor(private readonly options: NotificationServiceOptions) { this.now = options.now ?? (() => new Date()); }

  /** notifications.send: the recipient is a resource attribute for AuthBoundry, never an identity. */
  async create(input: CreateNotificationInput, caller: AuthenticatedPrincipal): Promise<Notification> {
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor(input, principal);
    const tenantId = resolveTenant(input, principal);
    validateInput({ ...input, tenantId });
    return this.gateway().execute('notifications.send', principal, { type: 'notification', tenantId, attributes: { recipient: input.recipient, channel: input.channel ?? 'in-app' } }, { service: 'notifications', provider: input.channel ?? 'in-app' }, async () => {
      const createdAt = this.now().toISOString();
      const { channel: _channel, ...fields } = input;
      const item: Notification = { ...fields, tenantId, id: randomUUID(), priority: input.priority ?? 'normal', createdAt, __version: 1 };
      await this.options.store.create(item);
      if (this.options.deliveryStore) {
        await this.options.deliveryStore.create({ id: randomUUID(), tenantId: item.tenantId, notificationId: item.id, channel: input.channel ?? 'in-app', status: 'pending', __version: 1 });
      }
      await this.audit('notification.created', item, principal);
      return item;
    });
  }

  async get(tenantId: string, id: string, caller: AuthenticatedPrincipal): Promise<Notification> {
    const principal = requireVerifiedPrincipal(caller);
    const item = await this.options.store.get(resolveTenant({ tenantId }, principal), id);
    if (!item) throw new NotificationNotFoundError();
    return this.gateway().execute('notifications.read', principal, notificationResource(item), { service: 'notifications' }, async () => item);
  }

  /** Without a recipient filter the request is for every recipient; AuthBoundry decides whether that is allowed. */
  async list(tenantId: string, options: NotificationListOptions = {}, caller: AuthenticatedPrincipal): Promise<NotificationPage> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    return this.gateway().execute('notifications.read', principal, { type: 'notification', tenantId: tenant, attributes: { recipient: options.recipient ?? '*' } }, { service: 'notifications' }, async () => {
      const all = await this.options.store.list(tenant);
      const items = all.filter((item) =>
        (!options.recipient || item.recipient === options.recipient) &&
        (!options.unread || !item.readAt) &&
        (!options.type || item.type === options.type) &&
        (!options.priority || item.priority === options.priority) &&
        (!options.sourceType || item.source?.type === options.sourceType) &&
        (!cursor || afterCursor(item, cursor)),
      ).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      const page = items.slice(0, limit);
      return { items: page, ...(items.length > limit ? { nextCursor: encodeCursor(page.at(-1)!) } : {}) };
    });
  }

  async markRead(tenantId: string, id: string, caller: AuthenticatedPrincipal): Promise<Notification> {
    return this.mutate('notification.read', tenantId, id, caller, () => ({ readAt: this.now().toISOString() }));
  }
  async dismiss(tenantId: string, id: string, caller: AuthenticatedPrincipal): Promise<Notification> {
    return this.mutate('notification.dismissed', tenantId, id, caller, () => ({ dismissedAt: this.now().toISOString() }));
  }
  async delete(tenantId: string, id: string, caller: AuthenticatedPrincipal): Promise<void> {
    const principal = requireVerifiedPrincipal(caller);
    const item = await this.options.store.get(resolveTenant({ tenantId }, principal), id);
    if (!item) return;
    await this.gateway().execute('notifications.delete', principal, notificationResource(item), { service: 'notifications' }, async () => {
      await this.options.store.delete(id);
      await this.audit('notification.deleted', item, principal);
    });
  }
  async deliveries(tenantId: string, id: string, caller: AuthenticatedPrincipal): Promise<readonly NotificationDelivery[]> {
    const item = await this.get(tenantId, id, caller);
    return this.options.deliveryStore?.list(item.tenantId, item.id) ?? [];
  }

  private async mutate(type: 'notification.read' | 'notification.dismissed', tenantId: string, id: string, caller: AuthenticatedPrincipal, updates: () => Partial<Notification>): Promise<Notification> {
    const principal = requireVerifiedPrincipal(caller);
    const item = await this.options.store.get(resolveTenant({ tenantId }, principal), id);
    if (!item) throw new NotificationNotFoundError();
    return this.gateway().execute('notifications.update', principal, notificationResource(item), { service: 'notifications' }, async () => {
      const updated = await this.options.store.update(item.id, item.__version, updates());
      if (!updated) throw new NotificationValidationError('Notification was modified concurrently');
      await this.audit(type, updated, principal);
      return updated;
    });
  }
  private gateway(): ServiceGateway {
    if (!this.options.authority) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Notifications have no AuthBoundry authority configured');
    return this.options.authority;
  }
  private async audit(type: 'notification.created' | 'notification.read' | 'notification.dismissed' | 'notification.deleted', item: Notification, principal: AuthenticatedPrincipal): Promise<void> {
    await this.options.auditSink.record({ id: randomUUID(), type, notificationId: item.id, tenantId: item.tenantId, recipient: item.recipient, principalId: principal.principalId, timestamp: this.now().toISOString(), result: 'success' });
  }
}

function notificationResource(item: Notification): ServiceResource {
  return { type: 'notification', tenantId: item.tenantId, id: item.id, attributes: { recipient: item.recipient } };
}

function validateInput(input: CreateNotificationInput & { tenantId: string }): void {
  for (const name of ['recipient', 'type', 'title'] as const) if (typeof input[name] !== 'string' || !input[name].trim()) throw new NotificationValidationError(`${name} is required`);
  for (const [name, value] of Object.entries(input)) if (['body', 'data', 'source', 'priority', 'channel'].includes(name)) continue; else if (typeof value !== 'string' || !value.trim()) throw new NotificationValidationError(`${name} is required`);
  if (input.priority && !['low', 'normal', 'high', 'urgent'].includes(input.priority)) throw new NotificationValidationError('Invalid priority');
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
