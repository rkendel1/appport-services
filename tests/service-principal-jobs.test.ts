import assert from 'node:assert/strict';
import test from 'node:test';

import { createServices, isServiceAuthorityError, JobTerminalError, type AppPortServices } from '../src/index.js';
import { TestAuthority } from './support/authority.js';

const APP = 'meetings';
const SERVICE = 'service:meetings';

function open(authority: TestAuthority, options: { servicePrincipal?: boolean } = {}) {
  const services = createServices({
    memory: true,
    namespace: `svc-jobs-${crypto.randomUUID()}`,
    application: APP,
    authorizer: authority,
    ...(options.servicePrincipal === false ? {} : { servicePrincipal: { principalId: SERVICE } }),
  } as never);
  const host = services.identify({ principalId: 'host-1', principalType: 'user', tenantId: 'tenant-a' })!;
  return { services, host };
}

async function grantHost(authority: TestAuthority, ...capabilities: string[]) {
  for (const capability of capabilities) await authority.grant({ subject: 'host-1', capability });
}

async function evidenceOf(services: AppPortServices, runId: string) {
  return (await services.evidence.findByRunId(runId)).records;
}

test('S1: a service-run job runs as the application service principal after the enqueuer lost access', async () => {
  const authority = new TestAuthority();
  const { services, host } = open(authority);
  await grantHost(authority, 'jobs.create.service');
  await authority.grant({ subject: SERVICE, capability: 'jobs.execute', attributes: { jobType: 'meeting.summary' } });
  await authority.grant({ subject: SERVICE, capability: 'notifications.send' });
  const seen: { principalId: string; principalType: string; verifiedBy: string; enqueuedBy?: string; runAs: string }[] = [];
  services.jobs.register('meeting.summary', async (_job, execution) => {
    seen.push({ principalId: execution.principal.principalId, principalType: execution.principal.principalType, verifiedBy: execution.principal.verifiedBy, ...(execution.principal.enqueuedBy ? { enqueuedBy: execution.principal.enqueuedBy } : {}), runAs: execution.runAs });
    // Effects the handler causes are authorized as the service principal.
    await services.notifications.notify({ recipient: 'host-1', type: 'summary.ready', title: 'Summary ready' }, execution.principal);
  });

  const job = await services.jobs.enqueue({ type: 'meeting.summary', payload: { meetingId: 'm1' }, runAs: 'service' }, host);
  assert.equal(job.runAs, 'service');
  assert.equal(job.principal?.principalId, 'host-1', 'the durable principal records who enqueued it');

  // The last host's session ends: every grant of the host is gone.
  authority.clearGrants();
  await authority.grant({ subject: SERVICE, capability: 'jobs.execute', attributes: { jobType: 'meeting.summary' } });
  await authority.grant({ subject: SERVICE, capability: 'notifications.send' });

  assert.equal(await services.jobs.executeJob('tenant-a', job.id, 'worker'), true);
  assert.deepEqual(seen, [{ principalId: SERVICE, principalType: 'service', verifiedBy: 'service', enqueuedBy: 'host-1', runAs: 'service' }]);
  assert.equal((await services.jobs.getJob('tenant-a', job.id))?.status, 'completed');

  // AuthBoundry saw the service principal, as the application, with who enqueued it.
  const execute = authority.requests.find((request) => request.capability === 'jobs.execute')!;
  assert.deepEqual(execute.subject, { kind: 'service', id: SERVICE });
  assert.equal(execute.context.verified_by, 'service');
  assert.equal(execute.context.enqueued_by, 'host-1');
  assert.equal(execute.application_id, APP);
  assert.equal(execute.resource.attributes?.runAs, 'service');

  // Evidence: the run and its effects ran as the service principal, enqueued by host-1.
  const records = await evidenceOf(services, `${job.id}:1`);
  assert.deepEqual(records.map((record) => [record.capability, record.principalId, record.principalType, record.enqueuedBy, record.outcome]).sort(), [
    ['jobs.execute', SERVICE, 'service', 'host-1', 'succeeded'],
    ['notifications.send', SERVICE, 'service', 'host-1', 'succeeded'],
  ]);
});

