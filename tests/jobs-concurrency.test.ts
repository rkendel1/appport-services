/**
 * Job concurrency (FeltKit M2.1 gap G14), reproduced against the real FeltDB-backed stores:
 *
 *   1. Two processors handling the same due schedule at once must create ONE job for that tick
 *      (the job used to be created before the schedule's compare-and-swap, so both created one).
 *   2. A worker whose claim was lost (the job changed under it) must not record success
 *      (completeJob used to ignore its version-checked update and always audit success).
 *   3. An update naming another tenant's job must not change it
 *      (updateJob used to check the tenant after applying the update).
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFeltDbRuntime, FeltDbJobAuditSink, FeltDbJobScheduleStore, FeltDbJobStore, JobService } from '../src/_internal.js';
import { principal as verified, testGateway } from './support/authority.js';

const caller = (tenantId: string) => verified({ principalId: 'user-1', principalType: 'api_key', tenantId, credentialId: 'key' });

async function shared(now: () => Date) {
  const path = await mkdtemp(join(tmpdir(), 'appport-jobs-concurrency-'));
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: 'jobs-conc-' + Math.random().toString(16).slice(2), path });
  const audit = new FeltDbJobAuditSink(runtime.db);
  const service = () => new JobService({ jobStore: new FeltDbJobStore(runtime.db), scheduleStore: new FeltDbJobScheduleStore(runtime.db), auditSink: audit, authority: testGateway(runtime.db), now });
  return { runtime, service, jobStore: new FeltDbJobStore(runtime.db), audit };
}

test('two processors handling the same due schedule create one job for the tick', async () => {
  let clock = new Date('2026-11-11T12:00:00.000Z');
  const { runtime, service } = await shared(() => clock);
  try {
    const first = service();
    const second = service();
    await first.scheduleRecurring({ tenantId: 'tenant-a', type: 'test.recurring', payload: {}, interval: '1h' }, caller('tenant-a'));
    clock = new Date('2026-11-11T13:00:01.000Z');
    const created = await Promise.all([first.processRecurringSchedules('tenant-a'), second.processRecurringSchedules('tenant-a'), first.processRecurringSchedules('tenant-a')]);
    const jobs = (await first.listJobs('tenant-a')).filter((j) => j.type === 'test.recurring');
    assert.equal(jobs.length, 1, `one job for one tick (processors reported ${created.join(', ')})`);
    assert.equal(created.reduce((a, b) => a + b, 0), 1, 'exactly one processor reports creating it');
    // The next tick is the next job; running again within the same tick creates nothing.
    assert.equal(await second.processRecurringSchedules('tenant-a'), 0);
    clock = new Date('2026-11-11T14:00:02.000Z');
    assert.equal(await second.processRecurringSchedules('tenant-a'), 1);
    assert.equal((await first.listJobs('tenant-a')).filter((j) => j.type === 'test.recurring').length, 2);
  } finally {
    await runtime.db.close();
  }
});

test('a worker whose claim was lost does not record success', async () => {
  const { runtime, service, jobStore } = await shared(() => new Date());
  try {
    const svc = service();
    // While the handler runs, the job changes under the worker (its claim expired and it was handed out again).
    svc.register('test.job', async (job) => {
      const current = await jobStore.get('tenant-a', job.id);
      await jobStore.updateJob('tenant-a', job.id, current!.__version, { status: 'pending' });
    });
    const job = await svc.enqueue({ tenantId: 'tenant-a', type: 'test.job', payload: {} }, caller('tenant-a'));
    const ran = await svc.executeJob('tenant-a', job.id, 'worker-1');
    assert.equal(ran, false, 'the stale worker reports that it did not complete the job');
    assert.notEqual((await svc.getJob('tenant-a', job.id))?.status, 'completed', 'the job is not marked completed by a stale worker');
    const events = (await (svc as any).auditSink.list?.('tenant-a')) ?? null;
    if (events) assert.ok(!events.some((e: { type: string; jobId: string; result: string }) => e.type === 'job.completed' && e.jobId === job.id && e.result === 'success'), 'no success is recorded');
  } finally {
    await runtime.db.close();
  }
});

test("an update naming another tenant's job does not change it", async () => {
  const { runtime, service, jobStore } = await shared(() => new Date());
  try {
    const svc = service();
    const job = await svc.enqueue({ tenantId: 'tenant-a', type: 'test.job', payload: {} }, caller('tenant-a'));
    const result = await jobStore.updateJob('tenant-b', job.id, job.__version, { status: 'completed' });
    assert.equal(result, null);
    const after = await jobStore.get('tenant-a', job.id);
    assert.equal(after?.status, job.status, 'unchanged');
    assert.equal(after?.__version, job.__version, 'not even its version moved');
  } finally {
    await runtime.db.close();
  }
});
