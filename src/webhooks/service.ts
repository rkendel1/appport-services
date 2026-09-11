import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import type {
  WebhookEndpoint,
  WebhookDelivery,
  CreateWebhookEndpointInput,
  DisableWebhookEndpointInput,
  EmitWebhookEventInput,
  WebhookDeliveryResult,
} from './models.js';
import type {
  WebhookEndpointStore,
  WebhookDeliveryStore,
  WebhookAuditSink,
} from '../storage/webhooks.js';
import type { WebhookSecretStore } from './secrets.js';
import { signWebhookPayload } from './secrets.js';

const MAX_RETRY_ATTEMPTS = 5;
const INITIAL_RETRY_DELAY_MS = 5000;

interface WebhookServiceOptions {
  readonly endpointStore: WebhookEndpointStore;
  readonly deliveryStore: WebhookDeliveryStore;
  readonly auditSink: WebhookAuditSink;
  readonly secretStore: WebhookSecretStore;
  readonly now?: () => Date;
  readonly maxRetryAttempts?: number;
  readonly requestTimeoutMs?: number;
  readonly allowedEvents?: readonly string[];
}

export class WebhookService {
  private readonly endpointStore: WebhookEndpointStore;
  private readonly deliveryStore: WebhookDeliveryStore;
  private readonly auditSink: WebhookAuditSink;
  private readonly secretStore: WebhookSecretStore;
  private readonly now: () => Date;
  private readonly maxRetryAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly allowedEvents?: ReadonlySet<string>;

  constructor(options: WebhookServiceOptions) {
    this.endpointStore = options.endpointStore;
    this.deliveryStore = options.deliveryStore;
    this.auditSink = options.auditSink;
    this.secretStore = options.secretStore;
    this.now = options.now ?? (() => new Date());
    this.maxRetryAttempts = options.maxRetryAttempts ?? MAX_RETRY_ATTEMPTS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.allowedEvents = options.allowedEvents?.length ? new Set(options.allowedEvents) : undefined;
  }

  async createWebhookEndpoint(
    input: CreateWebhookEndpointInput,
  ): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
    const id = randomUUID();
    const createdAt = this.now().toISOString();

    const { secret, encrypted } = await this.secretStore.create(id);

    const endpoint: WebhookEndpoint = {
      id,
      tenantId: input.tenantId,
      url: input.url,
      events: [...input.events],
      createdAt,
      createdBy: input.createdBy,
      __version: 1,
    };

    await this.endpointStore.create(endpoint);

    await this.auditSink.record({
      id: randomUUID(),
      type: 'webhook.endpoint.created',
      endpointId: endpoint.id,
      tenantId: endpoint.tenantId,
      principalId: input.createdBy,
      timestamp: createdAt,
      result: 'success',
    });

