import type { FeltDBOptions } from '@feltdb/core';
import { createFeltDbRuntime, FeltDbApiKeyStore, FeltDbAuditSink } from '../storage/api-keys.js';
import { ApiKeyService } from '../api-keys/service.js';
import { WebhookService } from '../webhooks/service.js';
import { FeltDbWebhookEndpointStore, FeltDbWebhookDeliveryStore, FeltDbWebhookAuditSink, FeltDbWebhookIntegrationStore, FeltDbInboundWebhookReplayStore } from '../storage/webhooks.js';
import type { ServiceAuthorizer } from '../authority/authorizer.js';
import type { ServiceExecutionContext, ServiceResource } from '../authority/context.js';
import type { WebhookDestinationPolicy } from '../authority/destination.js';
import { FeltDbEffectEvidenceStore } from '../authority/evidence.js';
import { ServiceGateway } from '../authority/gateway.js';
import { SERVICE_CAPABILITY_MANIFEST, type ServiceCapability } from '../authority/manifest.js';
import { requireVerifiedPrincipal, type PrincipalClaims, type VerifiedPrincipal } from '../authority/principal.js';
import type { ScopedSecretsResolver } from '../secrets/protocol.js';
import { invokeService } from './invoke.js';
import { JobService } from '../jobs/service.js';
import { FeltDbJobStore, FeltDbJobScheduleStore, FeltDbJobAuditSink } from '../jobs/store.js';
import { TransactionBuilder } from './transaction.js';
import { TransactionContextImpl } from './transaction-services.js';
import { parseAppPortConfig, type AppPortConfig } from './dsl.js';
import { ConfigurationService } from '../configuration/service.js';
import { FeltDbConfigurationStore } from '../configuration/storage.js';
import { NotificationService } from '../notifications/service.js';
import { FeltDbNotificationAuditSink, FeltDbNotificationDeliveryStore, FeltDbNotificationStore } from '../storage/notifications.js';
import { FileService } from '../files/service.js';
import { FeltDbFileAuditSink, FeltDbFileStore } from '../storage/files.js';
import { ScheduleService } from '../schedules/service.js';

/**
 * Unified AppPort Services instance.
 * All three services share a single FeltDB runtime.
 * The application uses this object to access API Keys, Webhooks, and Jobs.
 */
export interface AppPortServices {
  readonly apiKeys: ApiKeyService;
  readonly webhooks: WebhookService;
  readonly jobs: JobService;
  readonly configuration: ConfigurationService;
  readonly notifications: NotificationService;
  readonly files: FileService;
  readonly schedules: ScheduleService;
  /** The Policy Enforcement Point every service effect passes through. */
  readonly gateway: ServiceGateway;
  /** Deterministic capability manifest. */
  readonly capabilities: readonly ServiceCapability[];

  /** The safe service API: AuthBoundry authorizes, then the effect runs. */
  invoke(capability: string, input: Record<string, unknown>, options: { readonly principal: VerifiedPrincipal }): Promise<unknown>;
  /** Pre-authorize one transactional effect; the context is single-use. */
  authorize(capability: string, principal: VerifiedPrincipal, resource: Omit<ServiceResource, 'tenantId'> & { readonly tenantId?: string }): Promise<ServiceExecutionContext>;
  /** Brand identity claims from a trusted host authentication adapter. */
  identify(claims: PrincipalClaims | null | undefined): VerifiedPrincipal | null;

  /**
   * Execute application and AppPort operations atomically.
   *
   * All operations in the callback are collected and executed in a single
   * FeltDB transaction. Either all succeed together or all roll back.
   *
   * @param callback Receives a context for queuing operations
   * @returns Result of the callback
   */
  transaction<T>(callback: (tx: TransactionContextImpl) => Promise<T>): Promise<T>;

  /**
   * @internal Test-only: Access to underlying FeltDB instance for verification
   */
  readonly ['_getDb']?: unknown;
}

/**
 * Options for creating AppPort Services.
 */
export interface CreateServicesOptions extends FeltDBOptions {
  /**
   * Optional path to appport.toml DSL configuration.
   * If provided, configuration values override defaults.
   */
  config?: string;
  /** Application identity. Defaults to appport.toml application.name, else the namespace, else "default". */
  application?: string;
  /** AuthBoundry client. Without it every service effect fails closed. */
  authorizer?: ServiceAuthorizer;
  /** AuthBoundry credential custody. */
  credentials?: ScopedSecretsResolver;
  authorizationTimeoutMs?: number;
  /** Trusted host-only destination policy override (local development, tests). */
  webhookDestinationPolicy?: WebhookDestinationPolicy;
}

