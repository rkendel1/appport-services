import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';
import rateLimit from 'express-rate-limit';

import { createFeltDbRuntime, FeltDbNotificationAuditSink, FeltDbNotificationDeliveryStore, FeltDbNotificationStore } from '../src/_internal.js';
import { FeltDbJobAuditSink, FeltDbJobScheduleStore, FeltDbJobStore } from '../src/jobs/store.js';
import { JobService, systemJobs } from '../src/jobs/service.js';
import { ServiceAuthorityError } from '../src/authority/errors.js';
import {
  BrowserNotificationChannel, InAppNotificationChannel, type BrowserNotificationMessage, type NotificationChannel, type NotificationDeliveryResult,
} from '../src/notifications/channels.js';
import { createNotificationRouter, notificationErrorHandler } from '../src/notifications/http.js';
import type { Notification, NotificationDelivery } from '../src/notifications/models.js';
import {
  NOTIFICATION_DELIVERY_JOB, NotificationAuthorizationError, NotificationSensitiveDataError, NotificationService, NotificationValidationError,
} from '../src/notifications/service.js';
import type { AuthenticatedPrincipal } from '../src/contract/principals.js';
import { principal as verified, testGateway, TestAuthority } from './support/authority.js';

const ALL = ['notifications.create', 'notifications.read', 'notifications.write', 'notifications.delete'];
const principal = (id = 'recipient', scopes: readonly string[] = ALL, tenantId = 'tenant-a'): AuthenticatedPrincipal => ({
  principalId: id, principalType: 'api_key', tenantId, scopes, credentialId: 'key',
} as unknown as AuthenticatedPrincipal);
const producer = principal('monitor-service', ['notifications.create']);
const admin = principal('operator', ['notifications.admin']);
const verifiedPrincipal = (id = 'recipient') => verified({ principalId: id, principalType: 'api_key', tenantId: 'tenant-a', credentialId: 'key' });
const isDenied = (error: unknown) => error instanceof ServiceAuthorityError && error.code === 'DENIED';

/** A test channel whose behavior is scripted per call. */
class ScriptedChannel implements NotificationChannel {
  readonly calls: Array<{ notification: Notification; delivery: NotificationDelivery }> = [];
  constructor(readonly type: string, private readonly script: Array<NotificationDeliveryResult | Error> = []) {}
  async deliver(notification: Notification, delivery: NotificationDelivery): Promise<NotificationDeliveryResult> {
    this.calls.push({ notification, delivery });
    const next = this.script.shift() ?? { status: 'delivered' };
    if (next instanceof Error) throw next;
    return next;
  }
}

class Clock {
  constructor(public value = new Date('2026-09-22T12:00:00.000Z')) {}
  now = (): Date => new Date(this.value);
  advance(ms: number): void { this.value = new Date(this.value.getTime() + ms); }
}

interface SetupOptions {
  readonly path?: string;
  readonly channels?: readonly NotificationChannel[];
  readonly withJobs?: boolean;
  readonly clock?: Clock;
  readonly defaultChannels?: readonly string[];
}

async function setup(options: SetupOptions = {}) {
  const path = options.path ?? await mkdtemp(join(tmpdir(), 'appport-notifications-'));
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: 'notifications-test', path });
  const clock = options.clock ?? new Clock();
  const jobStore = new FeltDbJobStore(runtime.db);
  const jobs = options.withJobs === false ? undefined : new JobService({
    jobStore, scheduleStore: new FeltDbJobScheduleStore(runtime.db), auditSink: new FeltDbJobAuditSink(runtime.db), now: clock.now,
  });
  const store = new FeltDbNotificationStore(runtime.db);
  const deliveryStore = new FeltDbNotificationDeliveryStore(runtime.db);
  const service = new NotificationService({
    store, deliveryStore, auditSink: new FeltDbNotificationAuditSink(runtime.db),
    channels: [new InAppNotificationChannel(), ...(options.channels ?? [])],
    ...(options.defaultChannels ? { defaultChannels: options.defaultChannels } : {}),
    ...(jobs ? { jobs } : {}),
    retryDelayMs: 1_000,
    maxDeliveryAttempts: 3,
    now: clock.now,
  });
  return { path, runtime, service, jobs, jobStore, store, deliveryStore, clock, close: () => runtime.db.close() };
}

/** Run every due job the way the managed runtime and JobWorker do. */
async function runDueJobs(jobs: JobService, tenantId = 'tenant-a'): Promise<number> {
  const due = await jobs.listDueJobs(tenantId);
  for (const job of due) await jobs.executeJob(tenantId, job.id, 'test-worker');
  return due.length;
}

const monitorEvent = (eventId = 'observation-123') => ({
  tenantId: 'tenant-a', recipient: 'recipient', type: 'monitor.triggered', title: 'Status changed',
  body: 'The healthcare application status changed.', data: { status: 'degraded' },
  source: { type: 'monitor', id: 'monitor-7', eventId },
});

// ─── Resource ────────────────────────────────────────────────────────────────

