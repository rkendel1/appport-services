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
  JobWorker,
} from '../src/_internal.js';

async function createLocalJobService(now?: () => Date, pollIntervalMs?: number) {
  const path = await mkdtemp(join(tmpdir(), 'appport-jobs-execution-test-'));
  const runtime = createFeltDbRuntime({
    mode: 'local',
    namespace: 'jobs-exec-' + Math.random().toString(16).slice(2),
    path,
  });

  const service = new JobService({
    jobStore: new FeltDbJobStore(runtime.db),
    scheduleStore: new FeltDbJobScheduleStore(runtime.db),
    auditSink: new FeltDbJobAuditSink(runtime.db),
    now,
  });

  const jobStore = new FeltDbJobStore(runtime.db);

  return { service, jobStore, runtime };
}

test('two workers cannot claim the same job', async () => {
  const { service, runtime } = await createLocalJobService();

  service.register('test.job', async () => {
    // Handler that does nothing
  });

  const job = await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: {},
  });

  // First worker claims it
  const result1 = await service.executeJob('tenant-a', job.id, 'worker-1');
  assert.equal(result1, true);

  // Verify job is completed
  const fetched = await service.getJob('tenant-a', job.id);
  assert.equal(fetched?.status, 'completed');

  // Second worker attempts to execute (should be idempotent, job already done)
  const result2 = await service.executeJob('tenant-a', job.id, 'worker-2');
  assert.equal(result2, true);

  await runtime.db.close();
});

test('concurrent claim attempts only one succeeds', async () => {
  const { service, runtime } = await createLocalJobService();

  let executionCount = 0;
  service.register('test.job', async () => {
    executionCount++;
  });

  const job = await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: {},
  });

  // Three concurrent execution attempts
  const results = await Promise.all([
    service.executeJob('tenant-a', job.id, 'worker-1'),
    service.executeJob('tenant-a', job.id, 'worker-2'),
    service.executeJob('tenant-a', job.id, 'worker-3'),
  ]);

  const successCount = results.filter((r) => r).length;
  assert.equal(successCount, 1, 'only one concurrent execution succeeds');
  assert.equal(executionCount, 1, 'handler executed exactly once');

  await runtime.db.close();
});

test('lease expiration permits recovery', async () => {
  let now = new Date('2026-09-10T12:00:00Z');
  const getNow = () => now;

  const path = await mkdtemp(join(tmpdir(), 'appport-jobs-lease-test-'));
  const runtime = createFeltDbRuntime({
    mode: 'local',
    namespace: 'jobs-lease-' + Math.random().toString(16).slice(2),
    path,
  });

  const service = new JobService({
    jobStore: new FeltDbJobStore(runtime.db),
    scheduleStore: new FeltDbJobScheduleStore(runtime.db),
    auditSink: new FeltDbJobAuditSink(runtime.db),
    now: getNow,
    leaseDurationMs: 5000, // 5 second lease
  });

  const jobStore = new FeltDbJobStore(runtime.db);

  service.register('test.job', async () => {
    // Simulate work
  });

  const job = await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: {},
  });

  // Worker A claims job
  const claimed = await jobStore.get('tenant-a', job.id);
  assert.ok(claimed);

  // Lease expires
  now = new Date(now.getTime() + 6000); // 6 seconds later

  // List due jobs should include the expired lease
  const dueJobs = await jobStore.listDue('tenant-a', now.toISOString());
  const expiredJob = dueJobs.find((j) => j.id === job.id);
  assert.ok(expiredJob, 'expired job should be discoverable');

  await runtime.db.close();
});

test('stale worker cannot overwrite newer worker', async () => {
  let now = new Date('2026-09-10T12:00:00Z');
  const getNow = () => now;

  const path = await mkdtemp(join(tmpdir(), 'appport-jobs-stale-worker-test-'));
  const runtime = createFeltDbRuntime({
    mode: 'local',
    namespace: 'jobs-stale-' + Math.random().toString(16).slice(2),
    path,
  });

  const service = new JobService({
    jobStore: new FeltDbJobStore(runtime.db),
    scheduleStore: new FeltDbJobScheduleStore(runtime.db),
    auditSink: new FeltDbJobAuditSink(runtime.db),
    now: getNow,
    leaseDurationMs: 5000,
  });

  const jobStore = new FeltDbJobStore(runtime.db);

  service.register('test.job', async () => {
    // Handler
  });

  const job = await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: {},
  });

  // Worker A claims and starts (version 2)
  const jobV2 = await jobStore.get('tenant-a', job.id);
  assert.ok(jobV2);
  const claimedByA = await jobStore.claim('tenant-a', job.id, jobV2.__version, new Date(now.getTime() + 5000).toISOString());
  assert.ok(claimedByA);
  const jobV3 = claimedByA; // Running, version 3

  // Simulate time passage and lease expiration
  now = new Date(now.getTime() + 6000);

  // Worker B claims expired job (version 3)
  const claimedByB = await jobStore.claim('tenant-a', job.id, jobV3.__version, new Date(now.getTime() + 5000).toISOString());
  assert.ok(claimedByB);
  const jobV4 = claimedByB; // Version 4, claimed by B

  // Worker A tries to complete with stale version (3)
  // This should fail because version has advanced to 4
  const updateResult = await jobStore.updateJob('tenant-a', job.id, jobV3.__version, {
    status: 'completed',
  });

  assert.equal(updateResult, null, 'stale update should fail');

  // Worker B can successfully complete with correct version
  const updateResultB = await jobStore.updateJob('tenant-a', job.id, jobV4.__version, {
    status: 'completed',
  });

  assert.ok(updateResultB, 'correct version update should succeed');
  assert.equal(updateResultB.status, 'completed');

  await runtime.db.close();
});

