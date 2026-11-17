import type { StateFirstDB } from '@feltdb/core';
import type { Notification, NotificationAuditEvent, NotificationDelivery } from '../notifications/models.js';
import { FELTDB_QUERY_PAGE_LIMIT } from './bounded.js';

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
  /**
   * One page of the notifications addressed to `recipient` in `tenantId`, newest first
   * (`createdAt` descending, then `id` ascending: FeltDB's tie order), by a bounded, indexed read: never a scan of
   * the recipient's whole history. Optional for compatibility with stores written before it:
   * `NotificationService.inbox`, `unreadCount` and `markAllRead` refuse without it.
   */
  pageByRecipient?(tenantId: string, recipient: string, query: NotificationRecipientQuery): Promise<NotificationRecipientPage>;
}

/** What `NotificationStore.pageByRecipient` reads. */
export interface NotificationRecipientQuery {
  /** At most this many records in the page (1–1000). Every page of one walk must ask for the same limit. */
  readonly limit: number;
  /** The store's own continuation, from a previous page of the same query. */
  readonly cursor?: string;
  /** Only this notification type. */
  readonly type?: string;
  /** Only notifications without `readAt`. */
  readonly unread?: boolean;
  /** Only notifications of this application (records without one are not returned). */
  readonly applicationId?: string;
  /**
   * The most records the read examines before it returns what it found (possibly fewer than
   * `limit`, even none) with a continuation. Bounds a filtered page whose matches are sparse.
   */
  readonly examine?: number;
}

export interface NotificationRecipientPage {
  readonly records: readonly Notification[];
  /** Present when records may remain after this page. */
  readonly nextCursor?: string;
}

/** Thrown by a store given a continuation it did not issue for this query. */
export class NotificationStoreCursorError extends Error {
  constructor() { super('Invalid cursor'); this.name = 'NotificationStoreCursorError'; }
}

/** The recipient timeline index `pageByRecipient` reads (newest first). */
export const NOTIFICATIONS_BY_RECIPIENT_INDEX = 'notifications_by_recipient';
/** The recipient-and-type timeline index `pageByRecipient` reads when a type is given. */
export const NOTIFICATIONS_BY_RECIPIENT_TYPE_INDEX = 'notifications_by_recipient_type';
/** The default examination bound of one `pageByRecipient` call. */
export const NOTIFICATION_PAGE_EXAMINATION_LIMIT = 1_000;

export interface NotificationDeliveryStore {
  create(item: NotificationDelivery): Promise<void>;
  get(tenantId: string, id: string): Promise<NotificationDelivery | null>;
  list(tenantId: string, notificationId?: string): Promise<readonly NotificationDelivery[]>;
  update(tenantId: string, id: string, expectedVersion: number, updates: Partial<NotificationDelivery>): Promise<NotificationDelivery | null>;
  delete(id: string): Promise<void>;
}

export interface NotificationAuditSink {
  record(event: NotificationAuditEvent): Promise<void>;
}

