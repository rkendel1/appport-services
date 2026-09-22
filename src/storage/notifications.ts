import type { StateFirstDB } from '@feltdb/core';
import type { Notification, NotificationAuditEvent, NotificationDelivery } from '../notifications/models.js';

const NOTIFICATIONS = 'notifications';
const DELIVERIES = 'notification_deliveries';
const AUDIT = 'notification_audit_events';

export interface NotificationStore {
  create(item: Notification): Promise<void>;
  /**
   * Atomically create a notification and its delivery records. Returns false,
   * writing nothing, when a notification with the same id already exists.
   */
  createWithDeliveries(item: Notification, deliveries: readonly NotificationDelivery[]): Promise<boolean>;
  get(tenantId: string, id: string): Promise<Notification | null>;
  list(tenantId: string): Promise<readonly Notification[]>;
  update(id: string, expectedVersion: number, updates: Partial<Notification>): Promise<Notification | null>;
  delete(id: string): Promise<void>;
}

export interface NotificationDeliveryStore {
  create(item: NotificationDelivery): Promise<void>;
  get(tenantId: string, id: string): Promise<NotificationDelivery | null>;
  list(tenantId: string, notificationId?: string): Promise<readonly NotificationDelivery[]>;
  update(tenantId: string, id: string, expectedVersion: number, updates: Partial<NotificationDelivery>): Promise<NotificationDelivery | null>;
}

export interface NotificationAuditSink {
  record(event: NotificationAuditEvent): Promise<void>;
}

export class FeltDbNotificationStore implements NotificationStore {
  private readonly collection;
  constructor(private readonly db: StateFirstDB) { this.collection = db.collection<Notification>(NOTIFICATIONS); }
  async create(item: Notification): Promise<void> {
    await this.db.transaction({ operations: [{ collection: NOTIFICATIONS, id: item.id, requireAbsent: true, value: { ...item } }] });
  }
  async createWithDeliveries(item: Notification, deliveries: readonly NotificationDelivery[]): Promise<boolean> {
    try {
      await this.db.transaction({
        operations: [
          { collection: NOTIFICATIONS, id: item.id, requireAbsent: true, value: { ...item } },
          ...deliveries.map((delivery) => ({ collection: DELIVERIES, id: delivery.id, requireAbsent: true, value: { ...delivery } })),
        ],
      });
      return true;
    } catch (error) {
      // A concurrent or repeated create of the same logical notification.
      if (await this.collection.get(item.id)) return false;
      throw error;
    }
  }
  async get(tenantId: string, id: string): Promise<Notification | null> {
    const item = await this.collection.get(id);
    return item?.tenantId === tenantId ? item : null;
  }
  async list(tenantId: string): Promise<readonly Notification[]> { return this.collection.find({ tenantId }); }
  async update(id: string, expectedVersion: number, updates: Partial<Notification>): Promise<Notification | null> {
    const current = await this.collection.get(id);
    if (!current) return null;
    const result = await this.collection.updateIfVersion(id, expectedVersion, { ...current, ...updates });
    return result.updated ? result.item ?? null : null;
  }
  async delete(id: string): Promise<void> { await this.collection.delete(id); }
}

export class FeltDbNotificationDeliveryStore implements NotificationDeliveryStore {
  private readonly collection;
  constructor(private readonly db: StateFirstDB) { this.collection = db.collection<NotificationDelivery>(DELIVERIES); }
  async create(item: NotificationDelivery): Promise<void> {
    await this.db.transaction({ operations: [{ collection: DELIVERIES, id: item.id, requireAbsent: true, value: { ...item } }] });
  }
  async get(tenantId: string, id: string): Promise<NotificationDelivery | null> {
    const item = await this.collection.get(id);
    return item?.tenantId === tenantId ? item : null;
  }
  async list(tenantId: string, notificationId?: string): Promise<readonly NotificationDelivery[]> {
    return this.collection.find(notificationId ? { tenantId, notificationId } : { tenantId });
  }
  async update(tenantId: string, id: string, expectedVersion: number, updates: Partial<NotificationDelivery>): Promise<NotificationDelivery | null> {
    const current = await this.collection.get(id);
    if (!current || current.tenantId !== tenantId) return null;
    const result = await this.collection.updateIfVersion(id, expectedVersion, { ...current, ...updates });
    return result.updated ? result.item ?? null : null;
  }
}

export class FeltDbNotificationAuditSink implements NotificationAuditSink {
  private readonly collection;
  constructor(private readonly db: StateFirstDB) { this.collection = db.collection<NotificationAuditEvent>(AUDIT); }
  async record(event: NotificationAuditEvent): Promise<void> { await this.collection.insert({ ...event }, event.id); }
}

export function notificationCollectionNames(): readonly string[] {
  return [NOTIFICATIONS, DELIVERIES, AUDIT];
}
