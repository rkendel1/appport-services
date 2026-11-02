import type { Notification, NotificationDelivery } from './models.js';
import type { NotificationChannel, NotificationDeliveryResult } from './channels.js';

/** What the e-mail channel hands its transport: one message to one address. */
export interface EmailMessage {
  /** Sender identity name (Mailerport `identity`), resolved to an address by the transport. */
  readonly identity: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /** Stable per notification and channel: a transport that de-duplicates uses it. */
  readonly idempotencyKey: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * The transport contract. It is Mailerport's `send()` (`createMailPort()` from
 * `mailerport`), so a MailPort instance is a transport as it is, without this
 * package depending on it. Any object with this method works.
 */
export interface EmailTransport {
  send(message: EmailMessage): Promise<{ readonly message_id?: string; readonly id?: string } | unknown>;
}

/** Subject and body of the e-mail for a notification. */
export interface EmailContent {
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface EmailChannelOptions {
  readonly transport: EmailTransport;
  /** Sender identity for every message. Default `"system"`. */
  readonly identity?: string;
  /**
   * The address for a notification's recipient (a principal id). Notifications
   * address principals, never raw addresses, so the host maps one to the other.
   * `null`: the recipient has no address, and the delivery fails without retry.
   */
  address(notification: Notification): string | null | Promise<string | null>;
  /**
   * The message for a notification. Default: the title as subject, the body as
   * text. A host renders here what must not be stored in the notification,
   * such as a link carrying a signature computed at delivery time.
   */
  render?(notification: Notification, delivery: NotificationDelivery): EmailContent | null | Promise<EmailContent | null>;
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/**
 * E-mail delivery. Like every channel, it decides nothing about whether a
 * notification exists and keeps no state: AppPort Services records the
 * delivery, its attempts, and its outcome. A thrown transport error is a
 * retryable failure; a missing or invalid address is not.
 */
export class EmailNotificationChannel implements NotificationChannel {
  readonly type = 'email';
  constructor(private readonly options: EmailChannelOptions) {}

  async deliver(notification: Notification, delivery: NotificationDelivery): Promise<NotificationDeliveryResult> {
    const to = await this.options.address(notification);
    if (!to || !ADDRESS.test(to)) return { status: 'failed', reason: 'no_email_address', retryable: false };
    const content = this.options.render
      ? await this.options.render(notification, delivery)
      : { subject: notification.title, text: notification.body ?? notification.title };
    if (!content) return { status: 'failed', reason: 'not_renderable', retryable: false };
    const sent = (await this.options.transport.send({
      identity: this.options.identity ?? 'system',
      to,
      subject: content.subject,
      text: content.text,
      ...(content.html ? { html: content.html } : {}),
      idempotencyKey: delivery.idempotencyKey,
      metadata: { notificationId: notification.id, deliveryId: delivery.id, type: notification.type },
    })) as { message_id?: unknown; id?: unknown } | null | undefined;
    const externalId = typeof sent?.message_id === 'string' ? sent.message_id : typeof sent?.id === 'string' ? sent.id : undefined;
    return { status: 'delivered', ...(externalId ? { externalId } : {}) };
  }
}
