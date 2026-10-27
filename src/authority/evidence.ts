import type { StateFirstDB } from '@feltdb/core';

import { boundedFind } from '../storage/bounded.js';

const EVIDENCE_COLLECTION = 'service_effect_evidence';

export type EffectOutcome = 'started' | 'succeeded' | 'failed' | 'provider_error' | 'denied';

/**
 * Durable record of one consequential service effect (or its denial).
 * It references credentials only by credential-ref and never carries
 * secrets, tokens, API keys, or payloads.
 */
export interface EffectEvidence {
  readonly id: string;
  readonly application: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly principalType: string;
  readonly delegationId?: string;
  readonly runId?: string;
  readonly capability: string;
  readonly capabilityVersion: number;
  readonly resource: string;
  readonly decision: 'allow' | 'deny' | 'none';
  readonly decisionId?: string;
  readonly credentialRef?: string;
  readonly service: string;
  readonly provider?: string;
  readonly requestId: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly outcome: EffectOutcome;
  readonly failureCode?: string;
}

export interface EffectEvidenceStore {
  record(evidence: EffectEvidence): Promise<void>;
  complete(id: string, updates: Pick<EffectEvidence, 'outcome' | 'completedAt'> & Partial<Pick<EffectEvidence, 'failureCode' | 'credentialRef' | 'provider'>>): Promise<void>;
  get(id: string): Promise<EffectEvidence | null>;
  list(tenantId: string): Promise<readonly EffectEvidence[]>;
  findByDecision(decisionId: string): Promise<readonly EffectEvidence[]>;
  /**
   * At most `limit` rows whose `runId` equals `runId` (and, when given, whose
   * application / tenant match). Optional so existing custom stores keep
   * compiling; `services.evidence.findByRunId` requires it.
   */
  findByRunId?(runId: string, filter: { readonly limit: number; readonly application?: string; readonly tenantId?: string }): Promise<readonly EffectEvidence[]>;
}

/**
 * Where one evidence row is in its lifecycle.
 *
 * - `started`: the effect was authorized and the `started` row was written,
 *   but no completion was recorded. Either it is still running, or the process
 *   stopped before the completion write: the effect's outcome is **unknown**.
 * - `completed`: the effect returned successfully (outcome `succeeded`).
 * - `failed`: the effect failed, the provider failed, or it was denied
 *   (outcome `failed`, `provider_error` or `denied`).
 */
export type EffectEvidenceState = 'started' | 'completed' | 'failed';

/** An evidence row with its lifecycle state. */
export interface EffectEvidenceRecord extends EffectEvidence {
  readonly state: EffectEvidenceState;
}

export interface EffectEvidenceLookupOptions {
  /** Maximum rows returned. Default 100, at most 1000. */
  readonly limit?: number;
  /** Only rows of this tenant. */
  readonly tenantId?: string;
}

/** Every recorded effect of one run (a caller's correlation id, or a job/delivery attempt). */
export interface EffectEvidenceLookup {
  readonly runId: string;
  /**
   * Aggregate over `records`: `none` when nothing was recorded; `failed` when
   * any effect failed; otherwise `started` when any effect has no recorded
   * completion (outcome unknown); otherwise `completed`.
   */
  readonly state: EffectEvidenceState | 'none';
  /** Oldest first (by `startedAt`). */
  readonly records: readonly EffectEvidenceRecord[];
  /** True when more rows matched than `limit`; only `limit` of them are returned. */
  readonly truncated: boolean;
}

/** The read side of effect evidence, as `services.evidence`. */
export interface EffectEvidenceReader {
  /**
   * Evidence recorded for one run id: the `runId` of the principal that caused
   * the effects. A host sets it per request with
   * `services.identify({ ..., runId })`; jobs use `<jobId>:<attempt>` and
   * webhook deliveries `<deliveryId>:<attempt>`. Bounded and served by a hash
   * index on `runId`. Rows of other applications sharing the namespace are not
   * returned.
   */
  findByRunId(runId: string, options?: EffectEvidenceLookupOptions): Promise<EffectEvidenceLookup>;
}

export const DEFAULT_EVIDENCE_LOOKUP_LIMIT = 100;
export const MAX_EVIDENCE_LOOKUP_LIMIT = 1000;

export function evidenceState(outcome: EffectOutcome): EffectEvidenceState {
  if (outcome === 'started') return 'started';
  if (outcome === 'succeeded') return 'completed';
  return 'failed';
}

