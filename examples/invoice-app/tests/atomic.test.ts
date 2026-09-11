import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServices } from '@appport/services';

test('Atomic composition: invoice creation with webhook + job', async () => {
  const path = await mkdtemp(join(tmpdir(), 'invoice-atomic-test-'));
  const configPath = join(path, 'appport.toml');

  const config = `use api
use webhooks
use jobs

[webhooks]
events = ["invoice.created"]

[jobs]
max_attempts = 3
`;
  writeFileSync(configPath, config);

  const services = createServices({
    mode: 'local',
    namespace: 'invoice-atomic-test',
    path: join(path, '.feltdb'),
    config: configPath,
  });

  const tenantId = 'test-tenant';
  const db = (services as any)['_getDb'];

  // 1. Create webhook endpoint
  const { endpoint } = await services.webhooks.createWebhookEndpoint({
    tenantId,
    url: 'https://example.com/webhook',
    events: ['invoice.created'],
    createdBy: 'test',
  });

  // 2. Simulate invoice creation transaction
  const invoiceId = randomUUID();
  const customerId = randomUUID();
  const now = new Date().toISOString();

  const invoice = {
    id: invoiceId,
    tenant_id: tenantId,
    customer_id: customerId,
    items: [],
    total_amount: 100,
    status: 'pending',
    created_at: now,
    created_by: 'test-user',
    updated_at: now,
    __version: 1,
  };

  // Execute atomic transaction
  await services.transaction(async (tx) => {
    // 1. Create invoice
    await tx.collection('invoices').insert(invoice, invoiceId);

    // 2. Queue webhook delivery
    tx.queueWebhookDeliveries([endpoint.id], {
      tenantId,
      type: 'invoice.created',
      payload: { id: invoiceId, total_amount: 100 },
    });

    // 3. Enqueue job
    tx.queueJob({
      tenantId,
      type: 'invoice.process',
      payload: { invoiceId },
      maxAttempts: 3,
    });
  });

  // Verify all three were created
  const invoices = await db.collection('invoices').find({ tenant_id: tenantId });
  const deliveries = await services.webhooks.listWebhookDeliveries(tenantId);
  const jobs = await services.jobs.listJobs(tenantId);

  assert.equal(invoices.length, 1, 'Invoice created');
  assert.equal(invoices[0].id, invoiceId);
  assert.equal(deliveries.length, 1, 'Webhook delivery created');
  assert.equal(deliveries[0].eventType, 'invoice.created');
  assert.equal(jobs.length, 1, 'Job enqueued');
  assert.equal(jobs[0].type, 'invoice.process');

  console.log('✓ Atomic composition: invoice + webhook + job in one transaction');
});

test('Atomic composition: rollback on error', async () => {
  const path = await mkdtemp(join(tmpdir(), 'invoice-rollback-test-'));
  const configPath = join(path, 'appport.toml');

  const config = `use api
use webhooks
use jobs

[webhooks]
events = ["invoice.created"]

[jobs]
max_attempts = 3
`;
  writeFileSync(configPath, config);

  const services = createServices({
    mode: 'local',
    namespace: 'invoice-rollback-test',
    path: join(path, '.feltdb'),
    config: configPath,
  });

  const tenantId = 'test-tenant';
  const db = (services as any)['_getDb'];

  // Create endpoint
  await services.webhooks.createWebhookEndpoint({
    tenantId,
    url: 'https://example.com/webhook',
    events: ['invoice.created'],
    createdBy: 'test',
  });

  // Intentional error in transaction
  let transactionError: unknown;
  try {
    await services.transaction(async (tx) => {
      const invoiceId = randomUUID();
      const now = new Date().toISOString();

      const invoice = {
        id: invoiceId,
        tenant_id: tenantId,
        customer_id: randomUUID(),
        items: [],
        total_amount: 100,
        status: 'pending',
        created_at: now,
        created_by: 'test',
        updated_at: now,
        __version: 1,
      };

      // Start creating invoice
      await tx.collection('invoices').insert(invoice, invoiceId);

      // Simulate error before webhook/job are queued
      throw new Error('Simulated failure before completing transaction');
    });
  } catch (error) {
    transactionError = error;
  }

  assert.ok(transactionError, 'Transaction should fail');

  // Verify nothing was persisted (rollback behavior)
  const invoices = await db.collection('invoices').find({ tenant_id: tenantId });
  const deliveries = await services.webhooks.listWebhookDeliveries(tenantId);
  const jobs = await services.jobs.listJobs(tenantId);

  assert.equal(invoices.length, 0, 'No invoices persisted after rollback');
  assert.equal(deliveries.length, 0, 'No webhook deliveries persisted after rollback');
  assert.equal(jobs.length, 0, 'No jobs persisted after rollback');

  console.log('✓ Atomic composition: error rolls back all operations');
});

test('Atomic composition: tenant isolation', async () => {
  const path = await mkdtemp(join(tmpdir(), 'invoice-tenant-test-'));
  const configPath = join(path, 'appport.toml');

  const config = `use api
use webhooks
use jobs

[webhooks]
events = ["invoice.created"]

[jobs]
max_attempts = 3
`;
  writeFileSync(configPath, config);

  const services = createServices({
    mode: 'local',
    namespace: 'invoice-tenant-test',
    path: join(path, '.feltdb'),
    config: configPath,
  });

  // Create invoices for two tenants
  const tenantA = 'tenant-a';
  const tenantB = 'tenant-b';

  // Create endpoints for both
  await services.webhooks.createWebhookEndpoint({
    tenantId: tenantA,
    url: 'https://example.com/webhook-a',
    events: ['invoice.created'],
    createdBy: 'test',
  });

  const endpointB = await services.webhooks.createWebhookEndpoint({
    tenantId: tenantB,
    url: 'https://example.com/webhook-b',
    events: ['invoice.created'],
    createdBy: 'test',
  });

  // Create invoice for tenant B
  const invoiceId = randomUUID();
  const now = new Date().toISOString();

  await services.transaction(async (tx) => {
    const invoice = {
      id: invoiceId,
      tenant_id: tenantB,
      customer_id: randomUUID(),
      items: [],
      total_amount: 100,
      status: 'pending',
      created_at: now,
      created_by: 'test',
      updated_at: now,
      __version: 1,
    };

    await tx.collection('invoices').insert(invoice, invoiceId);

    tx.queueWebhookDeliveries([endpointB.endpoint.id], {
      tenantId: tenantB,
      type: 'invoice.created',
      payload: { id: invoiceId },
    });

    tx.queueJob({
      tenantId: tenantB,
      type: 'invoice.process',
      payload: { invoiceId },
      maxAttempts: 3,
    });
  });

  // Verify tenant B has data, tenant A doesn't
  const deliveriesA = await services.webhooks.listWebhookDeliveries(tenantA);
  const deliveriesB = await services.webhooks.listWebhookDeliveries(tenantB);
  const jobsA = await services.jobs.listJobs(tenantA);
  const jobsB = await services.jobs.listJobs(tenantB);

  assert.equal(deliveriesA.length, 0, 'Tenant A has no deliveries');
  assert.equal(deliveriesB.length, 1, 'Tenant B has invoice delivery');
  assert.equal(jobsA.length, 0, 'Tenant A has no jobs');
  assert.equal(jobsB.length, 1, 'Tenant B has invoice job');

  console.log('✓ Atomic composition: tenant isolation maintained');
});
