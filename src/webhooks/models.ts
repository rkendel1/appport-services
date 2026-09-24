import type { CredentialRef } from '../authority/credentials.js';
import type { DurablePrincipal } from '../authority/principal.js';

export type { DurablePrincipal };

export interface WebhookEndpoint {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId?: string;
  /** Destination bound at registration. Deliveries can only go here. */
  readonly url: string;
  readonly events: readonly string[];
  /** Signing credential held in AuthBoundry custody, bound to this destination. */
  readonly signingCredentialRef?: CredentialRef;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly disabledAt?: string;
  readonly __version: number;
}

export type WebhookEndpointView = Omit<WebhookEndpoint, '__version'>;

export interface CreateWebhookEndpointInput {
  readonly tenantId?: string;
  readonly url: string;
  readonly events: readonly string[];
  /** credential-ref:<id> of the signing secret registered in AuthBoundry custody. */
  readonly signingCredentialRef: string;
  /** @deprecated Must equal the verified caller when supplied. */
  readonly createdBy?: string;
}

export interface DisableWebhookEndpointInput {
  readonly tenantId?: string;
  readonly id: string;
  /** @deprecated Must equal the verified caller when supplied. */
  readonly disabledBy?: string;
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
  /** Principal that emitted the event. Every delivery attempt is authorized as this principal. */
  readonly principal?: DurablePrincipal;
  readonly __version: number;
}

export type WebhookDeliveryView = Omit<WebhookDelivery, '__version'>;

export interface WebhookEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface EmitWebhookEventInput {
  readonly tenantId?: string;
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
    | 'webhook.delivery.denied'
    | 'webhook.delivery.replayed'
    | 'webhook.integration.registered'
    | 'webhook.inbound.accepted'
    | 'webhook.inbound.rejected';
  readonly endpointId?: string;
  readonly deliveryId?: string;
  readonly integrationId?: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly timestamp: string;
  readonly result: 'success' | 'failure';
  readonly reason?: string;
}

export interface WebhookDeliveryResult {
  readonly success: boolean;
  readonly statusCode?: number;
  readonly error?: string;
  /** Distinguishes authorization outcomes from provider outcomes. */
  readonly code?: 'DENIED' | 'AUTHORITY_UNAVAILABLE' | 'AUTHORIZATION_TIMEOUT' | 'INVALID_REQUEST' | 'PROVIDER_ERROR';
}

/** An inbound webhook source. The integration, not the webhook payload, is the executing principal. */
export interface WebhookIntegration {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly provider: string;
  /** Always integration:<provider>. */
  readonly principalId: string;
  readonly signingCredentialRef: CredentialRef;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly disabledAt?: string;
  readonly __version: number;
}

export interface RegisterWebhookIntegrationInput {
  readonly tenantId?: string;
  readonly provider: string;
  readonly signingCredentialRef: string;
}

export interface InboundWebhookRequest {
  readonly integrationId: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Exact bytes received; the signature covers these. */
  readonly rawBody: string;
}

export interface InboundWebhookEvent {
  readonly integrationId: string;
  readonly provider: string;
  readonly eventId: string;
  readonly timestamp: string;
  readonly payload: unknown;
}

export interface InboundWebhookResult {
  readonly accepted: boolean;
  readonly eventId: string;
  readonly result?: unknown;
}
