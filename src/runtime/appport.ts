import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { parseFlowSpec, validateFlowSpec, type FeltDBOptions, type FlowSpec, type StateFirstDB } from '@feltdb/core';
import type { IncomingMessage } from 'node:http';

import { ApiKeyService } from '../api-keys/service.js';
import { JobService } from '../jobs/service.js';
import { FeltDbJobAuditSink, FeltDbJobScheduleStore, FeltDbJobStore } from '../jobs/store.js';
import { FeltDbApiKeyStore, FeltDbAuditSink, createFeltDbRuntime } from '../storage/api-keys.js';
import { FeltDbInboundWebhookReplayStore, FeltDbWebhookAuditSink, FeltDbWebhookDeliveryStore, FeltDbWebhookEndpointStore, FeltDbWebhookIntegrationStore } from '../storage/webhooks.js';
import { WebhookService, type InboundWebhookHandler } from '../webhooks/service.js';
import type { InboundWebhookRequest, InboundWebhookResult } from '../webhooks/models.js';
import { ServiceGateway } from '../authority/gateway.js';
import { FeltDbEffectEvidenceStore } from '../authority/evidence.js';
import type { ServiceAuthorizer } from '../authority/authorizer.js';
import type { ServiceExecutionContext, ServiceResource } from '../authority/context.js';
import type { WebhookDestinationPolicy } from '../authority/destination.js';
import { ServiceAuthorityError } from '../authority/errors.js';
import { SERVICE_CAPABILITY_MANIFEST, type ServiceCapability } from '../authority/manifest.js';
import { requireVerifiedPrincipal, type PrincipalClaims, type VerifiedPrincipal } from '../authority/principal.js';
import type { ScopedSecretsResolver } from '../secrets/protocol.js';
import type { JobExecution } from '../jobs/service.js';
import { invokeService } from './invoke.js';
import { assertApplicationCollection } from '../authority/reserved.js';
import { NotificationService } from '../notifications/service.js';
import { FeltDbNotificationAuditSink, FeltDbNotificationDeliveryStore, FeltDbNotificationStore } from '../storage/notifications.js';
import { FileService } from '../files/service.js';
import { FeltDbFileAuditSink, FeltDbFileStore } from '../storage/files.js';
import { parseAppPortConfig, type AppPortConfig, type AppPortContractSnapshot } from './dsl.js';
import { AppPortEvents, AppPortTenantContext, startHttpRuntime, type AppPortHttpRuntime } from './platform.js';
import { TransactionContextImpl } from './transaction-services.js';
import { TransactionBuilder } from './transaction.js';
import { ScheduleService } from '../schedules/service.js';

export type AppPortCapabilityName = 'api' | 'webhooks' | 'jobs' | 'secrets' | 'notifications' | 'files';

export interface CapabilityPlan {
  readonly capabilities: readonly AppPortCapabilityName[];
  readonly config: AppPortConfig;
  readonly flow?: FlowSpec;
}

export interface AppPortOptions extends FeltDBOptions {
  /** Contract path. Defaults to appport.toml in the current working directory. */
  readonly config?: string;
  /** Authoritative FeltDB contract. Defaults to feltdb.flow beside appport.toml. */
  readonly flow?: string;
  readonly routes?: Readonly<Record<string, AppPortRouteHandler>>;
  readonly jobs?: Readonly<Record<string, AppPortJobHandler>>;
  readonly webhooks?: Readonly<Record<string, (event: import('./platform.js').AppPortEvent<Record<string, unknown>>) => void | Promise<void>>>;
  /** Inbound webhook handlers by integration provider. They run as integration:<provider>. */
  readonly inbound?: Readonly<Record<string, InboundWebhookHandler>>;
  /** @deprecated Use jobs. */
  readonly jobHandlers?: Readonly<Record<string, AppPortJobHandler>>;
  /** AuthBoundry client. Every service effect is authorized through it; without it effects fail closed. */
  readonly authorizer?: ServiceAuthorizer;
  /** AuthBoundry credential custody used to resolve provider credentials after authorization. */
  readonly credentials?: ScopedSecretsResolver;
  /** Trusted host authentication adapter for non-API-key identities (sessions, SSO). */
  readonly identify?: (request: IncomingMessage) => PrincipalClaims | null | Promise<PrincipalClaims | null>;
  readonly authorizationTimeoutMs?: number;
  /** Trusted host-only override for local development (e.g. allowPrivateNetworks). */
  readonly webhookDestinationPolicy?: WebhookDestinationPolicy;
}

