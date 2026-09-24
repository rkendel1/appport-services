import type { ApiKeyService } from '../api-keys/service.js';
import type { ConfigurationService } from '../configuration/service.js';
import type { FileService } from '../files/service.js';
import type { JobService } from '../jobs/service.js';
import type { NotificationService } from '../notifications/service.js';
import type { ScheduleService } from '../schedules/service.js';
import type { WebhookService } from '../webhooks/service.js';
import { ServiceAuthorityError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { getServiceCapability } from '../authority/manifest.js';
import { requireVerifiedPrincipal, resolveTenant, type VerifiedPrincipal } from '../authority/principal.js';

export interface InvokableServices {
  readonly gateway: ServiceGateway;
  readonly apiKeys?: ApiKeyService;
  readonly webhooks?: WebhookService;
  readonly jobs?: JobService;
  readonly schedules?: ScheduleService;
  readonly notifications?: NotificationService;
  readonly files?: FileService;
  readonly configuration?: ConfigurationService;
}

export interface InvokeOptions {
  /** The verified caller. Never an actor string. */
  readonly principal: VerifiedPrincipal;
}

type Input = Record<string, unknown>;
type Handler = (services: InvokableServices, input: Input, principal: VerifiedPrincipal) => Promise<unknown>;

/**
 * Protected service dispatcher: the public way to cause a service effect.
 * It maps a manifest capability to its service operation; the operation then
 * asks AuthBoundry before doing anything.
 */
export async function invokeService(services: InvokableServices, capability: string, input: unknown, options: InvokeOptions): Promise<unknown> {
  const declared = getServiceCapability(capability);
  if (!declared) throw new ServiceAuthorityError('INVALID_REQUEST', `Capability "${capability}" is not declared in the service capability manifest`);
  if (!declared.invocable) throw new ServiceAuthorityError('INVALID_REQUEST', `Capability "${capability}" is runtime-internal and cannot be invoked`);
  const principal = requireVerifiedPrincipal(options?.principal);
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input))) {
    throw new ServiceAuthorityError('INVALID_REQUEST', 'Service input must be an object');
  }
  return HANDLERS[capability](services, (input ?? {}) as Input, principal);
}

/** Restrict tenant-keyed observations to records of this application. */
export function ownedBy(application: string, value: unknown): unknown {
  const owned = (record: unknown) => !!record && typeof record === 'object' && (record as { applicationId?: unknown }).applicationId === application;
  if (Array.isArray(value)) return value.filter(owned);
  return value === null || owned(value) ? value : null;
}

function need<T>(service: T | undefined, name: string): T {
  if (!service) throw new ServiceAuthorityError('INVALID_REQUEST', `The ${name} capability is not enabled for this application`);
  return service;
}

function id(input: Input): string {
  if (typeof input.id !== 'string' || !input.id) throw new ServiceAuthorityError('INVALID_REQUEST', 'id is required');
  return input.id;
}

/** Wrap a tenant-keyed observation API with an explicit read authorization. */
function observe(services: InvokableServices, capability: string, type: string, input: Input, principal: VerifiedPrincipal, read: (tenantId: string) => Promise<unknown>): Promise<unknown> {
  const tenantId = resolveTenant(input, principal);
  const application = services.gateway.application;
  return services.gateway.execute(capability, principal, { type, tenantId, ...(typeof input.id === 'string' ? { id: input.id } : {}) }, { service: type }, async () => ownedBy(application, await read(tenantId)));
}

