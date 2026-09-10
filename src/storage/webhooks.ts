import {
  ConditionalConflictError,
  type StateFirstDB,
} from '@feltdb/core';

import type {
  WebhookEndpoint,
  WebhookDelivery,
  WebhookAuditEvent,
} from '../webhooks/models.js';

const WEBHOOK_ENDPOINTS_COLLECTION = 'webhook_endpoints';
const WEBHOOK_DELIVERIES_COLLECTION = 'webhook_deliveries';
const WEBHOOK_AUDIT_COLLECTION = 'webhook_audit_events';

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