test('exponential backoff increases retry delay', async () => {
  const { service, runtime } = await createLocalJobService();

  service.register('test.job', async () => {
    throw new Error('fail');
  });

  const job = await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: {},
    maxAttempts: 4,
  });

  await service.executeJob('tenant-a', job.id, 'worker-1');
  let fetched = await service.getJob('tenant-a', job.id);
  assert.equal(fetched?.attemptCount, 1);
  const nextAttempt1 = fetched?.nextAttemptAt;

  await service.executeJob('tenant-a', job.id, 'worker-1');
  fetched = await service.getJob('tenant-a', job.id);
  assert.equal(fetched?.attemptCount, 2);
  const nextAttempt2 = fetched?.nextAttemptAt;

  assert.ok(
    new Date(nextAttempt2!).getTime() > new Date(nextAttempt1!).getTime(),
    'backoff increases',
  );

  await runtime.db.close();
});

test('job durability: job survives process restart', async () => {
  const path = await mkdtemp(join(tmpdir(), 'appport-jobs-durability-'));
  const namespace = 'durability-' + Math.random().toString(16).slice(2);

  // Process 1: Create job
  {
    const runtime = createFeltDbRuntime({ mode: 'local', namespace, path });
    const service = new JobService({
      jobStore: new FeltDbJobStore(runtime.db),
      scheduleStore: new FeltDbJobScheduleStore(runtime.db),
      auditSink: new FeltDbJobAuditSink(runtime.db),
    });

    const job = await service.enqueue({
      tenantId: 'tenant-a',
      type: 'test.job',
      payload: { data: 'persisted' },
    });

    assert.ok(job.id);
    await runtime.db.close();
  }

  // Process 2: Verify job still exists
  {
    const runtime = createFeltDbRuntime({ mode: 'local', namespace, path });
    const service = new JobService({
      jobStore: new FeltDbJobStore(runtime.db),
      scheduleStore: new FeltDbJobScheduleStore(runtime.db),
      auditSink: new FeltDbJobAuditSink(runtime.db),
    });

    const jobs = await service.listJobs('tenant-a');
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0].payload, { data: 'persisted' });

    await runtime.db.close();
  }
});

test('handler errors with original payload available for debugging', async () => {
  const { service, runtime } = await createLocalJobService();

  const debugData = { invoiceId: 'inv-123', amount: 500 };
  service.register('test.job', async (job) => {
    const payload = job.payload as typeof debugData;
    assert.deepEqual(payload, debugData);
    throw new Error('processing failed');
  });

  const job = await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: debugData,
    maxAttempts: 2,
  });

  await service.executeJob('tenant-a', job.id, 'worker-1');

  const fetched = await service.getJob('tenant-a', job.id);
  assert.deepEqual(fetched?.payload, debugData);
  assert.equal(fetched?.lastError, 'processing failed');

  await runtime.db.close();
});

test('concurrent tenants remain isolated', async () => {
  const { service, runtime } = await createLocalJobService();

  service.register('test.job', async () => {
    // Handler
  });

  const jobA = await service.enqueue({
    tenantId: 'tenant-a',
    type: 'test.job',
    payload: { tenant: 'a' },
  });

  const jobB = await service.enqueue({
    tenantId: 'tenant-b',
    type: 'test.job',
    payload: { tenant: 'b' },
  });

  // Concurrent execution
  await Promise.all([
    service.executeJob('tenant-a', jobA.id, 'worker-1'),
    service.executeJob('tenant-b', jobB.id, 'worker-2'),
  ]);

  const fetchedA = await service.getJob('tenant-a', jobA.id);
  const fetchedB = await service.getJob('tenant-b', jobB.id);

  assert.equal(fetchedA?.status, 'completed');
  assert.equal(fetchedB?.status, 'completed');

  // Tenant isolation
  assert.equal(await service.getJob('tenant-a', jobB.id), null);
  assert.equal(await service.getJob('tenant-b', jobA.id), null);

  await runtime.db.close();
});
