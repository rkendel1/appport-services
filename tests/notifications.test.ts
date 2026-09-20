import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFeltDbRuntime, FeltDbNotificationAuditSink, FeltDbNotificationDeliveryStore, FeltDbNotificationStore } from '../src/_internal.js';
import { NotificationAuthorizationError, NotificationService } from '../src/notifications/service.js';
import type { AuthenticatedPrincipal } from '../src/contract/principals.js';

const principal = (id = 'recipient', scopes = ['notifications.create', 'notifications.read', 'notifications.write', 'notifications.delete']): AuthenticatedPrincipal => ({
  principalId: id, principalType: 'api_key', tenantId: 'tenant-a', scopes, credentialId: 'key',
});

async function service(path: string) {
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: `notifications-${Math.random()}`, path });
  return {
    runtime,
    service: new NotificationService({
      store: new FeltDbNotificationStore(runtime.db),
      deliveryStore: new FeltDbNotificationDeliveryStore(runtime.db),
      auditSink: new FeltDbNotificationAuditSink(runtime.db),
    }),
  };
}

test('notifications persist, paginate, and transition through FeltDB', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-notifications-'));
  const first = await service(path);
  const one = await first.service.create({ tenantId: 'tenant-a', recipient: 'recipient', type: 'invoice.ready', title: 'Invoice ready', priority: 'high' }, principal());
  await first.service.create({ tenantId: 'tenant-a', recipient: 'recipient', type: 'message', title: 'Message' }, principal());
  const page = await first.service.list('tenant-a', { limit: 1 }, principal());
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  const read = await first.service.markRead('tenant-a', one.id, principal());
  assert.ok(read.readAt);
  await first.runtime.db.close();

  const restarted = await service(path);
  assert.equal((await restarted.service.get('tenant-a', one.id, principal())).title, 'Invoice ready');
  await restarted.runtime.db.close();
});

test('notifications enforce tenant and recipient isolation', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-notifications-auth-'));
  const { runtime, service: notifications } = await service(path);
  await assert.rejects(
    notifications.create({ tenantId: 'tenant-b', recipient: 'recipient', type: 'x', title: 'x' }, principal()),
    NotificationAuthorizationError,
  );
  const item = await notifications.create({ tenantId: 'tenant-a', recipient: 'other', type: 'x', title: 'x' }, principal('sender', ['notifications.create', 'notifications.read']));
  await assert.rejects(notifications.get('tenant-a', item.id, principal()), NotificationAuthorizationError);
  await runtime.db.close();
});
