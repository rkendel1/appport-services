import {
  ConditionalConflictError,
  type StateFirstDB,
} from '@feltdb/core';

import type {
  WebhookEndpoint,
  WebhookDelivery,
  WebhookAuditEvent,
  WebhookIntegration,
  WebhookDeliveryStatus,
} from '../webhooks/models.js';
import { boundedFind } from './bounded.js';

const WEBHOOK_ENDPOINTS_COLLECTION = 'webhook_endpoints';
const WEBHOOK_DELIVERIES_COLLECTION = 'webhook_deliveries';
const WEBHOOK_AUDIT_COLLECTION = 'webhook_audit_events';
const WEBHOOK_INTEGRATIONS_COLLECTION = 'webhook_integrations';
const INBOUND_WEBHOOK_EVENTS_COLLECTION = 'inbound_webhook_events';

export interface WebhookIntegrationStore {
  create(integration: WebhookIntegration): Promise<void>;
  get(id: string): Promise<WebhookIntegration | null>;
  list(tenantId: string): Promise<readonly WebhookIntegration[]>;
  /** Compare-and-set: null when another writer moved the record past expectedVersion. Optional for older stores. */
  update?(id: string, expectedVersion: number, changes: Partial<Omit<WebhookIntegration, 'id' | 'tenantId' | 'applicationId' | 'provider' | 'principalId' | 'createdAt' | 'createdBy' | '__version'>>): Promise<WebhookIntegration | null>;
}

/** The identity of one inbound event, as the receiver first saw it. */
export interface InboundEventIdentity {
  readonly id: string;
  readonly integrationId: string;
  readonly provider: string;
  readonly eventId: string;
  readonly eventTimestamp: string;
  readonly acceptedAt: string;
  readonly tenantId: string;
}

/**
 * The processing state of one inbound event (durable). Receiving and processing are distinct:
 *   processing  a handler attempt holds it until `leaseUntil` (a crashed attempt's lease expires)
 *   failed      the last attempt failed; the next delivery runs it again
 *   processed   a handler completed; recorded only after it did
 *   dead        failed `maxAttempts` times: refused (poisoned) until an operator releases it
 * A record without `state` was written before this lifecycle existed and counts as processed.
 */
export type InboundEventState = 'processing' | 'failed' | 'processed' | 'dead';

export interface InboundEventRecord extends InboundEventIdentity {
  readonly state?: InboundEventState;
  readonly attempts?: number;
  readonly leaseUntil?: string;
  readonly lastAttemptAt?: string;
  readonly processedAt?: string;
  readonly deadAt?: string;
  /** The most recent failures, newest last (at most 10): when, and the handler's error message (bounded). */
  readonly failures?: readonly { readonly at: string; readonly attempt: number; readonly error: string }[];
  readonly __version?: number;
}

export type InboundClaim =
  | { readonly outcome: 'claimed'; readonly attempt: number; readonly version: number }
  | { readonly outcome: 'processed' | 'in_progress' | 'poisoned' };

/** Inbound event identities and their processing state. Durable, so replay protection survives restart. */
export interface InboundWebhookReplayStore {
  /** Returns false when the event identity was already accepted. (The single-step form; `claim` supersedes it.) */
  accept(record: InboundEventIdentity): Promise<boolean>;
  /** Start a processing attempt: claimed (run the handler), or why not. */
  claim?(record: InboundEventIdentity, options: { readonly now: Date; readonly leaseMs: number; readonly maxAttempts: number }): Promise<InboundClaim>;
  /** The attempt's handler completed: processed. False when the attempt no longer holds the record. */
  complete?(id: string, version: number, at: Date): Promise<boolean>;
  /** The attempt's handler failed: failed, or dead after `maxAttempts`. */
  fail?(id: string, version: number, at: Date, error: string, maxAttempts: number): Promise<'failed' | 'dead' | 'lost'>;
  /** Events of an integration, newest first, optionally in one state. */
  list?(tenantId: string, filter: { readonly integrationId: string; readonly state?: InboundEventState; readonly limit: number }): Promise<readonly InboundEventRecord[]>;
  /** An operator releases a dead event: the next delivery runs it again (with a fresh attempt budget). */
  release?(id: string): Promise<InboundEventRecord | null>;
}

