import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { parseFlowSpec, validateFlowSpec, type Collection, type FeltDBOptions, type FlowSpec, type StateFirstDB } from '@feltdb/core';
import type { IncomingMessage } from 'node:http';

import { ApiKeyService } from '../api-keys/service.js';
import { JobService } from '../jobs/service.js';
import { FeltDbJobAuditSink, FeltDbJobScheduleStore, FeltDbJobStore } from '../jobs/store.js';
import { FeltDbApiKeyStore, FeltDbAuditSink, createFeltDbRuntime } from '../storage/api-keys.js';
import { FeltDbWebhookAuditSink, FeltDbWebhookDeliveryStore, FeltDbWebhookEndpointStore } from '../storage/webhooks.js';
import { EncryptedWebhookSecretStore } from '../webhooks/secrets.js';
import { WebhookService } from '../webhooks/service.js';
import { parseAppPortConfig, type AppPortConfig, type AppPortContractSnapshot } from './dsl.js';
import { AppPortEvents, AppPortTenantContext, startHttpRuntime, type AppPortHttpRuntime } from './platform.js';
import { TransactionContextImpl } from './transaction-services.js';
import { TransactionBuilder } from './transaction.js';

export type AppPortCapabilityName = 'api' | 'webhooks' | 'jobs';

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
  readonly jobHandlers?: Readonly<Record<string, (job: import('../jobs/models.js').Job) => Promise<void>>>;
}

export interface AppPortRouteContext { readonly application: AppPortApplication; readonly services: AppPortTenantServices; readonly request: IncomingMessage; readonly body: unknown; readonly tenantId: string; readonly principal: import('../contract/principals.js').AuthenticatedPrincipal | null }
export type AppPortRouteHandler = (context: AppPortRouteContext) => unknown | Promise<unknown>;
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
  publish<T extends Record<string, unknown>>(type: string, data: T): Promise<import('./platform.js').AppPortEvent<T>>;
}
export interface AppPortState {
  collection<T>(name: string): Pick<Collection<T>, 'get' | 'list' | 'find' | 'insert' | 'update' | 'delete' | 'subscribe'>;
  subscribe<T>(collection: string, handler: (items: T[]) => void): () => void;
}

export interface AppPortApiCapability {
  readonly keys: ApiKeyService;
}

export interface AppPortApplication {
  readonly plan: CapabilityPlan;
  readonly contract: AppPortContractSnapshot;
  readonly api: AppPortApiCapability;
  readonly webhooks: WebhookService;
  readonly jobs: JobService;
  readonly events: AppPortEvents;
  readonly state: AppPortState;
  readonly tenant: AppPortTenantContext;
  readonly http?: AppPortHttpRuntime;
  forTenant(tenantId: string): AppPortTenantServices;
  publish<T extends Record<string, unknown>>(type: string, data: T, tenantId?: string): Promise<import('./platform.js').AppPortEvent<T>>;
  overview(): Record<string, unknown>;
  transaction<T>(callback: (tx: TransactionContextImpl) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class CapabilityNotDeclaredError extends Error {
  constructor(readonly capability: string) {
    const declaration = capability.split('.')[0];
    super(`Capability "${capability}" is not declared in appport.toml. Add "use ${declaration}" to enable it.`);
    this.name = 'CapabilityNotDeclaredError';
  }
}

export function createCapabilityPlan(config: AppPortConfig, flow?: FlowSpec): CapabilityPlan {
  const capabilities = (['api', 'webhooks', 'jobs'] as const).filter((name) => config.capabilities[name]);
  return { capabilities, config, ...(flow ? { flow } : {}) };
}

interface InitializedCapabilities {
  apiKeys?: ApiKeyService;
  webhooks?: WebhookService;
  jobs?: JobService;
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
};

/** Bootstrap AppPort from the executable appport.toml contract. */
export async function appport(options: AppPortOptions = {}): Promise<AppPortApplication> {
  const configPath = resolve(options.config ?? 'appport.toml');
  const config = parseAppPortConfig(configPath);
  const flowPath = resolve(options.flow ?? dirname(configPath), options.flow ? '' : 'feltdb.flow');
  const flow = await loadAuthoritativeFlow(flowPath, config);
  const plan = createCapabilityPlan(config, flow);
  const { config: _config, flow: _flow, routes = {}, jobHandlers = {}, ...explicitFeltDbOptions } = options;
  const feltDbOptions = runtimeOptionsFromContract(config, explicitFeltDbOptions, dirname(configPath));
  const runtime = createFeltDbRuntime(feltDbOptions);
  const services: InitializedCapabilities = {};

  for (const capability of plan.capabilities) {
    capabilityRegistry[capability](runtime.db, config, services, runtime);
  }

  await runtime.db.deployFlowSpec(flow);
  for (const [type, handler] of Object.entries(jobHandlers)) services.jobs?.register(type, handler);

  const events = new AppPortEvents();
  const tenant = new AppPortTenantContext(config.tenant.default);
  const state: AppPortState = {
    collection: <T>(name: string) => runtime.db.collection<T>(name),
    subscribe: <T>(name: string, handler: (items: T[]) => void) => runtime.db.collection<T>(name).subscribe(handler),
  };
  let http: AppPortHttpRuntime | undefined;
  let closed = false;
  const workerTimers: NodeJS.Timeout[] = [];
  const shutdown = () => void application.close();

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
        get keys(): ApiKeyService {
          if (!services.apiKeys) throw new CapabilityNotDeclaredError('api.keys');
          return services.apiKeys;
        },
      };
    },
    get webhooks(): WebhookService {
      if (!services.webhooks) throw new CapabilityNotDeclaredError('webhooks');
      return services.webhooks;
    },
    get jobs(): JobService {
      if (!services.jobs) throw new CapabilityNotDeclaredError('jobs');
      return services.jobs;
    },
    overview(): Record<string, unknown> {
      return { application: config.application, deployment: config.deployment, capabilities: plan.capabilities, tenant: config.tenant, state: { ...config.state, runtime: runtime.deployment }, api: config.api, webhooks: config.webhooks, jobs: config.jobs, events: events.overview(), health: { ok: !closed } };
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
        publish: (type, data) => application.publish(type, data, tenantId),
      };
    },
    async publish<T extends Record<string, unknown>>(type: string, data: T, tenantId = tenant.current()): Promise<import('./platform.js').AppPortEvent<T>> {
      const event = events.publish(type, data, tenantId);
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

  if (config.http.enabled) http = await startHttpRuntime(application, routes);
  if (config.lifecycle.managed && config.tenant.default && services.jobs && config.jobs.execution.enabled) {
    workerTimers.push(startManagedLoop(async () => {
      const jobs = await services.jobs?.listJobs(config.tenant.default!);
      for (const job of jobs ?? []) if (job.status === 'pending' || job.status === 'retrying') await services.jobs?.executeJob(job.tenantId, job.id, `${config.application.name}:runtime`);
    }));
  }
  if (config.lifecycle.managed && config.tenant.default && services.webhooks && config.webhooks.delivery.enabled) {
    workerTimers.push(startManagedLoop(async () => {
      const deliveries = await services.webhooks?.listWebhookDeliveries(config.tenant.default!);
      for (const delivery of deliveries ?? []) if (delivery.status === 'pending' || delivery.status === 'retrying') await services.webhooks?.deliverWebhook(delivery.tenantId, delivery.id);
    }));
  }
  if (config.lifecycle.managed) {
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  return application;
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
  for (const capability of ['api', 'webhooks', 'jobs'] as const) {
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