const HANDLERS: Readonly<Record<string, Handler>> = {
  'apikeys.read': (s, input, p) => { const keys = need(s.apiKeys, 'api'); return observe(s, 'apikeys.read', 'api_key', input, p, (t) => typeof input.id === 'string' ? keys.getApiKey(t, input.id) : keys.listApiKeys(t)); },
  'apikeys.create': (s, input, p) => need(s.apiKeys, 'api').createApiKey(input as never, p),
  'apikeys.revoke': (s, input, p) => need(s.apiKeys, 'api').revokeApiKey({ ...input, id: id(input) } as never, p),

  'webhooks.read': (s, input, p) => { const hooks = need(s.webhooks, 'webhooks'); return observe(s, 'webhooks.read', 'webhook_endpoint', input, p, (t) => typeof input.id === 'string' ? hooks.getWebhookEndpoint(t, input.id) : hooks.listWebhookEndpoints(t)); },
  'webhooks.register': (s, input, p) => need(s.webhooks, 'webhooks').createWebhookEndpoint(input as never, p),
  'webhooks.remove': (s, input, p) => need(s.webhooks, 'webhooks').disableWebhookEndpoint({ ...input, id: id(input) } as never, p),
  'webhooks.emit': (s, input, p) => need(s.webhooks, 'webhooks').emitWebhookEvent(input as never, p),
  'webhooks.replay': (s, input, p) => need(s.webhooks, 'webhooks').replayWebhookDelivery(resolveTenant(input, p), id(input), p),
  'webhooks.integrations.register': (s, input, p) => need(s.webhooks, 'webhooks').registerIntegration(input as never, p),

  'jobs.read': (s, input, p) => { const jobs = need(s.jobs, 'jobs'); return observe(s, 'jobs.read', 'job', input, p, (t) => typeof input.id === 'string' ? jobs.getJob(t, input.id) : jobs.listJobs(t)); },
  'jobs.create': (s, input, p) => need(s.jobs, 'jobs').enqueue(input as never, p),
  'jobs.retry': (s, input, p) => need(s.jobs, 'jobs').retry(resolveTenant(input, p), id(input), p),

  'schedules.read': (s, input, p) => { const schedules = need(s.schedules, 'jobs'); return typeof input.id === 'string' ? schedules.get(resolveTenant(input, p), input.id, p) : schedules.list(resolveTenant(input, p), p, typeof input.createdBy === 'string' ? { createdBy: input.createdBy } : {}); },
  'schedules.create': (s, input, p) => need(s.schedules, 'jobs').create(input as never, p),
  'schedules.cancel': (s, input, p) => need(s.schedules, 'jobs').disable(resolveTenant(input, p), id(input), p),

  'notifications.read': (s, input, p) => { const n = need(s.notifications, 'notifications'); return typeof input.id === 'string' ? n.get(resolveTenant(input, p), input.id, p) : n.list(resolveTenant(input, p), input as never, p); },
  'notifications.send': (s, input, p) => need(s.notifications, 'notifications').create(input as never, p),
  'notifications.update': (s, input, p) => { const n = need(s.notifications, 'notifications'); return input.action === 'dismiss' ? n.dismiss(resolveTenant(input, p), id(input), p) : n.markRead(resolveTenant(input, p), id(input), p); },
  'notifications.delete': (s, input, p) => need(s.notifications, 'notifications').delete(resolveTenant(input, p), id(input), p),

  'files.read': (s, input, p) => { const f = need(s.files, 'files'); return typeof input.id === 'string' ? f.get(resolveTenant(input, p), input.id, p) : f.list(resolveTenant(input, p), p, typeof input.owner === 'string' ? { owner: input.owner } : {}); },
  'files.write': (s, input, p) => { const f = need(s.files, 'files'); return typeof input.id === 'string' ? f.update(input as never, p) : f.create(input as never, p); },
  'files.delete': (s, input, p) => need(s.files, 'files').delete(resolveTenant(input, p), id(input), p),

  'configuration.read': (s, input, p) => need(s.configuration, 'configuration').list(input as never, p),
  'configuration.write': (s, input, p) => { const c = need(s.configuration, 'configuration'); return input.operation === 'update' ? c.updateVariable(input as never, p) : c.createVariable(input as never, p); },
  'configuration.delete': (s, input, p) => need(s.configuration, 'configuration').delete({ ...input, kind: 'variable' } as never, p),
  'credential.attach': (s, input, p) => need(s.configuration, 'configuration').createSecret(input as never, p),
  'credential.rotate': (s, input, p) => need(s.configuration, 'configuration').rotateSecret(input as never, p),
  'credential.detach': (s, input, p) => need(s.configuration, 'configuration').delete({ ...input, kind: 'secret' } as never, p),
};