test('S1: creator-scoped jobs stay the default and are refused once the creator loses access (with the reason, S12)', async () => {
  const authority = new TestAuthority();
  const { services, host } = open(authority);
  await grantHost(authority, 'jobs.create', 'jobs.execute');
  services.jobs.register('meeting.summary', async () => undefined);
  const job = await services.jobs.enqueue({ type: 'meeting.summary', payload: {} }, host);
  assert.equal(job.runAs, undefined);
  authority.clearGrants();
  assert.equal(await services.jobs.executeJob('tenant-a', job.id, 'worker'), false);
  const refused = (await services.jobs.getJob('tenant-a', job.id))!;
  assert.equal(refused.status, 'failed');
  assert.match(refused.lastError!, /^DENIED: AuthBoundry denied jobs\.execute \(no_grant\)$/, 'the authorizer reason is carried into lastError');
  assert.equal(refused.refusal?.code, 'DENIED');
  assert.equal(refused.refusal?.capability, 'jobs.execute');
  assert.equal(refused.refusal?.reason, 'no_grant');
  assert.equal(refused.refusal?.principalId, 'host-1');
  assert.ok(refused.refusal?.decisionId);
});

test('S1: enqueuing a service-run job needs jobs.create.service; jobs.create alone is refused, and nothing is stored', async () => {
  const authority = new TestAuthority();
  const { services, host } = open(authority);
  await grantHost(authority, 'jobs.create');
  services.jobs.register('meeting.summary', async () => undefined);
  await assert.rejects(services.jobs.enqueue({ type: 'meeting.summary', payload: {}, runAs: 'service' }, host), (error: unknown) =>
    isServiceAuthorityError(error) && error.code === 'DENIED' && error.details.capability === 'jobs.create.service' && error.details.principalId === 'host-1' && error.details.reason === 'no_grant');
  assert.equal((await services.jobs.listJobs('tenant-a')).length, 0);
});

test('S1: without a configured service principal, service-run work is refused; a host cannot assert the service principal', async () => {
  const authority = new TestAuthority({ allowAll: true });
  const { services, host } = open(authority, { servicePrincipal: false });
  services.jobs.register('meeting.summary', async () => undefined);
  await assert.rejects(services.jobs.enqueue({ type: 'meeting.summary', payload: {}, runAs: 'service' }, host), /No service principal is configured/);
  await assert.rejects(services.jobs.enqueue({ type: 'meeting.summary', payload: {}, runAs: 'service', delegationId: 'd1' }, host), /No service principal|delegationId/);
  const configured = open(new TestAuthority({ allowAll: true }));
  assert.throws(() => configured.services.identify({ principalId: SERVICE, principalType: 'service', tenantId: 'tenant-a' }), /cannot be asserted by a host/);
});

test('S1: a creator-scoped job record changed to runAs "service" does not attest and is refused', async () => {
  const authority = new TestAuthority({ allowAll: true });
  const { services, host } = open(authority);
  let ran = false;
  services.jobs.register('meeting.summary', async () => { ran = true; });
  const job = await services.jobs.enqueue({ type: 'meeting.summary', payload: {} }, host);
  const stored = await services.db.collection<Record<string, unknown>>('jobs').get(job.id);
  await services.db.collection('jobs').update(job.id, { ...stored, runAs: 'service' });
  assert.equal(await services.jobs.executeJob('tenant-a', job.id, 'worker'), false);
  assert.equal(ran, false);
  const refused = (await services.jobs.getJob('tenant-a', job.id))!;
  assert.equal(refused.refusal?.reason, 'unattested_principal');
});

test('S12: a handler FORBIDDEN (or JobTerminalError) is terminal: failed at once, not retried', async () => {
  const authority = new TestAuthority({ allowAll: true });
  const { services, host } = open(authority);
  let calls = 0;
  services.jobs.register('meeting.forbidden', async () => { calls += 1; throw Object.assign(new Error('not a participant'), { code: 'FORBIDDEN' }); });
  services.jobs.register('meeting.terminal', async () => { calls += 1; throw new JobTerminalError('meeting was deleted', 'GONE'); });
  const forbidden = await services.jobs.enqueue({ type: 'meeting.forbidden', payload: {}, maxAttempts: 5 }, host);
  const terminal = await services.jobs.enqueue({ type: 'meeting.terminal', payload: {}, maxAttempts: 5 }, host);
  await services.jobs.executeJob('tenant-a', forbidden.id, 'worker');
  await services.jobs.executeJob('tenant-a', terminal.id, 'worker');
  const a = (await services.jobs.getJob('tenant-a', forbidden.id))!;
  const b = (await services.jobs.getJob('tenant-a', terminal.id))!;
  assert.equal(calls, 2);
  assert.deepEqual([a.status, a.lastError, a.refusal?.code], ['failed', 'FORBIDDEN: not a participant', 'FORBIDDEN']);
  assert.deepEqual([b.status, b.lastError, b.refusal?.code], ['failed', 'GONE: meeting was deleted', 'GONE']);
  assert.deepEqual(await services.jobs.listDueJobs('tenant-a'), []);
  // An ordinary error is still retried.
  services.jobs.register('meeting.flaky', async () => { throw new Error('transient'); });
  const flaky = await services.jobs.enqueue({ type: 'meeting.flaky', payload: {}, maxAttempts: 5 }, host);
  await services.jobs.executeJob('tenant-a', flaky.id, 'worker');
  assert.equal((await services.jobs.getJob('tenant-a', flaky.id))?.status, 'retrying');
});