test('notify creates a durable notification with one delivery per channel', async () => {
  const ctx = await setup();
  const result = await ctx.service.notify({ ...monitorEvent(), channels: ['in-app'] }, producer);
  assert.equal(result.created, true);
  assert.equal(result.notification.recipient, 'recipient');
  assert.equal(result.notification.type, 'monitor.triggered');
  assert.deepEqual(result.notification.channels, ['in-app']);
  assert.deepEqual(result.notification.source, { type: 'monitor', id: 'monitor-7', eventId: 'observation-123' });
  assert.equal(result.notification.createdBy, 'monitor-service');
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.deliveries[0].notificationId, result.notification.id);
  assert.equal(result.deliveries[0].idempotencyKey, `${result.notification.id}:in-app`);

  const fetched = await ctx.service.get('tenant-a', result.notification.id, principal());
  assert.equal(fetched.title, 'Status changed');
  await ctx.close();
});

test('recipients retrieve only their own notifications with query filters', async () => {
  const ctx = await setup();
  const clock = ctx.clock;
  const first = await ctx.service.create({ tenantId: 'tenant-a', recipient: 'recipient', type: 'quote.status_changed', title: 'Quote' }, producer);
  clock.advance(1_000);
  await ctx.service.create({ tenantId: 'tenant-a', recipient: 'recipient', type: 'deployment.failed', title: 'Deploy', source: { type: 'ci' } }, producer);
  clock.advance(1_000);
  await ctx.service.create({ tenantId: 'tenant-a', recipient: 'someone-else', type: 'deployment.failed', title: 'Theirs' }, producer);

  const mine = await ctx.service.list('tenant-a', {}, principal());
  assert.deepEqual(mine.items.map((item) => item.title), ['Deploy', 'Quote']);
  assert.deepEqual((await ctx.service.list('tenant-a', { type: 'quote.status_changed' }, principal())).items.map((item) => item.id), [first.id]);
  assert.equal((await ctx.service.list('tenant-a', { sourceType: 'ci' }, principal())).items.length, 1);
  assert.equal((await ctx.service.list('tenant-a', { status: 'delivered' }, principal())).items.length, 2);
  assert.equal((await ctx.service.list('tenant-a', { createdAfter: first.createdAt }, principal())).items.length, 1);
  assert.equal((await ctx.service.list('tenant-a', { createdBefore: first.createdAt }, principal())).items.length, 0);

  const page = await ctx.service.list('tenant-a', { limit: 1 }, principal());
  assert.equal(page.items.length, 1);
  const next = await ctx.service.list('tenant-a', { limit: 1, cursor: page.nextCursor }, principal());
  assert.equal(next.items[0].id, first.id);

  const auditor = principal('auditor', ['notifications.read:any']);
  assert.equal((await ctx.service.list('tenant-a', { recipient: 'someone-else' }, auditor)).items.length, 1);
  assert.equal((await ctx.service.list('tenant-a', {}, auditor)).items.length, 3);
  await ctx.close();
});

test('notifications and delivery state survive a service restart', async () => {
  const first = await setup();
  const created = await first.service.notify({ ...monitorEvent(), channels: ['in-app'] }, producer);
  await first.service.markRead('tenant-a', created.notification.id, principal());
  await first.close();

  const restarted = await setup({ path: first.path });
  const item = await restarted.service.get('tenant-a', created.notification.id, principal());
  assert.equal(item.status, 'read');
  assert.ok(item.readAt);
  const deliveries = await restarted.service.deliveries('tenant-a', item.id, principal());
  assert.equal(deliveries[0].status, 'delivered');
  assert.equal(deliveries[0].attemptCount, 1);
  await restarted.close();
});

test('tenant isolation holds for create, get, list, and acknowledge', async () => {
  const ctx = await setup();
  const item = await ctx.service.create({ tenantId: 'tenant-a', recipient: 'recipient', type: 'x', title: 'x' }, producer);
  const tenantB = principal('recipient', [...ALL, 'notifications.admin'], 'tenant-b');
  await assert.rejects(ctx.service.create({ tenantId: 'tenant-a', recipient: 'recipient', type: 'x', title: 'x' }, tenantB), NotificationAuthorizationError);
  await assert.rejects(ctx.service.get('tenant-a', item.id, tenantB), NotificationAuthorizationError);
  await assert.rejects(ctx.service.get('tenant-b', item.id, tenantB), /Notification not found/);
  await assert.rejects(ctx.service.acknowledge('tenant-b', item.id, tenantB), /Notification not found/);
  assert.equal((await ctx.service.list('tenant-b', {}, tenantB)).items.length, 0);
  assert.equal((await ctx.deliveryStore.get('tenant-b', (await ctx.deliveryStore.list('tenant-a', item.id))[0].id)), null);
  await ctx.close();
});

// ─── Lifecycle ───────────────────────────────────────────────────────────────

test('lifecycle: pending → delivered', async () => {
  const ctx = await setup();
  const { notification, deliveries } = await ctx.service.notify({ ...monitorEvent(), channels: ['in-app'] }, producer);
  assert.equal(notification.status, 'delivered');
  assert.ok(notification.deliveredAt);
  assert.equal(deliveries[0].status, 'delivered');
  assert.ok(deliveries[0].deliveredAt);
  await ctx.close();
});

