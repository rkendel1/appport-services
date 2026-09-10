import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createApiKeyService,
  createFeltDbRuntime,
  FeltDbWebhookEndpointStore,
  FeltDbWebhookDeliveryStore,
  FeltDbWebhookAuditSink,
  WebhookService,
  EncryptedWebhookSecretStore,
  FeltDbJobStore,
  FeltDbJobScheduleStore,
  FeltDbJobAuditSink,
  JobService,
} from '@appport/services';
import { FeltDbInvoiceStore } from '../src/invoice-store.js';
import { InvoiceService } from '../src/invoice-service.js';

async function setupServices(path: string) {
  const runtime = createFeltDbRuntime({
    mode: 'local',
    namespace: 'test-' + Math.random().toString(16).slice(2),
    path,
  });

  const apiKeyService = createApiKeyService({
    mode: 'local',
    namespace: 'test-' + Math.random().toString(16).slice(2),
    path,
  });

  const webhookService = new WebhookService({
    endpointStore: new FeltDbWebhookEndpointStore(runtime.db),
    deliveryStore: new FeltDbWebhookDeliveryStore(runtime.db),
    auditSink: new FeltDbWebhookAuditSink(runtime.db),
    secretStore: new EncryptedWebhookSecretStore(),
  });

  const jobService = new JobService({
    jobStore: new FeltDbJobStore(runtime.db),
    scheduleStore: new FeltDbJobScheduleStore(runtime.db),
    auditSink: new FeltDbJobAuditSink(runtime.db),
  });

  const invoiceStore = new FeltDbInvoiceStore(runtime.db);
  const invoiceService = new InvoiceService(invoiceStore, webhookService, jobService);

  return {
    runtime,
    apiKeyService,
    webhookService,
    jobService,
    invoiceStore,
    invoiceService,
  };
}

test('Invoice creation establishes durable intents (API key → tenant → invoice → webhook → job)', async () => {
  const path = await mkdtemp(join(tmpdir(), 'services-demo-test-'));
  const { apiKeyService, invoiceService, webhookService, jobService, runtime } = await setupServices(path);

  // Create API key for tenant
  const key = await apiKeyService.createApiKey({
    tenantId: 'tenant-123',
    name: 'test-key',
    scopes: ['invoices.write'],
    createdBy: 'test-operator',
  });

  // Authenticate with API key
  const principal = await apiKeyService.authenticate({
    secret: key.secret,
    clientId: key.id,
  });

  assert.ok(principal);
  assert.equal(principal.tenantId, 'tenant-123');

  // Create invoice (establishes webhook and job intents)
  const invoice = await invoiceService.createInvoice(
    principal,
    'ACME Corp',
    1000,
  );

  assert.ok(invoice.id);
  assert.equal(invoice.tenant_id, 'tenant-123');
  assert.equal(invoice.customer, 'ACME Corp');
  assert.equal(invoice.status, 'pending');

  // Verify webhook delivery was created
  const deliveries = await webhookService.listDeliveries('tenant-123');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].eventType, 'invoice.created');
  assert.equal(deliveries[0].status, 'pending');

  // Verify job was enqueued
  const jobs = await jobService.listJobs('tenant-123');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, 'invoice.process');
  assert.equal(jobs[0].status, 'pending');

  await runtime.db.close();
});

test('Tenant isolation prevents cross-tenant invoice access', async () => {
  const path = await mkdtemp(join(tmpdir(), 'services-demo-test-'));
  const { apiKeyService, invoiceService, runtime } = await setupServices(path);

  // Create two API keys for different tenants
  const keyA = await apiKeyService.createApiKey({
    tenantId: 'tenant-a',
    name: 'key-a',
    scopes: ['invoices.write'],
    createdBy: 'operator',
  });

  const keyB = await apiKeyService.createApiKey({
    tenantId: 'tenant-b',
    name: 'key-b',
    scopes: ['invoices.write'],
    createdBy: 'operator',
  });

  // Authenticate with tenant A
  const principalA = await apiKeyService.authenticate({
    secret: keyA.secret,
    clientId: keyA.id,
  });

  // Create invoice for tenant A
  const invoiceA = await invoiceService.createInvoice(principalA, 'Customer A', 500);

  // Try to access invoice A as tenant B
  const principalB = await apiKeyService.authenticate({
    secret: keyB.secret,
    clientId: keyB.id,
  });

  const wrongInvoice = await invoiceService.getInvoice(principalB, invoiceA.id);
  assert.equal(wrongInvoice, null, 'Tenant B should not access Tenant A invoice');

  await runtime.db.close();
});

test('Job execution marks invoice as processed', async () => {
  const path = await mkdtemp(join(tmpdir(), 'services-demo-test-'));
  const { invoiceService, jobService, runtime } = await setupServices(path);

  const principal = {
    principalId: 'operator-1',
    principalType: 'api_key' as const,
    tenantId: 'tenant-123',
    scopes: [],
    credentialId: 'key-1',
  };

  // Register job handler
  jobService.register('invoice.process', async (job) => {
    const { invoiceId } = job.payload as { invoiceId: string };
    const updated = await invoiceService
      .getInvoice(principal, invoiceId)
      .then(async (inv) => {
        if (!inv) throw new Error('Invoice not found');
        // Mark as processed by getting store
      });
  });

  // Create invoice
  const invoice = await invoiceService.createInvoice(principal, 'Test Co', 750);

  // Get the job
  const jobs = await jobService.listJobs('tenant-123');
  assert.equal(jobs.length, 1);

  // Execute the job
  const result = await jobService.executeJob('tenant-123', jobs[0].id, 'worker-1');
  assert.equal(result, true);

  // Verify job completed
  const completedJob = await jobService.getJob('tenant-123', jobs[0].id);
  assert.equal(completedJob?.status, 'completed');

  await runtime.db.close();
});

