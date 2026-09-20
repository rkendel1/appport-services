import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { parseFlowSpec, validateFlowSpec, type FeltDBOptions, type FlowSpec, type StateFirstDB } from '@feltdb/core';
import type { IncomingMessage } from 'node:http';

import { ApiKeyService } from '../api-keys/service.js';
import { JobService } from '../jobs/service.js';
import { FeltDbJobAuditSink, FeltDbJobScheduleStore, FeltDbJobStore } from '../jobs/store.js';
import { FeltDbApiKeyStore, FeltDbAuditSink, createFeltDbRuntime } from '../storage/api-keys.js';
import { FeltDbWebhookAuditSink, FeltDbWebhookDeliveryStore, FeltDbWebhookEndpointStore } from '../storage/webhooks.js';
import { EncryptedWebhookSecretStore } from '../webhooks/secrets.js';
import { WebhookService } from '../webhooks/service.js';
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
  readonly jobs?: Readonly<Record<string, (job: import('../jobs/models.js').Job) => Promise<void>>>;
  readonly webhooks?: Readonly<Record<string, (event: import('./platform.js').AppPortEvent<Record<string, unknown>>) => void | Promise<void>>>;
  /** @deprecated Use jobs. */
  readonly jobHandlers?: Readonly<Record<string, (job: import('../jobs/models.js').Job) => Promise<void>>>;
}

