import type { StateFirstDB } from '@feltdb/core';

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
}

export function evidenceCollectionName(): string {
  return EVIDENCE_COLLECTION;
}
