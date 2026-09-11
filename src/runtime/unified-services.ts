import type { FeltDBOptions } from '@feltdb/core';
import { createFeltDbRuntime, FeltDbApiKeyStore, FeltDbAuditSink } from '../storage/api-keys.js';
import { ApiKeyService } from '../api-keys/service.js';
import { WebhookService } from '../webhooks/service.js';
import { FeltDbWebhookEndpointStore, FeltDbWebhookDeliveryStore, FeltDbWebhookAuditSink } from '../storage/webhooks.js';
import { EncryptedWebhookSecretStore } from '../webhooks/secrets.js';
import { JobService } from '../jobs/service.js';
import { FeltDbJobStore, FeltDbJobScheduleStore, FeltDbJobAuditSink } from '../jobs/store.js';
import { TransactionBuilder } from './transaction.js';
import { TransactionContextImpl } from './transaction-services.js';

/**
 * Unified AppPort Services instance.
 * All three services share a single FeltDB runtime.
 * The application uses this object to access API Keys, Webhooks, and Jobs.
 */
export interface AppPortServices {
  readonly apiKeys: ApiKeyService;
  readonly webhooks: WebhookService;
  readonly jobs: JobService;

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
 * Create a unified AppPort Services instance.
 *
 * All services share the same underlying FeltDB runtime and database.
 * This ensures atomic composition: invoice creation, webhook delivery intent,
 * and job enqueue can all happen within one durable transaction.
 *
 * @param options FeltDB runtime configuration (mode, namespace, path, etc.)
 * @returns AppPortServices with apiKeys, webhooks, and jobs
 */
export function createServices(options: FeltDBOptions = {}): AppPortServices {
  // Create one FeltDB runtime shared by all services
  const runtime = createFeltDbRuntime(options);
  const { db } = runtime;

  // Initialize API Key service
  const apiKeyService = new ApiKeyService({
    store: new FeltDbApiKeyStore(db),
    auditSink: new FeltDbAuditSink(db),
    runtime,
  });

  // Initialize Webhook service
  const webhookService = new WebhookService({
    endpointStore: new FeltDbWebhookEndpointStore(db),
    deliveryStore: new FeltDbWebhookDeliveryStore(db),
    auditSink: new FeltDbWebhookAuditSink(db),
    secretStore: new EncryptedWebhookSecretStore(),
  });

  // Initialize Job service
  const jobService = new JobService({
    jobStore: new FeltDbJobStore(db),
    scheduleStore: new FeltDbJobScheduleStore(db),
    auditSink: new FeltDbJobAuditSink(db),
  });

  return {
    apiKeys: apiKeyService,
    webhooks: webhookService,
    jobs: jobService,

    /**
     * Execute application and AppPort operations in a single atomic transaction.
     */
    async transaction<T>(callback: (tx: TransactionContextImpl) => Promise<T>): Promise<T> {
      const builder = new TransactionBuilder();
      const context = new TransactionContextImpl(builder);

      // Execute callback to collect operations
      const result = await callback(context);

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
