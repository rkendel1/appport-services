/**
 * Transactional effects are contract-safe: `queueJob` and `queueWebhookDeliveries` write only
 * what `servicesContract` declares, inside the caller's transaction, on a persisted FeltDB that
 * enforces that contract. Effect, audit, evidence and the caller's own records (an outbox
 * completion) commit together or not at all, and survive a restart.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { servicesContract, type ServicesContractFragment } from '../src/contract/services-contract.js';
import { evidenceCollectionName } from '../src/_internal.js';
import { all, openEnforced, OUTBOX, type Enforced } from './support/enforced.js';

const JOB_TYPE = 'invoice.send';
const EVENT = 'invoice.paid';

/** The declarations as 0.13.0 published them (no jobType / eventType on the audit records). */
function contract0130(): ServicesContractFragment {
  const current = servicesContract('all');
  const drop: Record<string, string> = { job_audit_events: 'jobType', webhook_audit_events: 'eventType' };
  return { indexes: current.indexes, collections: current.collections.map((c) => (drop[c.name] ? { ...c, fields: c.fields.filter((f) => f.name !== drop[c.name]) } : c)) };
}

async function pendingOutbox(s: Enforced, id: string): Promise<number> {
  await s.db.transaction({ operations: [{ collection: OUTBOX, id, requireAbsent: true, value: { id, state: 'pending', effect: 'job' } }] } as never);
  return ((await s.db.collection<{ __version: number }>(OUTBOX).get(id)) as { __version: number }).__version;
}

async function endpoint(s: Enforced): Promise<string> {
  const created = await s.services.webhooks!.createWebhookEndpoint({ url: 'https://example.com/hook', events: [EVENT], signingCredentialRef: 'credential-ref:signing' }, s.principal);
  return created.id;
}

/** The records a transaction may leave behind, by collection. */
async function counts(s: Enforced) {
  return {
    jobs: (await all(s.db, 'jobs')).length,
    jobAudit: (await all(s.db, 'job_audit_events')).filter((r) => r.type === 'job.enqueued').length,
    deliveries: (await all(s.db, 'webhook_deliveries')).length,
    webhookAudit: (await all(s.db, 'webhook_audit_events')).filter((r) => r.type === 'webhook.event.emitted').length,
    evidence: (await all(s.db, evidenceCollectionName())).filter((r) => r.capability === 'jobs.create' || r.capability === 'webhooks.emit').length,
    invoices: (await all(s.db, 'invoices').catch(() => [])).length,
  };
}

test('a job and its audit record commit with the caller\'s outbox completion, under the enforced contract', async () => {
  const s = await openEnforced();
  try {
    const version = await pendingOutbox(s, 'effect-1');
    const context = await s.services.authorize('jobs.create', s.principal, { type: 'job', attributes: { jobType: JOB_TYPE } });
    let operations: ReadonlyArray<{ collection: string; id: string; value?: unknown }> = [];
    const jobId = await s.services.transaction(async (tx) => {
      const id = tx.queueJob({ tenantId: s.tenantId, type: JOB_TYPE, payload: { invoice: 'A' } }, context);
      tx.addOperation({ collection: OUTBOX, id: 'effect-1', expectedVersion: version, value: { id: 'effect-1', state: 'done', effect: 'job', result: { jobId: id } } });
      operations = tx._getBuilder().getOperations();
      return id;
    });
    // Every record the transaction wrote is keyed by its own id (the store's invariant).
    for (const op of operations) if (op.value && typeof op.value === 'object') assert.equal((op.value as { id?: unknown }).id, op.id, `${op.collection}: key equals id`);
    const [job] = await all(s.db, 'jobs');
    assert.equal(job?.id, jobId);
    assert.equal(job?.status, 'pending');
    const audit = (await all(s.db, 'job_audit_events')).filter((r) => r.type === 'job.enqueued');
    assert.deepEqual(audit.map((r) => [r.jobId, r.jobType, r.principalId]), [[jobId, JOB_TYPE, 'alice']]);
    assert.deepEqual(await s.db.collection(OUTBOX).get('effect-1').then((r) => [(r as { state: string }).state, (r as { result: { jobId: string } }).result.jobId]), ['done', jobId]);
    assert.equal((await counts(s)).evidence, 1, 'the authority evidence commits with the effect');
  } finally {
    await s.close();
  }
});

