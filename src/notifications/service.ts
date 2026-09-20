import { randomUUID } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { NotificationAuditSink, NotificationDeliveryStore, NotificationStore } from '../storage/notifications.js';
import type { CreateNotificationInput, Notification, NotificationDelivery, NotificationListOptions, NotificationPage } from './models.js';

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
  readonly now?: () => Date;
}

export class NotificationService {
  private readonly now: () => Date;
  constructor(private readonly options: NotificationServiceOptions) { this.now = options.now ?? (() => new Date()); }

  async create(input: CreateNotificationInput, principal: AuthenticatedPrincipal): Promise<Notification> {
    this.authorizeTenant(principal, input.tenantId, 'notifications.create');
    validateInput(input);
    const createdAt = this.now().toISOString();
    const item: Notification = { ...input, id: randomUUID(), priority: input.priority ?? 'normal', createdAt, __version: 1 };
    delete (item as { channel?: string }).channel;
    await this.options.store.create(item);
    if (this.options.deliveryStore) {
      await this.options.deliveryStore.create({ id: randomUUID(), tenantId: item.tenantId, notificationId: item.id, channel: input.channel ?? 'in-app', status: 'pending', __version: 1 });
    }
    await this.audit('notification.created', item, principal);
    return item;
  }

  async get(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<Notification> {
    const item = await this.options.store.get(tenantId, id);
    if (!item) throw new NotificationNotFoundError();
    this.authorizeItem(principal, item, 'notifications.read');
    return item;
  }

  async list(tenantId: string, options: NotificationListOptions = {}, principal: AuthenticatedPrincipal): Promise<NotificationPage> {
    this.authorizeTenant(principal, tenantId, 'notifications.read');
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const all = await this.options.store.list(tenantId);
    let items = all.filter((item) =>
      (!options.recipient || item.recipient === options.recipient) &&
      (!options.unread || !item.readAt) &&
      (!options.type || item.type === options.type) &&
      (!options.priority || item.priority === options.priority) &&
      (!options.sourceType || item.source?.type === options.sourceType) &&
      (!options.cursor || afterCursor(item, decodeCursor(options.cursor))),
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    if (!principal.scopes.includes('notifications.read:any') && !principal.scopes.includes('notifications.admin')) {
      items = items.filter((item) => item.recipient === principal.principalId);
    }
    const page = items.slice(0, limit);
    return { items: page, ...(items.length > limit ? { nextCursor: encodeCursor(page.at(-1)!) } : {}) };
  }

  async markRead(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<Notification> {
    return this.mutate('notification.read', tenantId, id, principal, { readAt: this.now().toISOString() });
  }
  async dismiss(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<Notification> {
    return this.mutate('notification.dismissed', tenantId, id, principal, { dismissedAt: this.now().toISOString() });
  }
  async delete(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<void> {
    const item = await this.options.store.get(tenantId, id);
    if (!item) return;
    this.authorizeItem(principal, item, 'notifications.delete');
    await this.options.store.delete(id);
    await this.audit('notification.deleted', item, principal);
  }
  async deliveries(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<readonly NotificationDelivery[]> {
    const item = await this.get(tenantId, id, principal);
    return this.options.deliveryStore?.list(item.tenantId, item.id) ?? [];
  }

  private async mutate(type: 'notification.read' | 'notification.dismissed', tenantId: string, id: string, principal: AuthenticatedPrincipal, updates: Partial<Notification>): Promise<Notification> {
    const item = await this.options.store.get(tenantId, id);
    if (!item) throw new NotificationNotFoundError();
    this.authorizeItem(principal, item, 'notifications.write');
    const updated = await this.options.store.update(item.id, item.__version, updates);
    if (!updated) throw new NotificationValidationError('Notification was modified concurrently');
    await this.audit(type, updated, principal);
    return updated;
  }
  private authorizeTenant(principal: AuthenticatedPrincipal, tenantId: string, scope: string): void {
    if (principal.tenantId !== tenantId || (!principal.scopes.includes(scope) && !principal.scopes.includes('notifications.admin'))) throw new NotificationAuthorizationError();
  }
  private authorizeItem(principal: AuthenticatedPrincipal, item: Notification, scope: string): void {
    this.authorizeTenant(principal, item.tenantId, scope);
    if (scope !== 'notifications.create' && item.recipient !== principal.principalId && !principal.scopes.includes('notifications.read:any') && !principal.scopes.includes('notifications.admin')) throw new NotificationAuthorizationError();
  }
  private async audit(type: Notification['id'] extends string ? 'notification.created' | 'notification.read' | 'notification.dismissed' | 'notification.deleted' : never, item: Notification, principal: AuthenticatedPrincipal): Promise<void> {
    await this.options.auditSink.record({ id: randomUUID(), type, notificationId: item.id, tenantId: item.tenantId, recipient: item.recipient, principalId: principal.principalId, timestamp: this.now().toISOString(), result: 'success' });
  }
}

function validateInput(input: CreateNotificationInput): void {
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
