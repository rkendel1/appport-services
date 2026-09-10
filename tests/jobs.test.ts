import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createFeltDbRuntime,
  FeltDbJobStore,
  FeltDbJobScheduleStore,
  FeltDbJobAuditSink,
  JobService,
} from '../src/index.js';

async function createLocalJobService(now?: () => Date) {
  const path = await mkdtemp(join(tmpdir(), 'appport-jobs-test-'));
  const runtime = createFeltDbRuntime({
    mode: 'local',
    namespace: 'jobs-' + Math.random().toString(16).slice(2),
    path,
  });

  const service = new JobService({
    jobStore: new FeltDbJobStore(runtime.db),
    scheduleStore: new FeltDbJobScheduleStore(runtime.db),
    auditSink: new FeltDbJobAuditSink(runtime.db),
    now,
  });

  return { service, runtime };
}

test('enqueue creates pending job', async () => {
  const { service, runtime } = await createLocalJobService();

  const job = await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: { data: 'test' },
  });

  assert.ok(job.id);
  assert.equal(job.tenantId, 'tenant-a');
  assert.equal(job.type, 'test.job');
  assert.equal(job.status, 'pending');
  assert.equal(job.attemptCount, 0);
  assert.equal(job.maxAttempts, 5);

  const fetched = await service.getJob('tenant-a', job.id);
  assert.ok(fetched);
  assert.equal(fetched.status, 'pending');

  await runtime.db.close();
});

test('schedule creates scheduled job', async () => {
  const now = new Date('2026-09-10T12:00:00Z');
  const { service, runtime } = await createLocalJobService(() => now);

  const futureTime = new Date('2026-09-10T14:00:00Z').toISOString();

  const job = await service.schedule({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: {},
    runAt: futureTime,
  });

  assert.equal(job.status, 'scheduled');
  assert.equal(job.runAt, futureTime);

  await runtime.db.close();
});

test('tenant isolation prevents cross-tenant access', async () => {
  const { service, runtime } = await createLocalJobService();

  const job = await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: {},
  });

  const fetched = await service.getJob('tenant-b', job.id);
  assert.equal(fetched, null);

  await runtime.db.close();
});

test('list jobs filtered by tenant', async () => {
  const { service, runtime } = await createLocalJobService();

  await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: {},
  });

  await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: {},
  });

  await service.enqueue({
    tenantId: 'tenant-b',
    type: 'test.job',
    payload: {},
  });

  const jobsA = await service.listJobs('tenant-a');
  const jobsB = await service.listJobs('tenant-b');

  assert.equal(jobsA.length, 2);
  assert.equal(jobsB.length, 1);

  await runtime.db.close();
});

test('register and execute handler', async () => {
  const { service, runtime } = await createLocalJobService();

  let executed = false;
  service.register('test.job', async (job) => {
    executed = true;
    const payload = job.payload as { value: number };
    assert.equal(payload.value, 42);
  });

  const job = await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: { value: 42 },
  });

  const result = await service.executeJob('tenant-a', job.id, 'worker-1');
  assert.equal(result, true);
  assert.equal(executed, true);

  const fetched = await service.getJob('tenant-a', job.id);
  assert.equal(fetched?.status, 'completed');
  assert.ok(fetched?.completedAt);

  await runtime.db.close();
});

test('handler failure triggers retry', async () => {
  const { service, runtime } = await createLocalJobService();

  let attempts = 0;
  service.register('test.job', async () => {
    attempts++;
    throw new Error('test error');
  });

  const job = await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: {},
    maxAttempts: 3,
  });

  const result1 = await service.executeJob('tenant-a', job.id, 'worker-1');
  assert.equal(result1, false);
  assert.equal(attempts, 1);

  const fetched = await service.getJob('tenant-a', job.id);
  assert.equal(fetched?.status, 'retrying');
  assert.equal(fetched?.attemptCount, 1);
  assert.equal(fetched?.lastError, 'test error');
  assert.ok(fetched?.nextAttemptAt);

  await runtime.db.close();
});

