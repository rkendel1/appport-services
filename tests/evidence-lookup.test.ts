import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFeltDB } from '@feltdb/core';

import { createServices } from '../src/index.js';
import { TestAuthority } from './support/authority.js';

const EVIDENCE = 'service_effect_evidence';

function open(path: string, authorizer = new TestAuthority({ allowAll: true }), application = 'evidence-app') {
  return createServices({ mode: 'local', namespace: 'evidence', path, application, authorizer });
}

test('findByRunId returns every effect caused under the caller-supplied runId, typed and completed', async () => {
  const path = await mkdtemp(join(tmpdir(), 'evidence-run-'));
  const services = open(path);
  try {
    // The host sets runId to its own request/correlation id when it identifies the caller.
    const caller = services.identify({ principalId: 'ada', principalType: 'user', tenantId: 'acme', runId: 'req-123' })!;
    await services.apiKeys.createApiKey({ name: 'ci' }, caller);
    await services.files.create({ name: 'a.txt', size: 1, storageKey: 'k' }, caller);
    const other = services.identify({ principalId: 'ada', principalType: 'user', tenantId: 'acme', runId: 'req-other' })!;
    await services.files.create({ name: 'b.txt', size: 1, storageKey: 'k2' }, other);

    const lookup = await services.evidence.findByRunId('req-123');
    assert.equal(lookup.runId, 'req-123');
    assert.equal(lookup.state, 'completed');
    assert.equal(lookup.truncated, false);
    assert.deepEqual(lookup.records.map((record) => record.capability).sort(), ['apikeys.create', 'files.write']);
    for (const record of lookup.records) {
      assert.equal(record.runId, 'req-123');
      assert.equal(record.state, 'completed');
      assert.equal(record.outcome, 'succeeded');
      assert.equal(record.application, 'evidence-app');
      assert.equal(record.tenantId, 'acme');
      assert.ok(record.completedAt);
      assert.ok(!('__version' in record));
    }
    // Oldest first.
    assert.ok(lookup.records[0]!.startedAt <= lookup.records[1]!.startedAt);
    // A bounded query served by the runId hash index.
    const plan = await services.db.explain({ collection: EVIDENCE, where: [{ field: 'runId', eq: 'req-123' }], limit: 101 });
    assert.equal(plan.index, 'run_idx');

    assert.deepEqual(await services.evidence.findByRunId('never-used'), { runId: 'never-used', state: 'none', records: [], truncated: false });
  } finally {
    await services.apiKeys.close();
  }
});

test('findByRunId reports denials as failed, bounds the result, and filters by tenant and application', async () => {
  const path = await mkdtemp(join(tmpdir(), 'evidence-bounds-'));
  const authorizer = new TestAuthority();
  await authorizer.grant({ subject: 'ada', capability: 'files.write' });
  const services = open(path, authorizer);
  try {
    const caller = services.identify({ principalId: 'ada', principalType: 'user', tenantId: 'acme', runId: 'req-9' })!;
    for (const name of ['a', 'b', 'c']) await services.files.create({ name, size: 1, storageKey: name }, caller);
    await assert.rejects(services.apiKeys.createApiKey({ name: 'denied' }, caller), (error: { code?: string }) => error.code === 'DENIED');

    const all = await services.evidence.findByRunId('req-9');
    assert.equal(all.records.length, 4);
    assert.equal(all.state, 'failed', 'any failed or denied effect makes the run failed');
    const denied = all.records.find((record) => record.capability === 'apikeys.create')!;
    assert.equal(denied.state, 'failed');
    assert.equal(denied.outcome, 'denied');

    const page = await services.evidence.findByRunId('req-9', { limit: 2 });
    assert.equal(page.records.length, 2);
    assert.equal(page.truncated, true);

    assert.equal((await services.evidence.findByRunId('req-9', { limit: 1000 })).records.length, 4, 'the maximum limit is accepted');
    assert.equal((await services.evidence.findByRunId('req-9', { tenantId: 'other' })).records.length, 0);
    await assert.rejects(services.evidence.findByRunId('req-9', { limit: 0 }), RangeError);
    await assert.rejects(services.evidence.findByRunId('req-9', { limit: 1001 }), RangeError);
    await assert.rejects(services.evidence.findByRunId(''), TypeError);
  } finally {
    await services.apiKeys.close();
  }

  // Another application sharing the namespace does not see these rows.
  const neighbour = open(path, new TestAuthority({ allowAll: true }), 'neighbour-app');
  try {
    assert.equal((await neighbour.evidence.findByRunId('req-9')).state, 'none');
  } finally {
    await neighbour.apiKeys.close();
  }
});

test('a crash between the started and completion writes leaves state "started" (outcome unknown) across restart', async () => {
  const path = await mkdtemp(join(tmpdir(), 'evidence-crash-'));
  const first = open(path);
  const caller = first.identify({ principalId: 'ada', principalType: 'user', tenantId: 'acme', runId: 'req-crash' })!;
  // An effect that never returns stands in for a process that dies mid-effect.
  void first.gateway.execute('files.write', caller, { type: 'file', tenantId: 'acme' }, { service: 'files' }, () => new Promise<never>(() => undefined));
  let inFlight = await first.evidence.findByRunId('req-crash');
  for (let attempt = 0; inFlight.records.length === 0 && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight = await first.evidence.findByRunId('req-crash');
  }
  assert.equal(inFlight.state, 'started');
  await first.apiKeys.close();

  // "Restart": a new process over the same durable state.
  const second = open(path);
  try {
    const after = await second.evidence.findByRunId('req-crash');
    assert.equal(after.state, 'started', 'no completion was recorded, so the outcome is unknown');
    assert.equal(after.records.length, 1);
    assert.equal(after.records[0]!.outcome, 'started');
    assert.equal(after.records[0]!.completedAt, undefined);
  } finally {
    await second.apiKeys.close();
  }
});

test('job attempts are found by their <jobId>:<attempt> runId', async () => {
  const path = await mkdtemp(join(tmpdir(), 'evidence-job-'));
  const services = open(path);
  try {
    const caller = services.identify({ principalId: 'ada', principalType: 'user', tenantId: 'acme' })!;
    services.jobs.register('report.build', async () => undefined);
    const job = await services.jobs.enqueue({ type: 'report.build', payload: {} }, caller);
    assert.equal(await services.jobs.executeJob('acme', job.id, 'worker-1'), true);
    const lookup = await services.evidence.findByRunId(`${job.id}:1`);
    assert.equal(lookup.state, 'completed');
    assert.deepEqual(lookup.records.map((record) => record.capability), ['jobs.execute']);
  } finally {
    await services.apiKeys.close();
  }
});

test('findByRunId works on a host-supplied memory instance', async () => {
  const db = createFeltDB({ memory: true, namespace: 'evidence-memory' });
  const services = createServices({ db, application: 'm', authorizer: new TestAuthority({ allowAll: true }) });
  const caller = services.identify({ principalId: 'ada', principalType: 'user', tenantId: 'acme', runId: 'mem-1' })!;
  await services.files.create({ name: 'x', size: 1, storageKey: 'x' }, caller);
  assert.equal((await services.evidence.findByRunId('mem-1')).state, 'completed');
  await db.close();
});
