import type { FeltDBOptions } from '@feltdb/core';
import { createFeltDbRuntime, FeltDbApiKeyStore, FeltDbAuditSink } from '../storage/api-keys.js';
import { ApiKeyService } from '../api-keys/service.js';
import { WebhookService } from '../webhooks/service.js';
import { FeltDbWebhookEndpointStore, FeltDbWebhookDeliveryStore, FeltDbWebhookAuditSink } from '../storage/webhooks.js';
import { EncryptedWebhookSecretStore } from '../webhooks/secrets.js';
import { JobService } from '../jobs/service.js';
import { FeltDbJobStore, FeltDbJobScheduleStore, FeltDbJobAuditSink } from '../jobs/store.js';

/**
 * Unified AppPort Services instance.
 * All three services share a single FeltDB runtime.
 * The application uses this object to access API Keys, Webhooks, and Jobs.
 */
export interface AppPortServices {
  readonly apiKeys: ApiKeyService;
  readonly webhooks: WebhookService;
  readonly jobs: JobService;
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
  };
}
