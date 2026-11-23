export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

/**
 * Notification lifecycle. Channel outcomes live on NotificationDelivery; this
 * state only summarizes the notification as a whole.
 */
export type NotificationStatus = 'pending' | 'delivered' | 'failed' | 'read' | 'acknowledged' | 'expired';

/**
 * Provenance: a reference to the event that caused the notification, never a
 * copy of the source record. `type` names the producer (for example `monitor`),
 * `id` the producing resource, and `eventId` the specific event occurrence.
 */
export interface NotificationSource {
  readonly type: string;
  readonly id?: string;
  readonly eventId?: string;
}

/**
 * How to reach a recipient who is not a user of the application (a guest, an
 * invitee): an e-mail address and/or a push device. A notification with a
 * contact is addressed to `contact:<digest>` (no principal), and the e-mail and
 * push channels deliver to the contact directly.
 */
export interface NotificationContact {
  readonly email?: string;
  /** A push device or subscription identifier, as the host's push transport understands it. */
  readonly device?: string;
  /** Display name, for the message. */
  readonly name?: string;
}

/** Prefix of the recipient of a notification addressed to a contact (not a principal). */
export const CONTACT_RECIPIENT_PREFIX = 'contact:';

export interface Notification {
  readonly id: string;
  readonly tenantId: string;
  /** Owning application. Records without one (created before application scoping) are not served. */
  readonly applicationId?: string;
  readonly recipient: string;
  /** Set when the recipient is not a principal: where e-mail and push deliver. */
  readonly contact?: NotificationContact;
  readonly type: string;
  readonly title: string;
  readonly body?: string;
  readonly data?: Record<string, unknown>;
  readonly source?: NotificationSource;
  readonly priority: NotificationPriority;
  /** Delivery channels requested when the notification was created. */
  readonly channels: readonly string[];
  readonly status: NotificationStatus;
  /** Logical identity used to de-duplicate producer retries. */
  readonly idempotencyKey?: string;
  readonly createdAt: string;
  readonly createdBy?: string;
  readonly expiresAt?: string;
  readonly deliveredAt?: string;
  readonly failedAt?: string;
  readonly expiredAt?: string;
  readonly readAt?: string;
  readonly acknowledgedAt?: string;
  readonly dismissedAt?: string;
  readonly __version: number;
}

export type NotificationDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'retrying';

/** Channel-specific delivery state. Identity is `notificationId + channel`. */
export interface NotificationDelivery {
  readonly id: string;
  readonly tenantId: string;
  readonly notificationId: string;
  readonly recipient: string;
  readonly channel: string;
  readonly status: NotificationDeliveryStatus;
  /** Stable key passed to channels that support downstream de-duplication. */
  readonly idempotencyKey: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly createdAt: string;
  readonly lastAttemptAt?: string;
  readonly nextAttemptAt?: string;
  readonly deliveredAt?: string;
  readonly failedAt?: string;
  readonly failureReason?: string;
  /** Identifier reported by the channel for the downstream message, if any. */
  readonly externalId?: string;
  readonly __version: number;
}

export type NotificationAuditType =
  | 'notification.created'
  | 'notification.read'
  | 'notification.acknowledged'
  | 'notification.dismissed'
  | 'notification.deleted'
  | 'notification.expired'
  | 'notification.delivery.delivered'
  | 'notification.delivery.retrying'
  | 'notification.delivery.failed';

export interface NotificationAuditEvent {
  readonly id: string;
  readonly type: NotificationAuditType;
  readonly notificationId: string;
  readonly tenantId: string;
  readonly recipient: string;
  readonly principalId: string;
  readonly timestamp: string;
  readonly result: 'success' | 'failure';
  readonly channel?: string;
  readonly deliveryId?: string;
}

export interface CreateNotificationInput {
  /** Optional; must equal the caller's tenant. */
  readonly tenantId?: string;
  /** A principal id. Optional with `contact`: the recipient is then `contact:<digest of the address>`. */
  readonly recipient?: string;
  /** Reach a non-user directly (e-mail address, push device). Authorized with `recipientKind: "contact"`. */
  readonly contact?: NotificationContact;
  readonly type: string;
  readonly title: string;
  readonly body?: string;
  readonly data?: Record<string, unknown>;
  readonly source?: NotificationSource;
  readonly priority?: NotificationPriority;
  /** Requested delivery channels. Defaults to the service's default channels. */
  readonly channels?: readonly string[];
  /** @deprecated Use channels. */
  readonly channel?: string;
  /**
   * Explicit idempotency key. When omitted and `source.eventId` is present,
   * the key is derived from `source.type`, `source.eventId`, and `type`.
   */
  readonly idempotencyKey?: string;
  readonly expiresAt?: string;
}

export interface NotificationResult {
  readonly notification: Notification;
  readonly deliveries: readonly NotificationDelivery[];
  /** False when the request resolved to an existing notification. */
  readonly created: boolean;
}

export interface NotificationListOptions {
  readonly recipient?: string;
  readonly unread?: boolean;
  readonly unacknowledged?: boolean;
  readonly status?: NotificationStatus;
  readonly type?: string;
  readonly priority?: NotificationPriority;
  readonly sourceType?: string;
  readonly createdAfter?: string;
  readonly createdBefore?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface NotificationPage {
  readonly items: readonly Notification[];
  readonly nextCursor?: string;
}

/**
 * One recipient's notifications, newest first (`createdAt` descending, then `id` ascending), read
 * page by page from the recipient's timeline index. See `NotificationService.inbox`.
 */
export interface NotificationInboxOptions {
  /** Whose notifications. Defaults to the caller; another recipient is authorized as `list` is. */
  readonly recipient?: string;
  /** Only notifications not yet read. */
  readonly unread?: boolean;
  /** Only this notification type. */
  readonly type?: string;
  /** 1–100, default 50. A cursor is bound to the limit (and filters) of the page that issued it. */
  readonly limit?: number;
  /** `nextCursor` of the previous page. */
  readonly cursor?: string;
}

export interface NotificationUnreadCountOptions {
  readonly recipient?: string;
  readonly type?: string;
  /** Count at most this many (1–1000, default 100). */
  readonly max?: number;
}

export interface NotificationUnreadCount {
  readonly count: number;
  /**
   * False when `count` is a lower bound: there are more than `max` unread notifications, or the
   * count stopped after `NOTIFICATION_UNREAD_EXAMINATION_LIMIT` records (show it as "max+").
   */
  readonly complete: boolean;
}

export interface NotificationMarkAllReadOptions {
  /** Only this notification type. */
  readonly type?: string;
}

export interface NotificationMarkAllReadResult {
  /** Notifications this call marked read. */
  readonly marked: number;
  /**
   * False when the call stopped at `NOTIFICATION_MARK_ALL_READ_LIMIT` marks or at the examination
   * bound with notifications possibly still unread: call again to continue.
   */
  readonly complete: boolean;
}
