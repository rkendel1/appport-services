/**
 * FeltDbFeedbackStore against the real AppPort SDK (createFeedbackProvider / createFeedbackClient) on a persisted
 * FeltDB that enforces exactly feedbackStoreContract(): every write below would be refused if it were undeclared.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { AtomicTransactionError, createFeltDB, type StateFirstDB } from '@feltdb/core';
import { AppPortError, type FeedbackStore } from '@appport/sdk';
import { evidenceDigest, feedbackReportDigest, validateFeedbackStatus, type FeedbackStatus } from '@appport/protocol';

import { FeedbackStoreIntegrityError, FeedbackStoreRejectedError, FeltDbFeedbackStore, feedbackStoreContract } from '../src/index.js';
import { feedbackRig, openFeedbackDb, SESSIONS } from './support/feedback.js';

// Compile-time conformance: the store is the SDK's FeedbackStore, exactly.
const _conforms = (db: StateFirstDB): FeedbackStore => new FeltDbFeedbackStore(db, { tenantId: 't' });
void _conforms;

const owner = SESSIONS.reporter.principal;
const code = async (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (error: unknown) => (AppPortError.is(error) ? error.code : (error as Error).name));

async function withStore<T>(fn: (ctx: { db: StateFirstDB; path: string; store: FeltDbFeedbackStore }) => Promise<T>, path?: string): Promise<T> {
  const { db, path: dir } = await openFeedbackDb(path);
  try {
    return await fn({ db, path: dir, store: new FeltDbFeedbackStore(db, { tenantId: 'tenant-a' }) });
  } finally {
    await db.close();
  }
}

test('durable submission: the receipt is answered only after the record is committed, and reads back exactly', async () => {
  await withStore(async ({ store }) => {
    const rig = await feedbackRig(store);
    const { feedbackId, report, receipt } = await rig.reporter.submit(rig.report());
    const stored = await store.get(feedbackId);
    assert.ok(stored);
    assert.deepEqual(stored.report, report);
    assert.deepEqual(stored.status.receipt, receipt);
    assert.deepEqual(stored.owner, { id: owner.id, type: owner.type });
    assert.deepEqual(await store.findSubmission(owner, report.submissionId), stored);
  });
});

test('restart recovery: a new process sees every record, its history continues, and the consumer keeps tracking', async () => {
  const { db, path } = await openFeedbackDb();
  const first = await feedbackRig(new FeltDbFeedbackStore(db, { tenantId: 'tenant-a' }));
  const { feedbackId, tracker, report } = await first.reporter.submit(first.report());
  await first.provider.acknowledge(feedbackId);
  await first.provider.investigate(feedbackId);
  await db.close();

  await withStore(async ({ store }) => {
    const second = await feedbackRig(store);
    const before = await store.get(feedbackId);
    assert.equal(before?.status.state, 'investigating');
    await second.provider.markReproduced(feedbackId, { method: 'replayed in isolation' });
    await second.provider.accept(feedbackId);
    // The consumer's tracker, created before the restart, reads the history written by both processes.
    const status = await second.reporter.status(feedbackId);
    assert.equal(validateFeedbackStatus(status).ok, true);
    assert.deepEqual(status.updates.map((u) => u.to), ['acknowledged', 'investigating', 'reproduced', 'accepted']);
    // An identical resubmission after restart replays the original receipt.
    const again = await second.reporter.resubmit(report);
    assert.deepEqual(again.receipt, tracker.receipt);
  }, path);
});

test('duplicate submission replays the original receipt and stores one record', async () => {
  await withStore(async ({ store }) => {
    const rig = await feedbackRig(store);
    const first = await rig.reporter.submit(rig.report());
    const second = await rig.reporter.resubmit(first.report);
    assert.deepEqual(second.receipt, first.receipt);
    assert.equal((await store.list()).length, 1);
  });
});

test('conflicting submission (same submissionId, different report) is CONFLICT and changes nothing', async () => {
  await withStore(async ({ store }) => {
    const rig = await feedbackRig(store);
    const first = await rig.reporter.submit(rig.report());
    assert.equal(await code(rig.reporter.submit({ ...first.report, severity: 'low' })), 'CONFLICT');
    assert.deepEqual((await store.get(first.feedbackId))?.report, first.report);
    assert.equal((await store.list()).length, 1);
  });
});

test('concurrent writers on two handles: every compare-and-set race has exactly one winner, and history is never forked', async () => {
  const { db: a, path } = await openFeedbackDb();
  const b = createFeltDB({ mode: 'local', namespace: 'feedback', path, access: 'shared' } as never);
  try {
    const storeA = new FeltDbFeedbackStore(a, { tenantId: 'tenant-a' });
    const storeB = new FeltDbFeedbackStore(b, { tenantId: 'tenant-a' });
    const one = await feedbackRig(storeA);
    const two = await feedbackRig(storeB);
    const update = (feedbackId: string, message: string) => ({ protocol: 'appport.feedback/1', type: 'update', feedbackId, sequence: 1, from: 'submitted', to: 'acknowledged', at: new Date().toISOString(), actor: { kind: 'agent', id: 'maintainer' }, message }) as const;
    for (let i = 0; i < 20; i += 1) {
      const { feedbackId } = await one.reporter.submit(one.report());
      // Both instances read the same head, then both try to append a different first update.
      const [headA, headB] = await Promise.all([storeA.get(feedbackId), storeB.get(feedbackId)]);
      const next = (head: FeedbackStatus, message: string): FeedbackStatus => ({ ...head, state: 'acknowledged', sequence: 1, updates: [update(feedbackId, message) as never] });
      const results = await Promise.all([storeA.replace(feedbackId, 0, next(headA!.status, 'from A')), storeB.replace(feedbackId, 0, next(headB!.status, 'from B'))]);
      assert.equal(results.filter(Boolean).length, 1, `race ${i}: exactly one compare-and-set succeeds (${JSON.stringify(results)})`);
      const stored = (await storeB.get(feedbackId))!.status;
      assert.equal(stored.updates.length, 1);
      assert.equal(stored.updates[0]!.message, results[0] ? 'from A' : 'from B');
    }
    // Through the SDK: two provider instances acknowledge the same record at once.
    const { feedbackId } = await one.reporter.submit(one.report());
    const outcomes = await Promise.allSettled([one.provider.acknowledge(feedbackId), two.provider.acknowledge(feedbackId)]);
    assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    assert.ok(AppPortError.is(loser.reason) && ['CONFLICT', 'INVALID_INPUT'].includes(loser.reason.code), String(loser.reason));
    assert.deepEqual((await storeA.get(feedbackId))!.status.updates.map((u) => [u.sequence, u.to]), [[1, 'acknowledged']]);
  } finally {
    await a.close();
    await b.close();
  }
});

test('compare-and-set: a stale expected sequence writes nothing and returns false', async () => {
  await withStore(async ({ store }) => {
    const rig = await feedbackRig(store);
    const { feedbackId } = await rig.reporter.submit(rig.report());
    const at0 = (await store.get(feedbackId))!.status;
    await rig.provider.acknowledge(feedbackId);
    const stale = { ...at0, state: 'acknowledged' as const, sequence: 1, updates: [{ ...((await store.get(feedbackId))!.status.updates[0]!), message: 'a different first update' }] };
    assert.equal(await store.replace(feedbackId, 0, stale), false);
    assert.equal(await store.replace('fb_does_not_exist', 0, stale), false);
    assert.equal((await store.get(feedbackId))!.status.updates[0]!.message, undefined);
  });
});

test('invalid or rewritten history is refused by the store itself, even bypassing the SDK', async () => {
  await withStore(async ({ store }) => {
    const rig = await feedbackRig(store);
    const { feedbackId } = await rig.reporter.submit(rig.report());
    await rig.provider.acknowledge(feedbackId);
    const current = (await store.get(feedbackId))!.status;
    const skip = { protocol: 'appport.feedback/1', type: 'update', feedbackId, sequence: 2, from: 'acknowledged', to: 'resolved', at: new Date().toISOString(), actor: { kind: 'system', id: 'x' }, resolution: { summary: 'x', retry: { action: 'retry' } } } as const;
    const forged: FeedbackStatus = { ...current, state: 'resolved', sequence: 2, updates: [...current.updates, skip as never] };
    await assert.rejects(store.replace(feedbackId, 1, forged), FeedbackStoreRejectedError);
    const rewritten: FeedbackStatus = { ...current, updates: [{ ...current.updates[0]!, message: 'rewritten' }] };
    await assert.rejects(store.replace(feedbackId, 1, { ...rewritten, sequence: 1 }), FeedbackStoreRejectedError);
    const changedReceipt: FeedbackStatus = { ...current, receipt: { ...current.receipt, receivedAt: '2020-01-01T00:00:00Z' } };
    await assert.rejects(store.replace(feedbackId, 1, changedReceipt), FeedbackStoreRejectedError);
    assert.deepEqual((await store.get(feedbackId))!.status, current);
    // The SDK refuses the same transition before it reaches the store.
    assert.equal(await code(rig.provider.resolve(feedbackId, { summary: 'x', retry: { action: 'retry' } })), 'INVALID_INPUT');
  });
});

test('reporter isolation: another principal gets NOT_FOUND; another tenant sees nothing', async () => {
  await withStore(async ({ db, store }) => {
    const rig = await feedbackRig(store);
    const { feedbackId, report } = await rig.reporter.submit(rig.report());
    assert.equal(await code(rig.other.status(feedbackId)), 'NOT_FOUND');
    const otherTenant = new FeltDbFeedbackStore(db, { tenantId: 'tenant-b' });
    assert.equal(await otherTenant.get(feedbackId), undefined);
    assert.equal(await otherTenant.findSubmission(owner, report.submissionId), undefined);
    assert.deepEqual(await otherTenant.list({ includeSecurityConcerns: true }), []);
    // The same submissionId in another tenant is a separate submission, not a replay.
    const created = await otherTenant.create({ ...(await store.get(feedbackId))!, status: { ...(await store.get(feedbackId))!.status } });
    assert.deepEqual(created, { created: true });
  });
});

test('provider access: list() gives heads without report content, and keeps security concerns out unless asked', async () => {
  await withStore(async ({ store }) => {
    const rig = await feedbackRig(store);
    const a = await rig.reporter.submit(rig.report());
    await rig.reporter.submit(rig.report({ category: 'security_concern', severity: 'critical', reproduction: undefined }));
    await rig.provider.acknowledge(a.feedbackId);
    const visible = await store.list();
    assert.equal(visible.length, 1);
    assert.deepEqual(Object.keys(visible[0]!).sort(), ['category', 'correlationId', 'createdAt', 'feedbackId', 'fingerprint', 'owner', 'product', 'sequence', 'severity', 'state', 'updatedAt']);
    assert.equal(visible[0]!.state, 'acknowledged');
    assert.equal((await store.list({ includeSecurityConcerns: true })).length, 2);
    assert.equal((await store.list({ state: 'submitted', includeSecurityConcerns: true }))[0]!.category, 'security_concern');
  });
});

test('transaction rollback: a commit that fails writes nothing, and the retry succeeds', async () => {
  await withStore(async ({ db, store }) => {
    const rig = await feedbackRig(store);
    // Real atomicity: the record id is taken, so the transaction fails on its second operation; the idempotency key
    // its first operation would have written must not exist afterwards.
    const existing = await rig.reporter.submit(rig.report());
    const record = (await store.get(existing.feedbackId))!;
    const otherSubmission = { ...record.report, submissionId: 'sub_rollback_000001' };
    const receipt = { ...record.status.receipt, submissionId: otherSubmission.submissionId, reportDigest: feedbackReportDigest(otherSubmission) };
    await assert.rejects(store.create({ ...record, report: otherSubmission, status: { ...record.status, submissionId: otherSubmission.submissionId, receipt } }), FeedbackStoreRejectedError);
    assert.equal(await store.findSubmission(owner, otherSubmission.submissionId), undefined);
    assert.equal((await store.list()).length, 1);
    // A commit the authority refuses outright: nothing is written, and the same submission then succeeds.
    const real = db.transaction.bind(db);
    (db as { transaction: unknown }).transaction = async () => { throw new AtomicTransactionError('simulated authority failure', 'tx-1', 'DURABILITY_FAILURE' as never); };
    const input = rig.report();
    assert.equal(await code(rig.reporter.submit(input)), 'INTERNAL_ERROR');
    (db as { transaction: unknown }).transaction = real;
    assert.equal((await store.list()).length, 1);
    const { feedbackId } = await rig.reporter.submit(input);
    assert.equal((await store.get(feedbackId))?.status.state, 'submitted');
  });
});

test('outcome unknown: a commit that succeeded but was reported as failed is recovered by resubmitting', async () => {
  await withStore(async ({ db, store }) => {
    const rig = await feedbackRig(store);
    const real = db.transaction.bind(db);
    let report: Parameters<typeof rig.reporter.resubmit>[0] | undefined;
    (db as { transaction: unknown }).transaction = async (...args: Parameters<StateFirstDB['transaction']>) => {
      await real(...args);
      throw new AtomicTransactionError('connection lost after commit', 'tx-2', 'COMMIT_OUTCOME_UNKNOWN' as never);
    };
    const built = await rig.reporter.build(rig.report());
    report = built;
    assert.equal(await code(rig.reporter.submit(built)), 'INTERNAL_ERROR');
    (db as { transaction: unknown }).transaction = real;
    const replay = await rig.reporter.resubmit(report);
    assert.equal(replay.receipt.reportDigest, feedbackReportDigest(built));
    assert.equal((await store.list()).length, 1, 'the resubmission found the committed record instead of creating another');
  });
});

test('interrupted writes: a provider process killed mid-write leaves only whole, coherent records', async () => {
  const { db, path } = await openFeedbackDb();
  await db.close();
  const writer = spawn(process.execPath, [fileURLToPath(new URL('./support/feedback-writer.js', import.meta.url)), path], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    let progress = 0;
    writer.stdout.on('data', (chunk: Buffer) => {
      progress += chunk.toString().split('\n').filter((line) => /^\d+$/.test(line)).length;
      if (progress >= 2) resolve();
    });
    writer.on('exit', (status) => reject(new Error(`writer exited early (${status})`)));
    const timer = setTimeout(() => reject(new Error('writer made no progress')), 60_000);
    timer.unref();
  });
  writer.kill('SIGKILL');
  await new Promise((resolve) => writer.once('exit', resolve));

  await withStore(async ({ store }) => {
    const heads = await store.list({ limit: 1000 });
    assert.ok(heads.length >= 6, `expected several records, found ${heads.length}`);
    for (const head of heads) {
      const record = await store.get(head.feedbackId); // throws FeedbackStoreIntegrityError on a torn record
      assert.ok(record);
      assert.equal(validateFeedbackStatus(record.status).ok, true);
      assert.equal(record.status.sequence, head.sequence);
    }
    // The store remains writable: lifecycles left mid-way can continue.
    const rig = await feedbackRig(store);
    const unfinished = heads.find((h) => h.state !== 'in_progress');
    if (unfinished) assert.ok((await rig.provider.transition(unfinished.feedbackId, { to: unfinished.state === 'submitted' ? 'acknowledged' : unfinished.state === 'acknowledged' ? 'investigating' : 'accepted' })).sequence > unfinished.sequence);
  }, path);
});

test('evidence and provenance are preserved exactly, and a record altered outside the store is not served', async () => {
  const { db, path } = await openFeedbackDb();
  const rig = await feedbackRig(new FeltDbFeedbackStore(db, { tenantId: 'tenant-a' }));
  const { feedbackId, report, receipt } = await rig.reporter.submit(rig.report());
  await db.close();
  await withStore(async ({ db: reopened, store }) => {
    const stored = (await store.get(feedbackId))!;
    assert.deepEqual(stored.report.evidence, report.evidence);
    assert.deepEqual(stored.report.evidence![0]!.digest, evidenceDigest(report.evidence![0]!.content!).digest);
    assert.deepEqual(stored.report.context, report.context);
    assert.deepEqual(stored.status.receipt.provenance, receipt.provenance);
    assert.equal(stored.status.receipt.correlationId, 'task_month_end_0042');
    assert.deepEqual(stored.claimedAgent, { id: 'reporter-agent', version: '1.0.0' });

    // Someone edits the stored evidence directly in FeltDB.
    const records = reopened.collection<Record<string, any>>('feedback_records');
    const [raw] = await records.find({ feedbackId } as never);
    await records.updateIfVersion(raw!.id, raw!.__version, { report: { ...raw!.report, evidence: [{ ...raw!.report.evidence[0], content: '{"ok":true}' }] } });
    await assert.rejects(store.get(feedbackId), FeedbackStoreIntegrityError);
    const fresh = await feedbackRig(store);
    assert.equal(await code(fresh.reporter.status(feedbackId)), 'INTERNAL_ERROR');
  }, path);
});

test('the store writes only what feedbackStoreContract() declares (enforced by FeltDB) and refuses malformed records', async () => {
  await withStore(async ({ store }) => {
    const rig = await feedbackRig(store);
    const { feedbackId } = await rig.reporter.submit(rig.report());
    for (const step of ['acknowledge', 'investigate', 'accept', 'startWork'] as const) await rig.provider[step](feedbackId);
    await rig.provider.markVerified(feedbackId, { method: 'regression tests' });
    await rig.provider.markReleased(feedbackId, { version: '3.2.1', releasedAt: new Date().toISOString(), compatibility: { breaking: false } });
    const done = await rig.provider.resolve(feedbackId, { summary: 'Fixed in 3.2.1.', retry: { action: 'retry_after_upgrade', upgrade: { api: '3.2.1' } } });
    assert.equal(done.state, 'resolved');
    assert.equal((await store.get(feedbackId))!.status.sequence, 7);

    const record = (await store.get(feedbackId))!;
    await assert.rejects(store.create({ ...record, owner: { id: '', type: 'service' } }), FeedbackStoreRejectedError);
    await assert.rejects(store.create({ ...record, report: { ...record.report, severity: 'blocking' as never } }), FeedbackStoreRejectedError);
    assert.deepEqual(feedbackStoreContract().collections.map((c) => c.name), ['feedback_records', 'feedback_submissions', 'feedback_updates']);
    assert.throws(() => new FeltDbFeedbackStore(null as never, { tenantId: '' }), TypeError);
  });
});
