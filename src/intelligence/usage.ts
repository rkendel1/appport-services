import type { StateFirstDB } from '@feltdb/core';

import { boundedFind } from '../storage/bounded.js';
import type { IntelligenceModality } from './providers.js';

const USAGE = 'intelligence_usage';

/** What a metered call is counted in. */
export type IntelligenceUsageUnit = 'audio_second' | 'token';

/**
 * One metered intelligence call: per tenant, application and environment,
 * which provider and model, how many units, and what they cost. Written in the
 * same effect as the call (its `requestId` is the evidence row's). Never the
 * input, the output, or credential material.
 */
export interface IntelligenceUsageRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environment: string;
  readonly modality: Exclude<IntelligenceModality, 'chat'>;
  readonly provider: string;
  readonly model: string;
  readonly unit: IntelligenceUsageUnit;
  /** Units consumed (seconds of audio may be fractional). */
  readonly units: number;
  /** True when the provider did not report usage and `units` is an estimate. */
  readonly estimated: boolean;
  /** Cost in millionths of `currency` (integer), from the host's price table; 0 when unpriced. */
  readonly costMicros: number;
  readonly currency: string;
  readonly priced: boolean;
  /** Inputs in the call (1 for a transcription). */
  readonly requests: number;
  readonly principalId: string;
  readonly requestId: string;
  readonly createdAt: string;
}

/**
 * A price for one provider (and optionally one model) and modality, per unit,
 * in millionths of the currency. The most specific entry wins (model before
 * provider-wide). Hosts replace the table when prices change.
 */
export interface IntelligencePrice {
  readonly provider: string;
  /** Omit for every model of the provider. */
  readonly model?: string;
  readonly modality: Exclude<IntelligenceModality, 'chat'>;
  readonly unit: IntelligenceUsageUnit;
  readonly microsPerUnit: number;
  /** Default `USD`. */
  readonly currency?: string;
}

export interface IntelligenceUsageStore {
  record(record: IntelligenceUsageRecord): Promise<void>;
  /** At most `limit` records of a tenant and application, in no particular order. */
  list(tenantId: string, applicationId: string, limit: number): Promise<readonly IntelligenceUsageRecord[]>;
}

export class FeltDbIntelligenceUsageStore implements IntelligenceUsageStore {
  constructor(private readonly db: StateFirstDB) {}

  async record(record: IntelligenceUsageRecord): Promise<void> {
    await this.db.transaction({ operations: [{ collection: USAGE, id: record.id, requireAbsent: true, value: { ...record } }] });
  }

  list(tenantId: string, applicationId: string, limit: number): Promise<readonly IntelligenceUsageRecord[]> {
    return boundedFind<IntelligenceUsageRecord>(this.db, USAGE, { tenantId, applicationId }, limit);
  }
}

export function intelligenceUsageCollectionName(): string {
  return USAGE;
}

export function priceFor(prices: readonly IntelligencePrice[], provider: string, model: string, modality: IntelligencePrice['modality'], unit: IntelligenceUsageUnit): IntelligencePrice | undefined {
  const matching = prices.filter((price) => price.provider === provider && price.modality === modality && price.unit === unit);
  return matching.find((price) => price.model === model) ?? matching.find((price) => price.model === undefined);
}

export function validatePrices(prices: readonly IntelligencePrice[]): readonly IntelligencePrice[] {
  for (const price of prices) {
    if (!price || typeof price.provider !== 'string' || !price.provider) throw new TypeError('Each intelligence price needs a provider');
    if (price.modality !== 'transcription' && price.modality !== 'embeddings') throw new TypeError('An intelligence price modality is "transcription" or "embeddings"');
    if (price.unit !== 'audio_second' && price.unit !== 'token') throw new TypeError('An intelligence price unit is "audio_second" or "token"');
    if (typeof price.microsPerUnit !== 'number' || !Number.isFinite(price.microsPerUnit) || price.microsPerUnit < 0) throw new TypeError('microsPerUnit must be a non-negative number');
  }
  return Object.freeze(prices.map((price) => Object.freeze({ ...price })));
}

/** Usage totals over a period: one row per modality, provider, model, unit and currency. */
export interface IntelligenceUsageTotal {
  readonly modality: IntelligenceUsageRecord['modality'];
  readonly provider: string;
  readonly model: string;
  readonly unit: IntelligenceUsageUnit;
  readonly currency: string;
  readonly units: number;
  readonly costMicros: number;
  /** Metered calls. */
  readonly calls: number;
  readonly estimated: boolean;
}

export interface IntelligenceUsageSummary {
  readonly tenantId: string;
  readonly environment?: string;
  readonly since?: string;
  readonly until?: string;
  readonly totals: readonly IntelligenceUsageTotal[];
  /** False when more records exist than the examination bound: the totals are then a lower bound. */
  readonly complete: boolean;
}

/** The most usage records one `usage()` call examines. */
export const INTELLIGENCE_USAGE_EXAMINATION_LIMIT = 10_000;

export function summarizeUsage(records: readonly IntelligenceUsageRecord[]): IntelligenceUsageTotal[] {
  const totals = new Map<string, { -readonly [K in keyof IntelligenceUsageTotal]: IntelligenceUsageTotal[K] }>();
  for (const record of records) {
    const key = [record.modality, record.provider, record.model, record.unit, record.currency].join('\u0000');
    const total = totals.get(key) ?? { modality: record.modality, provider: record.provider, model: record.model, unit: record.unit, currency: record.currency, units: 0, costMicros: 0, calls: 0, estimated: false };
    total.units += record.units;
    total.costMicros += record.costMicros;
    total.calls += 1;
    total.estimated = total.estimated || record.estimated;
    totals.set(key, total);
  }
  return [...totals.values()].sort((a, b) => a.modality.localeCompare(b.modality) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
}
