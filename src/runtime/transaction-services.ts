import { TransactionBuilder, TransactionCollectionImpl, type AppPortTransactionCollection, type TransactionOperation } from './transaction.js';
import { consumeExecutionContext, type ServiceExecutionContext } from '../authority/context.js';
import { ServiceAuthorityError } from '../authority/errors.js';
import { evidenceCollectionName } from '../authority/evidence.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { toDurablePrincipal } from '../authority/principal.js';
import { assertApplicationCollection } from '../authority/reserved.js';
import { assertNoCredentials } from '../notifications/sensitive.js';
import type { WebhookEndpoint } from '../webhooks/models.js';

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
  private readonly pending: Promise<void>[] = [];

  constructor(
    builder: TransactionBuilder,
    private readonly gateway?: ServiceGateway,
    /** Registered endpoints for a tenant; used to validate caller-supplied endpoint ids. */
    private readonly endpoints?: (tenantId: string) => Promise<readonly WebhookEndpoint[]>,
  ) {
    this.builder = builder;
  }

  /** @internal Wait for queued validations. The transaction commits only after this resolves. */
  async _settle(): Promise<void> {
    await Promise.all(this.pending);
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
   * Queue deliveries of an event to the given endpoints. Each id must be a
   * registered, enabled endpoint of this tenant and application that
   * subscribes to the event; ids are validated before the transaction
   * commits, so callers cannot target arbitrary destinations.
   */
  queueWebhookDeliveries(
    endpointIds: readonly string[],
    event: { tenantId: string; type: string; payload: unknown },
    context: ServiceExecutionContext,
  ): Promise<void> {
    const authorized = this.authorized(context, 'webhooks.emit', event.tenantId, 'webhook_event');
    if (authorized.resource.attributes?.eventType !== event.type) {
      throw new ServiceAuthorityError('DENIED', `Execution context was not issued for event ${event.type}`);
    }
    if (!this.endpoints) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Transactions cannot validate webhook endpoints without the webhook service');
    const lookup = this.endpoints;
    const work = (async () => {
      const registered = await lookup(event.tenantId);
      for (const endpointId of endpointIds) {
        const endpoint = registered.find((candidate) => candidate.id === endpointId);
        if (!endpoint || endpoint.tenantId !== event.tenantId || endpoint.applicationId !== authorized.application || endpoint.disabledAt || !endpoint.events.includes(event.type)) {
          throw new ServiceAuthorityError('DENIED', `Endpoint ${endpointId} is not a registered, enabled subscriber to ${event.type} for this tenant`);
        }
      }
      this.addDeliveries(endpointIds, event, authorized);
    })();
    // Handled here so an abandoned transaction cannot raise an unhandled rejection; _settle still observes it.
    work.catch(() => undefined);
    this.pending.push(work);
    return work;
  }

  private addDeliveries(endpointIds: readonly string[], event: { tenantId: string; type: string; payload: unknown }, authorized: ServiceExecutionContext): void {
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
    if (authorized.resource.attributes?.jobType !== input.type) {
      throw new ServiceAuthorityError('DENIED', `Execution context was not issued for job type ${input.type}`);
    }
    // The delegation must be the one AuthBoundry authorized, never chosen afterwards.
    const delegationId = authorized.resource.attributes?.delegationId ?? authorized.principal.delegationId;
    if (input.delegationId !== undefined && input.delegationId !== delegationId) {
      throw new ServiceAuthorityError('DENIED', 'Execution context was not issued for this delegation');
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
      applicationId: authorized.application,
      principal: toDurablePrincipal(authorized.principal, delegationId, authorized.authorization.decisionId),
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
    source?: { type: string; id?: string; eventId?: string };
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  }, context: ServiceExecutionContext): string {
    const authorized = this.authorized(context, 'notifications.send', input.tenantId, 'notification');
    if (authorized.resource.attributes?.recipient !== input.recipient) {
      throw new ServiceAuthorityError('DENIED', 'Execution context was not issued for this recipient');
    }
    assertNoCredentials(input.title, 'title');
    if (input.body !== undefined) assertNoCredentials(input.body, 'body');
    if (input.data !== undefined) assertNoCredentials(input.data, 'data');
    if (input.source !== undefined) assertNoCredentials(input.source, 'source');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const notification = {
      id,
      tenantId: input.tenantId,
      applicationId: authorized.application,
      recipient: input.recipient,
      type: input.type,
      title: input.title,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.data === undefined ? {} : { data: input.data }),
      ...(input.source === undefined ? {} : { source: input.source }),
      priority: input.priority ?? 'normal',
      channels: ['in-app'],
      status: 'delivered' as const,
      createdAt: now,
      createdBy: authorized.principal.principalId,
      deliveredAt: now,
      __version: 1,
    };
    this.builder.addOperation({ collection: 'notifications', id, requireAbsent: true, value: notification });
    const deliveryId = crypto.randomUUID();
    this.builder.addOperation({
      collection: 'notification_deliveries',
      id: deliveryId,
      requireAbsent: true,
      value: {
        id: deliveryId,
        tenantId: input.tenantId,
        notificationId: id,
        recipient: input.recipient,
        channel: 'in-app',
        status: 'delivered',
        idempotencyKey: `${id}:in-app`,
        attemptCount: 1,
        maxAttempts: 1,
        createdAt: now,
        lastAttemptAt: now,
        deliveredAt: now,
        __version: 1,
      },
    });
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
