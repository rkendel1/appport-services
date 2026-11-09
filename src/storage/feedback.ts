/**
 * Durable storage for the AppPort Agent Feedback Protocol (`appport.feedback/1`).
 *
 * `FeltDbFeedbackStore` implements the `FeedbackStore` contract of `@appport/sdk` (>= 1.7.0) on FeltDB, so a provider
 * built with `createFeedbackProvider({ store })` keeps feedback across restarts, deployments and several instances.
 * The protocol and its rules belong to AppPort (`@appport/protocol`): this module stores and checks, it decides nothing.
 * FeltDB sees only collections, ids and fields; nothing in it knows what feedback is.
 *
 * Three collections, written together in single FeltDB transactions:
 *
 * - `feedback_records`: one per report. The report, its digest and the receipt are written once and never change;
 *   `state`, `sequence` and `updatedAt` are the head, rewritten only under a compare-and-set on the record's version.
 * - `feedback_submissions`: the idempotency key (tenant, principal, submissionId), created with `requireAbsent` in the
 *   same transaction as the record, so two instances cannot both accept one submission.
 * - `feedback_updates`: one row per lifecycle update, created with `requireAbsent` and never rewritten: the history is
 *   append-only. A record's status is rebuilt from these rows on every read; the head is checked against them.
 *
 * Every read re-verifies what it returns with Core (report digest, receipt, history coherence) and refuses to serve a
 * record that does not hold up (`FeedbackStoreIntegrityError`), so stored evidence cannot change silently.
 */
import {
  ConditionalConflictError,
  type StateFirstDB,
} from '@feltdb/core';
import {
  applyFeedbackUpdate,
  createFeedbackStatus,
  digestOf,
  feedbackReportDigest,
  validateFeedbackReport,
  validateFeedbackStatus,
  type FeedbackReport,
  type FeedbackState,
  type FeedbackStatus,
  type FeedbackSubmitter,
  type FeedbackUpdate,
} from '@appport/protocol';

import { boundedFind } from './bounded.js';
import type { ServicesContractFragment } from '../contract/services-contract.js';

const RECORDS = 'feedback_records';
const SUBMISSIONS = 'feedback_submissions';
const UPDATES = 'feedback_updates';

/** The largest lifecycle a record can have (Core's status bound). */
const MAX_UPDATES = 1000;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Contract                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------------ */

type FieldType = 'text' | 'integer' | 'json';
const declare = (name: string, spec: string) => Object.freeze({
  name,
  fields: Object.freeze(spec.trim().split(/\s+/).map((entry) => {
    const [field, type] = entry.split(':') as [string, FieldType];
    return Object.freeze(field === 'id' ? { name: field, type, required: true, nullable: false } : { name: field, type, required: false, nullable: true });
  })),
});

const FEEDBACK_COLLECTIONS = Object.freeze([
  declare(RECORDS, `id:text tenantId:text feedbackId:text product:text protocol:text submissionId:text ownerId:text ownerType:text
    claimedAgent:json report:json reportDigest:text fingerprint:text correlationId:text category:text severity:text receipt:json
    state:text sequence:integer createdAt:text updatedAt:text`),
  declare(SUBMISSIONS, 'id:text tenantId:text feedbackId:text ownerId:text ownerType:text submissionId:text reportDigest:text createdAt:text'),
  declare(UPDATES, 'id:text tenantId:text feedbackId:text sequence:integer fromState:text toState:text at:text update:json createdAt:text'),
]);

const FEEDBACK_INDEXES = Object.freeze([
  Object.freeze({ name: `${RECORDS}_by_tenant`, collection: RECORDS, fields: Object.freeze(['tenantId']) }),
  Object.freeze({ name: `${SUBMISSIONS}_by_tenant`, collection: SUBMISSIONS, fields: Object.freeze(['tenantId']) }),
  Object.freeze({ name: `${UPDATES}_by_record`, collection: UPDATES, fields: Object.freeze(['tenantId', 'feedbackId']) }),
]);