export interface WebhookEndpointStore {
  create(endpoint: WebhookEndpoint): Promise<void>;
  get(id: string): Promise<WebhookEndpoint | null>;
  list(tenantId: string): Promise<readonly WebhookEndpoint[]>;
  disable(
    id: string,
    expectedVersion: number,
    disabledAt: string,
  ): Promise<WebhookEndpoint | null>;
}

export interface WebhookDeliveryStore {
  create(delivery: WebhookDelivery): Promise<void>;
  createMultiple(deliveries: readonly WebhookDelivery[]): Promise<void>;
  get(id: string): Promise<WebhookDelivery | null>;
  list(
    tenantId: string,
    endpointId?: string,
    limit?: number,
  ): Promise<readonly WebhookDelivery[]>;
  /**
   * At most `limit` deliveries of a tenant matching the filter, answered by a
   * bounded query at the storage boundary. Optional for custom stores; without
   * it reads fall back to `list` and are bounded in memory.
   */
  page?(
    tenantId: string,
    filter: { readonly endpointId?: string; readonly status?: WebhookDeliveryStatus },
    limit: number,
  ): Promise<readonly WebhookDelivery[]>;
  claim(
    id: string,
    expectedVersion: number,
  ): Promise<WebhookDelivery | null>;
  updateDelivery(
    id: string,
    expectedVersion: number,
    updates: Partial<WebhookDelivery>,
  ): Promise<WebhookDelivery | null>;
}

export interface WebhookAuditSink {
  record(event: WebhookAuditEvent): Promise<void>;
}

export class FeltDbWebhookEndpointStore implements WebhookEndpointStore {
  private readonly endpoints;

  constructor(private readonly db: StateFirstDB) {
    this.endpoints = db.collection<WebhookEndpoint>(WEBHOOK_ENDPOINTS_COLLECTION);
  }

  async create(endpoint: WebhookEndpoint): Promise<void> {
    await this.db.transaction({
      operations: [
        {
          collection: WEBHOOK_ENDPOINTS_COLLECTION,
          id: endpoint.id,
          requireAbsent: true,
          value: { ...endpoint },
        },
      ],
    });
  }

  async get(id: string): Promise<WebhookEndpoint | null> {
    return this.endpoints.get(id);
  }

  async list(tenantId: string): Promise<readonly WebhookEndpoint[]> {
    return this.endpoints.find({ tenantId });
  }

  async disable(
    id: string,
    expectedVersion: number,
    disabledAt: string,
  ): Promise<WebhookEndpoint | null> {
    const result = await this.endpoints.updateIfVersion(id, expectedVersion, {
      disabledAt,
    });
    return result.updated ? (result.item ?? null) : null;
  }
}

