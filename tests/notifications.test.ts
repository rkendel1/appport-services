import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFeltDbRuntime, FeltDbNotificationAuditSink, FeltDbNotificationDeliveryStore, FeltDbNotificationStore } from '../src/_internal.js';
import { NotificationService } from '../src/notifications/service.js';
import { ServiceAuthorityError } from '../src/authority/errors.js';
import { principal as verified, testGateway, TestAuthority } from './support/authority.js';

const principal = (id = 'recipient') => verified({ principalId: id, principalType: 'api_key', tenantId: 'tenant-a', credentialId: 'key' });
const isDenied = (error: unknown) => error instanceof ServiceAuthorityError && error.code === 'DENIED';

/** AuthBoundry policy used here: senders may send; recipients act on their own notifications. */
async function recipientPolicy(): Promise<TestAuthority> {
  const authority = new TestAuthority();
  for (const subject of ['recipient', 'sender']) await authority.grant({ subject, capability: 'notifications.send', tenantId: 'tenant-a' });
  for (const capability of ['notifications.read', 'notifications.update', 'notifications.delete']) {
    await authority.grant({ subject: 'recipient', capability, tenantId: 'tenant-a', attributes: { recipient: 'recipient' } });
  }
  return authority;
}

async function service(path: string) {
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: `notifications-${Math.random()}`, path });
  return {
    runtime,
    service: new NotificationService({
      store: new FeltDbNotificationStore(runtime.db),
      deliveryStore: new FeltDbNotificationDeliveryStore(runtime.db),
      auditSink: new FeltDbNotificationAuditSink(runtime.db),
      authority: testGateway(runtime.db, { authorizer: await recipientPolicy() }),
    }),
  };
}

test('notifications persist, paginate, and transition through FeltDB', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-notifications-'));
  const first = await service(path);
  const one = await first.service.create({ tenantId: 'tenant-a', recipient: 'recipient', type: 'invoice.ready', title: 'Invoice ready', priority: 'high' }, principal());
  await first.service.create({ tenantId: 'tenant-a', recipient: 'recipient', type: 'message', title: 'Message' }, principal());
  const page = await first.service.list('tenant-a', { limit: 1, recipient: 'recipient' }, principal());
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  const read = await first.service.markRead('tenant-a', one.id, principal());
  assert.ok(read.readAt);
  await first.runtime.db.close();

  const restarted = await service(path);
  assert.equal((await restarted.service.get('tenant-a', one.id, principal())).title, 'Invoice ready');
  await restarted.runtime.db.close();
});

test('notifications enforce tenant and recipient isolation through AuthBoundry', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-notifications-auth-'));
  const { runtime, service: notifications } = await service(path);
  await assert.rejects(notifications.create({ tenantId: 'tenant-b', recipient: 'recipient', type: 'x', title: 'x' }, principal()), isDenied);
  const item = await notifications.create({ tenantId: 'tenant-a', recipient: 'other', type: 'x', title: 'x' }, principal('sender'));
  await assert.rejects(notifications.get('tenant-a', item.id, principal()), isDenied);
  await assert.rejects(notifications.list('tenant-a', {}, principal()), isDenied);
  await runtime.db.close();
});
