import { resolve } from 'node:path';

import type { FeltDBOptions, StateFirstDB } from '@feltdb/core';

import { ApiKeyService } from '../api-keys/service.js';
import { JobService } from '../jobs/service.js';
import { FeltDbJobAuditSink, FeltDbJobScheduleStore, FeltDbJobStore } from '../jobs/store.js';
import { FeltDbApiKeyStore, FeltDbAuditSink, createFeltDbRuntime } from '../storage/api-keys.js';
import { FeltDbWebhookAuditSink, FeltDbWebhookDeliveryStore, FeltDbWebhookEndpointStore } from '../storage/webhooks.js';
import { EncryptedWebhookSecretStore } from '../webhooks/secrets.js';
import { WebhookService } from '../webhooks/service.js';
import { parseAppPortConfig, type AppPortConfig } from './dsl.js';
import { TransactionContextImpl } from './transaction-services.js';
import { TransactionBuilder } from './transaction.js';

export type AppPortCapabilityName = 'api' | 'webhooks' | 'jobs';

export interface CapabilityPlan {
  readonly capabilities: readonly AppPortCapabilityName[];
  readonly config: AppPortConfig;
}

export interface AppPortOptions extends FeltDBOptions {
  /** Contract path. Defaults to appport.toml in the current working directory. */
  readonly config?: string;
}

export interface AppPortApiCapability {
  readonly keys: ApiKeyService;
}

export interface AppPortApplication {
  readonly plan: CapabilityPlan;
  readonly api: AppPortApiCapability;
  readonly webhooks: WebhookService;
  readonly jobs: JobService;
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

export function createCapabilityPlan(config: AppPortConfig): CapabilityPlan {
  const capabilities = (['api', 'webhooks', 'jobs'] as const).filter((name) => config.capabilities[name]);
  return { capabilities, config };
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
    if (config.api?.keys === false) return;
    services.apiKeys = new ApiKeyService({
      store: new FeltDbApiKeyStore(db),
      auditSink: new FeltDbAuditSink(db),
      runtime,
    });
  },
  webhooks(db, _config, services) {
    services.webhooks = new WebhookService({
      endpointStore: new FeltDbWebhookEndpointStore(db),
      deliveryStore: new FeltDbWebhookDeliveryStore(db),
      auditSink: new FeltDbWebhookAuditSink(db),
      secretStore: new EncryptedWebhookSecretStore(),
    });
  },
  jobs(db, _config, services) {
    services.jobs = new JobService({
      jobStore: new FeltDbJobStore(db),
      scheduleStore: new FeltDbJobScheduleStore(db),
      auditSink: new FeltDbJobAuditSink(db),
    });
  },
};

/** Bootstrap AppPort from the executable appport.toml contract. */
export async function appport(options: AppPortOptions = {}): Promise<AppPortApplication> {
  const configPath = resolve(options.config ?? 'appport.toml');
  const config = parseAppPortConfig(configPath);
  const plan = createCapabilityPlan(config);
  const { config: _config, ...feltDbOptions } = options;
  const runtime = createFeltDbRuntime(feltDbOptions);
  const services: InitializedCapabilities = {};

  for (const capability of plan.capabilities) {
    capabilityRegistry[capability](runtime.db, config, services, runtime);
  }

  const application = {
    plan,
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
    async transaction<T>(callback: (tx: TransactionContextImpl) => Promise<T>): Promise<T> {
      const builder = new TransactionBuilder();
      const context = capabilityAwareTransactionContext(new TransactionContextImpl(builder), config);
      const result = await callback(context);
      await builder.commit(runtime.db);
      return result;
    },
    async close(): Promise<void> {
      await runtime.db.close();
    },
  } satisfies AppPortApplication;

  return application;
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