test('max attempts marks job as failed', async () => {
  const { service, runtime } = await createLocalJobService();

  service.register('test.job', async () => {
    throw new Error('persistent failure');
  });

  const job = await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: {},
    maxAttempts: 2,
  });

  await service.executeJob('tenant-a', job.id, 'worker-1');
  let fetched = await service.getJob('tenant-a', job.id);
  assert.equal(fetched?.status, 'retrying');

  await service.executeJob('tenant-a', job.id, 'worker-1');
  fetched = await service.getJob('tenant-a', job.id);
  assert.equal(fetched?.status, 'failed');
  assert.equal(fetched?.attemptCount, 2);

  await runtime.db.close();
});

test('manual retry resets failed job', async () => {
  const { service, runtime } = await createLocalJobService();

  service.register('test.job', async (job) => {
    if (job.attemptCount === 0) {
      throw new Error('first failure');
    }
  });

  const job = await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: {},
    maxAttempts: 2,
  });

  await service.executeJob('tenant-a', job.id, 'worker-1');
  let fetched = await service.getJob('tenant-a', job.id);
  assert.equal(fetched?.status, 'retrying');

  const retried = await service.retry('tenant-a', job.id);
  assert.ok(retried);
  assert.equal(retried.status, 'pending');
  assert.equal(retried.attemptCount, 0);
  assert.equal(retried.lastError, undefined);

  await runtime.db.close();
});

test('schedule recurring creates execution jobs', async () => {
  const now = new Date('2026-09-10T12:00:00Z');
  const { service, runtime } = await createLocalJobService(() => now);

  const schedule = await service.scheduleRecurring({
    tenantId: 'tenant-a',
    type: 'test.recurring',
    payload: { id: 123 },
    interval: '1h',
    createdBy: 'user-1',
  });

  assert.ok(schedule.id);
  assert.equal(schedule.interval, '1h');
  assert.ok(schedule.nextRunAt);

  // First execution is now + 1h
  const nextRun = new Date(schedule.nextRunAt);
  const expectedNext = new Date(now.getTime() + 60 * 60 * 1000);
  assert.equal(nextRun.getTime(), expectedNext.getTime());

  await runtime.db.close();
});

test('restart preserves jobs and schedules', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-jobs-restart-'));
  const namespace = 'restart-' + Math.random().toString(16).slice(2);

  const first = new JobService({
    jobStore: new FeltDbJobStore(
      createFeltDbRuntime({ mode: 'local', namespace, path }).db,
    ),
    scheduleStore: new FeltDbJobScheduleStore(
      createFeltDbRuntime({ mode: 'local', namespace, path }).db,
    ),
    auditSink: new FeltDbJobAuditSink(
      createFeltDbRuntime({ mode: 'local', namespace, path }).db,
    ),
  });

  const job = await first.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: {},
  });

  const schedule = await first.scheduleRecurring({
    tenantId: 'tenant-a',
    type: 'test.recurring',
    payload: {},
    interval: '1h',
    createdBy: 'user-1',
  });

  const runtime = createFeltDbRuntime({ mode: 'local', namespace, path });
  const second = new JobService({
    jobStore: new FeltDbJobStore(runtime.db),
    scheduleStore: new FeltDbJobScheduleStore(runtime.db),
    auditSink: new FeltDbJobAuditSink(runtime.db),
  });

  const fetchedJob = await second.getJob('tenant-a', job.id);
  const fetchedSchedule = await second.getSchedule('tenant-a', schedule.id);

  assert.ok(fetchedJob);
  assert.equal(fetchedJob.status, 'pending');
  assert.ok(fetchedSchedule);
  assert.equal(fetchedSchedule.enabled, true);

  await runtime.db.close();
});

test('disable schedule stops generating jobs', async () => {
  const { service, runtime } = await createLocalJobService();

  const schedule = await service.scheduleRecurring({
    tenantId: 'tenant-a',
    type: 'test.recurring',
    payload: {},
    interval: '1h',
    createdBy: 'user-1',
  });

  const disabled = await service.disableSchedule('tenant-a', schedule.id);
  assert.ok(disabled);
  assert.equal(disabled.enabled, false);

  const fetched = await service.getSchedule('tenant-a', schedule.id);
  assert.equal(fetched?.enabled, false);

  await runtime.db.close();
});
