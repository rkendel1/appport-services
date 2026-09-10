import type { CreateFeltDbRuntimeOptions } from './storage/api-keys.js';
import { createFeltDbRuntime, FeltDbApiKeyStore, FeltDbAuditSink } from './storage/api-keys.js';
import { ApiKeyService } from './api-keys/service.js';
import { WebhookService } from './webhooks/service.js';
import { FeltDbWebhookEndpointStore, FeltDbWebhookDeliveryStore, FeltDbWebhookAuditSink } from './storage/webhooks.js';

export { ApiKeyService } from './api-keys/service.js';
export type {
  ApiKey,
  ApiKeyAuditEvent,
  ApiKeyView,
  CreateApiKeyInput,
  CreatedApiKey,
  RevokeApiKeyInput,
} from './api-keys/models.js';
export { WebhookService } from './webhooks/service.js';
export type {
  WebhookEndpoint,
  WebhookEndpointView,
  CreateWebhookEndpointInput,
  DisableWebhookEndpointInput,
  WebhookDelivery,
  WebhookDeliveryView,
  WebhookDeliveryStatus,
  WebhookEvent,
  EmitWebhookEventInput,
  WebhookAuditEvent,
  WebhookDeliveryResult,
} from './webhooks/models.js';
export type { AuthenticatedPrincipal } from './contract/principals.js';
export type { ApiKeysConfig } from './runtime/config.js';
export { authenticateBearerToken } from './runtime/api-keys.js';
export {
  createApiKeyAuth,
  assertTenant,
  AuthenticationError,
  TenantMismatchError,
  RequestContext,
  type HttpRequest,
  type AuthenticationResult,
} from './runtime/http-adapter.js';
export { apiKeyAuth, requireApiKeyAuth } from './runtime/express-middleware.js';
export {
  createFeltDbRuntime,
  FeltDbApiKeyStore,
  FeltDbAuditSink,
  auditCollectionName,
} from './storage/api-keys.js';
export type { AuditSink, ApiKeyStore, FeltDbServiceRuntime } from './storage/api-keys.js';

export function createApiKeyService(options: CreateFeltDbRuntimeOptions = {}): ApiKeyService {
  const runtime = createFeltDbRuntime(options);
  return new ApiKeyService({
    store: new FeltDbApiKeyStore(runtime.db),
    auditSink: new FeltDbAuditSink(runtime.db),
    runtime,
  });
}

export {
  FeltDbWebhookEndpointStore,
  FeltDbWebhookDeliveryStore,
  FeltDbWebhookAuditSink,
  webhookAuditCollectionName,
} from './storage/webhooks.js';
export type {
  WebhookEndpointStore,
  WebhookDeliveryStore,
  WebhookAuditSink,
} from './storage/webhooks.js';
export { EncryptedWebhookSecretStore, InMemoryWebhookSecretStore } from './webhooks/secrets.js';
export type { WebhookSecretStore } from './webhooks/secrets.js';