test('lifecycle: pending → failed when every channel fails permanently', async () => {
  const email = new ScriptedChannel('email', [{ status: 'failed', reason: 'mailbox_unknown', retryable: false }]);
  const ctx = await setup({ channels: [email] });
  const { notification, deliveries } = await ctx.service.notify({ ...monitorEvent(), channels: ['email'] }, producer);
  assert.equal(notification.status, 'failed');
  assert.equal(deliveries[0].status, 'failed');
  assert.equal(deliveries[0].failureReason, 'mailbox_unknown');
  assert.ok(deliveries[0].failedAt);
  // The notification itself survives a failed delivery.
  assert.equal((await ctx.service.get('tenant-a', notification.id, principal())).id, notification.id);
  await ctx.close();
});

test('lifecycle: failed → retrying → delivered via an explicit retry', async () => {
  const email = new ScriptedChannel('email', [{ status: 'failed', reason: 'smtp_down', retryable: false }]);
  const ctx = await setup({ channels: [email] });
  const { notification } = await ctx.service.notify({ ...monitorEvent(), channels: ['email'] }, producer);
  assert.equal(notification.status, 'failed');

  const retrying = await ctx.service.retryDelivery('tenant-a', notification.id, 'email', admin);
  assert.equal(retrying.status, 'retrying');
  assert.ok(retrying.maxAttempts > retrying.attemptCount);
  assert.equal(await runDueJobs(ctx.jobs!), 1);

  const [delivery] = await ctx.service.deliveries('tenant-a', notification.id, admin);
  assert.equal(delivery.status, 'delivered');
  assert.equal(delivery.attemptCount, 2);
  assert.equal((await ctx.service.get('tenant-a', notification.id, admin)).status, 'delivered');
  await assert.rejects(ctx.service.retryDelivery('tenant-a', notification.id, 'email', principal()), NotificationAuthorizationError);
  await ctx.close();
});

test('lifecycle: delivered → read → acknowledged, and read does not imply acknowledged', async () => {
  const ctx = await setup();
  const { notification } = await ctx.service.notify({ ...monitorEvent(), channels: ['in-app'] }, producer);
  assert.equal(notification.status, 'delivered');

  const read = await ctx.service.markRead('tenant-a', notification.id, principal());
  assert.equal(read.status, 'read');
  assert.ok(read.readAt);
  assert.equal(read.acknowledgedAt, undefined);
  assert.equal((await ctx.service.list('tenant-a', { unread: true }, principal())).items.length, 0);
  assert.equal((await ctx.service.list('tenant-a', { unacknowledged: true }, principal())).items.length, 1);

  ctx.clock.advance(5_000);
  const acknowledged = await ctx.service.acknowledge('tenant-a', notification.id, principal());
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal(acknowledged.readAt, read.readAt);
  assert.ok(acknowledged.acknowledgedAt! > read.readAt!);
  assert.equal((await ctx.service.list('tenant-a', { unacknowledged: true }, principal())).items.length, 0);

  // Idempotent: repeating read/acknowledge changes nothing.
  assert.equal((await ctx.service.markRead('tenant-a', notification.id, principal())).status, 'acknowledged');
  assert.equal((await ctx.service.acknowledge('tenant-a', notification.id, principal())).acknowledgedAt, acknowledged.acknowledgedAt);
  await ctx.close();
});

test('lifecycle: an expired notification is not newly delivered and remains as evidence', async () => {
  const email = new ScriptedChannel('email', [new Error('provider unavailable')]);
  const ctx = await setup({ channels: [email] });
  const expiresAt = new Date(ctx.clock.value.getTime() + 60_000).toISOString();
  const { notification, deliveries } = await ctx.service.notify({ ...monitorEvent(), type: 'appointment.available', title: 'Appointment slot available', channels: ['email'], expiresAt }, producer);
  assert.equal(deliveries[0].status, 'retrying');

  ctx.clock.advance(120_000);
  await runDueJobs(ctx.jobs!);
  assert.equal(email.calls.length, 1, 'no delivery attempt after expiry');
  const [delivery] = await ctx.service.deliveries('tenant-a', notification.id, principal());
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.failureReason, 'notification_expired');
  const evidence = await ctx.service.get('tenant-a', notification.id, principal());
  assert.equal(evidence.status, 'expired');
  assert.ok(evidence.expiredAt);
  assert.equal(evidence.title, 'Appointment slot available');

  await assert.rejects(
    ctx.service.notify({ ...monitorEvent('late'), expiresAt: new Date(ctx.clock.value.getTime() - 1).toISOString() }, producer),
    /expiresAt must be in the future/,
  );
  await ctx.close();
});

// ─── Channels ────────────────────────────────────────────────────────────────