/** Build the public reader over a store, scoped to one application. */
export function createEvidenceReader(store: EffectEvidenceStore, application: string): EffectEvidenceReader {
  return {
    async findByRunId(runId, options = {}) {
      if (typeof runId !== 'string' || !runId) throw new TypeError('findByRunId requires a non-empty runId');
      const limit = options.limit ?? DEFAULT_EVIDENCE_LOOKUP_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVIDENCE_LOOKUP_LIMIT) {
        throw new RangeError(`limit must be an integer from 1 to ${MAX_EVIDENCE_LOOKUP_LIMIT}`);
      }
      if (!store.findByRunId) throw new Error('This evidence store does not support findByRunId');
      // One extra row tells a full page from a truncated one.
      const rows = await store.findByRunId(runId, { limit: limit + 1, application, ...(options.tenantId ? { tenantId: options.tenantId } : {}) });
      const matching = rows.filter((row) => row.runId === runId && row.application === application && (!options.tenantId || row.tenantId === options.tenantId));
      const truncated = matching.length > limit;
      const records = matching
        .slice(0, limit)
        .map((row) => ({ ...stripVersion(row), state: evidenceState(row.outcome) }))
        .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
      return { runId, state: aggregateState(records), records, truncated };
    },
  };
}

function aggregateState(records: readonly EffectEvidenceRecord[]): EffectEvidenceLookup['state'] {
  if (records.length === 0) return 'none';
  if (records.some((record) => record.state === 'failed')) return 'failed';
  if (records.some((record) => record.state === 'started')) return 'started';
  return 'completed';
}

function stripVersion(row: EffectEvidence): EffectEvidence {
  const { __version: _version, ...rest } = row as EffectEvidence & { __version?: number };
  return rest;
}

const SECRET_KEY = /secret|token|password|authorization|api[_-]?key|signature|credential(?!Ref)/i;
const SECRET_VALUE = /(app_live_[0-9a-f]{6}_)|(^bearer\s)|(-----BEGIN)/i;

/** Evidence is built from fixed fields; this guard keeps a future change from leaking material into it. */
export function assertEvidenceHasNoSecrets(evidence: Partial<EffectEvidence>): void {
  for (const [key, value] of Object.entries(evidence)) {
    if (key !== 'credentialRef' && SECRET_KEY.test(key)) throw new Error(`Evidence field "${key}" is not permitted`);
    if (typeof value === 'string' && SECRET_VALUE.test(value)) throw new Error(`Evidence field "${key}" contains credential material`);
    if (key === 'credentialRef' && value !== undefined && !String(value).startsWith('credential-ref:')) {
      throw new Error('Evidence may reference credentials only by credential-ref');
    }
  }
}

export class FeltDbEffectEvidenceStore implements EffectEvidenceStore {
  private readonly collection;

  constructor(private readonly db: StateFirstDB) {
    this.collection = db.collection<EffectEvidence & { __version?: number }>(EVIDENCE_COLLECTION);
  }

  async record(evidence: EffectEvidence): Promise<void> {
    assertEvidenceHasNoSecrets(evidence);
    await this.db.transaction({ operations: [{ collection: EVIDENCE_COLLECTION, id: evidence.id, requireAbsent: true, value: { ...evidence } }] });
  }

  async complete(id: string, updates: Parameters<EffectEvidenceStore['complete']>[1]): Promise<void> {
    assertEvidenceHasNoSecrets(updates);
    const current = await this.collection.get(id);
    if (!current) throw new Error(`Evidence ${id} not found`);
    await this.collection.update(id, { ...current, ...updates });
  }

  get(id: string): Promise<EffectEvidence | null> {
    return this.collection.get(id);
  }

  list(tenantId: string): Promise<readonly EffectEvidence[]> {
    return this.collection.find({ tenantId });
  }

  findByDecision(decisionId: string): Promise<readonly EffectEvidence[]> {
    return this.collection.find({ decisionId });
  }

  async findByRunId(runId: string, filter: { readonly limit: number; readonly application?: string; readonly tenantId?: string }): Promise<readonly EffectEvidence[]> {
    this.ensureRunIndex();
    const where = { runId, ...(filter.application ? { application: filter.application } : {}), ...(filter.tenantId ? { tenantId: filter.tenantId } : {}) };
    // Bounded queries at the storage boundary, answered from the runId hash index.
    return boundedFind<EffectEvidence>(this.db, EVIDENCE_COLLECTION, where, filter.limit);
  }

  private runIndexed = false;

  /**
   * Declare the hash index on `runId` the first time it is needed. A managed
   * authority declares it from the Flow contract (`run_idx`) instead; a
   * runtime that refuses the declaration still answers the bounded query.
   */
  private ensureRunIndex(): void {
    if (this.runIndexed) return;
    this.runIndexed = true;
    try {
      if (!this.collection.listIndexes().some((index) => index.field === 'runId')) {
        this.collection.createIndex({ name: 'run_idx', type: 'hash', field: 'runId' });
      }
    } catch { /* the bounded query is still correct without the index */ }
  }
}

export function evidenceCollectionName(): string {
  return EVIDENCE_COLLECTION;
}