export type AppPortJobHandler = (job: import('../jobs/models.js').Job, execution: JobExecution) => Promise<void>;

export interface AppPortRouteContext { readonly application: AppPortApplication; readonly services: AppPortTenantServices; readonly request: IncomingMessage; readonly body: unknown; readonly tenantId: string; readonly principal: import('../contract/principals.js').AuthenticatedPrincipal | null }
export type AppPortRouteHandler = (context: AppPortRouteContext) => unknown | Promise<unknown>;
export interface AppPortApiKeys extends Pick<ApiKeyService, 'createApiKey' | 'listApiKeys' | 'getApiKey' | 'revokeApiKey' | 'authenticateApiKey'> {}
export interface AppPortWebhooks extends Pick<WebhookService, 'createWebhookEndpoint' | 'getWebhookEndpoint' | 'listWebhookEndpoints' | 'disableWebhookEndpoint' | 'emitWebhookEvent' | 'getWebhookDelivery' | 'listWebhookDeliveries' | 'replayWebhookDelivery'> {}
export interface AppPortJobs extends Pick<JobService, 'enqueue' | 'schedule' | 'scheduleRecurring' | 'getJob' | 'listJobs' | 'getSchedule' | 'listSchedules' | 'disableSchedule' | 'retry'> {}
export interface AppPortNotifications extends Pick<NotificationService, 'create' | 'get' | 'list' | 'markRead' | 'dismiss' | 'delete' | 'deliveries'> {}
export interface AppPortFiles extends Pick<FileService, 'create' | 'get' | 'list' | 'update' | 'delete'> {}
export interface AppPortSchedules extends Pick<ScheduleService, 'create' | 'get' | 'list' | 'disable'> {}
/**
 * Tenant-bound helpers for route handlers. Every consequential call takes the
 * verified principal; the tenant must be the principal's own.
 */
export interface AppPortTenantServices {
  readonly api: { readonly keys: {
    createApiKey(input: Omit<import('../api-keys/models.js').CreateApiKeyInput, 'tenantId'>, principal: VerifiedPrincipal): ReturnType<ApiKeyService['createApiKey']>;
    listApiKeys(principal: VerifiedPrincipal): ReturnType<ApiKeyService['listApiKeys']>;
    getApiKey(id: string, principal: VerifiedPrincipal): ReturnType<ApiKeyService['getApiKey']>;
    revokeApiKey(input: Omit<import('../api-keys/models.js').RevokeApiKeyInput, 'tenantId'>, principal: VerifiedPrincipal): ReturnType<ApiKeyService['revokeApiKey']>;
  } };
  readonly webhooks: {
    createWebhookEndpoint(input: Omit<import('../webhooks/models.js').CreateWebhookEndpointInput, 'tenantId'>, principal: VerifiedPrincipal): ReturnType<WebhookService['createWebhookEndpoint']>;
    listWebhookEndpoints(principal: VerifiedPrincipal): ReturnType<WebhookService['listWebhookEndpoints']>;
    emitWebhookEvent(input: Omit<import('../webhooks/models.js').EmitWebhookEventInput, 'tenantId'>, principal: VerifiedPrincipal): ReturnType<WebhookService['emitWebhookEvent']>;
  };
  readonly jobs: {
    enqueue(input: Omit<import('../jobs/models.js').CreateJobInput, 'tenantId'>, principal: VerifiedPrincipal): ReturnType<JobService['enqueue']>;
    listJobs(principal: VerifiedPrincipal): ReturnType<JobService['listJobs']>;
  };
  readonly files: {
    create(input: Omit<import('../files/models.js').CreateFileInput, 'tenantId'>, principal: VerifiedPrincipal): ReturnType<FileService['create']>;
    list(principal: VerifiedPrincipal): ReturnType<FileService['list']>;
  };
  readonly schedules: {
    create(input: Omit<import('../schedules/models.js').CreateScheduleInput, 'tenantId' | 'createdBy'>, principal: VerifiedPrincipal): ReturnType<ScheduleService['create']>;
    list(principal: VerifiedPrincipal): ReturnType<ScheduleService['list']>;
  };
  invoke(capability: string, input: Record<string, unknown>, principal: VerifiedPrincipal): Promise<unknown>;
  publish<T extends Record<string, unknown>>(type: string, data: T, principal?: VerifiedPrincipal): Promise<import('./platform.js').AppPortEvent<T>>;
}
export interface AppPortState {
  collection<T>(name: string): AppPortStateCollection<T>;
  subscribe<T>(collection: string, handler: (items: T[]) => void): () => void;
}
export interface AppPortStateCollection<T> { get(id: string | number): Promise<T | null>; list(): Promise<T[]>; find(query?: Partial<T>): Promise<T[]>; insert(data: Partial<T>, id?: string | number): Promise<string>; update(id: string | number, changes: Partial<T>): Promise<void>; delete(id: string | number): Promise<void>; subscribe(handler: (items: T[]) => void): () => void }