test('J1: a refused enqueue is a typed error with capability, reason and principal, through invoke and in a transaction', async () => {
  const authority = new TestAuthority();
  const { services, host } = open(authority);
  services.jobs.register('handoff.sync', async () => undefined);
  await assert.rejects(services.invoke('jobs.create', { type: 'handoff.sync', payload: {} }, { principal: host }), (error: unknown) =>
    isServiceAuthorityError(error) && error.code === 'DENIED' && error.status === 403 && error.details.capability === 'jobs.create' && error.details.principalId === 'host-1' && error.details.reason === 'no_grant');
  // A transaction cannot queue a job without a jobs.create context: authorize() refuses, and a context for
  // another capability makes the transaction fail; nothing commits.
  await assert.rejects(services.authorize('jobs.create', host, { type: 'job', attributes: { jobType: 'handoff.sync' } }), /AuthBoundry denied jobs\.create/);
  await authority.grant({ subject: 'host-1', capability: 'files.read' });
  const wrong = await services.authorize('files.read', host, { type: 'file', attributes: { owner: '*' } });
  await assert.rejects(services.transaction(async (tx) => {
    await tx.collection('handoffs').insert({ id: 'h1' }, 'h1');
    tx.queueJob({ tenantId: 'tenant-a', type: 'handoff.sync', payload: {} }, wrong);
  }), (error: unknown) => isServiceAuthorityError(error) && error.code === 'DENIED');
  assert.equal(await services.db.collection('handoffs').get('h1'), null, 'the application write rolled back with the refused enqueue');
  assert.equal((await services.jobs.listJobs('tenant-a')).length, 0);
});

test('J2: idempotent enqueue returns the original job, refuses a different input, and is safe under concurrency', async () => {
  const authority = new TestAuthority({ allowAll: true });
  const { services, host } = open(authority);
  services.jobs.register('handoff.sync', async () => undefined);
  services.jobs.register('handoff.other', async () => undefined);
  const first = await services.jobs.enqueue({ type: 'handoff.sync', payload: { a: 1, b: 2 }, idempotencyKey: 'op-1' }, host);
  // A retry after an ambiguous response (the caller never saw `first`): same key, same input (keys reordered).
  const retry = await services.jobs.enqueue({ type: 'handoff.sync', payload: { b: 2, a: 1 }, idempotencyKey: 'op-1' }, host);
  assert.equal(retry.id, first.id);
  await assert.rejects(services.jobs.enqueue({ type: 'handoff.sync', payload: { a: 9 }, idempotencyKey: 'op-1' }, host), (error: unknown) =>
    isServiceAuthorityError(error) && error.code === 'CONFLICT' && error.status === 409 && error.details.reason === 'idempotency_conflict');
  // The key is scoped by job type: another type with the same key is a different job.
  const other = await services.jobs.enqueue({ type: 'handoff.other', payload: {}, idempotencyKey: 'op-1' }, host);
  assert.notEqual(other.id, first.id);
  // Concurrent enqueues with one key create one job.
  const racing = await Promise.all(Array.from({ length: 8 }, () => services.jobs.enqueue({ type: 'handoff.sync', payload: { n: 1 }, idempotencyKey: 'op-2' }, host)));
  assert.equal(new Set(racing.map((job) => job.id)).size, 1);
  assert.equal((await services.jobs.listJobs('tenant-a')).filter((job) => job.idempotencyKey === 'op-2').length, 1);
  // Through invoke, and scoped by tenant.
  const otherTenant = services.identify({ principalId: 'host-2', principalType: 'user', tenantId: 'tenant-b' })!;
  const b = await services.invoke('jobs.create', { type: 'handoff.sync', payload: { a: 1, b: 2 }, idempotencyKey: 'op-1' }, { principal: otherTenant }) as { id: string; tenantId: string };
  assert.notEqual(b.id, first.id);
  assert.equal(b.tenantId, 'tenant-b');
  await assert.rejects(services.jobs.enqueue({ type: 'handoff.sync', payload: {}, idempotencyKey: '' }, host), /idempotencyKey/);
  // In a transaction a repeated key fails the transaction (conditional write): nothing commits twice.
  const enqueue = await services.authorize('jobs.create', host, { type: 'job', attributes: { jobType: 'handoff.sync' } });
  await assert.rejects(services.transaction(async (tx) => {
    tx.queueJob({ tenantId: 'tenant-a', type: 'handoff.sync', payload: {}, idempotencyKey: 'op-1' }, enqueue);
  }));
});

