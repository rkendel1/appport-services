export interface WebhookEndpoint {
  readonly id: string;
  readonly tenantId: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly disabledAt?: string;
  readonly __version: number;
}

export interface WebhookEndpointView {
  readonly id: string;
  readonly tenantId: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly disabledAt?: string;
}

export interface CreateWebhookEndpointInput {
  readonly tenantId: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly createdBy: string;
}

export interface DisableWebhookEndpointInput {
  readonly tenantId: string;
  readonly id: string;
  readonly disabledBy: string;
}

export type WebhookDeliveryStatus = 'pending' | 'delivering' | 'delivered' | 'retrying' | 'failed';

export interface WebhookDelivery {
  readonly id: string;
  readonly tenantId: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly status: WebhookDeliveryStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt?: string;
  readonly createdAt: string;
  readonly lastAttemptAt?: string;
  readonly deliveredAt?: string;
  readonly lastStatusCode?: number;
  readonly lastError?: string;
  readonly __version: number;
}

export interface WebhookDeliveryView {
  readonly id: string;
  readonly tenantId: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly status: WebhookDeliveryStatus;
  readonly attemptCount: number;
  readonly nextAttemptAt?: string;
  readonly createdAt: string;
  readonly lastAttemptAt?: string;
  readonly deliveredAt?: string;
  readonly lastStatusCode?: number;
  readonly lastError?: string;
}

export interface WebhookEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface EmitWebhookEventInput {
  readonly tenantId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

export interface WebhookAuditEvent {
  readonly id: string;
  readonly type:
    | 'webhook.endpoint.created'
    | 'webhook.endpoint.disabled'
    | 'webhook.delivery.created'
    | 'webhook.delivery.delivered'
    | 'webhook.delivery.failed'
    | 'webhook.delivery.replayed';
  readonly endpointId?: string;
  readonly deliveryId?: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly timestamp: string;
  readonly result: 'success' | 'failure';
}

export interface WebhookDeliveryResult {
  readonly success: boolean;
  readonly statusCode?: number;
  readonly error?: string;
}
