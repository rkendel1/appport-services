import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatFlowSpec, parseFlowSpec } from '@feltdb/core';

import { appport, BROWSER_NOTIFICATION_EVENT, type AppPortEvent, type AuthenticatedPrincipal, type BrowserNotificationMessage } from '../src/index.js';

async function writeFlow(path: string, collections: readonly string[]): Promise<void> {
  const template = await readFile(new URL('../../appport.flow', import.meta.url), 'utf8');
  const flow = parseFlowSpec(template);
  flow.collections = flow.collections.filter((collection) => collections.includes(collection.name));
  await writeFile(join(path, 'feltdb.flow'), formatFlowSpec(flow));
}

const producer: AuthenticatedPrincipal = { principalId: 'web-monitor', principalType: 'service', tenantId: 'tenant-a', scopes: ['notifications.create'] } as unknown as AuthenticatedPrincipal;
const recipient: AuthenticatedPrincipal = { principalId: 'user-1', principalType: 'user', tenantId: 'tenant-a', scopes: ['notifications.read', 'notifications.write'] } as unknown as AuthenticatedPrincipal;

test('appport runtime delivers browser notifications through the canonical primitive', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-notifications-runtime-'));
  const config = join(path, 'appport.toml');
  await writeFile(config, [
    'use notifications', 'use jobs', '',
    '[tenant]', 'default = "tenant-a"', '',
    '[lifecycle]', 'managed = false', '',
    '[notifications]', 'default_channel = "browser"', '',
    '[notifications.delivery]', 'max_attempts = 4', '',
  ].join('\n'));
  await writeFlow(path, ['Notifications', 'NotificationDeliveries', 'NotificationAuditEvents', 'Jobs', 'JobSchedules', 'JobAuditEvents']);
  const application = await appport({ config, mode: 'local', namespace: 'notifications-runtime', path: join(path, '.feltdb') });
  try {
    assert.deepEqual([...application.notifications.channelTypes()].sort(), ['browser', 'in-app']);
    const received: AppPortEvent[] = [];
    const subscription = application.events.subscribe((event) => received.push(event), { tenantId: 'tenant-a', type: BROWSER_NOTIFICATION_EVENT });

    // Monitor → condition satisfied → AppPort notification → browser delivery.
    const result = await application.forTenant('tenant-a').notifications.notify({
      recipient: 'user-1', type: 'monitor.triggered', title: 'Status changed',
      source: { type: 'monitor', id: 'monitor-7', eventId: 'observation-123' },
    }, producer);
    subscription.close();

    assert.deepEqual(result.notification.channels, ['browser']);
    assert.equal(result.deliveries[0].maxAttempts, 4);
    assert.equal(result.deliveries[0].status, 'delivered');
    assert.equal(received.length, 1);
    const message = received[0].data as BrowserNotificationMessage;
    assert.equal(message.notificationId, result.notification.id);
    assert.equal(message.recipient, 'user-1');
    assert.equal('title' in message, false, 'the shared event stream carries a pointer, not content');

    // The browser fetches content through the authorized API.
    const fetched = await application.notifications.get('tenant-a', message.notificationId, recipient);
    assert.equal(fetched.title, 'Status changed');
    assert.equal((await application.notifications.acknowledge('tenant-a', fetched.id, recipient)).status, 'acknowledged');

    // Application code cannot drive AppPort's internal delivery jobs.
    await assert.rejects(application.jobs.enqueue({ tenantId: 'tenant-a', type: 'appport.notifications.deliver', payload: {} }), /reserved/);
  } finally {
    await application.close();
  }
});