test('browser channel receives the canonical notification and pushes only a pointer', async () => {
  const pushed: BrowserNotificationMessage[] = [];
  const browser = new BrowserNotificationChannel({ push: (message) => { pushed.push(message); } });
  const spy: Array<{ notification: Notification; delivery: NotificationDelivery }> = [];
  const observed: NotificationChannel = { type: 'browser', deliver: async (notification, delivery) => { spy.push({ notification, delivery }); return browser.deliver(notification, delivery); } };
  const ctx = await setup({ channels: [observed] });
  const { notification, deliveries } = await ctx.service.notify({ ...monitorEvent(), channels: ['browser'] }, producer);

  assert.equal(spy.length, 1);
  assert.equal(spy[0].notification.id, notification.id);
  assert.equal(spy[0].notification.type, 'monitor.triggered');
  assert.deepEqual(spy[0].notification.source, monitorEvent().source);
  assert.equal(pushed.length, 1);
  assert.deepEqual(Object.keys(pushed[0]).sort(), ['createdAt', 'deliveryId', 'idempotencyKey', 'notificationId', 'recipient', 'tenantId', 'type']);
  assert.equal(pushed[0].idempotencyKey, `${notification.id}:browser`);
  assert.equal(deliveries[0].status, 'delivered');
  assert.equal(deliveries[0].externalId, pushed[0].idempotencyKey);
  await ctx.close();
});

test('one channel failing does not invalidate another channel', async () => {
  const browser = new ScriptedChannel('browser', [new Error('transport closed')]);
  const email = new ScriptedChannel('email');
  const ctx = await setup({ channels: [browser, email] });
  const { notification, deliveries } = await ctx.service.notify({ ...monitorEvent(), channels: ['browser', 'email', 'in-app'] }, producer);
  const byChannel = Object.fromEntries(deliveries.map((delivery) => [delivery.channel, delivery]));
  assert.equal(byChannel.browser.status, 'retrying');
  assert.equal(byChannel.browser.failureReason, 'transport closed');
  assert.equal(byChannel.email.status, 'delivered');
  assert.equal(byChannel['in-app'].status, 'delivered');
  assert.equal(notification.status, 'delivered');
  await ctx.close();
});

test('unknown channels are rejected before anything is persisted', async () => {
  const ctx = await setup();
  await assert.rejects(ctx.service.notify({ ...monitorEvent(), channels: ['sms'] }, producer), /Unknown notification channel: sms/);
  assert.equal((await ctx.store.list('tenant-a')).length, 0);
  await ctx.close();
});

// ─── Idempotency ─────────────────────────────────────────────────────────────

test('duplicate creation for the same source event produces one notification', async () => {
  const email = new ScriptedChannel('email');
  const ctx = await setup({ channels: [email] });
  const first = await ctx.service.notify({ ...monitorEvent(), channels: ['email'] }, producer);
  const second = await ctx.service.notify({ ...monitorEvent(), channels: ['email'] }, producer);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.notification.id, first.notification.id);
  assert.equal(first.notification.idempotencyKey, JSON.stringify(['monitor', 'observation-123', 'monitor.triggered']));
  assert.equal((await ctx.store.list('tenant-a')).length, 1);
  assert.equal(email.calls.length, 1);

  // A different event, or a different recipient, is a different notification.
  assert.notEqual((await ctx.service.notify({ ...monitorEvent('observation-124'), channels: ['email'] }, producer)).notification.id, first.notification.id);
  assert.notEqual((await ctx.service.notify({ ...monitorEvent(), recipient: 'other', channels: ['email'] }, producer)).notification.id, first.notification.id);
  await ctx.close();
});

test('concurrent duplicate creation yields one notification and one delivery per channel', async () => {
  const email = new ScriptedChannel('email');
  const ctx = await setup({ channels: [email] });
  const results = await Promise.all(Array.from({ length: 5 }, () => ctx.service.notify({ ...monitorEvent(), channels: ['email'], idempotencyKey: 'agent-run-9' }, producer)));
  assert.equal(new Set(results.map((result) => result.notification.id)).size, 1);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal((await ctx.store.list('tenant-a')).length, 1);
  assert.equal((await ctx.deliveryStore.list('tenant-a')).length, 1);
  assert.equal(email.calls.length, 1);
  await ctx.close();
});

test('duplicate or early retry jobs do not produce duplicate deliveries', async () => {
  const email = new ScriptedChannel('email', [new Error('timeout')]);
  const ctx = await setup({ channels: [email] });
  const { notification, deliveries } = await ctx.service.notify({ ...monitorEvent(), channels: ['email'] }, producer);
  assert.equal(deliveries[0].status, 'retrying');
  // A stray second job for the same delivery.
  await systemJobs(ctx.jobs!).enqueue({ tenantId: 'tenant-a', type: NOTIFICATION_DELIVERY_JOB, payload: { deliveryId: deliveries[0].id } });
  await runDueJobs(ctx.jobs!);
  assert.equal(email.calls.length, 1, 'the early job must not attempt before nextAttemptAt');

  ctx.clock.advance(1_000);
  await runDueJobs(ctx.jobs!);
  await runDueJobs(ctx.jobs!);
  assert.equal(email.calls.length, 2);
  const [delivery] = await ctx.service.deliveries('tenant-a', notification.id, principal());
  assert.equal(delivery.status, 'delivered');
  assert.equal((await ctx.deliveryStore.list('tenant-a')).length, 1);
  await ctx.close();
});