export class FeltDbWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly deliveries;

  constructor(private readonly db: StateFirstDB) {
    this.deliveries = db.collection<WebhookDelivery>(WEBHOOK_DELIVERIES_COLLECTION);
  }

  async create(delivery: WebhookDelivery): Promise<void> {
    await this.db.transaction({
      operations: [
        {
          collection: WEBHOOK_DELIVERIES_COLLECTION,
          id: delivery.id,
          requireAbsent: true,
          value: { ...delivery },
        },
      ],
    });
  }

  async createMultiple(deliveries: readonly WebhookDelivery[]): Promise<void> {
    if (deliveries.length === 0) return;

    await this.db.transaction({
      operations: deliveries.map((delivery) => ({
        collection: WEBHOOK_DELIVERIES_COLLECTION,
        id: delivery.id,
        requireAbsent: true,
        value: { ...delivery },
      })),
    });
  }

  async get(id: string): Promise<WebhookDelivery | null> {
    return this.deliveries.get(id);
  }

  async list(
    tenantId: string,
    endpointId?: string,
    limit?: number,
  ): Promise<readonly WebhookDelivery[]> {
    const query: Record<string, unknown> = { tenantId };
    if (endpointId) {
      query.endpointId = endpointId;
    }
    const results = await this.deliveries.find(query);
    if (limit) {
      return results.slice(0, limit);
    }
    return results;
  }

  async page(
    tenantId: string,
    filter: { readonly endpointId?: string; readonly status?: WebhookDeliveryStatus },
    limit: number,
  ): Promise<readonly WebhookDelivery[]> {
    const where = { tenantId, ...(filter.endpointId ? { endpointId: filter.endpointId } : {}), ...(filter.status ? { status: filter.status } : {}) };
    return boundedFind<WebhookDelivery>(this.db, WEBHOOK_DELIVERIES_COLLECTION, where, limit);
  }

  async claim(
    id: string,
    expectedVersion: number,
  ): Promise<WebhookDelivery | null> {
    const now = new Date().toISOString();
    const result = await this.deliveries.updateIfVersion(id, expectedVersion, {
      status: 'delivering',
      lastAttemptAt: now,
    });
    return result.updated ? (result.item ?? null) : null;
  }

  async updateDelivery(
    id: string,
    expectedVersion: number,
    updates: Partial<WebhookDelivery>,
  ): Promise<WebhookDelivery | null> {
    const result = await this.deliveries.updateIfVersion(id, expectedVersion, updates);
    return result.updated ? (result.item ?? null) : null;
  }
}

export class FeltDbWebhookAuditSink implements WebhookAuditSink {
  private readonly auditCollection;

  constructor(db: StateFirstDB) {
    this.auditCollection = db.collection<WebhookAuditEvent>(WEBHOOK_AUDIT_COLLECTION);
  }

  async record(event: WebhookAuditEvent): Promise<void> {
    await this.auditCollection.insert({ ...event }, event.id);
  }
}

export function webhookAuditCollectionName(): string {
  return WEBHOOK_AUDIT_COLLECTION;
}

export function isConditionalConflict(error: unknown): error is ConditionalConflictError {
  return error instanceof ConditionalConflictError;
}

export class FeltDbWebhookIntegrationStore implements WebhookIntegrationStore {
  private readonly integrations;

  constructor(private readonly db: StateFirstDB) {
    this.integrations = db.collection<WebhookIntegration>(WEBHOOK_INTEGRATIONS_COLLECTION);
  }

  async create(integration: WebhookIntegration): Promise<void> {
    await this.db.transaction({ operations: [{ collection: WEBHOOK_INTEGRATIONS_COLLECTION, id: integration.id, requireAbsent: true, value: { ...integration } }] });
  }

  get(id: string): Promise<WebhookIntegration | null> {
    return this.integrations.get(id);
  }

  list(tenantId: string): Promise<readonly WebhookIntegration[]> {
    return this.integrations.find({ tenantId });
  }

  async update(id: string, expectedVersion: number, changes: Parameters<NonNullable<WebhookIntegrationStore['update']>>[2]): Promise<WebhookIntegration | null> {
    const result = await this.integrations.updateIfVersion(id, expectedVersion, { ...changes });
    return result.updated ? (result.item ?? null) : null;
  }
}

export class FeltDbInboundWebhookReplayStore implements InboundWebhookReplayStore {
  private readonly events;

  constructor(private readonly db: StateFirstDB) {
    this.events = db.collection<InboundEventRecord & { __version: number }>(INBOUND_WEBHOOK_EVENTS_COLLECTION);
  }

