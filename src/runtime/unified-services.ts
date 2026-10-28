import type { FeltDBOptions, StateFirstDB } from '@feltdb/core';
import { createFeltDbRuntime, FeltDbApiKeyStore, FeltDbAuditSink } from '../storage/api-keys.js';
import { ApiKeyService } from '../api-keys/service.js';
import { WebhookService } from '../webhooks/service.js';
import { FeltDbWebhookEndpointStore, FeltDbWebhookDeliveryStore, FeltDbWebhookAuditSink, FeltDbWebhookIntegrationStore, FeltDbInboundWebhookReplayStore } from '../storage/webhooks.js';
import type { ServiceAuthorizer } from '../authority/authorizer.js';
import type { ServiceExecutionContext, ServiceResource } from '../authority/context.js';
import type { WebhookDestinationPolicy } from '../authority/destination.js';
import { FeltDbEffectEvidenceStore, createEvidenceReader, type EffectEvidenceReader } from '../authority/evidence.js';
import { ServiceGateway } from '../authority/gateway.js';
import { SERVICE_CAPABILITY_MANIFEST, type ServiceCapability } from '../authority/manifest.js';
import { requireVerifiedPrincipal, type PrincipalClaims, type VerifiedPrincipal } from '../authority/principal.js';
import { isSecretCustody, type ScopedSecretsResolver, type SecretCustody } from '../secrets/protocol.js';
import { FeltDbSecretMetadataStore } from '../storage/secrets.js';
import { invokeService } from './invoke.js';
import { JobService } from '../jobs/service.js';
import { FeltDbJobStore, FeltDbJobScheduleStore, FeltDbJobAuditSink } from '../jobs/store.js';
import { TransactionBuilder } from './transaction.js';
import { TransactionContextImpl } from './transaction-services.js';
import { parseAppPortConfig, type AppPortConfig } from './dsl.js';
import { ConfigurationService } from '../configuration/service.js';
import { FeltDbConfigurationStore } from '../configuration/storage.js';
import { IntelligenceService } from '../intelligence/service.js';
import { NotificationService } from '../notifications/service.js';
import { FeltDbNotificationAuditSink, FeltDbNotificationDeliveryStore, FeltDbNotificationStore } from '../storage/notifications.js';
import { FileService } from '../files/service.js';
import { FeltDbFileAuditSink, FeltDbFileStore } from '../storage/files.js';
import { ScheduleService } from '../schedules/service.js';
import { describeCapabilities, type RuntimeCapabilityDescriptor } from './discovery.js';
import { collectHealth, type AppPortServicesHealth, type ServiceHealthOptions } from './health.js';
import type { ConfigurationDeclaration } from '../configuration/models.js';
import { VERSION } from '../version.js';

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
  /** Canonical provider/model/endpoint/credential configuration. Configuration only; never executes a model. */
  readonly intelligence: IntelligenceService;
  readonly notifications: NotificationService;
  readonly files: FileService;
  readonly schedules: ScheduleService;
  /** The Policy Enforcement Point every service effect passes through. */
  readonly gateway: ServiceGateway;
  /** Deterministic capability manifest. */
  readonly capabilities: readonly ServiceCapability[];
  /** Capability discovery derived from the mounted implementation. */
  readonly discovery: readonly RuntimeCapabilityDescriptor[];

  /**
   * The FeltDB instance every service runs on: the one passed as
   * `createServices({ db })` (local, memory, or remote), else the one
   * `createServices()` opened and owns. Read-only; it is the same object for
   * the life of this services instance.
   */
  readonly db: StateFirstDB;
  /** True only for the very instance the services run on (identity, not configuration equality). */
  usesInstance(db: unknown): boolean;
  /** True when `createServices()` opened the instance itself (and `apiKeys.close()` closes it); false for a host-supplied `db`. */
  readonly ownsDb: boolean;

  /** Read side of the effect evidence the gateway records. See docs/AUTHORITY.md#evidence. */
  readonly evidence: EffectEvidenceReader;

  /**
   * Per-service state and the counts needing attention, from bounded queries
   * over durable state. A trusted, in-process host API (like the services'
   * observation methods): it is not authorized per caller and returns counts
   * only, never records. See docs/health.md.
   */
  health(options?: ServiceHealthOptions): Promise<AppPortServicesHealth>;

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
   * @internal Test-only. @deprecated Use `db` / `usesInstance(db)`.
   */
  readonly ['_getDb']?: unknown;
}

/**
 * Options for creating AppPort Services.
 */
