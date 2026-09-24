export type NotificationPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface NotificationSource {
  readonly type: string;
  readonly id?: string;
}

export interface Notification {
  readonly id: string;
  readonly tenantId: string;
  readonly recipient: string;
  readonly type: string;
  readonly title: string;
  readonly body?: string;
  readonly data?: Record<string, unknown>;
  readonly source?: NotificationSource;
  readonly priority: NotificationPriority;
  readonly createdAt: string;
  readonly readAt?: string;
  readonly dismissedAt?: string;
  readonly __version: number;
}

export type NotificationDeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface NotificationDelivery {
  readonly id: string;
  readonly tenantId: string;
  readonly notificationId: string;
  readonly channel: string;
  readonly status: NotificationDeliveryStatus;
  readonly attemptedAt?: string;
  readonly deliveredAt?: string;
  readonly error?: string;
  readonly __version: number;
}

export type NotificationAuditType =
  | 'notification.created'
  | 'notification.read'
  | 'notification.dismissed'
  | 'notification.deleted';

export interface NotificationAuditEvent {
  readonly id: string;
  readonly type: NotificationAuditType;
  readonly notificationId: string;
  readonly tenantId: string;
  readonly recipient: string;
  readonly principalId: string;
  readonly timestamp: string;
  readonly result: 'success';
}

export interface CreateNotificationInput {
  /** Optional; must equal the caller's tenant. */
  readonly tenantId?: string;
  readonly recipient: string;
  readonly type: string;
  readonly title: string;
  readonly body?: string;
  readonly data?: Record<string, unknown>;
  readonly source?: NotificationSource;
  readonly priority?: NotificationPriority;
  readonly channel?: string;
}

export interface NotificationListOptions {
  readonly recipient?: string;
  readonly unread?: boolean;
  readonly type?: string;
  readonly priority?: NotificationPriority;
  readonly sourceType?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface NotificationPage {
  readonly items: readonly Notification[];
  readonly nextCursor?: string;
}
