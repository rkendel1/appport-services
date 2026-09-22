import type { Notification, NotificationDelivery } from './models.js';

/**
 * Outcome reported by a channel adapter.
 *
 * A thrown error is treated as a retryable failure. Return
 * `{ status: 'failed', retryable: false }` for failures that retrying cannot fix
 * (for example an unknown destination).
 */
export type NotificationDeliveryResult =
  | { readonly status: 'delivered'; readonly externalId?: string }
  | { readonly status: 'failed'; readonly reason: string; readonly retryable?: boolean };

/**
 * Delivery adapter contract.
 *
 * An adapter receives the authoritative notification and the delivery record it
 * is attempting. It must not persist notification state or decide whether a
 * notification should exist; AppPort Services owns both. Adapters whose
 * downstream supports de-duplication should forward `delivery.idempotencyKey`.
 */
export interface NotificationChannel {
  readonly type: string;
  deliver(notification: Notification, delivery: NotificationDelivery): Promise<NotificationDeliveryResult>;
}

export class NotificationChannelRegistry {
  private readonly channels = new Map<string, NotificationChannel>();

  constructor(channels: readonly NotificationChannel[] = []) {
    for (const channel of channels) this.register(channel);
  }

  register(channel: NotificationChannel): void {
    if (!/^[a-z][a-z0-9_-]*$/.test(channel.type)) throw new Error(`Invalid notification channel type "${channel.type}"`);
    if (this.channels.has(channel.type)) throw new Error(`Notification channel "${channel.type}" is already registered`);
    this.channels.set(channel.type, channel);
  }

  get(type: string): NotificationChannel | undefined { return this.channels.get(type); }
  has(type: string): boolean { return this.channels.has(type); }
  types(): readonly string[] { return [...this.channels.keys()]; }
}

/**
 * The durable inbox. A notification is available to its recipient through the
 * notification API as soon as it is committed, so this channel only records
 * that fact.
 */
export class InAppNotificationChannel implements NotificationChannel {
  readonly type = 'in-app';
  async deliver(): Promise<NotificationDeliveryResult> { return { status: 'delivered' }; }
}

/**
 * Message handed to a browser transport. It is a pointer, not the notification:
 * browsers and extensions fetch the content through the authorized
 * notification API, so a shared transport never exposes one recipient's
 * notification to another.
 */
export interface BrowserNotificationMessage {
  readonly notificationId: string;
  readonly deliveryId: string;
  readonly tenantId: string;
  readonly recipient: string;
  readonly type: string;
  /** Stable per notification+channel; use as the browser notification tag. */
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

export interface BrowserNotificationTransport {
  push(message: BrowserNotificationMessage): void | Promise<void>;
}

/**
 * Browser delivery. Forwards canonical AppPort notifications to the browser
 * transport (the AppPort event stream that browsers and extensions subscribe
 * to). It evaluates no application conditions and keeps no state.
 */
export class BrowserNotificationChannel implements NotificationChannel {
  readonly type = 'browser';
  constructor(private readonly transport: BrowserNotificationTransport) {}

  async deliver(notification: Notification, delivery: NotificationDelivery): Promise<NotificationDeliveryResult> {
    await this.transport.push({
      notificationId: notification.id,
      deliveryId: delivery.id,
      tenantId: notification.tenantId,
      recipient: notification.recipient,
      type: notification.type,
      idempotencyKey: delivery.idempotencyKey,
      createdAt: notification.createdAt,
      ...(notification.expiresAt ? { expiresAt: notification.expiresAt } : {}),
    });
    return { status: 'delivered', externalId: delivery.idempotencyKey };
  }
}

/** Event type published on the AppPort event stream for browser delivery. */
export const BROWSER_NOTIFICATION_EVENT = 'appport.notification';
