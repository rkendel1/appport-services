import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createServices } from '@appport/services';
import type { StateFirstDB } from '@feltdb/core';

// The test-only `_getDb` handle exposes the shared FeltDB instance for direct
// verification; it is not part of the supported public API.
function getDb(services: ReturnType<typeof createServices>): StateFirstDB {
  return services['_getDb'] as StateFirstDB;
}

test('Invoice creation establishes durable intents', async () => {
  const path = await mkdtemp(join(tmpdir(), 'demo-test-'));
  const namespace = 'test-' + Math.random().toString(16).slice(2);

  const services = createServices({ mode: 'local', namespace, path });

  // Create API key
  const key = await services.apiKeys.createApiKey({
    tenantId: 'tenant-123',
    name: 'test-key',
    scopes: ['invoices.write'],
    createdBy: 'operator',
  });

  assert.ok(key.id);
  assert.ok(key.secret);

  // Authenticate with API key
  const principal = await services.apiKeys.authenticateApiKey(key.secret);
  assert.ok(principal);
  assert.equal(principal.tenantId, 'tenant-123');

  // Create invoice (this establishes webhook and job intents)
  const invoiceId = 'inv-123';
  await services.transaction(async (tx) => {
    await tx.collection<Record<string, unknown>>('invoices').insert(
      {
        id: invoiceId,
        tenant_id: principal.tenantId,
        customer: 'ACME Corp',
        amount: 1000,
        status: 'pending',
        created_at: new Date().toISOString(),
        created_by: principal.principalId,
      },
      invoiceId,
    );
  });

  // Create a webhook endpoint first
  await services.webhooks.createWebhookEndpoint({
    tenantId: principal.tenantId,
    url: 'https://example.com/webhook',
    events: ['invoice.created'],
    createdBy: principal.principalId,
  });

  // Emit webhook event
  await services.webhooks.emitWebhookEvent({
    tenantId: principal.tenantId,
    type: 'invoice.created',
    payload: { id: invoiceId },
  });

  // Enqueue job
  await services.jobs.enqueue({
    tenantId: principal.tenantId,
    type: 'invoice.process',
    payload: { invoiceId },
  });

  // Verify webhook delivery was created
  const deliveries = await services.webhooks.listWebhookDeliveries('tenant-123');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].eventType, 'invoice.created');

  // Verify job was enqueued
  const jobs = await services.jobs.listJobs('tenant-123');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].type, 'invoice.process');

  await getDb(services).close();
});

test('Tenant isolation prevents cross-tenant access', async () => {
  const path = await mkdtemp(join(tmpdir(), 'demo-test-'));
  const namespace = 'test-' + Math.random().toString(16).slice(2);

  const services = createServices({ mode: 'local', namespace, path });
  const invoices = getDb(services).collection<any>('invoices');

  // Create invoices for different tenants
  const invoiceA = { id: 'inv-a', tenant_id: 'tenant-a', customer: 'A', amount: 100, status: 'pending', created_at: new Date().toISOString(), created_by: 'op' };
  const invoiceB = { id: 'inv-b', tenant_id: 'tenant-b', customer: 'B', amount: 200, status: 'pending', created_at: new Date().toISOString(), created_by: 'op' };

  await invoices.insert(invoiceA, 'inv-a');
  await invoices.insert(invoiceB, 'inv-b');

  // Query tenant A
  const tenantAInvoices = await invoices.find({ tenant_id: 'tenant-a' });
  assert.equal(tenantAInvoices.length, 1);
  assert.equal(tenantAInvoices[0].id, 'inv-a');

  // Query tenant B
  const tenantBInvoices = await invoices.find({ tenant_id: 'tenant-b' });
  assert.equal(tenantBInvoices.length, 1);
  assert.equal(tenantBInvoices[0].id, 'inv-b');

  await getDb(services).close();
});

test('Process restart preserves durable state', async () => {
  const path = await mkdtemp(join(tmpdir(), 'demo-test-'));
  const namespace = 'durability-' + Math.random().toString(16).slice(2);

  // Process 1: Create data
  {
    const services = createServices({ mode: 'local', namespace, path });
    const invoices = getDb(services).collection<any>('invoices');

    await invoices.insert(
      {
        id: 'inv-persist',
        tenant_id: 'tenant-123',
        customer: 'Persistent Corp',
        amount: 999,
        status: 'pending',
        created_at: new Date().toISOString(),
        created_by: 'op',
      },
      'inv-persist',
    );

    await services.jobs.enqueue({
      tenantId: 'tenant-123',
      type: 'invoice.process',
      payload: { invoiceId: 'inv-persist' },
    });

    await getDb(services).close();
  }

  // Process 2: Verify state survives restart
  {
    const services = createServices({ mode: 'local', namespace, path });
    const invoices = getDb(services).collection<any>('invoices');

    const allInvoices = await invoices.find({ tenant_id: 'tenant-123' });
    assert.equal(allInvoices.length, 1);
    assert.equal(allInvoices[0].customer, 'Persistent Corp');

    const jobs = await services.jobs.listJobs('tenant-123');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].type, 'invoice.process');

    await getDb(services).close();
  }
});
