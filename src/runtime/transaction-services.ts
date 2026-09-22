import type { StateFirstDB } from '@feltdb/core';
import { TransactionBuilder, TransactionCollectionImpl, type AppPortTransactionCollection, type TransactionOperation } from './transaction.js';
import { assertNoCredentials } from '../notifications/sensitive.js';

/**
 * Transaction context for atomic composition of application state, webhooks, and jobs.
 *
 * Provides:
 * - Direct operation API for application-owned state
 * - Helper methods for common AppPort operations
 * - Guaranteed atomic execution (all-or-nothing)
 *
 * All operations queued via this context execute in a single FeltDB transaction.
 */
export class TransactionContextImpl {
  private readonly builder: TransactionBuilder;

  constructor(builder: TransactionBuilder) {
    this.builder = builder;
  }

  /**
   * Add a FeltDB transaction operation.
   *
   * Use this for application-owned state or custom collection operations.
   * The operation will be executed as part of the atomic transaction.
   */
  addOperation(op: TransactionOperation): void {
    this.builder.addOperation(op);
  }

  /**
   * Get a FeltDB collection for use within this transaction.
   *
   * Operations on this collection are queued for atomic execution.
   */
  collection<T extends Record<string, unknown>>(name: string): AppPortTransactionCollection<T> {
    return new TransactionCollectionImpl<T>(this.builder, name);
  }

  /**
   * Queue a webhook event emission (creates delivery records for matching endpoints).
   *
   * Note: This currently requires manually finding matching endpoints beforehand.
   * A more ergonomic API would be: `tx.webhooks.emitWebhookEvent(input)` with
   * endpoint resolution, but that requires calling the existing webhookService
   * outside the transaction.
   */
  queueWebhookDeliveries(
    endpointIds: readonly string[],
    event: { tenantId: string; type: string; payload: unknown },
  ): void {
    const createdAt = new Date().toISOString();

    for (const endpointId of endpointIds) {
      const delivery = {
        id: crypto.randomUUID(),
        tenantId: event.tenantId,
        endpointId,
        eventType: event.type,
        payload: event.payload,
        status: 'pending' as const,
        attemptCount: 0,
        nextAttemptAt: createdAt,
        createdAt,
        __version: 1,
      };

      this.addOperation({
        collection: 'webhook_deliveries',
        id: delivery.id,
        requireAbsent: true,
        value: delivery,
      });
    }

    // Audit record
    this.addOperation({
      collection: 'webhook_audit_events',
      id: crypto.randomUUID(),
      requireAbsent: true,
      value: {
        id: crypto.randomUUID(),
        type: 'webhook.event.emitted',
        tenantId: event.tenantId,
        eventType: event.type,
        timestamp: createdAt,
        result: 'success',
      },
    });
  }

  /**
   * Queue a job enqueue.
   */
  queueJob(input: {
    tenantId: string;
    type: string;
    payload: unknown;
    maxAttempts?: number;
    runAt?: string;
  }): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const runAt = input.runAt ?? now;
    const status = runAt <= now ? 'pending' : 'scheduled';

    const job = {
      id,
      tenantId: input.tenantId,
      type: input.type,
      payload: input.payload,
      status,
      runAt,
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? 3,
      nextAttemptAt: runAt,
      createdAt: now,
      __version: 1,
    };

    this.addOperation({
      collection: 'jobs',
      id: job.id,
      requireAbsent: true,
      value: job,
    });

    // Audit record
    this.addOperation({
      collection: 'job_audit_events',
      id: crypto.randomUUID(),
      requireAbsent: true,
      value: {
        id: crypto.randomUUID(),
        type: 'job.enqueued',
        jobId: job.id,
        tenantId: job.tenantId,
        jobType: job.type,
        timestamp: now,
        result: 'success',
      },
    });

    return id;
  }

  /**
   * Queue an in-app notification that commits with the surrounding transaction.
   * The durable inbox is its delivery channel, so the in-app delivery record is
   * written as delivered in the same commit. Use NotificationService.notify()
   * for other channels.
   */
  queueNotification(input: {
    tenantId: string;
    recipient: string;
    type: string;
    title: string;
    body?: string;
    data?: Record<string, unknown>;
    source?: { type: string; id?: string; eventId?: string };
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  }): string {
    assertNoCredentials(input.title, 'title');
    if (input.body !== undefined) assertNoCredentials(input.body, 'body');
    if (input.data !== undefined) assertNoCredentials(input.data, 'data');
    if (input.source !== undefined) assertNoCredentials(input.source, 'source');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const notification = {
      id, tenantId: input.tenantId, recipient: input.recipient, type: input.type, title: input.title,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      priority: input.priority ?? 'normal', channels: ['in-app'], status: 'delivered', createdAt: now, deliveredAt: now, createdBy: 'transaction', __version: 1,
    };
    this.addOperation({ collection: 'notifications', id, requireAbsent: true, value: notification });
    const deliveryId = crypto.randomUUID();
    this.addOperation({
      collection: 'notification_deliveries',
      id: deliveryId,
      requireAbsent: true,
      value: { id: deliveryId, tenantId: input.tenantId, notificationId: id, recipient: input.recipient, channel: 'in-app', status: 'delivered', idempotencyKey: `${id}:in-app`, attemptCount: 1, maxAttempts: 1, createdAt: now, lastAttemptAt: now, deliveredAt: now, __version: 1 },
    });
    const auditId = crypto.randomUUID();
    this.addOperation({
      collection: 'notification_audit_events',
      id: auditId,
      requireAbsent: true,
      value: { id: auditId, type: 'notification.created', notificationId: id, tenantId: input.tenantId, recipient: input.recipient, principalId: 'transaction', timestamp: now, result: 'success' },
    });
    return id;
  }

  /**
   * Internal: get the builder (used to commit the transaction).
   */
  _getBuilder(): TransactionBuilder {
    return this.builder;
  }
}