test('webhook deliveries and their audit record commit with the caller\'s outbox completion, under the enforced contract', async () => {
  const s = await openEnforced();
  try {
    const endpointId = await endpoint(s);
    const version = await pendingOutbox(s, 'effect-2');
    const context = await s.services.authorize('webhooks.emit', s.principal, { type: 'webhook_event', attributes: { eventType: EVENT } });
    let operations: ReadonlyArray<{ collection: string; id: string; value?: unknown }> = [];
    await s.services.transaction(async (tx) => {
      await tx.queueWebhookDeliveries([endpointId], { tenantId: s.tenantId, type: EVENT, payload: { invoice: 'B' } }, context);
      tx.addOperation({ collection: OUTBOX, id: 'effect-2', expectedVersion: version, value: { id: 'effect-2', state: 'done', effect: 'webhook', result: { deliveries: 1 } } });
      operations = tx._getBuilder().getOperations();
    });
    for (const op of operations) if (op.value && typeof op.value === 'object') assert.equal((op.value as { id?: unknown }).id, op.id, `${op.collection}: key equals id`);
    const deliveries = await all(s.db, 'webhook_deliveries');
    assert.deepEqual(deliveries.map((d) => [d.endpointId, d.eventType, d.status]), [[endpointId, EVENT, 'pending']]);
    const audit = (await all(s.db, 'webhook_audit_events')).filter((r) => r.type === 'webhook.event.emitted');
    assert.deepEqual(audit.map((r) => r.eventType), [EVENT]);
    assert.equal(((await s.db.collection(OUTBOX).get('effect-2')) as { state: string }).state, 'done');
  } finally {
    await s.close();
  }
});

test('an audit record the contract refuses rolls back everything: no job, deliveries, evidence, app record or outbox completion', async () => {
  // A host that composed 0.13.0's declarations: the audit fields are undeclared there.
  const s = await openEnforced({ fragment: contract0130() });
  try {
    const endpointId = await endpoint(s);
    const before = await counts(s);
    const version = await pendingOutbox(s, 'effect-3');
    const job = await s.services.authorize('jobs.create', s.principal, { type: 'job', attributes: { jobType: JOB_TYPE } });
    await assert.rejects(
      s.services.transaction(async (tx) => {
        await tx.collection('invoices').insert({ id: 'inv-1', total: 10 }, 'inv-1');
        tx.queueJob({ tenantId: s.tenantId, type: JOB_TYPE, payload: {} }, job);
        tx.addOperation({ collection: OUTBOX, id: 'effect-3', expectedVersion: version, value: { id: 'effect-3', state: 'done', effect: 'job' } });
      }),
      (error: { message?: string }) => /job_audit_events:.*unknown field jobType/.test(String(error.message)),
    );
    const emit = await s.services.authorize('webhooks.emit', s.principal, { type: 'webhook_event', attributes: { eventType: EVENT } });
    await assert.rejects(s.services.transaction(async (tx) => {
      await tx.queueWebhookDeliveries([endpointId], { tenantId: s.tenantId, type: EVENT, payload: {} }, emit);
      tx.addOperation({ collection: OUTBOX, id: 'effect-3', expectedVersion: version, value: { id: 'effect-3', state: 'done', effect: 'webhook' } });
    }), (error: { message?: string }) => /webhook_audit_events:.*unknown field eventType/.test(String(error.message)));
    assert.deepEqual(await counts(s), before, 'no partial records');
    assert.equal(((await s.db.collection(OUTBOX).get('effect-3')) as { state: string }).state, 'pending');
  } finally {
    await s.close();
  }
});

test('a job record the contract refuses, or a stale outbox completion, rolls back the job, its audit and its deliveries', async () => {
  const s = await openEnforced();
  try {
    const endpointId = await endpoint(s);
    const before = await counts(s);
    const version = await pendingOutbox(s, 'effect-4');
    // jobs.maxAttempts is declared integer: 1.5 is refused by FeltDB.
    const job = await s.services.authorize('jobs.create', s.principal, { type: 'job', attributes: { jobType: JOB_TYPE } });
    await assert.rejects(s.services.transaction(async (tx) => {
      tx.queueJob({ tenantId: s.tenantId, type: JOB_TYPE, payload: {}, maxAttempts: 1.5 }, job);
      tx.addOperation({ collection: OUTBOX, id: 'effect-4', expectedVersion: version, value: { id: 'effect-4', state: 'done', effect: 'job' } });
    }), (error: { message?: string }) => /jobs:.*maxAttempts/.test(String(error.message)));
    // The caller's completion is stale (another performer recorded it first): nothing commits.
    const emit = await s.services.authorize('webhooks.emit', s.principal, { type: 'webhook_event', attributes: { eventType: EVENT } });
    await assert.rejects(s.services.transaction(async (tx) => {
      await tx.queueWebhookDeliveries([endpointId], { tenantId: s.tenantId, type: EVENT, payload: {} }, emit);
      tx.addOperation({ collection: OUTBOX, id: 'effect-4', expectedVersion: version + 1, value: { id: 'effect-4', state: 'done', effect: 'webhook' } });
    }), (error: { code?: string }) => error.code === 'PRECONDITION_FAILED');
    assert.deepEqual(await counts(s), before, 'no partial records');
  } finally {
    await s.close();
  }
});