export interface AppPortRouteContext { readonly application: AppPortApplication; readonly services: AppPortTenantServices; readonly request: IncomingMessage; readonly body: unknown; readonly tenantId: string; readonly principal: import('../contract/principals.js').AuthenticatedPrincipal | null }
export type AppPortRouteHandler = (context: AppPortRouteContext) => unknown | Promise<unknown>;
export interface AppPortApiKeys extends Pick<ApiKeyService, 'createApiKey' | 'listApiKeys' | 'getApiKey' | 'revokeApiKey' | 'authenticateApiKey'> {}
export interface AppPortWebhooks extends Pick<WebhookService, 'createWebhookEndpoint' | 'getWebhookEndpoint' | 'listWebhookEndpoints' | 'disableWebhookEndpoint' | 'emitWebhookEvent' | 'getWebhookDelivery' | 'listWebhookDeliveries' | 'replayWebhookDelivery'> {}
export interface AppPortJobs extends Pick<JobService, 'enqueue' | 'schedule' | 'scheduleRecurring' | 'getJob' | 'listJobs' | 'getSchedule' | 'listSchedules' | 'disableSchedule' | 'retry'> {}
export interface AppPortNotifications extends Pick<NotificationService, 'create' | 'get' | 'list' | 'markRead' | 'dismiss' | 'delete' | 'deliveries'> {}
export interface AppPortFiles extends Pick<FileService, 'create' | 'get' | 'list' | 'update' | 'delete'> {}
export interface AppPortSchedules extends Pick<ScheduleService, 'create' | 'get' | 'list' | 'disable'> {}
export interface AppPortTenantServices {
  readonly api: { readonly keys: {
    createApiKey(input: Omit<import('../api-keys/models.js').CreateApiKeyInput, 'tenantId'>): ReturnType<ApiKeyService['createApiKey']>;
    listApiKeys(): ReturnType<ApiKeyService['listApiKeys']>;
    getApiKey(id: string): ReturnType<ApiKeyService['getApiKey']>;
    revokeApiKey(input: Omit<import('../api-keys/models.js').RevokeApiKeyInput, 'tenantId'>): ReturnType<ApiKeyService['revokeApiKey']>;
  } };
  readonly webhooks: {
    createWebhookEndpoint(input: Omit<import('../webhooks/models.js').CreateWebhookEndpointInput, 'tenantId'>): ReturnType<WebhookService['createWebhookEndpoint']>;
    listWebhookEndpoints(): ReturnType<WebhookService['listWebhookEndpoints']>;
    emitWebhookEvent(input: Omit<import('../webhooks/models.js').EmitWebhookEventInput, 'tenantId'>): ReturnType<WebhookService['emitWebhookEvent']>;
  };
  readonly jobs: {
    enqueue(input: Omit<import('../jobs/models.js').CreateJobInput, 'tenantId'>): ReturnType<JobService['enqueue']>;
    listJobs(): ReturnType<JobService['listJobs']>;
  };
  readonly files: {
    create(input: Omit<import('../files/models.js').CreateFileInput, 'tenantId'>, principal: import('../contract/principals.js').AuthenticatedPrincipal): ReturnType<FileService['create']>;
    list(principal: import('../contract/principals.js').AuthenticatedPrincipal): ReturnType<FileService['list']>;
  };
  readonly schedules: {
    create(input: Omit<import('../schedules/models.js').CreateScheduleInput, 'tenantId' | 'createdBy'>, principal: import('../contract/principals.js').AuthenticatedPrincipal): ReturnType<ScheduleService['create']>;
    list(principal: import('../contract/principals.js').AuthenticatedPrincipal): ReturnType<ScheduleService['list']>;
  };
  publish<T extends Record<string, unknown>>(type: string, data: T): Promise<import('./platform.js').AppPortEvent<T>>;
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
  start(): Promise<void>;
  forTenant(tenantId: string): AppPortTenantServices;
  publish<T extends Record<string, unknown>>(type: string, data: T, tenantId?: string): Promise<import('./platform.js').AppPortEvent<T>>;
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

type CapabilityFactory = (
  db: StateFirstDB,
  config: AppPortConfig,
  services: InitializedCapabilities,
  runtime: ReturnType<typeof createFeltDbRuntime>,
) => void;

export const capabilityRegistry: Readonly<Record<AppPortCapabilityName, CapabilityFactory>> = {
  api(db, config, services, runtime) {
    if (!config.api.keys.enabled) return;
    services.apiKeys = new ApiKeyService({
      store: new FeltDbApiKeyStore(db),
      auditSink: new FeltDbAuditSink(db),
      runtime,
      allowedScopes: config.api.keys.scopes,
    });
  },
  webhooks(db, config, services) {
    services.webhooks = new WebhookService({
      endpointStore: new FeltDbWebhookEndpointStore(db),
      deliveryStore: new FeltDbWebhookDeliveryStore(db),
      auditSink: new FeltDbWebhookAuditSink(db),
      secretStore: new EncryptedWebhookSecretStore(),
      maxRetryAttempts: config.webhooks.delivery.retries,
      requestTimeoutMs: config.webhooks.delivery.timeout_ms,
      allowedEvents: config.webhooks.events.allowed,
    });
  },
  jobs(db, config, services) {
    services.jobs = new JobService({
      jobStore: new FeltDbJobStore(db),
      scheduleStore: new FeltDbJobScheduleStore(db),
      auditSink: new FeltDbJobAuditSink(db),
      maxRetryAttempts: config.jobs.execution.max_attempts,
      allowedTypes: Object.keys(config.jobs.types),
    });
  },
  // Secrets is a contract capability only. AppBoundry supplies execution.
  secrets() {},
  notifications(db, _config, services) {
    services.notifications = new NotificationService({
      store: new FeltDbNotificationStore(db),
      deliveryStore: new FeltDbNotificationDeliveryStore(db),
      auditSink: new FeltDbNotificationAuditSink(db),
    });
  },
  files(db, _config, services) {
    services.files = new FileService({
      store: new FeltDbFileStore(db),
      auditSink: new FeltDbFileAuditSink(db),
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
  const { config: _config, flow: _flow, routes = {}, jobs = {}, jobHandlers = {}, webhooks: webhookHandlers = {}, ...explicitFeltDbOptions } = options;
  const feltDbOptions = runtimeOptionsFromContract(config, explicitFeltDbOptions, dirname(configPath));
  const runtime = createFeltDbRuntime(feltDbOptions);
  const services: InitializedCapabilities = {};

  for (const capability of plan.capabilities) {
    capabilityRegistry[capability](runtime.db, config, services, runtime);
  }
  if (services.jobs) services.schedules = new ScheduleService({ jobs: services.jobs });

  await runtime.db.deployFlowSpec(flow);
  for (const [type, handler] of Object.entries({ ...jobHandlers, ...jobs })) services.jobs?.register(type, handler);

  const events = new AppPortEvents();
  const tenant = new AppPortTenantContext(config.tenant.default);
  const state: AppPortState = {
    collection: <T>(name: string) => runtime.db.collection<T>(name),
    subscribe: <T>(name: string, handler: (items: T[]) => void) => runtime.db.collection<T>(name).subscribe(handler),
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
      if (config.lifecycle.managed && config.tenant.default && services.jobs && config.jobs.execution.enabled) workerTimers.push(startManagedLoop(async () => { await services.jobs?.processRecurringSchedules(config.tenant.default!); const queued = await services.jobs?.listJobs(config.tenant.default!); for (const job of queued ?? []) if (job.status === 'pending' || job.status === 'retrying') await services.jobs?.executeJob(job.tenantId, job.id, `${config.application.name}:runtime`); }));
      if (config.lifecycle.managed && config.tenant.default && services.webhooks && config.webhooks.delivery.enabled) workerTimers.push(startManagedLoop(async () => { const deliveries = await services.webhooks?.listWebhookDeliveries(config.tenant.default!); for (const delivery of deliveries ?? []) if (delivery.status === 'pending' || delivery.status === 'retrying') await services.webhooks?.deliverWebhook(delivery.tenantId, delivery.id); }));
      if (config.lifecycle.managed) { process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown); }
    },
    overview(): Record<string, unknown> {
      return { application: config.application, deployment: config.deployment, capabilities: plan.capabilities, tenant: config.tenant, state: { ...config.state, runtime: runtime.deployment }, api: config.api, webhooks: config.webhooks, jobs: config.jobs, notifications: config.notifications, files: config.files, events: events.overview(), health: { ok: !closed } };
    },
    forTenant(tenantId: string): AppPortTenantServices {
      return {
        api: { keys: {
          createApiKey: (input) => application.api.keys.createApiKey({ ...input, tenantId }),
          listApiKeys: () => application.api.keys.listApiKeys(tenantId),
          getApiKey: (id) => application.api.keys.getApiKey(tenantId, id),
          revokeApiKey: (input) => application.api.keys.revokeApiKey({ ...input, tenantId }),
        } },
        webhooks: {
          createWebhookEndpoint: (input) => application.webhooks.createWebhookEndpoint({ ...input, tenantId }),
          listWebhookEndpoints: () => application.webhooks.listWebhookEndpoints(tenantId),
          emitWebhookEvent: (input) => application.webhooks.emitWebhookEvent({ ...input, tenantId }),
        },
        jobs: {
          enqueue: (input) => application.jobs.enqueue({ ...input, tenantId }),
          listJobs: () => application.jobs.listJobs(tenantId),
        },
        files: {
          create: (input, principal) => application.files.create({ ...input, tenantId }, principal),
          list: (principal) => application.files.list(tenantId, principal),
        },
        schedules: {
          create: (input, principal) => application.schedules.create({ ...input, tenantId, createdBy: principal.principalId }, principal),
          list: (principal) => application.schedules.list(tenantId, principal),
        },
        publish: (type, data) => application.publish(type, data, tenantId),
      };
    },
    async publish<T extends Record<string, unknown>>(type: string, data: T, tenantId = tenant.current()): Promise<import('./platform.js').AppPortEvent<T>> {
      const event = events.publish(type, data, tenantId);
      await webhookHandlers[type]?.(event);
      if (services.webhooks) {
        const deliveries = await services.webhooks.emitWebhookEvent({ tenantId, type, payload: data });
        await Promise.all(deliveries.map((delivery) => services.webhooks?.deliverWebhook(tenantId, delivery.id)));
      }
      return event;
    },
    async transaction<T>(callback: (tx: TransactionContextImpl) => Promise<T>): Promise<T> {
      const builder = new TransactionBuilder();
      const context = capabilityAwareTransactionContext(new TransactionContextImpl(builder), config);
      const result = await callback(context);
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
