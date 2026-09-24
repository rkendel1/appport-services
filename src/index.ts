// ============================================================================
// CONSUMER-FACING PUBLIC API
// ============================================================================

// Primary factory for creating unified AppPort Services
export { appport, capabilityRegistry, createCapabilityPlan, CapabilityNotDeclaredError } from './runtime/appport.js';
export type { AppPortApplication, AppPortJobHandler, CapabilityFactoryContext, AppPortApiCapability, AppPortApiKeys, AppPortCapabilityName, AppPortJobs, AppPortNotifications, AppPortOptions, AppPortRouteContext, AppPortRouteHandler, AppPortState, AppPortStateCollection, AppPortTenantServices, AppPortWebhooks, CapabilityPlan } from './runtime/appport.js';
export { createServices } from './runtime/unified-services.js';
export type { AppPortServices, CreateServicesOptions } from './runtime/unified-services.js';

// Authority boundary: AppPort Services is a Policy Enforcement Point, not an authority.
export {
  SERVICE_CAPABILITY_MANIFEST, LEGACY_SCOPE_MIGRATION, getServiceCapability, serviceCapabilityManifestDigest,
  ServiceAuthorityError, ServiceMigrationError, isServiceAuthorityError,
  ServiceGateway, FeltDbEffectEvidenceStore, assertEvidenceHasNoSecrets,
  isVerifiedPrincipal, requireVerifiedPrincipal, isExecutionContext, assertExecutionContext,
  isCredentialRef, formatCredentialRef, validateDestination, isForbiddenAddress,
} from './authority/index.js';
export type {
  ServiceCapability, ServiceCapabilityName, ServiceEffect, ServiceFailureCode,
  ServiceAuthorizer, ServiceAuthorizationRequest, ServiceAuthorizationDecision, AuthorizationSubject, AuthorizationResource,
  VerifiedPrincipal, PrincipalClaims, PrincipalVerification, ServiceExecutionContext, ServiceResource, AuthorizationEvidence,
  CredentialRef, EffectEvidence, EffectEvidenceStore, EffectOutcome, ServiceGatewayOptions, ExecuteOptions, EffectTools,
  WebhookDestinationPolicy, ValidatedDestination, ResolvedAddress,
} from './authority/index.js';
export { invokeService } from './runtime/invoke.js';
export type { InvokableServices, InvokeOptions } from './runtime/invoke.js';
export type { JobExecution } from './jobs/service.js';
export type { InboundWebhookHandler, InboundWebhookHandlerInput } from './webhooks/service.js';
export { ApiKeyScopesNotSupportedError } from './api-keys/service.js';

// Atomic transaction API
export type { AppPortTransactionContext, AppPortTransactionCollection } from './runtime/transaction.js';

// AppPort Services DSL (appport.toml configuration)
export { parseAppPortConfig, parseAppPortConfigText, AppPortConfigError } from './runtime/dsl.js';
export type { AppPortConfig, AppPortContractSnapshot, DeploymentMode } from './runtime/dsl.js';
export { AppPortEvents, AppPortTenantContext } from './runtime/platform.js';
export type { AppPortEvent, AppPortHttpRuntime, EventSubscription } from './runtime/platform.js';
export {
  API_KEY_MANAGEMENT_CAPABILITIES, APPPORT_UI_CONTRIBUTIONS,
  createManagementRouter, managementErrorHandler,
  ManagementAuthenticationError, ManagementAuthorizationError,
} from './runtime/management.js';
export type {
  ApiKeyManagementCapability, CreateManagementRouterOptions, ManagementAuthenticationAdapter,
  ManagementAuthorizationAdapter, ManagementAuthorizationContext, ManagementAuthorizationResult, ManagementServices,
} from './runtime/management.js';

// Service classes (consumers construct services via createServices)
export { ApiKeyService } from './api-keys/service.js';
export { WebhookService } from './webhooks/service.js';
export { JobService, JobWorker } from './jobs/index.js';
export { NotificationService, NotificationAuthorizationError, NotificationValidationError, NotificationNotFoundError, NotificationSensitiveDataError, NOTIFICATION_DELIVERY_JOB } from './notifications/index.js';
export { NotificationChannelRegistry, InAppNotificationChannel, BrowserNotificationChannel, BROWSER_NOTIFICATION_EVENT, assertNoCredentials } from './notifications/index.js';
export { createNotificationRouter, notificationErrorHandler } from './notifications/index.js';
export { FeltDbNotificationStore, FeltDbNotificationDeliveryStore, FeltDbNotificationAuditSink } from './storage/notifications.js';
export { FileService, FileAuthorizationError, FileValidationError, FileNotFoundError } from './files/index.js';
export { FeltDbFileStore, FeltDbFileAuditSink } from './files/index.js';
export { ScheduleService, ScheduleAuthorizationError, ScheduleValidationError } from './schedules/index.js';
export {
  ConfigurationService, ConfigurationAuthorizationError, ConfigurationValidationError,
  createConfigurationRouter, createConfigurationManagementRouter, createConfigurationUiRouter, configurationErrorHandler,
} from './configuration/index.js';
export type {
  ConfigurationEnvironment, ConfigurationKind, ConfigurationScope, ConfigurationVariableView,
  ConfigurationSecretView, ConfigurationDeclaration, ConfigurationList, ConfigurationAuditEvent,
} from './configuration/index.js';
export type { Secret, SecretVersion, SecretMetadata, SecretStatus, SecretVersionStatus, SecretAuditEvent, RegisterSecretInput, RotateSecretInput, SecretOperationInput, ResolveSecretInput, SecretReference, SecretResolutionContext, ScopedResolveSecretInput, ResolvedSecret, SecretResolutionFailureCode, SecretsProtocol, ScopedSecretsResolver } from './secrets/index.js';
export {
  SecretError, SecretNotFoundError, SecretRevokedError, SecretExpiredError, SecretResolutionDeniedError,
  SecretProviderUnavailableError, InvalidSecretReferenceError, InvalidSecretLifecycleOperationError,
  SecretTenantMismatchError, SecretInactiveError, SecretProviderMismatchError, SecretUnavailableError, SecretInternalError,
} from './secrets/index.js';

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
  WebhookIntegration,
  RegisterWebhookIntegrationInput,
  InboundWebhookRequest,
  InboundWebhookEvent,
  InboundWebhookResult,
  DurablePrincipal,
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
export type {
  Notification, NotificationDelivery, NotificationAuditEvent, NotificationAuditType, NotificationPriority, NotificationSource, NotificationStatus,
  NotificationDeliveryStatus, CreateNotificationInput, NotificationListOptions, NotificationPage, NotificationResult, NotificationServiceOptions,
  NotificationChannel, NotificationDeliveryResult, BrowserNotificationMessage, BrowserNotificationTransport,
} from './notifications/index.js';
export type { File, FileAuditEvent, CreateFileInput, UpdateFileInput } from './files/index.js';
export type { Schedule, CreateScheduleInput } from './schedules/index.js';
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