test('a recent pending attempt is treated as leased and duplicate delivery jobs do not redeliver it', async () => {
  const email = new ScriptedChannel('email');
  const ctx = await setup({ channels: [email] });
  const createdAt = ctx.clock.value.toISOString();
  const notification: Notification = {
    id: '5c2e3b1a-0000-4000-8000-000000000011',
    tenantId: 'tenant-a',
    recipient: 'recipient',
    type: 'monitor.triggered',
    title: 'Status changed',
    priority: 'normal',
    channels: ['email'],
    status: 'pending',
    createdAt,
    __version: 1,
  };
  const delivery: NotificationDelivery = {
    id: '5c2e3b1a-0000-4000-8000-000000000012',
    tenantId: 'tenant-a',
    notificationId: notification.id,
    recipient: 'recipient',
    channel: 'email',
    status: 'pending',
    idempotencyKey: `${notification.id}:email`,
    attemptCount: 1,
    maxAttempts: 3,
    createdAt,
    lastAttemptAt: createdAt,
    __version: 1,
  };
  await ctx.store.createWithDeliveries(notification, [delivery]);

  await systemJobs(ctx.jobs!).enqueue({ tenantId: 'tenant-a', type: NOTIFICATION_DELIVERY_JOB, payload: { deliveryId: delivery.id } });
  assert.equal(await runDueJobs(ctx.jobs!), 1);
  assert.equal(email.calls.length, 0, 'freshly leased pending delivery must not redeliver');
  assert.equal((await ctx.service.deliveries('tenant-a', notification.id, principal()))[0].status, 'pending');

  ctx.clock.advance(31_000);
  await systemJobs(ctx.jobs!).enqueue({ tenantId: 'tenant-a', type: NOTIFICATION_DELIVERY_JOB, payload: { deliveryId: delivery.id } });
  assert.equal(await runDueJobs(ctx.jobs!), 1);
  const [recovered] = await ctx.service.deliveries('tenant-a', notification.id, principal());
  assert.equal(recovered.status, 'delivered');
  assert.equal(recovered.attemptCount, 2);
  assert.equal(email.calls.length, 1);
  await ctx.close();
});

test('a producer retry after a failed delivery does not create a duplicate notification', async () => {
  const email = new ScriptedChannel('email', [{ status: 'failed', reason: 'bounced', retryable: false }]);
  const ctx = await setup({ channels: [email] });
  const first = await ctx.service.notify({ ...monitorEvent(), channels: ['email'] }, producer);
  const retry = await ctx.service.notify({ ...monitorEvent(), channels: ['email'] }, producer);
  assert.equal(retry.notification.id, first.notification.id);
  assert.equal(retry.deliveries[0].status, 'failed');
  assert.equal(email.calls.length, 1);
  await ctx.close();
});

test('a deleted notification can be recreated with the same idempotency key', async () => {
  const email = new ScriptedChannel('email', [{ status: 'failed', reason: 'bounced', retryable: false }]);
  const ctx = await setup({ channels: [email] });
  const first = await ctx.service.notify({ ...monitorEvent(), channels: ['email'], idempotencyKey: 'recreate-me' }, producer);
  await ctx.service.delete('tenant-a', first.notification.id, principal());
  const recreated = await ctx.service.notify({ ...monitorEvent(), channels: ['email'], idempotencyKey: 'recreate-me' }, producer);
  assert.equal(recreated.notification.id, first.notification.id);
  assert.equal(recreated.created, true);
  await ctx.close();
});

// ─── Retry ───────────────────────────────────────────────────────────────────

test('retryable failures are retried through the existing job infrastructure with backoff', async () => {
  const email = new ScriptedChannel('email', [new Error('503'), new Error('503')]);
  const ctx = await setup({ channels: [email] });
  const { notification, deliveries } = await ctx.service.notify({ ...monitorEvent(), channels: ['email'] }, producer);
  assert.equal(notification.status, 'pending');
  assert.equal(deliveries[0].status, 'retrying');
  assert.equal(deliveries[0].nextAttemptAt, new Date(ctx.clock.value.getTime() + 1_000).toISOString());

  const retryJobs = (await ctx.jobs!.listJobs('tenant-a')).filter((job) => job.type === NOTIFICATION_DELIVERY_JOB);
  assert.equal(retryJobs.length, 1);
  assert.equal(retryJobs[0].runAt, deliveries[0].nextAttemptAt);
  assert.equal(await runDueJobs(ctx.jobs!), 0, 'not due yet');

  ctx.clock.advance(1_000);
  await runDueJobs(ctx.jobs!);
  let [delivery] = await ctx.service.deliveries('tenant-a', notification.id, principal());
  assert.equal(delivery.status, 'retrying');
  assert.equal(delivery.attemptCount, 2);
  assert.equal(delivery.nextAttemptAt, new Date(ctx.clock.value.getTime() + 2_000).toISOString());

  ctx.clock.advance(2_000);
  await runDueJobs(ctx.jobs!);
  [delivery] = await ctx.service.deliveries('tenant-a', notification.id, principal());
  assert.equal(delivery.status, 'delivered');
  assert.equal(delivery.attemptCount, 3);
  assert.equal((await ctx.service.get('tenant-a', notification.id, principal())).status, 'delivered');
  await ctx.close();
});