export interface AppPortApiCapability {
  readonly keys: AppPortApiKeys;
}

export interface AppPortApplication {
  readonly plan: CapabilityPlan;
  readonly contract: AppPortContractSnapshot;
  readonly api: AppPortApiCapability;
  readonly webhooks: AppPortWebhooks;
  readonly jobs: AppPortJobs;
  readonly notifications: AppPortNotifications;
  readonly files: AppPortFiles;
  readonly schedules: AppPortSchedules;
  readonly events: AppPortEvents;
  readonly state: AppPortState;
  readonly tenant: AppPortTenantContext;
  readonly http?: AppPortHttpRuntime;
  /** Deterministic capability manifest AppPort/AuthBoundry evaluate against. */
  readonly capabilities: readonly ServiceCapability[];
  /** The Policy Enforcement Point every service effect passes through. */
  readonly gateway: ServiceGateway;
  start(): Promise<void>;
  /** The safe service API: authorize with AuthBoundry, then perform the effect. */
  invoke(capability: string, input: Record<string, unknown>, options: { readonly principal: VerifiedPrincipal }): Promise<unknown>;
  /** Pre-authorize one effect for a transaction; the returned context is single-use. */
  authorize(capability: string, principal: VerifiedPrincipal, resource: Omit<ServiceResource, 'tenantId'> & { readonly tenantId?: string }): Promise<ServiceExecutionContext>;
  /** Authenticate a request with an API key or the host identity adapter. */
  authenticate(request: IncomingMessage): Promise<VerifiedPrincipal | null>;
  /** Accept an inbound webhook for a registered integration. */
  receiveWebhook(request: InboundWebhookRequest): Promise<InboundWebhookResult>;
  forTenant(tenantId: string): AppPortTenantServices;
  publish<T extends Record<string, unknown>>(type: string, data: T, options?: string | { readonly tenantId?: string; readonly principal?: VerifiedPrincipal }): Promise<import('./platform.js').AppPortEvent<T>>;
  overview(): Record<string, unknown>;
  transaction<T>(callback: (tx: TransactionContextImpl) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class CapabilityNotDeclaredError extends Error {
  constructor(readonly capability: string) {
    const declaration = capability === 'schedules' ? 'jobs' : capability.split('.')[0];
    super(`Capability "${capability}" is not declared in appport.toml. Add "use ${declaration}" to enable it.`);
    this.name = 'CapabilityNotDeclaredError';
  }
}

export function createCapabilityPlan(config: AppPortConfig, flow?: FlowSpec): CapabilityPlan {
  const capabilities = (['api', 'webhooks', 'jobs', 'secrets', 'notifications', 'files'] as const).filter((name) => config.capabilities[name]);
  return { capabilities, config, ...(flow ? { flow } : {}) };
}

interface InitializedCapabilities {
  apiKeys?: ApiKeyService;
  webhooks?: WebhookService;
  jobs?: JobService;
  notifications?: NotificationService;
  files?: FileService;
  schedules?: ScheduleService;
}

export interface CapabilityFactoryContext {
  readonly authority: ServiceGateway;
  readonly destinationPolicy?: WebhookDestinationPolicy;
}

type CapabilityFactory = (
  db: StateFirstDB,
  config: AppPortConfig,
  services: InitializedCapabilities,
  runtime: ReturnType<typeof createFeltDbRuntime>,
  context: CapabilityFactoryContext,
) => void;

export const capabilityRegistry: Readonly<Record<AppPortCapabilityName, CapabilityFactory>> = {
  api(db, config, services, runtime, { authority }) {
    if (!config.api.keys.enabled) return;
    services.apiKeys = new ApiKeyService({
      store: new FeltDbApiKeyStore(db),
      auditSink: new FeltDbAuditSink(db),
      runtime,
      applicationId: config.application.name,
      authority,
    });
  },
  webhooks(db, config, services, _runtime, { authority, destinationPolicy }) {
    services.webhooks = new WebhookService({
      endpointStore: new FeltDbWebhookEndpointStore(db),
      deliveryStore: new FeltDbWebhookDeliveryStore(db),
      auditSink: new FeltDbWebhookAuditSink(db),
      integrationStore: new FeltDbWebhookIntegrationStore(db),
      replayStore: new FeltDbInboundWebhookReplayStore(db),
      authority,
      destinationPolicy,
      maxRetryAttempts: config.webhooks.delivery.retries,
      requestTimeoutMs: config.webhooks.delivery.timeout_ms,
      allowedEvents: config.webhooks.events.allowed,
    });
  },
  jobs(db, config, services, _runtime, { authority }) {
    services.jobs = new JobService({
      jobStore: new FeltDbJobStore(db),
      scheduleStore: new FeltDbJobScheduleStore(db),
      auditSink: new FeltDbJobAuditSink(db),
      maxRetryAttempts: config.jobs.execution.max_attempts,
      allowedTypes: Object.keys(config.jobs.types),
      authority,
    });
  },
  // Secrets is a contract capability only. AppBoundry supplies execution.
  secrets() {},
  notifications(db, _config, services, _runtime, { authority }) {
    services.notifications = new NotificationService({
      store: new FeltDbNotificationStore(db),
      deliveryStore: new FeltDbNotificationDeliveryStore(db),
      auditSink: new FeltDbNotificationAuditSink(db),
      authority,
    });
  },
  files(db, _config, services, _runtime, { authority }) {
    services.files = new FileService({
      store: new FeltDbFileStore(db),
      auditSink: new FeltDbFileAuditSink(db),
      authority,
    });
  },
};

/** Bootstrap AppPort from the executable appport.toml contract. */
export async function appport(options: AppPortOptions = {}): Promise<AppPortApplication> {
  const configPath = resolve(options.config ?? 'appport.toml');
  const config = parseAppPortConfig(configPath);
  const flowPath = resolve(options.flow ?? dirname(configPath), options.flow ? '' : 'feltdb.flow');
  const flow = await loadAuthoritativeFlow(flowPath, config);
  const plan = createCapabilityPlan(config, flow);
  const {
    config: _config, flow: _flow, routes = {}, jobs = {}, jobHandlers = {}, webhooks: webhookHandlers = {}, inbound = {},
    authorizer, credentials, identify, authorizationTimeoutMs, webhookDestinationPolicy,
    ...explicitFeltDbOptions
  } = options;
  const feltDbOptions = runtimeOptionsFromContract(config, explicitFeltDbOptions, dirname(configPath));
  const runtime = createFeltDbRuntime(feltDbOptions);
  const services: InitializedCapabilities = {};
  const gateway = new ServiceGateway({
    application: config.application.name,
    authorizer,
    credentials,
    evidence: new FeltDbEffectEvidenceStore(runtime.db),
    authorizationTimeoutMs,
  });

  for (const capability of plan.capabilities) {
    capabilityRegistry[capability](runtime.db, config, services, runtime, { authority: gateway, destinationPolicy: webhookDestinationPolicy });
  }
  if (services.jobs) services.schedules = new ScheduleService({ jobs: services.jobs, authority: gateway });

  await runtime.db.deployFlowSpec(flow);
  for (const [type, handler] of Object.entries({ ...jobHandlers, ...jobs })) services.jobs?.register(type, handler);
  for (const [provider, handler] of Object.entries(inbound)) services.webhooks?.registerInboundHandler(provider, handler);
  const invokable = { gateway, ...services };

  const events = new AppPortEvents();
  const tenant = new AppPortTenantContext(config.tenant.default);
  // Application state only: service-owned collections are reachable solely through authorized capabilities.
  const state: AppPortState = {
    collection: <T>(name: string) => { assertApplicationCollection(name); return runtime.db.collection<T>(name); },
    subscribe: <T>(name: string, handler: (items: T[]) => void) => { assertApplicationCollection(name); return runtime.db.collection<T>(name).subscribe(handler); },
  };
  let http: AppPortHttpRuntime | undefined;
  let closed = false;
  let started = false;
  const workerTimers: NodeJS.Timeout[] = [];
  const shutdown = () => void application.close();
  const apiKeysFacade: AppPortApiKeys | undefined = services.apiKeys ? bindMethods(services.apiKeys, ['createApiKey', 'listApiKeys', 'getApiKey', 'revokeApiKey', 'authenticateApiKey']) : undefined;
  const webhooksFacade: AppPortWebhooks | undefined = services.webhooks ? bindMethods(services.webhooks, ['createWebhookEndpoint', 'getWebhookEndpoint', 'listWebhookEndpoints', 'disableWebhookEndpoint', 'emitWebhookEvent', 'getWebhookDelivery', 'listWebhookDeliveries', 'replayWebhookDelivery']) : undefined;
  const jobsFacade: AppPortJobs | undefined = services.jobs ? bindMethods(services.jobs, ['enqueue', 'schedule', 'scheduleRecurring', 'getJob', 'listJobs', 'getSchedule', 'listSchedules', 'disableSchedule', 'retry']) : undefined;
  const notificationsFacade: AppPortNotifications | undefined = services.notifications ? bindMethods(services.notifications, ['create', 'get', 'list', 'markRead', 'dismiss', 'delete', 'deliveries']) : undefined;
  const filesFacade: AppPortFiles | undefined = services.files ? bindMethods(services.files, ['create', 'get', 'list', 'update', 'delete']) : undefined;
  const schedulesFacade: AppPortSchedules | undefined = services.schedules ? bindMethods(services.schedules, ['create', 'get', 'list', 'disable']) : undefined;

  const application = {
    plan,
    contract: config,
    capabilities: SERVICE_CAPABILITY_MANIFEST,
    gateway,
    events,
    state,
    tenant,
    get http(): AppPortHttpRuntime | undefined { return http; },
    get api(): AppPortApiCapability {
      if (!config.capabilities.api) throw new CapabilityNotDeclaredError('api');
      return {
        get keys(): AppPortApiKeys {
          if (!apiKeysFacade) throw new CapabilityNotDeclaredError('api.keys');
          return apiKeysFacade;
        },
      };
    },
    get webhooks(): AppPortWebhooks {
      if (!webhooksFacade) throw new CapabilityNotDeclaredError('webhooks');
      return webhooksFacade;
    },
    get jobs(): AppPortJobs {
      if (!jobsFacade) throw new CapabilityNotDeclaredError('jobs');
      return jobsFacade;
    },
    get notifications(): AppPortNotifications {
      if (!config.capabilities.notifications || !notificationsFacade) throw new CapabilityNotDeclaredError('notifications');
      return notificationsFacade;
    },
    get files(): AppPortFiles {
      if (!config.capabilities.files || !filesFacade) throw new CapabilityNotDeclaredError('files');
      return filesFacade;
    },
    get schedules(): AppPortSchedules {
      if (!schedulesFacade) throw new CapabilityNotDeclaredError('schedules');
      return schedulesFacade;
    },
    async start(): Promise<void> {
      if (closed) throw new Error('AppPort application is closed');
      if (started) return;
      started = true;
      if (config.http.enabled) http = await startHttpRuntime(application, routes);
      if (config.lifecycle.managed && config.tenant.default && services.jobs && config.jobs.execution.enabled) workerTimers.push(startManagedLoop(async () => { await services.jobs?.processRecurringSchedules(config.tenant.default!); const queued = await services.jobs?.listJobs(config.tenant.default!); const now = new Date().toISOString(); for (const job of queued ?? []) if ((job.status === 'pending' && job.runAt <= now) || (job.status === 'retrying' && (!job.nextAttemptAt || job.nextAttemptAt <= now))) await services.jobs?.executeJob(job.tenantId, job.id, `${config.application.name}:runtime`); }));
      if (config.lifecycle.managed && config.tenant.default && services.webhooks && config.webhooks.delivery.enabled) workerTimers.push(startManagedLoop(async () => { const deliveries = await services.webhooks?.listWebhookDeliveries(config.tenant.default!); const now = new Date().toISOString(); for (const delivery of deliveries ?? []) if (delivery.status === 'pending' || (delivery.status === 'retrying' && (!delivery.nextAttemptAt || delivery.nextAttemptAt <= now))) await services.webhooks?.deliverWebhook(delivery.tenantId, delivery.id); }));
      if (config.lifecycle.managed) { process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); }
    },
    overview(): Record<string, unknown> {
      return { application: config.application, deployment: config.deployment, capabilities: plan.capabilities, tenant: config.tenant, state: { ...config.state, runtime: runtime.deployment }, api: config.api, webhooks: config.webhooks, jobs: config.jobs, notifications: config.notifications, files: config.files, events: events.overview(), health: { ok: !closed } };
    },
    invoke(capability: string, input: Record<string, unknown>, invokeOptions: { readonly principal: VerifiedPrincipal }): Promise<unknown> {
      return invokeService(invokable, capability, input, invokeOptions);
    },
    authorize(capability: string, principal: VerifiedPrincipal, resource: Omit<ServiceResource, 'tenantId'> & { readonly tenantId?: string }): Promise<ServiceExecutionContext> {
      const verified = requireVerifiedPrincipal(principal);
      return gateway.authorize(capability, verified, { ...resource, tenantId: resource.tenantId ?? verified.tenantId });
    },
    async authenticate(request: IncomingMessage): Promise<VerifiedPrincipal | null> {
      const authorization = request.headers.authorization;
      const bearer = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      if (bearer && services.apiKeys) return services.apiKeys.authenticateApiKey(bearer);
      if (identify) return gateway.identify(await identify(request));
      return null;
    },
    receiveWebhook(request: InboundWebhookRequest): Promise<InboundWebhookResult> {
      if (!services.webhooks) throw new CapabilityNotDeclaredError('webhooks');
      return services.webhooks.receiveWebhook(request);
    },
    forTenant(tenantId: string): AppPortTenantServices {
      const own = (principal: VerifiedPrincipal): VerifiedPrincipal => {
        const verified = requireVerifiedPrincipal(principal);
        if (verified.tenantId !== tenantId) throw new ServiceAuthorityError('DENIED', 'Cross-tenant service operation denied', { reason: 'tenant_mismatch' });
        return verified;
      };
      return {
        api: { keys: {
          createApiKey: (input, principal) => application.api.keys.createApiKey(input, own(principal)),
          listApiKeys: (principal) => application.invoke('apikeys.read', {}, { principal: own(principal) }) as ReturnType<ApiKeyService['listApiKeys']>,
          getApiKey: (id, principal) => application.invoke('apikeys.read', { id }, { principal: own(principal) }) as ReturnType<ApiKeyService['getApiKey']>,
          revokeApiKey: (input, principal) => application.api.keys.revokeApiKey(input, own(principal)),
        } },
        webhooks: {
          createWebhookEndpoint: (input, principal) => application.webhooks.createWebhookEndpoint(input, own(principal)),
          listWebhookEndpoints: (principal) => application.invoke('webhooks.read', {}, { principal: own(principal) }) as ReturnType<WebhookService['listWebhookEndpoints']>,
          emitWebhookEvent: (input, principal) => application.webhooks.emitWebhookEvent(input, own(principal)),
        },
        jobs: {
          enqueue: (input, principal) => application.jobs.enqueue(input, own(principal)),
          listJobs: (principal) => application.invoke('jobs.read', {}, { principal: own(principal) }) as ReturnType<JobService['listJobs']>,
        },
        files: {
          create: (input, principal) => application.files.create(input, own(principal)),
          list: (principal) => application.files.list(tenantId, own(principal)),
        },
        schedules: {
          create: (input, principal) => application.schedules.create(input, own(principal)),
          list: (principal) => application.schedules.list(tenantId, own(principal)),
        },
        invoke: (capability, input, principal) => application.invoke(capability, input, { principal: own(principal) }),
        publish: (type, data, principal) => application.publish(type, data, { tenantId, ...(principal ? { principal: own(principal) } : {}) }),
      };
    },
    async publish<T extends Record<string, unknown>>(type: string, data: T, publishOptions?: string | { readonly tenantId?: string; readonly principal?: VerifiedPrincipal }): Promise<import('./platform.js').AppPortEvent<T>> {
      const resolved = typeof publishOptions === 'string' ? { tenantId: publishOptions } : publishOptions ?? {};
      const principal = resolved.principal === undefined ? undefined : requireVerifiedPrincipal(resolved.principal);
      const tenantId = principal?.tenantId ?? resolved.tenantId ?? tenant.current();
      if (principal && resolved.tenantId !== undefined && resolved.tenantId !== principal.tenantId) {
        throw new ServiceAuthorityError('DENIED', 'Cross-tenant service operation denied', { reason: 'tenant_mismatch' });
      }
      // In-process event fan-out is not a service effect. Outbound webhook
      // delivery is, so it runs only for a verified principal AuthBoundry allows.
      if (services.webhooks) {
        const endpoints = await services.webhooks.listWebhookEndpoints(tenantId);
        if (endpoints.some((endpoint) => !endpoint.disabledAt && endpoint.events.includes(type))) {
          if (!principal) throw new ServiceAuthorityError('UNAUTHENTICATED', `Publishing "${type}" delivers webhooks, which requires a verified principal`);
          const deliveries = await services.webhooks.emitWebhookEvent({ type, payload: data }, principal);
          await Promise.all(deliveries.map((delivery) => services.webhooks?.deliverWebhook(tenantId, delivery.id)));
        }
      }
      const event = events.publish(type, data, tenantId);
      await webhookHandlers[type]?.(event);
      return event;
    },
    async transaction<T>(callback: (tx: TransactionContextImpl) => Promise<T>): Promise<T> {
      const builder = new TransactionBuilder();
      const context = capabilityAwareTransactionContext(new TransactionContextImpl(builder, gateway, services.webhooks ? (tenantId) => services.webhooks!.listWebhookEndpoints(tenantId) : undefined), config);
      const result = await callback(context);
      await context._settle();
      await builder.commit(runtime.db);
      return result;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      events.close();
      for (const timer of workerTimers) clearInterval(timer);
      await http?.close();
      await runtime.db.close();
    },
  } satisfies AppPortApplication;

  if (config.lifecycle.managed) await application.start();

  return application;
}

function bindMethods<T extends object, K extends keyof T>(target: T, names: readonly K[]): Pick<T, K> {
  return Object.freeze(Object.fromEntries(names.map((name) => [name, (target[name] as Function).bind(target)]))) as Pick<T, K>;
}

function startManagedLoop(work: () => Promise<void>): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void work().catch(() => undefined).finally(() => { running = false; });
  }, 250);
  timer.unref();
  return timer;
}

