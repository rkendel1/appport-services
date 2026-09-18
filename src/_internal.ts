// ============================================================================
// INTERNAL-ONLY EXPORTS
// ============================================================================
// This file is NOT exported through package.json "exports".
// It exists only for monorepo internal tests, CLI, and infrastructure code.
//
// CONSUMERS: Do not import from this file. It is not part of the public API.
// Use createServices() from "@appport/services" instead.
// ============================================================================

// Internal infrastructure (FeltDB runtime, stores, factories)
export { createFeltDbRuntime, FeltDbApiKeyStore, FeltDbAuditSink, type CreateFeltDbRuntimeOptions, auditCollectionName } from './storage/api-keys.js';
export { FeltDbWebhookEndpointStore, FeltDbWebhookDeliveryStore, FeltDbWebhookAuditSink, webhookAuditCollectionName } from './storage/webhooks.js';
export { EncryptedWebhookSecretStore, InMemoryWebhookSecretStore } from './webhooks/secrets.js';
export { FeltDbJobStore, FeltDbJobScheduleStore, FeltDbJobAuditSink, jobAuditCollectionName } from './jobs/store.js';

// Public APIs (exported here for internal tests; also exported from index.ts for consumers)
export { createServices } from './runtime/unified-services.js';
export type { AppPortServices, CreateServicesOptions } from './runtime/unified-services.js';
export type { AppPortTransactionContext, AppPortTransactionCollection } from './runtime/transaction.js';
export { parseAppPortConfig } from './runtime/dsl.js';
export type { AppPortConfig } from './runtime/dsl.js';
export { ApiKeyService, parseApiKeyPrefix } from './api-keys/service.js';
export { WebhookService } from './webhooks/service.js';
export { JobService, JobWorker } from './jobs/index.js';

// Public HTTP integration APIs (exported here for internal tests)
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

// Type definitions for internal use
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

// Legacy factory for backward compatibility
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