test('after a restart the committed effect is there once, and completing it again is refused', async () => {
  const first = await openEnforced();
  const version = await pendingOutbox(first, 'effect-5');
  const context = await first.services.authorize('jobs.create', first.principal, { type: 'job', attributes: { jobType: JOB_TYPE } });
  const jobId = await first.services.transaction(async (tx) => {
    const id = tx.queueJob({ tenantId: first.tenantId, type: JOB_TYPE, payload: {} }, context);
    tx.addOperation({ collection: OUTBOX, id: 'effect-5', expectedVersion: version, value: { id: 'effect-5', state: 'done', effect: 'job', result: { jobId: id } } });
    return id;
  });
  await first.close();

  const second = await openEnforced({ path: first.path });
  try {
    assert.ok(await second.db.stateContract.active(), 'the contract is still enforced after the restart');
    assert.deepEqual((await all(second.db, 'jobs')).map((j) => j.id), [jobId]);
    assert.equal((await counts(second)).jobAudit, 1);
    // A recovering performer that read the record before it was completed: its completion is stale, so no second job.
    const again = await second.services.authorize('jobs.create', second.principal, { type: 'job', attributes: { jobType: JOB_TYPE } });
    await assert.rejects(second.services.transaction(async (tx) => {
      tx.queueJob({ tenantId: second.tenantId, type: JOB_TYPE, payload: {} }, again);
      tx.addOperation({ collection: OUTBOX, id: 'effect-5', expectedVersion: version, value: { id: 'effect-5', state: 'done', effect: 'job' } });
    }), (error: { code?: string }) => error.code === 'PRECONDITION_FAILED');
    assert.deepEqual((await all(second.db, 'jobs')).map((j) => j.id), [jobId], 'the effect was not created twice');
  } finally {
    await second.close();
  }
});

test('the non-transactional job and webhook paths behave as before under the enforced contract', async () => {
  const s = await openEnforced();
  try {
    const endpointId = await endpoint(s);
    const job = await s.services.jobs!.enqueue({ type: JOB_TYPE, payload: { invoice: 'C' } }, s.principal);
    assert.equal(job.status, 'pending');
    const deliveries = await s.services.webhooks!.emitWebhookEvent({ type: EVENT, payload: { invoice: 'C' } }, s.principal);
    assert.deepEqual(deliveries.map((d) => d.endpointId), [endpointId]);
    const audit = await all(s.db, 'job_audit_events');
    assert.ok(audit.some((r) => r.type === 'job.created' && (r.details as { jobType?: string } | undefined)?.jobType === JOB_TYPE && r.jobType === undefined), 'the direct path keeps its record shape (details.jobType)');
  } finally {
    await s.close();
  }
});

test('queueing never commits on its own: a transaction abandoned after queueing writes nothing', async () => {
  const s = await openEnforced();
  try {
    const endpointId = await endpoint(s);
    const before = await counts(s);
    const job = await s.services.authorize('jobs.create', s.principal, { type: 'job', attributes: { jobType: JOB_TYPE } });
    const emit = await s.services.authorize('webhooks.emit', s.principal, { type: 'webhook_event', attributes: { eventType: EVENT } });
    await assert.rejects(s.services.transaction(async (tx) => {
      tx.queueJob({ tenantId: s.tenantId, type: JOB_TYPE, payload: {} }, job);
      await tx.queueWebhookDeliveries([endpointId], { tenantId: s.tenantId, type: EVENT, payload: {} }, emit);
      throw new Error('the caller decides not to commit');
    }), /the caller decides not to commit/);
    assert.deepEqual(await counts(s), before, 'nothing was written by queueing');
  } finally {
    await s.close();
  }
});