function runtimeOptionsFromContract(config: AppPortConfig, explicit: FeltDBOptions, applicationRoot: string): FeltDBOptions {
  if (explicit.server || explicit.browser || explicit.memory || explicit.path || explicit.mode) return explicit;
  if (config.deployment.mode === 'managed') {
    const url = process.env.FELTDB_URL;
    if (!url) throw new Error('appport.toml deployment.mode is "managed" but FELTDB_URL is not configured');
    return { ...explicit, namespace: config.state.namespace, server: { url, token: process.env.FELTDB_TOKEN, applicationId: config.application.name, environment: process.env.FELTDB_ENVIRONMENT } };
  }
  if (config.deployment.storage === 'memory') return { ...explicit, namespace: config.state.namespace, memory: true };
  return { ...explicit, mode: 'local', namespace: config.state.namespace, path: resolve(applicationRoot, '.appport/state') };
}

const CAPABILITY_COLLECTIONS: Readonly<Record<AppPortCapabilityName, readonly string[]>> = {
  api: ['ApiKeys', 'ApiKeyPrefixes', 'ApiKeyAuditEvents'],
  webhooks: ['WebhookEndpoints', 'WebhookDeliveries', 'WebhookAuditEvents'],
  jobs: ['Jobs', 'JobSchedules', 'JobAuditEvents'],
  secrets: ['Secrets', 'SecretVersions', 'SecretAuditEvents'],
  notifications: ['Notifications', 'NotificationDeliveries', 'NotificationAuditEvents'],
  files: ['Files', 'FileAuditEvents'],
};