  async accept(record: InboundEventIdentity): Promise<boolean> {
    try {
      await this.db.transaction({ operations: [{ collection: INBOUND_WEBHOOK_EVENTS_COLLECTION, id: record.id, requireAbsent: true, value: { ...record, state: 'processed', processedAt: record.acceptedAt } }] });
      return true;
    } catch (error) {
      if (error instanceof ConditionalConflictError) return false;
      throw error;
    }
  }

  async claim(record: InboundEventIdentity, options: { now: Date; leaseMs: number; maxAttempts: number }): Promise<InboundClaim> {
    const now = options.now.getTime();
    const leaseUntil = new Date(now + options.leaseMs).toISOString();
    const lastAttemptAt = options.now.toISOString();
    for (let round = 0; round < 3; round++) {
      const current = await this.events.get(record.id);
      if (!current) {
        try {
          await this.db.transaction({ operations: [{ collection: INBOUND_WEBHOOK_EVENTS_COLLECTION, id: record.id, requireAbsent: true, value: { ...record, state: 'processing', attempts: 1, leaseUntil, lastAttemptAt } }] });
          return { outcome: 'claimed', attempt: 1, version: 1 };
        } catch (error) {
          if (error instanceof ConditionalConflictError) continue; // another receiver created it: read it again
          throw error;
        }
      }
      if (!current.state || current.state === 'processed') return { outcome: 'processed' };
      if (current.state === 'dead') return { outcome: 'poisoned' };
      if (current.state === 'processing' && current.leaseUntil && Date.parse(current.leaseUntil) > now) return { outcome: 'in_progress' };
      // Failed, or an attempt whose lease expired (its process stopped): another attempt, if any are left.
      const attempts = current.attempts ?? 1;
      if (attempts >= options.maxAttempts) {
        const dead = await this.events.updateIfVersion(record.id, current.__version, { state: 'dead', deadAt: lastAttemptAt, leaseUntil: undefined });
        if (dead.updated) return { outcome: 'poisoned' };
        continue;
      }
      const next = await this.events.updateIfVersion(record.id, current.__version, { state: 'processing', attempts: attempts + 1, leaseUntil, lastAttemptAt });
      if (next.updated && next.item) return { outcome: 'claimed', attempt: attempts + 1, version: next.item.__version };
    }
    return { outcome: 'in_progress' };
  }

  async complete(id: string, version: number, at: Date): Promise<boolean> {
    const result = await this.events.updateIfVersion(id, version, { state: 'processed', processedAt: at.toISOString(), leaseUntil: undefined });
    return result.updated;
  }

  async fail(id: string, version: number, at: Date, error: string, maxAttempts: number): Promise<'failed' | 'dead' | 'lost'> {
    const current = await this.events.get(id);
    if (!current || current.__version !== version) return 'lost';
    const attempts = current.attempts ?? 1;
    const failures = [...(current.failures ?? []), { at: at.toISOString(), attempt: attempts, error: error.slice(0, 500) }].slice(-10);
    const state = attempts >= maxAttempts ? 'dead' : 'failed';
    const result = await this.events.updateIfVersion(id, version, { state, failures, leaseUntil: undefined, ...(state === 'dead' ? { deadAt: at.toISOString() } : {}) });
    return result.updated ? state : 'lost';
  }

  async list(tenantId: string, filter: { integrationId: string; state?: InboundEventState; limit: number }): Promise<readonly InboundEventRecord[]> {
    const rows = await this.events.find({ tenantId, integrationId: filter.integrationId, ...(filter.state ? { state: filter.state } : {}) });
    return [...rows].sort((a, b) => (a.acceptedAt < b.acceptedAt ? 1 : a.acceptedAt > b.acceptedAt ? -1 : 0)).slice(0, filter.limit);
  }

  async release(id: string): Promise<InboundEventRecord | null> {
    const current = await this.events.get(id);
    if (!current || current.state !== 'dead') return current ?? null;
    const result = await this.events.updateIfVersion(id, current.__version, { state: 'failed', attempts: 0, deadAt: undefined });
    return result.updated ? (result.item ?? null) : null;
  }
}
