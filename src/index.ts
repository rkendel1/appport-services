// ============================================================================
// CONSUMER-FACING PUBLIC API
// ============================================================================

// Primary factory for creating unified AppPort Services
export { createServices } from './runtime/unified-services.js';
export type { AppPortServices, CreateServicesOptions } from './runtime/unified-services.js';

// Atomic transaction API
export type { AppPortTransactionContext, AppPortTransactionCollection } from './runtime/transaction.js';

// AppPort Services DSL (appport.toml configuration)
export { parseAppPortConfig } from './runtime/dsl.js';
export type { AppPortConfig } from './runtime/dsl.js';

// Service classes (consumers construct services via createServices)
export { ApiKeyService } from './api-keys/service.js';
export { WebhookService } from './webhooks/service.js';
export { JobService, JobWorker } from './jobs/index.js';

// Domain types
export type {
  ApiKey,
  ApiKeyAuditEvent,
  ApiKeyView,
  CreateApiKeyInput,
  CreatedApiKey,
  RevokeApiKeyInput,
} from './api-keys/models.js';
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
export type {
  Job,
  JobStatus,
  JobSchedule,
  JobAuditEvent,
  CreateJobInput,
  ScheduleRecurringInput,
} from './jobs/index.js';
export type { AuthenticatedPrincipal } from './contract/principals.js';

// HTTP integration
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

// ============================================================================
// INTERNAL EXPORTS - For testing, advanced use, and dependency injection
// (Not part of normal consumer documentation. Consumers should use createServices)
// ============================================================================

// Runtime and store interfaces for advanced use cases
export type { AuditSink, ApiKeyStore, FeltDbServiceRuntime } from './storage/api-keys.js';
export type {
  WebhookEndpointStore,
  WebhookDeliveryStore,
  WebhookAuditSink,
} from './storage/webhooks.js';
export type {
  JobStore,
  JobScheduleStore,
  JobAuditSink,
} from './jobs/index.js';
export type { WebhookSecretStore } from './webhooks/secrets.js';

// Concrete FeltDB implementations (for dependency injection in tests)
export { createFeltDbRuntime, FeltDbApiKeyStore, FeltDbAuditSink, type CreateFeltDbRuntimeOptions, auditCollectionName } from './storage/api-keys.js';
export { FeltDbWebhookEndpointStore, FeltDbWebhookDeliveryStore, FeltDbWebhookAuditSink, webhookAuditCollectionName } from './storage/webhooks.js';
export { EncryptedWebhookSecretStore, InMemoryWebhookSecretStore } from './webhooks/secrets.js';
export { FeltDbJobStore, FeltDbJobScheduleStore, FeltDbJobAuditSink, jobAuditCollectionName } from './jobs/store.js';

// Backward compatibility: single factory for API key service
// (Deprecated: use createServices instead for unified services with one runtime)
import { createFeltDbRuntime as _createFeltDbRuntime, FeltDbApiKeyStore as _FeltDbApiKeyStore, FeltDbAuditSink as _FeltDbAuditSink, type CreateFeltDbRuntimeOptions } from './storage/api-keys.js';
import { ApiKeyService as _ApiKeyService } from './api-keys/service.js';
export function createApiKeyService(options: CreateFeltDbRuntimeOptions = {}): _ApiKeyService {
  const runtime = _createFeltDbRuntime(options);
  return new _ApiKeyService({
    store: new _FeltDbApiKeyStore(runtime.db),
    auditSink: new _FeltDbAuditSink(runtime.db),
    runtime,
  });
}