    return { endpoint, secret };
  }

  async getWebhookEndpoint(tenantId: string, id: string): Promise<WebhookEndpoint | null> {
    const endpoint = await this.endpointStore.get(id);
    if (!endpoint || endpoint.tenantId !== tenantId) {
      return null;
    }
    return endpoint;
  }

  async listWebhookEndpoints(tenantId: string): Promise<readonly WebhookEndpoint[]> {
    return this.endpointStore.list(tenantId);
  }

  async disableWebhookEndpoint(input: DisableWebhookEndpointInput): Promise<WebhookEndpoint | null> {
    const endpoint = await this.endpointStore.get(input.id);
    if (!endpoint || endpoint.tenantId !== input.tenantId) {
      return null;
    }

    if (endpoint.disabledAt) {
      return endpoint;
    }

    const disabledAt = this.now().toISOString();
    const updated = await this.endpointStore.disable(
      input.id,
      endpoint.__version,
      disabledAt,
    );

    if (updated) {
      await this.auditSink.record({
        id: randomUUID(),
        type: 'webhook.endpoint.disabled',
        endpointId: updated.id,
        tenantId: updated.tenantId,
        principalId: input.disabledBy,
        timestamp: disabledAt,
        result: 'success',
      });
    }

    return updated;
  }

  async emitWebhookEvent(input: EmitWebhookEventInput): Promise<readonly WebhookDelivery[]> {
    if (this.allowedEvents && !this.allowedEvents.has(input.type)) {
      throw new Error(`Webhook event "${input.type}" is not declared in appport.toml`);
    }
    const endpoints = await this.endpointStore.list(input.tenantId);
    const matchingEndpoints = endpoints.filter(
      (e) => !e.disabledAt && e.events.includes(input.type),
    );

    if (matchingEndpoints.length === 0) {
      return [];
    }

    const eventId = randomUUID();
    const createdAt = this.now().toISOString();
    const deliveries: WebhookDelivery[] = matchingEndpoints.map((endpoint) => ({
      id: randomUUID(),
      tenantId: input.tenantId,
      endpointId: endpoint.id,
      eventId,
      eventType: input.type,
      payload: input.payload,
      status: 'pending',
      attemptCount: 0,
      createdAt,
      __version: 1,
    }));

    await this.deliveryStore.createMultiple(deliveries);

    for (const delivery of deliveries) {
      await this.auditSink.record({
        id: randomUUID(),
        type: 'webhook.delivery.created',
        deliveryId: delivery.id,
        endpointId: delivery.endpointId,
        tenantId: delivery.tenantId,
        principalId: 'system',
        timestamp: createdAt,
        result: 'success',
      });
    }

    return deliveries;
  }

  async getWebhookDelivery(tenantId: string, id: string): Promise<WebhookDelivery | null> {
    const delivery = await this.deliveryStore.get(id);
    if (!delivery || delivery.tenantId !== tenantId) {
      return null;
    }
    return delivery;
  }

  async listWebhookDeliveries(
    tenantId: string,
    endpointId?: string,
    limit?: number,
  ): Promise<readonly WebhookDelivery[]> {
    return this.deliveryStore.list(tenantId, endpointId, limit);
  }

  async deliverWebhook(tenantId: string, deliveryId: string): Promise<WebhookDeliveryResult> {
    const delivery = await this.deliveryStore.get(deliveryId);
    if (!delivery) {
      return { success: false, error: 'Delivery not found' };
    }

    if (delivery.tenantId !== tenantId) {
      return { success: false, error: 'Tenant mismatch' };
    }

    if (delivery.status === 'delivered') {
      return { success: true, statusCode: 200 };
    }

    if (delivery.status === 'delivering') {
      return { success: true, statusCode: 200 };
    }

    const endpoint = await this.endpointStore.get(delivery.endpointId);
    if (!endpoint) {
      return { success: false, error: 'Endpoint not found' };
    }

    if (endpoint.disabledAt) {
      await this.deliveryStore.updateDelivery(deliveryId, delivery.__version, {
        status: 'failed',
        lastError: 'Endpoint is disabled',
      });
      return { success: false, error: 'Endpoint is disabled' };
    }

    const claimed = await this.deliveryStore.claim(deliveryId, delivery.__version);
    if (!claimed) {
      return { success: true, statusCode: 200 };
    }

    const secretEncrypted = await this.secretStore.getEncrypted(endpoint.id);
    if (!secretEncrypted) {
      return { success: false, error: 'Signing secret not found' };
    }

    const secret = await this.secretStore.decrypt(secretEncrypted);
    const result = await this.performHttpDelivery(endpoint.url, claimed, secret);

    const now = this.now().toISOString();
    const isTerminal =
      result.statusCode &&
      result.statusCode >= 400 &&
      result.statusCode < 500 &&
      result.statusCode !== 408 &&
      result.statusCode !== 429;

    if (result.success) {
      const updates: Partial<WebhookDelivery> = {
        status: 'delivered' as const,
        deliveredAt: now,
        attemptCount: claimed.attemptCount + 1,
        lastStatusCode: result.statusCode,
      };

      await this.deliveryStore.updateDelivery(claimed.id, claimed.__version, updates);

      await this.auditSink.record({
        id: randomUUID(),
        type: 'webhook.delivery.delivered',
        deliveryId: claimed.id,
        endpointId: claimed.endpointId,
        tenantId: claimed.tenantId,
        principalId: 'system',
        timestamp: now,
        result: 'success',
      });
    } else if (isTerminal || claimed.attemptCount + 1 >= this.maxRetryAttempts) {
      const updates: Partial<WebhookDelivery> = {
        status: 'failed' as const,
        lastError: result.error || 'Unknown error',
        attemptCount: claimed.attemptCount + 1,
        lastStatusCode: result.statusCode,
      };

      await this.deliveryStore.updateDelivery(claimed.id, claimed.__version, updates);

      await this.auditSink.record({
        id: randomUUID(),
        type: 'webhook.delivery.failed',
        deliveryId: claimed.id,
        endpointId: claimed.endpointId,
        tenantId: claimed.tenantId,
        principalId: 'system',
        timestamp: now,
        result: 'failure',
      });
    } else {
      const nextAttemptAt = new Date(
        Date.now() + INITIAL_RETRY_DELAY_MS * Math.pow(2, claimed.attemptCount),
      ).toISOString();

      const updates: Partial<WebhookDelivery> = {
        status: 'retrying' as const,
        nextAttemptAt,
        lastError: result.error || 'Unknown error',
        attemptCount: claimed.attemptCount + 1,
        lastStatusCode: result.statusCode,
      };

      await this.deliveryStore.updateDelivery(claimed.id, claimed.__version, updates);
    }

    return result;
  }

  async replayWebhookDelivery(
    tenantId: string,
    deliveryId: string,
    replayedBy: string,
  ): Promise<WebhookDelivery | null> {
    const delivery = await this.deliveryStore.get(deliveryId);
    if (!delivery || delivery.tenantId !== tenantId) {
      return null;
    }

    const endpoint = await this.endpointStore.get(delivery.endpointId);
    if (!endpoint) {
      return null;
    }

    if (endpoint.disabledAt) {
      return null;
    }

    const now = this.now().toISOString();
    const updates: Partial<WebhookDelivery> = {
      status: 'pending' as const,
      attemptCount: 0,
      nextAttemptAt: undefined,
      lastAttemptAt: undefined,
      deliveredAt: undefined,
      lastStatusCode: undefined,
      lastError: undefined,
    };

    const updated = await this.deliveryStore.updateDelivery(
      deliveryId,
      delivery.__version,
      updates,
    );

    if (updated) {
      await this.auditSink.record({
        id: randomUUID(),
        type: 'webhook.delivery.replayed',
        deliveryId: updated.id,
        endpointId: updated.endpointId,
        tenantId: updated.tenantId,
        principalId: replayedBy,
        timestamp: now,
        result: 'success',
      });
    }

    return updated;
  }

  private async performHttpDelivery(
    url: string,
    delivery: WebhookDelivery,
    secret: string,
  ): Promise<WebhookDeliveryResult> {
    const payload = JSON.stringify({
      id: delivery.id,
      eventId: delivery.eventId,
      type: delivery.eventType,
      data: delivery.payload,
      timestamp: delivery.createdAt,
    });

    const signature = signWebhookPayload(secret, payload);

    return new Promise((resolve) => {
      const urlObj = new URL(url);
      const client = urlObj.protocol === 'https:' ? https : http;

      const req = client.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-AppPort-Signature': signature,
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: this.requestTimeoutMs,
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk) => {
            responseBody += chunk;
          });

          res.on('end', () => {
            const statusCode = res.statusCode ?? 500;

            if (statusCode >= 200 && statusCode < 300) {
              resolve({ success: true, statusCode });
            } else if (
              statusCode === 408 ||
              statusCode === 429 ||
              (statusCode >= 500 && statusCode < 600)
            ) {
              resolve({
                success: false,
                statusCode,
                error: `HTTP ${statusCode} (retryable)`,
              });
            } else {
              resolve({
                success: false,
                statusCode,
                error: `HTTP ${statusCode}`,
              });
            }
          });
        },
      );

      req.on('error', (error) => {
        resolve({
          success: false,
          error: `Network error: ${error instanceof Error ? error.message : String(error)}`,
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          error: 'Request timeout (retryable)',
        });
      });

      req.write(payload);
      req.end();
    });
  }
}
