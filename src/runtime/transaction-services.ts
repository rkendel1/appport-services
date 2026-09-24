import { TransactionBuilder, TransactionCollectionImpl, type AppPortTransactionCollection, type TransactionOperation } from './transaction.js';
import { consumeExecutionContext, type ServiceExecutionContext } from '../authority/context.js';
import { ServiceAuthorityError } from '../authority/errors.js';
import { evidenceCollectionName } from '../authority/evidence.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { toDurablePrincipal } from '../authority/principal.js';
import { assertApplicationCollection } from '../authority/reserved.js';

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

  constructor(builder: TransactionBuilder, private readonly gateway?: ServiceGateway) {
    this.builder = builder;
  }

  /**
   * AppPort effects queued in a transaction need a gateway-issued execution
   * context (from `authorize()`) for the matching capability. The context is
   * single-use and its evidence commits atomically with the effect.
   */
  private authorized(context: unknown, capability: string, tenantId: string, resourceType: string): ServiceExecutionContext {
    if (!this.gateway) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Transactions have no AuthBoundry authority configured');
    const authorized = consumeExecutionContext(context, capability, tenantId);
    if (authorized.resource.type !== resourceType) throw new ServiceAuthorityError('DENIED', `Execution context was issued for a ${authorized.resource.type}, not a ${resourceType}`);
    const evidence = this.gateway.evidenceFor(authorized, { service: 'transaction' }, crypto.randomUUID(), new Date().toISOString(), 'succeeded');
    this.builder.addOperation({ collection: evidenceCollectionName(), id: evidence.id, requireAbsent: true, value: { ...evidence } });
    return authorized;
  }

  /**
   * Add a FeltDB transaction operation.
   *
   * Use this for application-owned state or custom collection operations.
   * The operation will be executed as part of the atomic transaction.
   */
  addOperation(op: TransactionOperation): void {
    assertApplicationCollection(op.collection);
    this.builder.addOperation(op);
  }

  /**
   * Get a FeltDB collection for use within this transaction.
   *
   * Operations on this collection are queued for atomic execution.
   */
  collection<T extends Record<string, unknown>>(name: string): AppPortTransactionCollection<T> {
    assertApplicationCollection(name);
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
    context: ServiceExecutionContext,
  ): void {
    const authorized = this.authorized(context, 'webhooks.emit', event.tenantId, 'webhook_event');
    if (authorized.resource.attributes?.eventType !== undefined && authorized.resource.attributes.eventType !== event.type) {
      throw new ServiceAuthorityError('DENIED', `Execution context was issued for event ${authorized.resource.attributes.eventType}`);
    }
    const eventId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    for (const endpointId of endpointIds) {
      const delivery = {
        id: crypto.randomUUID(),
        tenantId: event.tenantId,
        endpointId,
        eventId,
        eventType: event.type,
        payload: event.payload,
        status: 'pending' as const,
        attemptCount: 0,
        nextAttemptAt: createdAt,
        createdAt,
        principal: toDurablePrincipal(authorized.principal, undefined, authorized.authorization.decisionId),
        __version: 1,
      };

      this.builder.addOperation({
        collection: 'webhook_deliveries',
        id: delivery.id,
        requireAbsent: true,
        value: delivery,
      });
    }

    // Audit record
    this.builder.addOperation({
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
    delegationId?: string;
  }, context: ServiceExecutionContext): string {
    const authorized = this.authorized(context, 'jobs.create', input.tenantId, 'job');
    if (authorized.resource.attributes?.jobType !== undefined && authorized.resource.attributes.jobType !== input.type) {
      throw new ServiceAuthorityError('DENIED', `Execution context was issued for job type ${authorized.resource.attributes.jobType}`);
    }
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
      principal: toDurablePrincipal(authorized.principal, input.delegationId ?? authorized.principal.delegationId, authorized.authorization.decisionId),
      __version: 1,
    };

    this.builder.addOperation({
      collection: 'jobs',
      id: job.id,
      requireAbsent: true,
      value: job,
    });

    // Audit record
    this.builder.addOperation({
      collection: 'job_audit_events',
      id: crypto.randomUUID(),
      requireAbsent: true,
      value: {
        id: crypto.randomUUID(),
        type: 'job.enqueued',
        jobId: job.id,
        tenantId: job.tenantId,
        jobType: job.type,
        principalId: authorized.principal.principalId,
        timestamp: now,
        result: 'success',
      },
    });

    return id;
  }

  queueNotification(input: {
    tenantId: string;
    recipient: string;
    type: string;
    title: string;
    body?: string;
    data?: Record<string, unknown>;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  }, context: ServiceExecutionContext): string {
    const authorized = this.authorized(context, 'notifications.send', input.tenantId, 'notification');
    if (authorized.resource.attributes?.recipient !== undefined && authorized.resource.attributes.recipient !== input.recipient) {
      throw new ServiceAuthorityError('DENIED', 'Execution context was issued for a different recipient');
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const notification = { ...input, id, priority: input.priority ?? 'normal', createdAt: now, __version: 1 };
    this.builder.addOperation({ collection: 'notifications', id, requireAbsent: true, value: notification });
    const auditId = crypto.randomUUID();
    this.builder.addOperation({
      collection: 'notification_audit_events',
      id: auditId,
      requireAbsent: true,
      value: { id: auditId, type: 'notification.created', notificationId: id, tenantId: input.tenantId, recipient: input.recipient, principalId: authorized.principal.principalId, timestamp: now, result: 'success' },
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
