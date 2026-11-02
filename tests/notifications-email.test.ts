import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createServices, EmailNotificationChannel, type EmailMessage } from '../src/index.js';
import { TestAuthority } from './support/authority.js';

/** Mailerport's `send()` shape: one call per message, an id back. */
class Outbox {
  readonly sent: EmailMessage[] = [];
  constructor(private readonly fail = 0) {}
  async send(message: EmailMessage) {
    if (this.sent.length < this.fail) {
      this.sent.push(message);
      throw new Error('mail service unavailable');
    }
    this.sent.push(message);
    return { message_id: `msg_${this.sent.length}` };
  }
}

const ADDRESSES: Record<string, string> = { 'user-1': 'ada@example.com' };

async function services(transport: Outbox, render?: ConstructorParameters<typeof EmailNotificationChannel>[0]['render']) {
  const path = await mkdtemp(join(tmpdir(), 'appport-email-'));
  const email = new EmailNotificationChannel({ transport, identity: 'auth', address: (n) => ADDRESSES[n.recipient] ?? null, ...(render ? { render } : {}) });
  const s = createServices({ mode: 'local', namespace: 'email-test', path, authorizer: new TestAuthority({ allowAll: true }), notificationChannels: [email] });
  const sender = s.identify({ principalId: 'auth-mailer', principalType: 'service', tenantId: 'tenant-a' })!;
  return { s, sender };
}

test('a host channel: notifications are delivered by e-mail through a Mailerport-shaped transport', async () => {
  const outbox = new Outbox();
  const { s, sender } = await services(outbox);
  const { notification, deliveries } = await s.notifications.notify({ tenantId: 'tenant-a', recipient: 'user-1', type: 'account.welcome', title: 'Welcome', body: 'Your account is ready.', channels: ['email'] }, sender);
  assert.equal(deliveries[0]!.status, 'delivered');
  assert.equal(deliveries[0]!.externalId, 'msg_1');
  assert.equal(notification.status, 'delivered');
  assert.deepEqual(
    { identity: outbox.sent[0]!.identity, to: outbox.sent[0]!.to, subject: outbox.sent[0]!.subject, text: outbox.sent[0]!.text, idempotencyKey: outbox.sent[0]!.idempotencyKey },
    { identity: 'auth', to: 'ada@example.com', subject: 'Welcome', text: 'Your account is ready.', idempotencyKey: `${notification.id}:email` },
  );
  // in-app stays registered and the default.
  const inApp = await s.notifications.notify({ tenantId: 'tenant-a', recipient: 'user-1', type: 'x', title: 'In the app' }, sender);
  assert.deepEqual(inApp.notification.channels, ['in-app']);
  assert.equal(outbox.sent.length, 1);
  await s.apiKeys.close();
});

test('render builds the message at delivery, so what it carries is never stored in the notification', async () => {
  const outbox = new Outbox();
  const { s, sender } = await services(outbox, (n) => ({ subject: n.title, text: `Open https://app.example/#reset=${String(n.data?.accountId)}.signed-now`, html: '<p>Reset</p>' }));
  const { notification } = await s.notifications.notify({ tenantId: 'tenant-a', recipient: 'user-1', type: 'account.reset', title: 'Reset your password', data: { accountId: 'acct_1' }, channels: ['email'] }, sender);
  assert.match(outbox.sent[0]!.text, /signed-now/);
  assert.equal(outbox.sent[0]!.html, '<p>Reset</p>');
  assert.ok(!JSON.stringify(notification).includes('signed-now'));
  await s.apiKeys.close();
});

test('no address fails for good; a transport error is retryable', async () => {
  const { s, sender } = await services(new Outbox());
  const none = await s.notifications.notify({ tenantId: 'tenant-a', recipient: 'nobody', type: 'x', title: 'Hi', channels: ['email'] }, sender);
  assert.equal(none.deliveries[0]!.status, 'failed');
  assert.equal(none.deliveries[0]!.failureReason, 'no_email_address');
  await s.apiKeys.close();

  const flaky = new Outbox(1);
  const second = await services(flaky);
  const result = await second.s.notifications.notify({ tenantId: 'tenant-a', recipient: 'user-1', type: 'x', title: 'Hi', channels: ['email'] }, second.sender);
  assert.notEqual(result.deliveries[0]!.status, 'delivered');
  assert.match(String(result.deliveries[0]!.failureReason ?? ''), /unavailable/);
  await second.s.apiKeys.close();
});
