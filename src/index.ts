// ============================================================================
// CONSUMER-FACING PUBLIC API
// ============================================================================

// Primary factory for creating unified AppPort Services
export { appport, capabilityRegistry, createCapabilityPlan, CapabilityNotDeclaredError } from './runtime/appport.js';
export type { AppPortApplication, AppPortApiCapability, AppPortCapabilityName, AppPortOptions, AppPortRouteContext, AppPortRouteHandler, AppPortState, AppPortTenantServices, CapabilityPlan } from './runtime/appport.js';
export { createServices } from './runtime/unified-services.js';
export type { AppPortServices, CreateServicesOptions } from './runtime/unified-services.js';

// Atomic transaction API
export type { AppPortTransactionContext, AppPortTransactionCollection } from './runtime/transaction.js';

// AppPort Services DSL (appport.toml configuration)
export { parseAppPortConfig, parseAppPortConfigText, AppPortConfigError } from './runtime/dsl.js';
export type { AppPortConfig, AppPortContractSnapshot, DeploymentMode } from './runtime/dsl.js';
export { AppPortEvents, AppPortTenantContext } from './runtime/platform.js';
export type { AppPortEvent, AppPortHttpRuntime, EventSubscription } from './runtime/platform.js';

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
// NOTE: Internal exports (FeltDB stores, runtime, legacy APIs) are kept in
// src/_internal.ts to enforce the public/private boundary. The compiled
// dist/src/index.js contains ONLY the consumer-facing public API above.
// ============================================================================