/**
 * Create a unified AppPort Services instance.
 *
 * All services share the same underlying FeltDB runtime and database.
 * This ensures atomic composition: invoice creation, webhook delivery intent,
 * and job enqueue can all happen within one durable transaction.
 *
 * @param options FeltDB runtime configuration (mode, namespace, path, etc.) and optional config path
 * @returns AppPortServices with apiKeys, webhooks, and jobs
 */
export function createServices(options: CreateServicesOptions = {}): AppPortServices {
  // Parse DSL configuration if provided
  let dslConfig: AppPortConfig | undefined;
  if (options.config) {
    dslConfig = parseAppPortConfig(options.config);
  }

  // Create one FeltDB runtime shared by all services
  // Extract FeltDB options (exclude config)
  const { config: _unused, application, authorizer, credentials, authorizationTimeoutMs, webhookDestinationPolicy, ...feltdbOptions } = options;
  const runtime = createFeltDbRuntime(feltdbOptions);
  const { db } = runtime;
  const gateway = new ServiceGateway({
    application: application ?? dslConfig?.application.name ?? feltdbOptions.namespace ?? 'default',
    authorizer,
    credentials,
    evidence: new FeltDbEffectEvidenceStore(db),
    authorizationTimeoutMs,
  });
  const authority = authorizer || credentials ? gateway : undefined;

  const apiKeyService = new ApiKeyService({
    store: new FeltDbApiKeyStore(db),
    auditSink: new FeltDbAuditSink(db),
    runtime,
    applicationId: gateway.application,
    authority,
  });

  const webhookService = new WebhookService({
    endpointStore: new FeltDbWebhookEndpointStore(db),
    deliveryStore: new FeltDbWebhookDeliveryStore(db),
    auditSink: new FeltDbWebhookAuditSink(db),
    integrationStore: new FeltDbWebhookIntegrationStore(db),
    replayStore: new FeltDbInboundWebhookReplayStore(db),
    destinationPolicy: webhookDestinationPolicy,
    authority,
  });

  const jobService = new JobService({
    jobStore: new FeltDbJobStore(db),
    scheduleStore: new FeltDbJobScheduleStore(db),
    auditSink: new FeltDbJobAuditSink(db),
    ...(authority ? { authority } : {}),
  });
  const configurationService = new ConfigurationService({ store: new FeltDbConfigurationStore(db), ...(authority ? { authority } : {}) });
  const notificationService = new NotificationService({
    store: new FeltDbNotificationStore(db),
    deliveryStore: new FeltDbNotificationDeliveryStore(db),
    auditSink: new FeltDbNotificationAuditSink(db),
    jobs: jobService,
    authority: gateway,
  });
  const fileService = new FileService({
    store: new FeltDbFileStore(db),
    auditSink: new FeltDbFileAuditSink(db),
    ...(authority ? { authority } : {}),
  });
  const scheduleService = new ScheduleService({ jobs: jobService, ...(authority ? { authority } : {}) });
  const invokable = {
    gateway,
    apiKeys: apiKeyService,
    webhooks: webhookService,
    jobs: jobService,
    configuration: configurationService,
    notifications: notificationService,
    files: fileService,
    schedules: scheduleService,
  };

  return {
    ...invokable,
    capabilities: SERVICE_CAPABILITY_MANIFEST,
    invoke: (capability, input, invokeOptions) => invokeService(invokable, capability, input, invokeOptions),
    authorize: (capability, principal, resource) => {
      const verified = requireVerifiedPrincipal(principal);
      return gateway.authorize(capability, verified, { ...resource, tenantId: resource.tenantId ?? verified.tenantId });
    },
    identify: (claims) => gateway.identify(claims),

    /**
     * Execute application and AppPort operations in a single atomic transaction.
     */
    async transaction<T>(callback: (tx: TransactionContextImpl) => Promise<T>): Promise<T> {
      const builder = new TransactionBuilder();
      const context = new TransactionContextImpl(builder, gateway, (tenantId) => webhookService.listWebhookEndpoints(tenantId));

      // Execute callback to collect operations, then wait for queued validations
      const result = await callback(context);
      await context._settle();

      // Commit all operations in a single FeltDB transaction
      await builder.commit(db);

      return result;
    },

    /**
     * @internal Test-only access to database
     */
    ['_getDb']: db,
  };
}
