import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

import type {
  CreateWebhookEndpointInput,
  DisableWebhookEndpointInput,
  EmitWebhookEventInput,
  InboundWebhookEvent,
  InboundWebhookRequest,
  InboundWebhookResult,
  RegisterWebhookIntegrationInput,
  WebhookDelivery,
  WebhookDeliveryResult,
  WebhookEndpoint,
  WebhookIntegration,
} from './models.js';
import type {
  InboundWebhookReplayStore,
  WebhookAuditSink,
  WebhookDeliveryStore,
  WebhookEndpointStore,
  WebhookIntegrationStore,
} from '../storage/webhooks.js';
import { signWebhookPayload, signingSecretValue, verifyWebhookSignature } from './secrets.js';
import type { ServiceExecutionContext } from '../authority/context.js';
import { requireCredentialRef } from '../authority/credentials.js';
import { validateDestination, type ValidatedDestination, type WebhookDestinationPolicy } from '../authority/destination.js';
import { ServiceAuthorityError, ServiceMigrationError, isServiceAuthorityError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { mintVerifiedPrincipal, rejectCallerActor, toDurablePrincipal, requireVerifiedPrincipal, resolveTenant, type VerifiedPrincipal } from '../authority/principal.js';

const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 5000;
const DEFAULT_INBOUND_TOLERANCE_MS = 5 * 60 * 1000;
const PROVIDER = /^[a-z][a-z0-9_-]{0,63}$/;

export interface InboundWebhookHandlerInput {
  readonly event: InboundWebhookEvent;
  /** The integration principal. The payload never chooses this. */
  readonly principal: VerifiedPrincipal;
  readonly context: ServiceExecutionContext;
}

export type InboundWebhookHandler = (input: InboundWebhookHandlerInput) => unknown | Promise<unknown>;

interface WebhookServiceOptions {
  readonly endpointStore: WebhookEndpointStore;
  readonly deliveryStore: WebhookDeliveryStore;
  readonly auditSink: WebhookAuditSink;
  readonly integrationStore?: WebhookIntegrationStore;
  readonly replayStore?: InboundWebhookReplayStore;
  /** Policy Enforcement Point. Without it, every webhook effect fails closed. */
  readonly authority?: ServiceGateway;
  readonly destinationPolicy?: WebhookDestinationPolicy;
  readonly now?: () => Date;
  readonly maxRetryAttempts?: number;
  readonly requestTimeoutMs?: number;
  readonly allowedEvents?: readonly string[];
  readonly inboundToleranceMs?: number;
  /** @deprecated Signing secrets are held in AuthBoundry custody; passing a local secret store is rejected. */
  readonly secretStore?: unknown;
}

export class WebhookService {
  private readonly endpointStore: WebhookEndpointStore;
  private readonly deliveryStore: WebhookDeliveryStore;
  private readonly auditSink: WebhookAuditSink;
  private readonly now: () => Date;
  private readonly maxRetryAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly allowedEvents?: ReadonlySet<string>;
  private readonly inboundHandlers = new Map<string, InboundWebhookHandler>();

  constructor(private readonly options: WebhookServiceOptions) {
    if (options.secretStore !== undefined) {
      throw new ServiceMigrationError('WebhookService no longer keeps signing secrets. Register them with AuthBoundry and pass signingCredentialRef per endpoint.');
    }
    this.endpointStore = options.endpointStore;
    this.deliveryStore = options.deliveryStore;
    this.auditSink = options.auditSink;
    this.now = options.now ?? (() => new Date());
    this.maxRetryAttempts = options.maxRetryAttempts ?? MAX_RETRY_ATTEMPTS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.allowedEvents = options.allowedEvents?.length ? new Set(options.allowedEvents) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Outbound endpoints
  // ---------------------------------------------------------------------------

  /** Register a destination bound to a signing credential reference. */
  async createWebhookEndpoint(input: CreateWebhookEndpointInput, caller: VerifiedPrincipal): Promise<WebhookEndpoint> {
    const principal = requireVerifiedPrincipal(caller);
    if ((input as { secret?: unknown }).secret !== undefined) throw new ServiceMigrationError('Webhook signing secrets are not accepted; pass signingCredentialRef.');
    rejectCallerActor(input, principal);
    const tenantId = resolveTenant(input, principal);
    if (typeof input.url !== 'string') throw new ServiceAuthorityError('INVALID_REQUEST', 'url must be a string');
    if (!Array.isArray(input.events) || input.events.some((event) => typeof event !== 'string' || !event)) {
      throw new ServiceAuthorityError('INVALID_REQUEST', 'events must be an array of event names');
    }
    const credentialRef = requireCredentialRef(input.signingCredentialRef, 'signingCredentialRef');
    const destination = await validateDestination(input.url, this.options.destinationPolicy);

    return this.gateway().execute('webhooks.register', principal,
      { type: 'webhook_endpoint', tenantId, attributes: { destination: destination.url.origin, credentialRef } },
      { service: 'webhooks', credentialRef },
      async (context) => {
        const createdAt = this.now().toISOString();
        const endpoint: WebhookEndpoint = {
          id: randomUUID(),
          tenantId,
          applicationId: context.application,
          url: destination.url.toString(),
          events: [...input.events],
          signingCredentialRef: credentialRef,
          createdAt,
          createdBy: principal.principalId,
          __version: 1,
        };
        await this.endpointStore.create(endpoint);
        await this.audit({ type: 'webhook.endpoint.created', endpointId: endpoint.id, tenantId, principalId: principal.principalId, result: 'success' });
        return endpoint;
      });
  }

  /** Observation API for trusted operators; applications read through invoke('webhooks.read'). */
  async getWebhookEndpoint(tenantId: string, id: string): Promise<WebhookEndpoint | null> {
    const endpoint = await this.endpointStore.get(id);
    if (!endpoint || endpoint.tenantId !== tenantId) {
      return null;
    }
    return endpoint;
  }

  /** Observation API for trusted operators; applications read through invoke('webhooks.read'). */
  async listWebhookEndpoints(tenantId: string): Promise<readonly WebhookEndpoint[]> {
    return this.endpointStore.list(tenantId);
  }

  async disableWebhookEndpoint(input: DisableWebhookEndpointInput, caller: VerifiedPrincipal): Promise<WebhookEndpoint | null> {
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor(input, principal);
    const tenantId = resolveTenant(input, principal);
    const endpoint = await this.getWebhookEndpoint(tenantId, input.id);
    if (!endpoint) return null;
    if (endpoint.disabledAt) return endpoint;

    return this.gateway().execute('webhooks.remove', principal,
      { type: 'webhook_endpoint', tenantId, id: endpoint.id },
      { service: 'webhooks' },
      async () => {
        const disabledAt = this.now().toISOString();
        const updated = await this.endpointStore.disable(endpoint.id, endpoint.__version, disabledAt);
        if (updated) {
          await this.audit({ type: 'webhook.endpoint.disabled', endpointId: updated.id, tenantId, principalId: principal.principalId, result: 'success' });
        }
        return updated;
      });
  }

  /** Queue deliveries of an event to the tenant's registered endpoints. Destinations are never caller-selected. */
  async emitWebhookEvent(input: EmitWebhookEventInput, caller: VerifiedPrincipal): Promise<readonly WebhookDelivery[]> {
    const principal = requireVerifiedPrincipal(caller);
    for (const field of ['url', 'destination', 'endpointId', 'endpointIds', 'signingCredentialRef', 'credentialRef']) {
      if ((input as unknown as Record<string, unknown>)[field] !== undefined) {
        throw new ServiceAuthorityError('INVALID_REQUEST', `"${field}" cannot be chosen when emitting; deliveries go only to registered, credential-bound destinations`);
      }
    }
    const tenantId = resolveTenant(input, principal);
    if (this.allowedEvents && !this.allowedEvents.has(input.type)) {
      throw new ServiceAuthorityError('INVALID_REQUEST', `Webhook event "${input.type}" is not declared in appport.toml`);
    }

    return this.gateway().execute('webhooks.emit', principal,
      { type: 'webhook_event', tenantId, attributes: { eventType: input.type } },
      { service: 'webhooks' },
      async (context) => {
        const endpoints = await this.endpointStore.list(tenantId);
        const matching = endpoints.filter((endpoint) => !endpoint.disabledAt && endpoint.events.includes(input.type));
        if (matching.length === 0) return [];
        const eventId = randomUUID();
        const createdAt = this.now().toISOString();
        const deliveries: WebhookDelivery[] = matching.map((endpoint) => ({
          id: randomUUID(),
          tenantId,
          endpointId: endpoint.id,
          eventId,
          eventType: input.type,
          payload: input.payload,
          status: 'pending',
          attemptCount: 0,
          createdAt,
          principal: toDurablePrincipal(principal, undefined, context.authorization.decisionId),
          __version: 1,
        }));
        await this.deliveryStore.createMultiple(deliveries);
        for (const delivery of deliveries) {
          await this.audit({ type: 'webhook.delivery.created', deliveryId: delivery.id, endpointId: delivery.endpointId, tenantId, principalId: principal.principalId, result: 'success' });
        }
        return deliveries;
      });
  }

  async getWebhookDelivery(tenantId: string, id: string): Promise<WebhookDelivery | null> {
    const delivery = await this.deliveryStore.get(id);
    if (!delivery || delivery.tenantId !== tenantId) {
      return null;
    }
    return delivery;
  }

  async listWebhookDeliveries(tenantId: string, endpointId?: string, limit?: number): Promise<readonly WebhookDelivery[]> {
    return this.deliveryStore.list(tenantId, endpointId, limit);
  }

  /**
   * Deliver one queued webhook. Each attempt is authorized as the durable
   * principal that emitted the event, before the signing credential is
   * resolved and before any network access.
   */
  async deliverWebhook(tenantId: string, deliveryId: string): Promise<WebhookDeliveryResult> {
    const delivery = await this.deliveryStore.get(deliveryId);
    if (!delivery) return { success: false, error: 'Delivery not found', code: 'INVALID_REQUEST' };
    if (delivery.tenantId !== tenantId) return { success: false, error: 'Tenant mismatch', code: 'DENIED' };
    if (delivery.status === 'delivered' || delivery.status === 'delivering') return { success: true, statusCode: 200 };

    const endpoint = await this.endpointStore.get(delivery.endpointId);
    if (!endpoint || endpoint.tenantId !== tenantId) return { success: false, error: 'Endpoint not found', code: 'INVALID_REQUEST' };
    if (endpoint.disabledAt) {
      await this.deliveryStore.updateDelivery(deliveryId, delivery.__version, { status: 'failed', lastError: 'Endpoint is disabled' });
      return { success: false, error: 'Endpoint is disabled', code: 'INVALID_REQUEST' };
    }
    if (!delivery.principal || delivery.principal.tenantId !== tenantId) {
      await this.deliveryStore.updateDelivery(deliveryId, delivery.__version, { status: 'failed', lastError: 'DENIED: delivery has no durable execution principal' });
      await this.audit({ type: 'webhook.delivery.denied', deliveryId, endpointId: endpoint.id, tenantId, principalId: 'anonymous', result: 'failure', reason: 'anonymous' });
      return { success: false, error: 'Delivery has no durable execution principal', code: 'DENIED' };
    }
    if (!endpoint.signingCredentialRef) {
      await this.deliveryStore.updateDelivery(deliveryId, delivery.__version, { status: 'failed', lastError: 'Endpoint has no signing credential reference; re-register it' });
      return { success: false, error: 'Endpoint has no signing credential reference', code: 'INVALID_REQUEST' };
    }

    try {
      await this.gateway().attest(delivery.principal, ['webhooks.emit', 'webhooks.replay']);
    } catch (error) {
      await this.deliveryStore.updateDelivery(deliveryId, delivery.__version, { status: 'failed', lastError: `DENIED: ${error instanceof Error ? error.message : String(error)}` });
      await this.audit({ type: 'webhook.delivery.denied', deliveryId, endpointId: endpoint.id, tenantId, principalId: delivery.principal.principalId, result: 'failure', reason: 'unattested_principal' });
      return failureResult(error);
    }

    const claimed = await this.deliveryStore.claim(deliveryId, delivery.__version);
    if (!claimed) return { success: true, statusCode: 200 };

    const principal = mintVerifiedPrincipal({ ...delivery.principal, runId: `${delivery.id}:${claimed.attemptCount + 1}` }, 'delivery');
    const credentialRef = endpoint.signingCredentialRef;
    let result: WebhookDeliveryResult;
    try {
      result = await this.gateway().execute('webhooks.deliver', principal,
        { type: 'webhook_delivery', tenantId, id: delivery.id, attributes: { endpointId: endpoint.id, destination: new URL(endpoint.url).origin, eventType: delivery.eventType } },
        { service: 'webhooks', provider: 'webhook', credentialRef },
        async (_context, tools) => {
          // Re-resolve and re-check the bound destination on every attempt so a DNS change cannot redirect it.
          const destination = await validateDestination(endpoint.url, this.options.destinationPolicy);
          const payload = deliveryBody(claimed);
          const signature = await tools.withCredential(credentialRef, 'webhook.sign', (secret) => signWebhookPayload(signingSecretValue(secret.value), payload));
          const outcome = await this.performHttpDelivery(destination, claimed, payload, signature);
          if (!outcome.success) throw Object.assign(new ServiceAuthorityError('PROVIDER_ERROR', outcome.error ?? 'Webhook delivery failed'), { outcome });
          return outcome;
        });
    } catch (error) {
      result = failureResult(error);
    }
    await this.recordAttempt(claimed, result);
    return result;
  }

  async replayWebhookDelivery(tenantId: string, deliveryId: string, caller: VerifiedPrincipal): Promise<WebhookDelivery | null> {
    const principal = requireVerifiedPrincipal(caller);
    if (principal.tenantId !== tenantId) throw new ServiceAuthorityError('DENIED', 'Cross-tenant service operation denied', { reason: 'tenant_mismatch' });
    const delivery = await this.getWebhookDelivery(tenantId, deliveryId);
    if (!delivery) return null;
    const endpoint = await this.endpointStore.get(delivery.endpointId);
    if (!endpoint || endpoint.disabledAt) return null;

    return this.gateway().execute('webhooks.replay', principal,
      { type: 'webhook_delivery', tenantId, id: delivery.id, attributes: { endpointId: endpoint.id } },
      { service: 'webhooks' },
      async (context) => {
        const updated = await this.deliveryStore.updateDelivery(deliveryId, delivery.__version, {
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: undefined,
          lastAttemptAt: undefined,
          deliveredAt: undefined,
          lastStatusCode: undefined,
          lastError: undefined,
          principal: toDurablePrincipal(principal, undefined, context.authorization.decisionId),
        });
        if (updated) {
          await this.audit({ type: 'webhook.delivery.replayed', deliveryId: updated.id, endpointId: updated.endpointId, tenantId, principalId: principal.principalId, result: 'success' });
        }
        return updated;
      });
  }

  // ---------------------------------------------------------------------------
  // Inbound integrations
  // ---------------------------------------------------------------------------

  /** Register an inbound webhook source. Its principal is always integration:<provider>. */
  async registerIntegration(input: RegisterWebhookIntegrationInput, caller: VerifiedPrincipal): Promise<WebhookIntegration> {
    const principal = requireVerifiedPrincipal(caller);
    rejectCallerActor(input, principal);
    const tenantId = resolveTenant(input, principal);
    if (typeof input.provider !== 'string' || !PROVIDER.test(input.provider)) throw new ServiceAuthorityError('INVALID_REQUEST', 'provider must be a lowercase identifier');
    const credentialRef = requireCredentialRef(input.signingCredentialRef, 'signingCredentialRef');
    const store = this.requireIntegrationStore();

    return this.gateway().execute('webhooks.integrations.register', principal,
      { type: 'webhook_integration', tenantId, attributes: { provider: input.provider, credentialRef } },
      { service: 'webhooks', provider: input.provider, credentialRef },
      async (context) => {
        const integration: WebhookIntegration = {
          id: randomUUID(),
          tenantId,
          applicationId: context.application,
          provider: input.provider,
          principalId: `integration:${input.provider}`,
          signingCredentialRef: credentialRef,
          createdAt: this.now().toISOString(),
          createdBy: principal.principalId,
          __version: 1,
        };
        await store.create(integration);
        await this.audit({ type: 'webhook.integration.registered', integrationId: integration.id, tenantId, principalId: principal.principalId, result: 'success' });
        return integration;
      });
  }

  registerInboundHandler(provider: string, handler: InboundWebhookHandler): void {
    if (!PROVIDER.test(provider)) throw new Error('provider must be a lowercase identifier');
    this.inboundHandlers.set(provider, handler);
  }

  /**
   * Accept an inbound webhook. Flow: resolve the durable integration, derive
   * its principal, authorize webhooks.receive, resolve the signing credential
   * through AuthBoundry, verify the signature, durably reject replays, then
   * hand the event to the application as the integration principal.
   */
  async receiveWebhook(request: InboundWebhookRequest): Promise<InboundWebhookResult> {
    const store = this.requireIntegrationStore();
    const replay = this.options.replayStore;
    if (!replay) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Inbound webhooks require a durable replay store');
    const integration = typeof request.integrationId === 'string' ? await store.get(request.integrationId) : null;
    if (!integration || integration.disabledAt) throw new ServiceAuthorityError('NOT_FOUND', 'Webhook integration not found');

    const eventId = header(request.headers, 'x-appport-event-id');
    const timestamp = header(request.headers, 'x-appport-timestamp');
    const signature = header(request.headers, 'x-appport-signature');
    if (!eventId || !timestamp || !signature || typeof request.rawBody !== 'string') {
      throw new ServiceAuthorityError('INVALID_REQUEST', 'Inbound webhook requires event id, timestamp, signature, and body');
    }
    const sentAt = Date.parse(timestamp);
    const tolerance = this.options.inboundToleranceMs ?? DEFAULT_INBOUND_TOLERANCE_MS;
    if (!Number.isFinite(sentAt) || Math.abs(this.now().getTime() - sentAt) > tolerance) {
      await this.audit({ type: 'webhook.inbound.rejected', integrationId: integration.id, tenantId: integration.tenantId, principalId: integration.principalId, result: 'failure', reason: 'stale_timestamp' });
      throw new ServiceAuthorityError('DENIED', 'Inbound webhook timestamp is outside the accepted window', { reason: 'stale_timestamp' });
    }

    // Identity comes from the integration record only; nothing in the payload is consulted.
    const principal = mintVerifiedPrincipal({
      principalId: integration.principalId,
      principalType: 'integration',
      tenantId: integration.tenantId,
      applicationId: integration.applicationId,
    }, 'integration');

    try {
      const result = await this.gateway().execute('webhooks.receive', principal,
        { type: 'webhook_integration', tenantId: integration.tenantId, id: integration.id, attributes: { provider: integration.provider, eventId } },
        { service: 'webhooks', provider: integration.provider, credentialRef: integration.signingCredentialRef },
        async (context, tools) => {
          const valid = await tools.withCredential(integration.signingCredentialRef, 'webhook.verify',
            (secret) => verifyWebhookSignature(signingSecretValue(secret.value), `${timestamp}.${request.rawBody}`, signature));
          if (!valid) throw new ServiceAuthorityError('DENIED', 'Inbound webhook signature is invalid', { reason: 'invalid_signature' });
          const accepted = await replay.accept({
            id: createHash('sha256').update(`${integration.id}:${eventId}`).digest('hex'),
            integrationId: integration.id,
            provider: integration.provider,
            eventId,
            eventTimestamp: new Date(sentAt).toISOString(),
            acceptedAt: this.now().toISOString(),
            tenantId: integration.tenantId,
          });
          if (!accepted) throw new ServiceAuthorityError('DENIED', 'Inbound webhook event was already accepted', { reason: 'replayed' });
          let payload: unknown;
          try {
            payload = JSON.parse(request.rawBody);
          } catch {
            throw new ServiceAuthorityError('INVALID_REQUEST', 'Inbound webhook body must be JSON');
          }
          const handler = this.inboundHandlers.get(integration.provider);
          const handled = handler
            ? await handler({ event: { integrationId: integration.id, provider: integration.provider, eventId, timestamp: new Date(sentAt).toISOString(), payload }, principal, context })
            : undefined;
          return { accepted: true, eventId, ...(handled === undefined ? {} : { result: handled }) };
        });
      await this.audit({ type: 'webhook.inbound.accepted', integrationId: integration.id, tenantId: integration.tenantId, principalId: principal.principalId, result: 'success' });
      return result;
    } catch (error) {
      await this.audit({ type: 'webhook.inbound.rejected', integrationId: integration.id, tenantId: integration.tenantId, principalId: principal.principalId, result: 'failure', reason: isServiceAuthorityError(error) ? error.details.reason ?? error.code : 'handler_failed' }).catch(() => undefined);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private gateway(): ServiceGateway {
    if (!this.options.authority) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Webhooks have no AuthBoundry authority configured');
    return this.options.authority;
  }

  private requireIntegrationStore(): WebhookIntegrationStore {
    if (!this.options.integrationStore) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Inbound webhook integrations are not configured');
    return this.options.integrationStore;
  }

  private async audit(event: Omit<Parameters<WebhookAuditSink['record']>[0], 'id' | 'timestamp'>): Promise<void> {
    await this.auditSink.record({ id: randomUUID(), timestamp: this.now().toISOString(), ...event });
  }

  private async recordAttempt(claimed: WebhookDelivery, result: WebhookDeliveryResult): Promise<void> {
    const now = this.now().toISOString();
    const principalId = claimed.principal?.principalId ?? 'anonymous';
    if (result.success) {
      await this.deliveryStore.updateDelivery(claimed.id, claimed.__version, { status: 'delivered', deliveredAt: now, attemptCount: claimed.attemptCount + 1, lastStatusCode: result.statusCode });
      await this.audit({ type: 'webhook.delivery.delivered', deliveryId: claimed.id, endpointId: claimed.endpointId, tenantId: claimed.tenantId, principalId, result: 'success' });
      return;
    }
    if (result.code === 'DENIED' || result.code === 'INVALID_REQUEST') {
      await this.deliveryStore.updateDelivery(claimed.id, claimed.__version, { status: 'failed', lastError: `${result.code}: ${result.error}` });
      await this.audit({ type: result.code === 'DENIED' ? 'webhook.delivery.denied' : 'webhook.delivery.failed', deliveryId: claimed.id, endpointId: claimed.endpointId, tenantId: claimed.tenantId, principalId, result: 'failure', reason: result.code });
      return;
    }
    if (result.code === 'AUTHORITY_UNAVAILABLE' || result.code === 'AUTHORIZATION_TIMEOUT') {
      // No effect happened; retry later without consuming a provider attempt.
      await this.deliveryStore.updateDelivery(claimed.id, claimed.__version, {
        status: 'retrying',
        nextAttemptAt: new Date(this.now().getTime() + INITIAL_RETRY_DELAY_MS).toISOString(),
        lastError: `${result.code}: ${result.error}`,
      });
      return;
    }
    const isTerminal = result.statusCode !== undefined && ((result.statusCode >= 300 && result.statusCode < 400)
      || (result.statusCode >= 400 && result.statusCode < 500 && result.statusCode !== 408 && result.statusCode !== 429));
    if (isTerminal || claimed.attemptCount + 1 >= this.maxRetryAttempts) {
      await this.deliveryStore.updateDelivery(claimed.id, claimed.__version, { status: 'failed', lastError: result.error || 'Unknown error', attemptCount: claimed.attemptCount + 1, lastStatusCode: result.statusCode });
      await this.audit({ type: 'webhook.delivery.failed', deliveryId: claimed.id, endpointId: claimed.endpointId, tenantId: claimed.tenantId, principalId, result: 'failure', reason: 'PROVIDER_ERROR' });
      return;
    }
    await this.deliveryStore.updateDelivery(claimed.id, claimed.__version, {
      status: 'retrying',
      nextAttemptAt: new Date(this.now().getTime() + INITIAL_RETRY_DELAY_MS * Math.pow(2, claimed.attemptCount)).toISOString(),
      lastError: result.error || 'Unknown error',
      attemptCount: claimed.attemptCount + 1,
      lastStatusCode: result.statusCode,
    });
  }

  /**
   * POST to the validated address only. Redirects are never followed and the
   * connection is pinned to the address that passed destination policy.
   */
  private performHttpDelivery(destination: ValidatedDestination, delivery: WebhookDelivery, payload: string, signature: string): Promise<WebhookDeliveryResult> {
    const { url, address } = destination;
    const pinned: LookupFunction = (_hostname, options, callback) => {
      if ((options as { all?: boolean }).all) (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [{ address: address.address, family: address.family }]);
      else callback(null, address.address, address.family);
    };
    const client = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
      const req = client.request({
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        agent: false,
        lookup: pinned,
        ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
        headers: {
          'Content-Type': 'application/json',
          'X-AppPort-Signature': signature,
          'X-AppPort-Event-Id': delivery.eventId,
          'Content-Length': Buffer.byteLength(payload),
          Connection: 'close',
        },
        timeout: this.requestTimeoutMs,
      }, (res) => {
        res.resume();
        res.on('end', () => {
          const statusCode = res.statusCode ?? 500;
          if (statusCode >= 200 && statusCode < 300) resolve({ success: true, statusCode });
          else if (statusCode >= 300 && statusCode < 400) resolve({ success: false, statusCode, error: `HTTP ${statusCode}: redirects are not followed (destination policy)`, code: 'PROVIDER_ERROR' });
          else if (statusCode === 408 || statusCode === 429 || statusCode >= 500) resolve({ success: false, statusCode, error: `HTTP ${statusCode} (retryable)`, code: 'PROVIDER_ERROR' });
          else resolve({ success: false, statusCode, error: `HTTP ${statusCode}`, code: 'PROVIDER_ERROR' });
        });
      });
      req.on('error', (error) => resolve({ success: false, error: `Network error: ${error instanceof Error ? error.message : String(error)}`, code: 'PROVIDER_ERROR' }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Request timeout (retryable)', code: 'PROVIDER_ERROR' });
      });
      req.end(payload);
    });
  }
}

function deliveryBody(delivery: WebhookDelivery): string {
  return JSON.stringify({ id: delivery.id, eventId: delivery.eventId, type: delivery.eventType, data: delivery.payload, timestamp: delivery.createdAt });
}

function failureResult(error: unknown): WebhookDeliveryResult {
  const outcome = (error as { outcome?: WebhookDeliveryResult }).outcome;
  if (outcome) return outcome;
  if (isServiceAuthorityError(error)) {
    const code = error.code === 'UNAUTHENTICATED' || error.code === 'NOT_FOUND' ? 'DENIED' : error.code;
    return { success: false, error: error.message, code };
  }
  return { success: false, error: error instanceof Error ? error.message : String(error), code: 'PROVIDER_ERROR' };
}

function header(headers: InboundWebhookRequest['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()] ?? Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return Array.isArray(value) ? value[0] : value;
}