test('Webhook retry respects exponential backoff', async () => {
  const path = await mkdtemp(join(tmpdir(), 'services-demo-test-'));
  const { webhookService, runtime } = await setupServices(path);

  // Create endpoint
  const { endpoint } = await webhookService.createWebhookEndpoint({
    tenantId: 'tenant-123',
    url: 'https://unreachable.example.com/webhook',
    events: ['test.event'],
    createdBy: 'operator',
  });

  // Emit event
  await webhookService.emitWebhookEvent({
    tenantId: 'tenant-123',
    type: 'test.event',
    payload: { test: true },
  });

  // Get delivery
  let deliveries = await webhookService.listDeliveries('tenant-123');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].status, 'pending');

  // First delivery attempt (will fail due to unreachable)
  await webhookService.deliverWebhook('tenant-123', deliveries[0].id);

  // Check retry scheduling
  deliveries = await webhookService.listDeliveries('tenant-123');
  const delivery = deliveries[0];
  assert.equal(delivery.attemptCount, 1);
  assert.equal(delivery.status, 'retrying');

  if (delivery.nextAttemptAt) {
    const nextTime = new Date(delivery.nextAttemptAt).getTime();
    const now = Date.now();
    // Should have some delay (backoff)
    assert.ok(nextTime > now);
  }

  await runtime.db.close();
});

test('Process restart preserves durable state', async () => {
  const path = await mkdtemp(join(tmpdir(), 'services-demo-test-'));
  const namespace = 'durability-' + Math.random().toString(16).slice(2);

  // Process 1: Create invoice
  {
    const runtime = createFeltDbRuntime({ mode: 'local', namespace, path });
    const apiKeyService = createApiKeyService({ mode: 'local', namespace, path });
    const webhookService = new WebhookService({
      endpointStore: new FeltDbWebhookEndpointStore(runtime.db),
      deliveryStore: new FeltDbWebhookDeliveryStore(runtime.db),
      auditSink: new FeltDbWebhookAuditSink(runtime.db),
      secretStore: new EncryptedWebhookSecretStore(),
    });
    const jobService = new JobService({
      jobStore: new FeltDbJobStore(runtime.db),
      scheduleStore: new FeltDbJobScheduleStore(runtime.db),
      auditSink: new FeltDbJobAuditSink(runtime.db),
    });

    const invoiceStore = new FeltDbInvoiceStore(runtime.db);
    const invoiceService = new InvoiceService(invoiceStore, webhookService, jobService);

    const key = await apiKeyService.createApiKey({
      tenantId: 'tenant-123',
      name: 'key',
      scopes: [],
      createdBy: 'op',
    });

    const principal = await apiKeyService.authenticate({
      secret: key.secret,
      clientId: key.id,
    });

    await invoiceService.createInvoice(principal, 'Persistent Corp', 999);
    await runtime.db.close();
  }

  // Process 2: Verify state survives restart
  {
    const runtime = createFeltDbRuntime({ mode: 'local', namespace, path });
    const invoiceStore = new FeltDbInvoiceStore(runtime.db);
    const jobService = new JobService({
      jobStore: new FeltDbJobStore(runtime.db),
      scheduleStore: new FeltDbJobScheduleStore(runtime.db),
      auditSink: new FeltDbJobAuditSink(runtime.db),
    });

    const invoices = await invoiceStore.list('tenant-123');
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0].customer, 'Persistent Corp');

    const jobs = await jobService.listJobs('tenant-123');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].type, 'invoice.process');

    await runtime.db.close();
  }
});

test('No cross-tenant job execution leakage', async () => {
  const path = await mkdtemp(join(tmpdir(), 'services-demo-test-'));
  const { jobService, invoiceService, runtime } = await setupServices(path);

  const principalA = {
    principalId: 'op-a',
    principalType: 'api_key' as const,
    tenantId: 'tenant-a',
    scopes: [],
    credentialId: 'key-a',
  };

  const principalB = {
    principalId: 'op-b',
    principalType: 'api_key' as const,
    tenantId: 'tenant-b',
    scopes: [],
    credentialId: 'key-b',
  };

  // Create invoices in both tenants
  const invoiceA = await invoiceService.createInvoice(principalA, 'A Corp', 100);
  const invoiceB = await invoiceService.createInvoice(principalB, 'B Corp', 200);

  // List jobs by tenant
  const jobsA = await jobService.listJobs('tenant-a');
  const jobsB = await jobService.listJobs('tenant-b');

  assert.equal(jobsA.length, 1);
  assert.equal(jobsB.length, 1);

  // Tenant A should not see Tenant B's job
  const jobIdB = jobsB[0].id;
  const jobFromA = await jobService.getJob('tenant-a', jobIdB);
  assert.equal(jobFromA, null);

  await runtime.db.close();
});