export interface CreateServicesOptions extends FeltDBOptions {
  /**
   * Use this FeltDB instance instead of opening one. Every service's stores, the
   * effect evidence, and `transaction()` then run on the host's instance, so the
   * application and its services share one source of truth. The host keeps
   * ownership: AppPort Services never closes an instance it was given.
   */
  db?: StateFirstDB;
  /**
   * Optional path to appport.toml DSL configuration.
   * If provided, configuration values override defaults.
   */
  config?: string;
  /** Application identity. Defaults to appport.toml application.name, else the namespace, else "default". */
  application?: string;
  /** AuthBoundry client. Without it every service effect fails closed. */
  authorizer?: ServiceAuthorizer;
  /**
   * Credential custody, supplied by the host. A `ScopedSecretsResolver` only
   * resolves credentials for authorized effects. A `SecretCustody` (a resolver
   * with `store` and `status`, see `isSecretCustody`) also lets
   * `credential.store` hand it a value and `credential.status` / `health()`
   * report whether material exists. AppPort Services keeps no material either
   * way: values are never FeltDB fields.
   */
  credentials?: ScopedSecretsResolver | SecretCustody;
  authorizationTimeoutMs?: number;
  /** Trusted host-only destination policy override (local development, tests). */
  webhookDestinationPolicy?: WebhookDestinationPolicy;
  /** Server-held API-key verifier key (>= 32 bytes) from the host's secret manager. Never persisted. */
  apiKeyVerifierKey?: string | Uint8Array;
  /** Configuration the application declares; `required` ones without a binding are reported by `health()`. */
  configurationDeclarations?: readonly ConfigurationDeclaration[];
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
  const { config: _unused, application, authorizer, credentials, authorizationTimeoutMs, webhookDestinationPolicy, apiKeyVerifierKey, configurationDeclarations, ...feltdbOptions } = options;
  const runtime = createFeltDbRuntime(feltdbOptions);
  const { db } = runtime;
  const evidenceStore = new FeltDbEffectEvidenceStore(db);
  const gateway = new ServiceGateway({
    application: application ?? dslConfig?.application.name ?? feltdbOptions.namespace ?? 'default',
    authorizer,
    credentials,
    evidence: evidenceStore,
    authorizationTimeoutMs,
  });
  const authority = authorizer || credentials ? gateway : undefined;

  const apiKeyService = new ApiKeyService({
    store: new FeltDbApiKeyStore(db),
    auditSink: new FeltDbAuditSink(db),
    runtime,
    applicationId: gateway.application,
    authority,
    ...(apiKeyVerifierKey ? { verifierKey: apiKeyVerifierKey } : {}),
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
  const scheduleService = new ScheduleService({ jobs: jobService, ...(authority ? { authority } : {}) });
  const configurationStore = new FeltDbConfigurationStore(db);
  const configurationService = new ConfigurationService({
    store: configurationStore,
    ...(configurationDeclarations ? { declarations: configurationDeclarations } : {}),
    transfer: { webhooks: webhookService, schedules: scheduleService },
    secretMetadata: new FeltDbSecretMetadataStore(db),
    ...(authority ? { authority } : {}),
  });
  const intelligenceService = new IntelligenceService({ store: configurationStore, ...(authority ? { authority } : {}) });
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
  const invokable = {
    gateway,
    apiKeys: apiKeyService,
    webhooks: webhookService,
    jobs: jobService,
    configuration: configurationService,
    intelligence: intelligenceService,
    notifications: notificationService,
    files: fileService,
    schedules: scheduleService,
  };

  const services: AppPortServices = {
    ...invokable,
    capabilities: SERVICE_CAPABILITY_MANIFEST,
    discovery: describeCapabilities({
      apikeys: true,
      webhooks: true,
      jobs: true,
      schedules: true,
      notifications: true,
      files: true,
      configuration: true,
      credentials: true,
      intelligence: true,
      secrets: false,
      'runtime-events': false,
    }),
    db,
    ownsDb: runtime.owned,
    usesInstance: (candidate) => candidate === db,
    evidence: createEvidenceReader(evidenceStore, gateway.application),
    health: (healthOptions) => collectHealth({
      db,
      application: gateway.application,
      version: VERSION,
      authorizer: Boolean(authorizer),
      credentials: Boolean(credentials),
      ...(isSecretCustody(credentials) ? { custody: credentials } : {}),
      declarations: configurationService.declarations,
    }, healthOptions),
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
  // The instance in use never changes: assigning `db` or `ownsDb` throws in strict mode.
  Object.defineProperty(services, 'db', { value: db, writable: false, configurable: false, enumerable: true });
  Object.defineProperty(services, 'ownsDb', { value: runtime.owned, writable: false, configurable: false, enumerable: true });
  return services;
}