test('delivery fails permanently once the attempt budget is exhausted', async () => {
  const email = new ScriptedChannel('email', [new Error('a'), new Error('b'), new Error('c')]);
  const ctx = await setup({ channels: [email] });
  const { notification } = await ctx.service.notify({ ...monitorEvent(), channels: ['email'] }, producer);
  for (let i = 0; i < 5; i++) { ctx.clock.advance(10_000); await runDueJobs(ctx.jobs!); }
  const [delivery] = await ctx.service.deliveries('tenant-a', notification.id, principal());
  assert.equal(delivery.status, 'failed');
  assert.equal(delivery.attemptCount, 3);
  assert.equal(delivery.failureReason, 'c');
  assert.equal(email.calls.length, 3);
  assert.equal((await ctx.service.get('tenant-a', notification.id, principal())).status, 'failed');
  await ctx.close();
});

test('application code cannot enqueue or register AppPort system job types', async () => {
  const ctx = await setup();
  await assert.rejects(ctx.jobs!.enqueue({ tenantId: 'tenant-a', type: NOTIFICATION_DELIVERY_JOB, payload: {} }), /reserved/);
  assert.throws(() => ctx.jobs!.register('appport.anything', async () => undefined), /reserved/);
  await ctx.close();
});

// ─── Authorization ───────────────────────────────────────────────────────────

test('authorization: unauthorized creation is rejected', async () => {
  const ctx = await setup();
  const input = { tenantId: 'tenant-a', recipient: 'recipient', type: 'x', title: 'x' };
  await assert.rejects(ctx.service.create(input, principal('reader', ['notifications.read'])), NotificationAuthorizationError);
  await assert.rejects(ctx.service.create(input, principal('other-tenant', ALL, 'tenant-b')), NotificationAuthorizationError);
  assert.equal((await ctx.store.list('tenant-a')).length, 0);
  await ctx.close();
});

test('authorization: missing or malformed authority fails closed', async () => {
  const ctx = await setup();
  const item = await ctx.service.create({ tenantId: 'tenant-a', recipient: 'recipient', type: 'x', title: 'x' }, producer);
  const missing = [undefined, null, {}, { principalId: 'recipient', tenantId: 'tenant-a' }, { principalId: '', tenantId: 'tenant-a', scopes: ALL }] as unknown as AuthenticatedPrincipal[];
  for (const candidate of missing) {
    await assert.rejects(ctx.service.create({ tenantId: 'tenant-a', recipient: 'recipient', type: 'x', title: 'x' }, candidate), NotificationAuthorizationError);
    await assert.rejects(ctx.service.get('tenant-a', item.id, candidate), NotificationAuthorizationError);
    await assert.rejects(ctx.service.list('tenant-a', {}, candidate), NotificationAuthorizationError);
    await assert.rejects(ctx.service.acknowledge('tenant-a', item.id, candidate), NotificationAuthorizationError);
  }
  await assert.rejects(ctx.service.create({ recipient: 'recipient', type: 'x', title: 'x' } as never, producer), NotificationAuthorizationError);
  await ctx.close();
});

test('authorization: unauthorized retrieval is rejected', async () => {
  const ctx = await setup();
  const item = await ctx.service.create({ tenantId: 'tenant-a', recipient: 'other', type: 'x', title: 'x' }, producer);
  await assert.rejects(ctx.service.get('tenant-a', item.id, principal()), NotificationAuthorizationError);
  await assert.rejects(ctx.service.deliveries('tenant-a', item.id, principal()), NotificationAuthorizationError);
  await assert.rejects(ctx.service.list('tenant-a', { recipient: 'other' }, principal()), NotificationAuthorizationError);
  assert.equal((await ctx.service.list('tenant-a', {}, principal())).items.length, 0);
  // Producers without read scope cannot read what they created.
  await assert.rejects(ctx.service.get('tenant-a', item.id, producer), NotificationAuthorizationError);
  await ctx.close();
});

test('authorization: acknowledgement requires authority over the notification', async () => {
  const ctx = await setup();
  const item = await ctx.service.create({ tenantId: 'tenant-a', recipient: 'recipient', type: 'x', title: 'x' }, producer);
  const readsAll = principal('auditor', ['notifications.read:any', 'notifications.write']);
  await assert.rejects(ctx.service.acknowledge('tenant-a', item.id, readsAll), NotificationAuthorizationError);
  await assert.rejects(ctx.service.markRead('tenant-a', item.id, readsAll), NotificationAuthorizationError);
  await assert.rejects(ctx.service.acknowledge('tenant-a', item.id, principal('recipient', ['notifications.read'])), NotificationAuthorizationError);
  assert.equal((await ctx.service.get('tenant-a', item.id, principal())).acknowledgedAt, undefined);
  assert.equal((await ctx.service.acknowledge('tenant-a', item.id, principal())).status, 'acknowledged');
  await ctx.close();
});

// ─── Security ────────────────────────────────────────────────────────────────

