/**
 * Drives every write path of one service through its public API on a fresh FeltDB
 * instance, and reports what was committed, from FeltDB's own operation journal
 * (`exportOperations`): each collection written and, per field, the JSON types its
 * values had. The contract tests compare that with SERVICES_CONTRACT, in both
 * directions, so the declarations cannot drift from what the services store.
 */
import type { StateFirstDB } from '@feltdb/core';

import { createServices, type AppPortServices } from '../../src/index.js';
import type { ServiceName } from '../../src/contract/services-contract.js';
import { TestAuthority } from './authority.js';
import { MemoryCustody } from './custody.js';
import { receiver, signInbound } from './stack.js';

export type JsonType = 'string' | 'integer' | 'number' | 'boolean' | 'null' | 'object' | 'array';

/** collection → field → JSON types seen. */
export type Observed = Map<string, Map<string, Set<JsonType>>>;

const TENANT = 'tenant-a';

function jsonType(value: unknown): JsonType {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value as JsonType;
}

interface Scenario {
  readonly services: AppPortServices;
  readonly db: StateFirstDB;
  readonly custody: MemoryCustody;
  invoke(capability: string, input: Record<string, unknown>): Promise<any>;
  readonly principal: ReturnType<AppPortServices['identify']> & {};
}

const SCENARIOS: Record<ServiceName, (s: Scenario) => Promise<void>> = {
  files: async (s) => {
    const file = await s.invoke('files.write', { name: 'report.pdf', size: 10, storageKey: 'k/1', contentType: 'application/pdf', checksum: 'sha256:abc', metadata: { project: 'p1' } });
    await s.invoke('files.write', { id: file.id, name: 'renamed.pdf' });
    await s.invoke('files.delete', { id: file.id });
  },
  notifications: async (s) => {
    const sent = await s.invoke('notifications.send', { recipient: 'alice', type: 'task.done', title: 'Done', body: 'It is done', data: { task: 't1' }, priority: 'high', idempotencyKey: 'once' });
    const n = sent.notification ?? sent;
    await s.invoke('notifications.update', { id: n.id });
    await s.services.notifications!.acknowledge(TENANT, n.id, s.principal);
    await s.invoke('notifications.update', { id: n.id, action: 'dismiss' });
    for (const delivery of await s.services.notifications!.deliveries(TENANT, n.id, s.principal)) {
      await s.services.notifications!.retryDelivery(TENANT, n.id, delivery.channel, s.principal).catch(() => undefined);
    }
    await s.services.notifications!.recoverDeliveries(TENANT);
    const other = await s.invoke('notifications.send', { recipient: 'alice', type: 'task.done', title: 'Second' });
    await s.invoke('notifications.delete', { id: (other.notification ?? other).id });
  },
  configuration: async (s) => {
    await s.invoke('configuration.write', { name: 'SUPPORT_EMAIL', value: 'help@example.com', environment: 'production', required: true, description: 'Where support mail goes' });
    await s.invoke('configuration.write', { operation: 'update', name: 'SUPPORT_EMAIL', value: 'support@example.com', environment: 'production', required: true });
    await s.invoke('credential.store', { ref: 'credential-ref:stripe', value: 'sk_test_contract_value', name: 'STRIPE_KEY', environment: 'production', provider: 'stripe' });
    await s.invoke('credential.attach', { name: 'OTHER_KEY', credentialRef: 'credential-ref:other', environment: 'production', required: false });
    await s.invoke('credential.rotate', { name: 'OTHER_KEY', credentialRef: 'credential-ref:other2', environment: 'production', required: false });
    await s.invoke('credential.detach', { name: 'OTHER_KEY', environment: 'production' });
    await s.invoke('configuration.delete', { name: 'SUPPORT_EMAIL', environment: 'production' });
  },
  apiKeys: async (s) => {
    const created = await s.invoke('apikeys.create', { name: 'ci', restrictions: { capabilities: ['files.read'] }, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    await s.services.apiKeys!.authenticateApiKey(created.secret);
    await s.invoke('apikeys.update', { id: created.id, name: 'ci-2', restrictions: null });
    const rotated = await s.invoke('apikeys.rotate', { id: created.id, overlapSeconds: 60 });
    await s.invoke('apikeys.revoke', { id: rotated.id });
    await s.invoke('apikeys.create', { name: 'other' });
    await s.services.apiKeys!.revokeAllApiKeys({}, s.principal);
  },
  webhooks: async (s) => {
    const hook = await receiver();
    try {
      // The host's custody holds the signing secret; webhooks reads it by reference only.
      await s.custody.store({ reference: { secretId: 'signing', tenantId: TENANT }, value: 'whsec_contract_signing', context: { tenantId: TENANT, principalId: 'host', purpose: 'test', authorizationRef: 'host-setup' } } as never);
      const endpoint = await s.invoke('webhooks.register', { url: hook.url, events: ['order.paid'], signingCredentialRef: 'credential-ref:signing' });
      const deliveries = await s.invoke('webhooks.emit', { type: 'order.paid', payload: { order: 1 } });
      for (const d of deliveries) await s.services.webhooks!.deliverWebhook(TENANT, d.id);
      hook.status = 500;
      const failing = await s.invoke('webhooks.emit', { type: 'order.paid', payload: { order: 2 } });
      for (const d of failing) {
        for (let attempt = 0; attempt < 8; attempt++) await s.services.webhooks!.deliverWebhook(TENANT, d.id).catch(() => undefined);
        await s.invoke('webhooks.replay', { id: d.id }).catch(() => undefined);
      }
      const integration = await s.invoke('webhooks.integrations.register', { provider: 'stripe', signingCredentialRef: 'credential-ref:signing' });
      s.services.webhooks!.registerInboundHandler('stripe', async () => undefined);
      const body = JSON.stringify({ id: 'evt_1' });
      await s.services.webhooks!.receiveWebhook({ integrationId: integration.id, rawBody: body, headers: signInbound('whsec_contract_signing', body, 'evt_1') });
      await s.invoke('webhooks.remove', { id: endpoint.id });
    } finally {
      await hook.close();
    }
  },
  jobs: async (s) => {
    let fail = true;
    s.services.jobs!.register('report.build', async () => {
      if (fail) {
        fail = false;
        throw new Error('first attempt fails');
      }
    });
    const job = await s.invoke('jobs.create', { type: 'report.build', payload: { week: 1 }, maxAttempts: 1 });
    await s.services.jobs!.executeJob(TENANT, job.id, 'worker-1');
    await s.invoke('jobs.retry', { id: job.id });
    await s.services.jobs!.executeJob(TENANT, job.id, 'worker-1');
  },
  schedules: async (s) => {
    s.services.jobs!.register('digest.send', async () => undefined);
    const schedule = await s.invoke('schedules.create', { type: 'digest.send', payload: { list: 'all' }, interval: '1s' });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await s.services.jobs!.processRecurringSchedules(TENANT);
    await s.invoke('schedules.cancel', { id: schedule.id });
  },
  intelligence: async (s) => {
    await s.invoke('intelligence.write', { provider: 'anthropic', model: 'claude-opus-5-5', credentialRef: 'credential-ref:anthropic', environment: 'production' });
    await s.invoke('intelligence.credential.set', { credentialRef: 'credential-ref:anthropic-2', environment: 'production' });
    await s.services.intelligence!.resolveRuntime({ environment: 'production' } as never, s.principal).catch(() => undefined);
    await s.invoke('intelligence.write', { provider: 'ollama', model: 'llama3.2', endpoint: 'http://127.0.0.1:11434/v1', environment: 'production' });
    await s.invoke('intelligence.credential.remove', { environment: 'production' });
  },
};

/** Enable `service` (and what it needs), drive its write paths, and report every committed write. */
export async function exercise(service: ServiceName): Promise<Observed> {
  const authorizer = new TestAuthority({ allowAll: true });
  const custody = new MemoryCustody();
  const services = createServices({
    memory: true,
    namespace: `contract-${service}-${crypto.randomUUID()}`,
    application: 'contract-app',
    authorizer,
    credentials: custody,
    webhookDestinationPolicy: { allowPrivateNetworks: true },
  } as never);
  const db = services.db as StateFirstDB;
  const principal = services.identify({ principalId: 'alice', principalType: 'user', tenantId: TENANT })!;
  const start = db.getSequence();
  try {
    await SCENARIOS[service]({ services, db, custody, principal, invoke: (capability, input) => services.invoke(capability, input, { principal }) as Promise<any> });
    const observed: Observed = new Map();
    for (const op of (await db.exportOperations(start)) as Array<{ collection: string; type: string; value?: Record<string, unknown> }>) {
      if (op.type !== 'put' || !op.value) continue;
      const fields = observed.get(op.collection) ?? new Map<string, Set<JsonType>>();
      observed.set(op.collection, fields);
      for (const [name, value] of Object.entries(op.value)) {
        if (name === '__version') continue;
        const types = fields.get(name) ?? new Set<JsonType>();
        types.add(jsonType(value));
        fields.set(name, types);
      }
    }
    return observed;
  } finally {
    await Promise.resolve((db as { close?: () => unknown }).close?.());
  }
}