export class FeltDbNotificationStore implements NotificationStore {
  private readonly collection;
  private readonly deliveries;
  constructor(private readonly db: StateFirstDB) {
    this.collection = db.collection<Notification>(NOTIFICATIONS);
    this.deliveries = db.collection<NotificationDelivery>(DELIVERIES);
  }
  async create(item: Notification): Promise<void> {
    await this.db.transaction({ operations: [{ collection: NOTIFICATIONS, id: item.id, requireAbsent: true, value: { ...item } }] });
  }
  async createWithDeliveries(item: Notification, deliveries: readonly NotificationDelivery[]): Promise<boolean> {
    const operations = [
      { collection: NOTIFICATIONS, id: item.id, requireAbsent: true, value: { ...item } },
      ...deliveries.map((delivery) => ({ collection: DELIVERIES, id: delivery.id, requireAbsent: true, value: { ...delivery } })),
    ];
    try {
      await this.db.transaction({ operations });
      return true;
    } catch (error) {
      // A concurrent or repeated create of the same logical notification.
      if (await this.collection.get(item.id)) return false;
      const orphaned = await Promise.all(deliveries.map(async (delivery) => (await this.deliveries.get(delivery.id)) ? delivery.id : null));
      const staleIds = orphaned.filter((id): id is string => id !== null);
      if (staleIds.length > 0) {
        await Promise.all(staleIds.map((id) => this.deliveries.delete(id)));
        await this.db.transaction({ operations });
        return true;
      }
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

  /**
   * Reads the recipient's timeline index (`notifications_by_recipient`, or
   * `notifications_by_recipient_type` with a type) in storage pages of exactly `limit`, so every
   * storage page of a walk asks for the same limit (a managed authority binds its cursor to the
   * limit). `unread` and `applicationId` are checked on the records read, at most `examine` of them.
   * The continuation names the storage page and the last record returned from it, so a walk resumes
   * after that record even when the page was only partly returned.
   */
  async pageByRecipient(tenantId: string, recipient: string, query: NotificationRecipientQuery): Promise<NotificationRecipientPage> {
    const limit = query.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > FELTDB_QUERY_PAGE_LIMIT) throw new RangeError('limit must be an integer from 1 to 1000');
    const examine = Math.max(query.examine ?? NOTIFICATION_PAGE_EXAMINATION_LIMIT, limit);
    this.ensureRecipientIndexes();
    const start = query.cursor === undefined ? { c: undefined, a: undefined } : decodeStoreCursor(query.cursor);
    const where: Array<{ field: string; eq: unknown }> = [{ field: 'tenantId', eq: tenantId }, { field: 'recipient', eq: recipient }];
    if (query.type !== undefined) where.push({ field: 'type', eq: query.type });
    const matches = (item: Notification) => item.tenantId === tenantId && item.recipient === recipient
      && (query.type === undefined || item.type === query.type)
      && (!query.unread || !item.readAt)
      && (query.applicationId === undefined || item.applicationId === query.applicationId);
    const records: Notification[] = [];
    let pageCursor = start.c;
    let after = start.a;
    let examined = 0;
    for (;;) {
      let page;
      try {
        page = await this.db.query<Notification>({
          collection: NOTIFICATIONS, where, orderBy: [{ field: 'createdAt', direction: 'desc' }], limit,
          ...(pageCursor ? { cursor: pageCursor } : {}),
        });
      } catch (error) {
        if (pageCursor && /INVALID_CURSOR/.test(String((error as { code?: unknown })?.code ?? '') + String((error as Error)?.message ?? ''))) throw new NotificationStoreCursorError();
        throw error;
      }
      const batch = page.records;
      for (let index = 0; index < batch.length; index++) {
        const item = batch[index]!;
        // Resuming inside a storage page: skip what the previous page already covered.
        // FeltDB breaks createdAt ties by record id ascending, in every runtime.
        if (after && !(item.createdAt < after.createdAt || (item.createdAt === after.createdAt && item.id > after.id))) continue;
        examined += 1;
        if (matches(item)) records.push(item);
        if (records.length === limit) {
          if (index < batch.length - 1) return { records, nextCursor: encodeStoreCursor(pageCursor, item) };
          return { records, ...(page.nextCursor ? { nextCursor: encodeStoreCursor(page.nextCursor) } : {}) };
        }
      }
      if (page.exhausted || !page.nextCursor || batch.length === 0) return { records };
      pageCursor = page.nextCursor;
      after = undefined;
      if (examined >= examine) return { records, nextCursor: encodeStoreCursor(pageCursor) };
    }
  }

  private recipientIndexed = false;

  /**
   * The recipient timeline indexes, declared the first time they are needed (a managed authority
   * declares them from the contract); a runtime that refuses the declaration still answers the
   * bounded query.
   */
  private ensureRecipientIndexes(): void {
    if (this.recipientIndexed) return;
    this.recipientIndexed = true;
    try {
      // A remote (managed) authority declares the indexes from the contract and refuses a runtime
      // declaration: don't ask.
      if ((this.db as { runtime?: () => { runtime?: string } }).runtime?.().runtime === 'remote') return;
      const existing = new Set(this.collection.listIndexes().map((index) => index.name));
      if (!existing.has(NOTIFICATIONS_BY_RECIPIENT_INDEX)) {
        this.collection.createIndex({ name: NOTIFICATIONS_BY_RECIPIENT_INDEX, type: 'compound', fields: ['tenantId', 'recipient', 'createdAt'], directions: ['asc', 'asc', 'desc'] });
      }
      if (!existing.has(NOTIFICATIONS_BY_RECIPIENT_TYPE_INDEX)) {
        this.collection.createIndex({ name: NOTIFICATIONS_BY_RECIPIENT_TYPE_INDEX, type: 'compound', fields: ['tenantId', 'recipient', 'type', 'createdAt'], directions: ['asc', 'asc', 'asc', 'desc'] });
      }
    } catch { /* the bounded query is still correct without the index */ }
  }
}

function encodeStoreCursor(pageCursor: string | undefined, after?: Notification): string {
  return Buffer.from(JSON.stringify({ c: pageCursor ?? null, ...(after ? { a: [after.createdAt, after.id] } : {}) }), 'utf8').toString('base64url');
}

function decodeStoreCursor(cursor: string): { c: string | undefined; a: { createdAt: string; id: string } | undefined } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; a?: unknown };
    const c = value.c;
    if (c !== null && (typeof c !== 'string' || !c)) throw new Error();
    const a = value.a;
    if (a !== undefined && (!Array.isArray(a) || a.length !== 2 || typeof a[0] !== 'string' || typeof a[1] !== 'string')) throw new Error();
    if (c === null && a === undefined) throw new Error();
    return { c: c ?? undefined, a: a ? { createdAt: a[0] as string, id: a[1] as string } : undefined };
  } catch { throw new NotificationStoreCursorError(); }
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
  async delete(id: string): Promise<void> { await this.collection.delete(id); }
}

export class FeltDbNotificationAuditSink implements NotificationAuditSink {
  private readonly collection;
  constructor(private readonly db: StateFirstDB) { this.collection = db.collection<NotificationAuditEvent>(AUDIT); }
  async record(event: NotificationAuditEvent): Promise<void> { await this.collection.insert({ ...event }, event.id); }
}

export function notificationCollectionNames(): readonly string[] {
  return [NOTIFICATIONS, DELIVERIES, AUDIT];
}