test('credentials cannot enter notification payloads', async () => {
  const ctx = await setup();
  const base = { tenantId: 'tenant-a', recipient: 'recipient', type: 'monitor.triggered', title: 'Status changed' };
  const rejected: Array<[string, Record<string, unknown>]> = [
    ['password', { data: { login: { password: 'hunter2' } } }],
    ['cookie', { data: { cookies: [{ name: 'sid', value: 'abc' }] } }],
    ['session cookie value', { body: 'Captured session=s%3AabcdefghijklmnopQ; Path=/' }],
    ['authorization header', { data: { request: { headers: { Authorization: 'x' } } } }],
    ['bearer value', { body: 'Use Bearer eyJhbGciOiJIUzI1NiJ9.token-value to call' }],
    ['refresh token', { data: { refresh_token: 'r-123' } }],
    ['api key name', { data: { apiKey: 'k-123' } }],
    ['api key value', { data: { note: 'app_live_a1b2c3_ZZZZZZZZZZZZZZZZZZZZZZZZ' } }],
    ['private key', { data: { pem: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...' } }],
    ['signing material', { data: { signingSecret: 'whsec_123' } }],
    ['jwt in title', { title: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' }],
    ['source credential', { source: { type: 'monitor', id: 'Bearer abcdefghijklmnop' } }],
  ];
  for (const [label, extra] of rejected) {
    await assert.rejects(ctx.service.notify({ ...base, ...extra } as never, producer), (error: unknown) => {
      assert.ok(error instanceof NotificationSensitiveDataError, label);
      assert.doesNotMatch((error as Error).message, /hunter2|abc|r-123|k-123|whsec_123|ZZZZ/, `${label} error must not echo the secret`);
      return true;
    });
  }
  assert.equal((await ctx.store.list('tenant-a')).length, 0, 'nothing is persisted');

  // Ordinary monitoring data is accepted.
  const ok = await ctx.service.notify({ ...base, data: { status: 'degraded', tokenCount: 3, url: 'https://status.example.com' } }, producer);
  assert.equal(ok.created, true);
  await ctx.close();
});

test('delivery failure reasons never persist credential material', async () => {
  const email = new ScriptedChannel('email', [{ status: 'failed', reason: 'POST failed with Authorization: Bearer abcdefghijklmnopqrstuvwxyz', retryable: false }]);
  const ctx = await setup({ channels: [email] });
  const { deliveries } = await ctx.service.notify({ ...monitorEvent(), channels: ['email'] }, producer);
  assert.doesNotMatch(deliveries[0].failureReason!, /abcdefghijklmnop/);
  await ctx.close();
});

test('delivery failure reasons with credential-like key names are scrubbed', async () => {
  const email = new ScriptedChannel('email', [{ status: 'failed', reason: ['password', '=', 'hunter2'].join(''), retryable: false }]);
  const ctx = await setup({ channels: [email] });
  const { deliveries } = await ctx.service.notify({ ...monitorEvent(), channels: ['email'] }, producer);
  assert.equal(deliveries[0].failureReason, 'delivery_failed (details withheld: contained credential material)');
  await ctx.close();
});

test('protected fields cannot be set by the producer', async () => {
  const ctx = await setup();
  await assert.rejects(ctx.service.notify({ ...monitorEvent(), status: 'acknowledged' } as never, producer), NotificationValidationError);
  await assert.rejects(ctx.service.notify({ ...monitorEvent(), id: 'chosen' } as never, producer), NotificationValidationError);
  await assert.rejects(ctx.service.notify({ ...monitorEvent(), source: { type: 'monitor', record: { full: 'copy' } } } as never, producer), /Unknown source field/);
  await ctx.close();
});

// ─── Recovery ────────────────────────────────────────────────────────────────

test('a worker restart resumes delivery retries from durable state', async () => {
  const flaky = new ScriptedChannel('email', [new Error('down')]);
  const first = await setup({ channels: [flaky] });
  const { notification } = await first.service.notify({ ...monitorEvent(), channels: ['email'] }, producer);
  await first.close();

  const clock = new Clock(new Date(first.clock.value.getTime() + 5_000));
  const healthy = new ScriptedChannel('email');
  const second = await setup({ path: first.path, channels: [healthy], clock });
  assert.equal(await runDueJobs(second.jobs!), 1);
  assert.equal(healthy.calls.length, 1);
  const [delivery] = await second.service.deliveries('tenant-a', notification.id, principal());
  assert.equal(delivery.status, 'delivered');
  assert.equal(delivery.attemptCount, 2);
  await second.close();
});

test('deliveries persisted before a crash are recovered exactly once', async () => {
  const ctx = await setup({ channels: [new ScriptedChannel('email')] });
  const createdAt = ctx.clock.value.toISOString();
  // Simulate a crash between the durable commit and the first delivery attempt.
  const notification: Notification = { id: '5c2e3b1a-0000-4000-8000-000000000001', tenantId: 'tenant-a', recipient: 'recipient', type: 'x', title: 'x', priority: 'normal', channels: ['email'], status: 'pending', createdAt, __version: 1 };
  await ctx.store.createWithDeliveries(notification, [{
    id: '5c2e3b1a-0000-4000-8000-000000000002', tenantId: 'tenant-a', notificationId: notification.id, recipient: 'recipient', channel: 'email', status: 'pending',
    idempotencyKey: `${notification.id}:email`, attemptCount: 0, maxAttempts: 3, createdAt, __version: 1,
  }]);
  await ctx.close();

  const email = new ScriptedChannel('email');
  const restarted = await setup({ path: ctx.path, channels: [email] });
  assert.equal(await restarted.service.recoverDeliveries('tenant-a'), 1);
  assert.equal(await restarted.service.recoverDeliveries('tenant-a'), 0);
  assert.equal(email.calls.length, 1);
  assert.equal((await restarted.service.get('tenant-a', notification.id, principal())).status, 'delivered');
  await restarted.close();
});

test('closing a browser does not lose notifications: a new session reads durable state', async () => {
  const pushed: BrowserNotificationMessage[] = [];
  const ctx = await setup({ channels: [new BrowserNotificationChannel({ push: (message) => { pushed.push(message); } })] });
  const { notification } = await ctx.service.notify({ ...monitorEvent(), channels: ['browser'] }, producer);
  assert.equal(pushed.length, 1);
  await ctx.close();

  // Browser closed and the service restarted; a fresh browser session catches up from the API.
  const restarted = await setup({ path: ctx.path });
  const unread = await restarted.service.list('tenant-a', { unread: true }, principal());
  assert.deepEqual(unread.items.map((item) => item.id), [notification.id]);
  await restarted.service.markRead('tenant-a', notification.id, principal());
  await restarted.close();

  const again = await setup({ path: ctx.path });
  assert.equal((await again.service.list('tenant-a', { unread: true }, principal())).items.length, 0);
  assert.equal((await again.service.get('tenant-a', notification.id, principal())).status, 'read');
  await again.close();
});

// ─── HTTP ────────────────────────────────────────────────────────────────────

test('HTTP API follows AppPort conventions and fails closed without authentication', async () => {
  const ctx = await setup();
  const app = express();
  app.use(express.json());
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
  app.use((req, _res, next) => {
    const id = req.header('x-test-principal');
    if (id) req.auth = principal(id, id === 'monitor-service' ? ['notifications.create'] : ALL);
    next();
  });
  app.use('/notifications', createNotificationRouter(ctx.service));
  app.use(notificationErrorHandler as express.ErrorRequestHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/notifications`;
  const call = (path: string, init: RequestInit & { as?: string } = {}) => fetch(`${base}${path}`, {
    ...init, headers: { 'content-type': 'application/json', ...(init.as ? { 'x-test-principal': init.as } : {}) },
  });
  try {
    const body = JSON.stringify({ recipient: 'recipient', type: 'monitor.triggered', title: 'Changed', source: { type: 'monitor', eventId: 'obs-1' }, channels: ['in-app'] });
    assert.equal((await call('', { method: 'POST', body })).status, 403);
    const created = await call('', { method: 'POST', body, as: 'monitor-service' });
    assert.equal(created.status, 201);
    const payload = await created.json() as { notification: Notification; deliveries: NotificationDelivery[] };
    assert.equal(payload.notification.status, 'delivered');
    assert.equal(payload.deliveries.length, 1);
    assert.equal((await call('', { method: 'POST', body, as: 'monitor-service' })).status, 200, 'idempotent replay');

    const id = payload.notification.id;
    assert.equal((await call(`/${id}`, { as: 'intruder' })).status, 403);
    assert.equal((await call(`/${id}`, { as: 'recipient' })).status, 200);
    assert.equal((await (await call('?unacknowledged=true', { as: 'recipient' })).json() as { items: unknown[] }).items.length, 1);
    assert.equal((await (await call(`/${id}/read`, { method: 'POST', as: 'recipient' })).json() as Notification).status, 'read');
    assert.equal((await call(`/${id}/acknowledge`, { method: 'POST', as: 'intruder' })).status, 403);
    assert.equal((await (await call(`/${id}/acknowledge`, { method: 'POST', as: 'recipient' })).json() as Notification).status, 'acknowledged');
    assert.equal((await call(`/${id}/deliveries`, { as: 'recipient' })).status, 200);
    assert.equal((await call('', { method: 'POST', as: 'monitor-service', body: JSON.stringify({ recipient: 'r', type: 't', title: 't', data: { password: 'p' } }) })).status, 400);
    assert.equal((await call('/missing', { as: 'recipient' })).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await ctx.close();
  }
});

test('notifications enforce tenant and recipient isolation through AuthBoundry', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-notifications-auth-'));
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: `notifications-auth-${Math.random()}`, path });
  const authority = new TestAuthority();
  for (const subject of ['recipient', 'sender']) await authority.grant({ subject, capability: 'notifications.send', tenantId: 'tenant-a' });
  await authority.grant({ subject: 'recipient', capability: 'notifications.read', tenantId: 'tenant-a', attributes: { recipient: 'recipient' } });
  const service = new NotificationService({
    store: new FeltDbNotificationStore(runtime.db),
    deliveryStore: new FeltDbNotificationDeliveryStore(runtime.db),
    auditSink: new FeltDbNotificationAuditSink(runtime.db),
    authority: testGateway(runtime.db, { authorizer: authority }),
  });
  await assert.rejects(service.create({ tenantId: 'tenant-b', recipient: 'recipient', type: 'x', title: 'x' }, verifiedPrincipal()), isDenied);
  const item = await service.create({ tenantId: 'tenant-a', recipient: 'other', type: 'x', title: 'x' }, verifiedPrincipal('sender'));
  await assert.rejects(service.get('tenant-a', item.id, verifiedPrincipal()), isDenied);
  await assert.rejects(service.list('tenant-a', {}, verifiedPrincipal()), isDenied);
  await runtime.db.close();
});