/**
 * The FeltDB application-contract entries this store writes, in the shape of `servicesContract(...)`. A host on an
 * application-scoped FeltDB authority composes them with its own declarations; every record the store writes is
 * declared here, with an equality index for each tenant-scoped read.
 */
export function feedbackStoreContract(): ServicesContractFragment {
  return Object.freeze({ collections: FEEDBACK_COLLECTIONS, indexes: FEEDBACK_INDEXES }) as ServicesContractFragment;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Types                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The SDK's `FeedbackRecord` (`@appport/sdk` >= 1.7.0), declared from `@appport/protocol` types so this package does not
 * depend on the SDK. `tests/feedback-store.test.ts` compiles `FeltDbFeedbackStore` against the SDK's own `FeedbackStore`.
 */
export interface FeedbackStoreRecord {
  owner: { id: string; type: string };
  claimedAgent: FeedbackSubmitter['claimedAgent'];
  report: FeedbackReport;
  status: FeedbackStatus;
}

/** The SDK's `FeedbackStore` contract. */
export interface FeedbackStoreContract {
  findSubmission(owner: { id: string; type: string }, submissionId: string): Promise<FeedbackStoreRecord | undefined>;
  create(record: FeedbackStoreRecord): Promise<{ created: true } | { created: false; existing: FeedbackStoreRecord }>;
  get(feedbackId: string): Promise<FeedbackStoreRecord | undefined>;
  replace(feedbackId: string, expectedSequence: number, status: FeedbackStatus): Promise<boolean>;
}

/** A record's head, for the provider's own triage. Never the report content. */
export interface FeedbackSummary {
  readonly feedbackId: string;
  readonly product: string;
  readonly category: FeedbackReport['category'];
  readonly severity: FeedbackReport['severity'];
  readonly state: FeedbackState;
  readonly sequence: number;
  readonly correlationId: string | null;
  readonly fingerprint: string;
  readonly owner: { readonly id: string; readonly type: string };
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface FeltDbFeedbackStoreOptions {
  /** Every record is written and read within this tenant. A store never sees another tenant's records. */
  readonly tenantId: string;
  readonly now?: () => Date;
}

/** A stored record that does not hold up against its own digests and history. It is not served. */
export class FeedbackStoreIntegrityError extends Error {
  readonly feedbackId: string;
  readonly problems: readonly string[];
  constructor(feedbackId: string, problems: readonly string[]) {
    super(`Stored feedback ${feedbackId} failed its integrity check: ${problems.join('; ')}`);
    this.name = 'FeedbackStoreIntegrityError';
    this.feedbackId = feedbackId;
    this.problems = problems;
  }
}

/** A record the store was asked to write is not one the protocol allows. Nothing is written. */
export class FeedbackStoreRejectedError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Feedback store refused the write: ${problems.join('; ')}`);
    this.name = 'FeedbackStoreRejectedError';
    this.problems = problems;
  }
}

interface StoredRecord {
  id: string;
  tenantId: string;
  feedbackId: string;
  product: string;
  protocol: string;
  submissionId: string;
  ownerId: string;
  ownerType: string;
  claimedAgent: FeedbackSubmitter['claimedAgent'];
  report: FeedbackReport;
  reportDigest: string;
  fingerprint: string;
  correlationId: string | null;
  category: string;
  severity: string;
  receipt: FeedbackStatus['receipt'];
  state: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
  __version?: number;
}

interface StoredSubmission {
  id: string;
  tenantId: string;
  feedbackId: string;
  ownerId: string;
  ownerType: string;
  submissionId: string;
  reportDigest: string;
  createdAt: string;
}

interface StoredUpdate {
  id: string;
  tenantId: string;
  feedbackId: string;
  sequence: number;
  fromState: string;
  toState: string;
  at: string;
  update: FeedbackUpdate;
  createdAt: string;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Store                                                                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

const key = (prefix: string, parts: readonly unknown[]): string => `${prefix}_${digestOf(parts).slice('sha256:'.length)}`;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class FeltDbFeedbackStore implements FeedbackStoreContract {
  readonly #db: StateFirstDB;
  readonly #tenantId: string;
  readonly #now: () => Date;

  constructor(db: StateFirstDB, options: FeltDbFeedbackStoreOptions) {
    if (typeof options?.tenantId !== 'string' || options.tenantId.length === 0) throw new TypeError('FeltDbFeedbackStore requires a tenantId');
    this.#db = db;
    this.#tenantId = options.tenantId;
    this.#now = options.now ?? (() => new Date());
  }

  #recordKey(feedbackId: string): string {
    return key('fbr', [this.#tenantId, feedbackId]);
  }

  #submissionKey(owner: { id: string; type: string }, submissionId: string): string {
    return key('fbs', [this.#tenantId, owner.type, owner.id, submissionId]);
  }

  #updateKey(feedbackId: string, sequence: number): string {
    return key('fbu', [this.#tenantId, feedbackId, sequence]);
  }

  async findSubmission(owner: { id: string; type: string }, submissionId: string): Promise<FeedbackStoreRecord | undefined> {
    const submission = await this.#db.collection<StoredSubmission>(SUBMISSIONS).get(this.#submissionKey(owner, submissionId));
    if (!submission || submission.tenantId !== this.#tenantId) return undefined;
    return this.get(submission.feedbackId);
  }

  /**
   * Records a new submission: the record and its idempotency key commit together or not at all. When the key is
   * already taken (an earlier or concurrent submission of the same submissionId by the same principal) nothing is
   * written and the existing record is returned, for the SDK to replay or refuse.
   */
  async create(record: FeedbackStoreRecord): Promise<{ created: true } | { created: false; existing: FeedbackStoreRecord }> {
    this.#checkNew(record);
    const { report, status, owner } = record;
    const feedbackId = status.feedbackId;
    const submissionKey = this.#submissionKey(owner, report.submissionId);
    const createdAt = this.#now().toISOString();
    const stored: StoredRecord = {
      id: this.#recordKey(feedbackId),
      tenantId: this.#tenantId,
      feedbackId,
      product: report.target.product.id,
      protocol: report.protocol,
      submissionId: report.submissionId,
      ownerId: owner.id,
      ownerType: owner.type,
      claimedAgent: plain(record.claimedAgent),
      report: plain(report),
      reportDigest: status.receipt.reportDigest,
      fingerprint: status.receipt.fingerprint,
      correlationId: report.context?.correlationId ?? null,
      category: report.category,
      severity: report.severity,
      receipt: plain(status.receipt),
      state: status.state,
      sequence: 0,
      createdAt,
      updatedAt: createdAt,
    };
    const submission: StoredSubmission = {
      id: submissionKey,
      tenantId: this.#tenantId,
      feedbackId,
      ownerId: owner.id,
      ownerType: owner.type,
      submissionId: report.submissionId,
      reportDigest: stored.reportDigest,
      createdAt,
    };
    try {
      await this.#db.transaction({
        operations: [
          { collection: SUBMISSIONS, id: submissionKey, requireAbsent: true, value: { ...submission } },
          { collection: RECORDS, id: stored.id, requireAbsent: true, value: { ...stored } },
        ],
      });
      return { created: true };
    } catch (error) {
      if (!(error instanceof ConditionalConflictError)) throw error;
      const existing = await this.findSubmission(owner, report.submissionId);
      if (existing) return { created: false, existing };
      // The key was free, so the record id was taken: a feedbackId collision, never a duplicate submission.
      throw new FeedbackStoreRejectedError([`feedbackId ${feedbackId} already exists`]);
    }
  }

  async get(feedbackId: string): Promise<FeedbackStoreRecord | undefined> {
    const stored = await this.#db.collection<StoredRecord>(RECORDS).get(this.#recordKey(feedbackId));
    if (!stored || stored.tenantId !== this.#tenantId || stored.feedbackId !== feedbackId) return undefined;
    const updates = await this.#updates(feedbackId);
    return this.#verified(stored, updates);
  }

  /**
   * Appends the updates `status` adds to the stored history, if the record is still at `expectedSequence`. The stored
   * history must be an unchanged prefix of `status`, and every added update must be the valid next transition (Core's
   * `applyFeedbackUpdate`); otherwise nothing is written and `FeedbackStoreRejectedError` is thrown. A record that
   * moved on concurrently returns false: the head is written under a compare-and-set on its FeltDB version and each
   * update row is created with `requireAbsent`, in one transaction.
   */
  async replace(feedbackId: string, expectedSequence: number, status: FeedbackStatus): Promise<boolean> {
    const stored = await this.#db.collection<StoredRecord>(RECORDS).get(this.#recordKey(feedbackId));
    if (!stored || stored.tenantId !== this.#tenantId || stored.feedbackId !== feedbackId) return false;
    if (stored.sequence !== expectedSequence) return false;
    const current = this.#verified(stored, await this.#updates(feedbackId));
    if (current.status.sequence !== expectedSequence) return false;

    const problems: string[] = [];
    if (status.feedbackId !== feedbackId) problems.push('status names another record');
    if (digestOf(status.receipt) !== digestOf(current.status.receipt)) problems.push('the receipt cannot change');
    if (status.updates.length <= expectedSequence) problems.push('no update to append');
    for (let i = 0; i < Math.min(expectedSequence, status.updates.length); i += 1) {
      if (digestOf(status.updates[i]) !== digestOf(current.status.updates[i])) problems.push(`update ${i + 1} would be rewritten`);
    }
    if (status.updates.length > MAX_UPDATES) problems.push(`a record holds at most ${MAX_UPDATES} updates`);
    if (problems.length) throw new FeedbackStoreRejectedError(problems);

    const added = status.updates.slice(expectedSequence);
    let next = current.status;
    for (const update of added) {
      const applied = applyFeedbackUpdate(next, update);
      if (!applied.ok) throw new FeedbackStoreRejectedError(applied.issues.map((issue) => `${issue.code} at ${issue.pointer}`));
      next = applied.value;
    }
    if (next.state !== status.state || next.sequence !== status.sequence) throw new FeedbackStoreRejectedError(['state or sequence does not follow from the updates']);

    const now = this.#now().toISOString();
    const version = stored.__version;
    if (typeof version !== 'number') throw new FeedbackStoreIntegrityError(feedbackId, ['record has no FeltDB version']);
    const { __version: _version, ...head } = stored;
    try {
      await this.#db.transaction({
        operations: [
          { collection: RECORDS, id: stored.id, expectedVersion: version, value: { ...head, state: next.state, sequence: next.sequence, updatedAt: now } },
          ...added.map((update) => ({
            collection: UPDATES,
            id: this.#updateKey(feedbackId, update.sequence),
            requireAbsent: true,
            value: { id: this.#updateKey(feedbackId, update.sequence), tenantId: this.#tenantId, feedbackId, sequence: update.sequence, fromState: update.from, toState: update.to, at: update.at, update: plain(update), createdAt: now } satisfies StoredUpdate,
          })),
        ],
      });
      return true;
    } catch (error) {
      if (error instanceof ConditionalConflictError) return false;
      throw error;
    }
  }

  /**
   * The provider's view of its records in this tenant, newest first, without report content. `security_concern`
   * records are left out unless asked for: the protocol keeps them within the provider's security handling.
   * Authorizing who may call this is the host's (the store has no caller).
   */
  async list(options: { state?: FeedbackState; limit?: number; includeSecurityConcerns?: boolean } = {}): Promise<FeedbackSummary[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
    // Only the tenant predicate goes to FeltDB: it is the one with a declared index, which an application-scoped
    // authority requires. The state and category filters are applied to that bounded read.
    const records = await boundedFind<StoredRecord>(this.#db, RECORDS, { tenantId: this.#tenantId }, 10_000);
    return records
      .filter((r) => (options.state === undefined || r.state === options.state) && (options.includeSecurityConcerns === true || r.category !== 'security_concern'))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit)
      .map((r) => Object.freeze({
        feedbackId: r.feedbackId,
        product: r.product,
        category: r.category as FeedbackReport['category'],
        severity: r.severity as FeedbackReport['severity'],
        state: r.state as FeedbackState,
        sequence: r.sequence,
        correlationId: r.correlationId ?? null,
        fingerprint: r.fingerprint,
        owner: Object.freeze({ id: r.ownerId, type: r.ownerType }),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
  }

  async #updates(feedbackId: string): Promise<StoredUpdate[]> {
    const rows = await boundedFind<StoredUpdate>(this.#db, UPDATES, { tenantId: this.#tenantId, feedbackId }, MAX_UPDATES + 1);
    return rows.sort((a, b) => a.sequence - b.sequence);
  }

  /** Rebuilds the record from immutable rows and checks it with Core. Throws rather than serve a record that does not hold up. */
  #verified(stored: StoredRecord, rows: StoredUpdate[]): FeedbackStoreRecord {
    const problems: string[] = [];
    const report = validateFeedbackReport(stored.report);
    if (!report.ok) problems.push('stored report is not a valid report');
    else if (feedbackReportDigest(report.value) !== stored.reportDigest) problems.push('stored report does not match its digest');
    if (stored.receipt?.reportDigest !== stored.reportDigest) problems.push('receipt does not match the stored report');
    if (stored.receipt?.feedbackId !== stored.feedbackId) problems.push('receipt names another record');
    // Rows are created only alongside a head that counts them, so more rows than the head means a write outside this store.
    if (rows.length !== stored.sequence) problems.push(`head says ${stored.sequence} updates, ${rows.length} stored`);
    let status: FeedbackStatus | undefined;
    if (problems.length === 0) {
      status = createFeedbackStatus(stored.receipt);
      for (const row of rows) {
        if (row.update?.sequence !== row.sequence || row.id !== this.#updateKey(stored.feedbackId, row.sequence)) {
          problems.push(`update row ${row.sequence} does not match its key`);
          break;
        }
        const applied = applyFeedbackUpdate(status, row.update);
        if (!applied.ok) {
          problems.push(`update ${row.sequence}: ${applied.issues.map((issue) => issue.code).join(', ')}`);
          break;
        }
        status = applied.value;
      }
      if (status && problems.length === 0) {
        if (status.state !== stored.state) problems.push('head state does not follow from the history');
        const coherent = validateFeedbackStatus(status);
        if (!coherent.ok) problems.push(...coherent.issues.map((issue) => issue.code));
      }
    }
    if (problems.length || !status || !report.ok) throw new FeedbackStoreIntegrityError(stored.feedbackId, problems);
    return {
      owner: { id: stored.ownerId, type: stored.ownerType },
      claimedAgent: stored.claimedAgent,
      report: report.value,
      status,
    };
  }

  #checkNew(record: FeedbackStoreRecord): void {
    const problems: string[] = [];
    if (!record?.owner?.id || !record.owner.type) problems.push('owner (the authenticated principal) is required');
    const report = validateFeedbackReport(record?.report);
    if (!report.ok) problems.push(...report.issues.map((issue) => `${issue.code} at ${issue.pointer}`));
    const status = validateFeedbackStatus(record?.status);
    if (!status.ok) problems.push(...status.issues.map((issue) => `${issue.code} at ${issue.pointer}`));
    if (problems.length === 0) {
      if (record.status.sequence !== 0 || record.status.updates.length !== 0) problems.push('a new record has no updates');
      if (record.status.receipt.reportDigest !== feedbackReportDigest(record.report)) problems.push('receipt is not for this report');
      if (record.status.submissionId !== record.report.submissionId) problems.push('status is for another submission');
    }
    if (problems.length) throw new FeedbackStoreRejectedError(problems);
  }
}