async function loadAuthoritativeFlow(path: string, config: AppPortConfig): Promise<FlowSpec> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read authoritative feltdb.flow at ${path}: ${String(error)}`);
  }
  const flow = parseFlowSpec(source);
  const errors = validateFlowSpec(flow).filter((diagnostic) => diagnostic.severity === 'error');
  if (errors.length > 0) {
    throw new Error(`Invalid authoritative feltdb.flow at ${path}: ${errors.map((error) => error.message).join('; ')}`);
  }

  const collections = new Set(flow.collections.map((collection) => collection.name));
  for (const capability of ['api', 'webhooks', 'jobs', 'notifications', 'files'] as const) {
    const present = CAPABILITY_COLLECTIONS[capability].filter((name) => collections.has(name));
    if (config.capabilities[capability] && present.length !== CAPABILITY_COLLECTIONS[capability].length) {
      const missing = CAPABILITY_COLLECTIONS[capability].filter((name) => !collections.has(name));
      throw new Error(`feltdb.flow is missing collections required by "use ${capability}": ${missing.join(', ')}`);
    }
    if (!config.capabilities[capability] && present.length > 0) {
      throw new Error(`feltdb.flow declares ${capability} infrastructure but appport.toml does not contain "use ${capability}"`);
    }
  }
  return flow;
}

function capabilityAwareTransactionContext(context: TransactionContextImpl, config: AppPortConfig): TransactionContextImpl {
  return new Proxy(context, {
    get(target, property, receiver) {
      if (property === 'queueWebhookDeliveries' && !config.capabilities.webhooks) {
        throw new CapabilityNotDeclaredError('webhooks');
      }
      if (property === 'queueJob' && !config.capabilities.jobs) {
        throw new CapabilityNotDeclaredError('jobs');
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
