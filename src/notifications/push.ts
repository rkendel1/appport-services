import type { Notification, NotificationDelivery } from './models.js';
import type { NotificationChannel, NotificationDeliveryResult } from './channels.js';

/** What the push channel hands its transport: one message to one device. */
export interface PushMessage {
  /** The device or subscription identifier the host's push service understands. */
  readonly device: string;
  readonly title: string;
  readonly body?: string;
  /** Non-secret data for the client (notification id, type, and what `render` adds). */
  readonly data: Readonly<Record<string, string>>;
  /** Stable per notification and channel: a transport that de-duplicates uses it (for example as the collapse key). */
  readonly idempotencyKey: string;
}

/**
 * The transport contract: any push service (APNs, FCM, Web Push, a vendor
 * SDK) behind one method. The host supplies it; AppPort Services depends on
 * no vendor. Throwing is a retryable failure; returning `{ retryable: false }`
 * with `ok: false` is not (for example an unregistered device).
 */
export interface PushTransport {
  send(message: PushMessage): Promise<{ readonly ok?: boolean; readonly id?: string; readonly retryable?: boolean; readonly reason?: string } | void>;
}

export interface PushChannelOptions {
  readonly transport: PushTransport;
  /**
   * The devices of a notification's recipient (a principal id). Not consulted
   * for a notification addressed to a contact (`contact.device`).
   */
  devices?(notification: Notification): readonly string[] | Promise<readonly string[]>;
  /** Title, body and data of the push for a notification. Default: its title and body. */
  render?(notification: Notification, delivery: NotificationDelivery): { readonly title: string; readonly body?: string; readonly data?: Readonly<Record<string, string>> } | null | Promise<{ readonly title: string; readonly body?: string; readonly data?: Readonly<Record<string, string>> } | null>;
}

/**
 * Push delivery to a user's devices, or to a contact's device. Like every
 * channel it keeps no state: AppPort Services records the delivery, its
 * attempts and its outcome. No device: fails without retry.
 */
export class PushNotificationChannel implements NotificationChannel {
  readonly type = 'push';
  constructor(private readonly options: PushChannelOptions) {}

  async deliver(notification: Notification, delivery: NotificationDelivery): Promise<NotificationDeliveryResult> {
    const devices = notification.contact
      ? (notification.contact.device ? [notification.contact.device] : [])
      : [...(await this.options.devices?.(notification) ?? [])];
    if (devices.length === 0) return { status: 'failed', reason: 'no_push_device', retryable: false };
    const content = this.options.render ? await this.options.render(notification, delivery) : { title: notification.title, ...(notification.body ? { body: notification.body } : {}) };
    if (!content) return { status: 'failed', reason: 'not_renderable', retryable: false };
    const ids: string[] = [];
    let delivered = 0;
    let permanent: string | undefined;
    for (const device of devices) {
      const sent = await this.options.transport.send({
        device,
        title: content.title,
        ...(content.body ? { body: content.body } : {}),
        data: { ...(content.data ?? {}), notificationId: notification.id, type: notification.type },
        idempotencyKey: delivery.idempotencyKey,
      });
      if (sent && sent.ok === false) {
        if (sent.retryable === false) { permanent = sent.reason ?? 'push_rejected'; continue; }
        throw new Error(sent.reason ?? 'push_failed');
      }
      delivered += 1;
      if (sent && typeof sent.id === 'string') ids.push(sent.id);
    }
    if (permanent && delivered === 0) return { status: 'failed', reason: permanent, retryable: false };
    return { status: 'delivered', ...(ids.length ? { externalId: ids.join(',') } : {}) };
  }
}
