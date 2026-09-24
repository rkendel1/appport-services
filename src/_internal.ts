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
export { FeltDbWebhookEndpointStore, FeltDbWebhookDeliveryStore, FeltDbWebhookAuditSink, FeltDbWebhookIntegrationStore, FeltDbInboundWebhookReplayStore, webhookAuditCollectionName } from './storage/webhooks.js';
export { signWebhookPayload, verifyWebhookSignature } from './webhooks/secrets.js';
export { ServiceGateway, FeltDbEffectEvidenceStore } from './authority/index.js';
export { mintVerifiedPrincipal } from './authority/principal.js';
export { evidenceCollectionName } from './authority/evidence.js';
export { FeltDbJobStore, FeltDbJobScheduleStore, FeltDbJobAuditSink, jobAuditCollectionName } from './jobs/store.js';
export { FeltDbNotificationStore, FeltDbNotificationDeliveryStore, FeltDbNotificationAuditSink } from './storage/notifications.js';
export { FeltDbFileStore, FeltDbFileAuditSink, fileCollectionNames } from './storage/files.js';

// Public APIs (exported here for internal tests; also exported from index.ts for consumers)
export { createServices } from './runtime/unified-services.js';
export type { AppPortServices, CreateServicesOptions } from './runtime/unified-services.js';
export type { AppPortTransactionContext, AppPortTransactionCollection } from './runtime/transaction.js';
export { parseAppPortConfig } from './runtime/dsl.js';
export type { AppPortConfig } from './runtime/dsl.js';
export { ApiKeyService, parseApiKeyPrefix } from './api-keys/service.js';
export { WebhookService } from './webhooks/service.js';
export { JobService, JobWorker } from './jobs/index.js';
export { NotificationService, createNotificationRouter, notificationErrorHandler } from './notifications/index.js';
export { FileService, FileAuthorizationError, FileValidationError, FileNotFoundError } from './files/index.js';
export { ScheduleService } from './schedules/index.js';
export { ConfigurationService, createConfigurationRouter, createConfigurationManagementRouter, createConfigurationUiRouter, configurationErrorHandler } from './configuration/index.js';
export { FeltDbConfigurationStore } from './configuration/storage.js';
export type { ConfigurationStore } from './configuration/storage.js';

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
export type { WebhookIntegrationStore, InboundWebhookReplayStore } from './storage/webhooks.js';
export type { NotificationStore, NotificationDeliveryStore, NotificationAuditSink } from './storage/notifications.js';
export type { FileStore, FileAuditSink } from './storage/files.js';

// Legacy factory for backward compatibility
import { createFeltDbRuntime as _createFeltDbRuntime, FeltDbApiKeyStore as _FeltDbApiKeyStore, FeltDbAuditSink as _FeltDbAuditSink, type CreateFeltDbRuntimeOptions } from './storage/api-keys.js';
import { ApiKeyService as _ApiKeyService } from './api-keys/service.js';
import { ServiceGateway as _ServiceGateway } from './authority/gateway.js';
import { FeltDbEffectEvidenceStore as _FeltDbEffectEvidenceStore } from './authority/evidence.js';
import type { ServiceAuthorizer as _ServiceAuthorizer } from './authority/authorizer.js';

export function createApiKeyService(options: CreateFeltDbRuntimeOptions & { readonly application?: string; readonly authorizer?: _ServiceAuthorizer } = {}): _ApiKeyService {
  const { application = 'default', authorizer, ...feltdb } = options;
  const runtime = _createFeltDbRuntime(feltdb);
  return new _ApiKeyService({
    store: new _FeltDbApiKeyStore(runtime.db),
    auditSink: new _FeltDbAuditSink(runtime.db),
    runtime,
    applicationId: application,
    authority: new _ServiceGateway({ application, authorizer, evidence: new _FeltDbEffectEvidenceStore(runtime.db) }),
  });
}