test('J3: a schedule runs in its own tenant, with its principal and runAs, and config import keeps runAs (S6)', async () => {
  const authority = new TestAuthority({ allowAll: true });
  const { services, host } = open(authority);
  const hostB = services.identify({ principalId: 'host-b', principalType: 'user', tenantId: 'tenant-b' })!;
  const runs: { tenantId: string; principal: string; enqueuedBy?: string }[] = [];
  services.jobs.register('meeting.reminders', async (job, execution) => {
    runs.push({ tenantId: job.tenantId, principal: `${execution.principal.principalId}@${execution.principal.tenantId}`, ...(execution.enqueuedBy ? { enqueuedBy: execution.enqueuedBy } : {}) });
    await services.files.create({ name: 'swept.txt', size: 1, storageKey: `k/${job.id}` }, execution.principal);
  });
  const scheduleA = await services.schedules.create({ type: 'meeting.reminders', payload: {}, interval: '1s', runAs: 'service' }, host);
  assert.equal(scheduleA.runAs, 'service');
  await assert.rejects(services.schedules.create({ type: 'meeting.reminders', payload: {}, interval: '1s', tenantId: 'tenant-a' }, hostB), /Cross-tenant/);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.equal(await services.jobs.processRecurringSchedules('tenant-b'), 0, 'tenant B has no schedule to fire');
  assert.equal(await services.jobs.processRecurringSchedules('tenant-a'), 1);
  const [fired] = await services.jobs.listDueJobs('tenant-a');
  assert.equal(fired?.runAs, 'service');
  assert.equal(fired?.principal?.principalId, 'host-1');
  assert.equal(await services.jobs.executeJob('tenant-b', fired!.id, 'worker'), false, 'a tenant-A job is not found from tenant B');
  assert.equal(await services.jobs.executeJob('tenant-a', fired!.id, 'worker'), true);
  assert.deepEqual(runs, [{ tenantId: 'tenant-a', principal: `${SERVICE}@tenant-a`, enqueuedBy: 'host-1' }]);
  assert.equal((await services.files.list('tenant-b', hostB)).length, 0, 'nothing written to tenant B');
  assert.equal((await services.files.list('tenant-a', host)).length, 1);

  // Promotion: export from this tenant, import into another services instance (production).
  const document = await services.configuration.export({ principal: host });
  assert.deepEqual(document.schedules.map((schedule) => [schedule.type, schedule.runAs]), [['meeting.reminders', 'service']]);
  const production = open(new TestAuthority({ allowAll: true }));
  production.services.jobs.register('meeting.reminders', async () => undefined);
  const report = await production.services.configuration.import(document, { principal: production.host });
  assert.equal(report.items.find((item) => item.kind === 'schedule')?.action, 'create');
  const imported = await production.services.schedules.list('tenant-a', production.host);
  assert.deepEqual(imported.map((schedule) => [schedule.type, schedule.runAs, schedule.tenantId]), [['meeting.reminders', 'service', 'tenant-a']]);
  const again = await production.services.configuration.import(document, { principal: production.host });
  assert.equal(again.items.find((item) => item.kind === 'schedule')?.action, 'unchanged');
});

test('S1: a service-run job can be queued atomically in a transaction with a jobs.create.service context', async () => {
  const authority = new TestAuthority({ allowAll: true });
  const { services, host } = open(authority);
  services.jobs.register('meeting.summary', async () => undefined);
  const context = await services.authorize('jobs.create.service', host, { type: 'job', attributes: { jobType: 'meeting.summary', runAs: 'service' } });
  let id = '';
  await services.transaction(async (tx) => {
    id = tx.queueJob({ tenantId: 'tenant-a', type: 'meeting.summary', payload: {} }, context);
  });
  const job = (await services.jobs.getJob('tenant-a', id))!;
  assert.equal(job.runAs, 'service');
  assert.equal(await services.jobs.executeJob('tenant-a', id, 'worker'), true);
});
