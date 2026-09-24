import { Router, json as jsonBody, type NextFunction, type Request, type Response } from 'express';

import type { ApiKeyService } from '../api-keys/service.js';
import type { AuthenticatedPrincipal } from '../contract/principals.js';
import { createConfigurationRouter } from '../configuration/http.js';
import { createConfigurationUiRouter } from '../configuration/ui.js';
import { ConfigurationAuthorizationError, ConfigurationService, ConfigurationValidationError } from '../configuration/service.js';
import { FileAuthorizationError, type FileService } from '../files/service.js';
import type { JobService } from '../jobs/service.js';
import { NotificationAuthorizationError, type NotificationService } from '../notifications/service.js';
import { ScheduleAuthorizationError, type ScheduleService } from '../schedules/service.js';
import type { WebhookService } from '../webhooks/service.js';
import { ServiceAuthorityError, ServiceMigrationError, isServiceAuthorityError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { isVerifiedPrincipal, type PrincipalClaims, type VerifiedPrincipal } from '../authority/principal.js';

export const API_KEY_MANAGEMENT_CAPABILITIES = {
  read: 'apikeys.read',
  create: 'apikeys.create',
  revoke: 'apikeys.revoke',
} as const;

export type ApiKeyManagementCapability = typeof API_KEY_MANAGEMENT_CAPABILITIES[keyof typeof API_KEY_MANAGEMENT_CAPABILITIES];

/** @deprecated Management authorization is performed by AuthBoundry through the service gateway. */
export interface ManagementAuthorizationContext {
  readonly principal: AuthenticatedPrincipal;
  readonly tenantId: string;
  readonly request: Request;
}

/**
 * Trusted host authentication adapter. It returns the identity the host
 * verified (a session, SSO token, or an API-key principal). It never returns
 * permissions; any scopes on the claims are ignored.
 */
export type ManagementAuthenticationAdapter = (request: Request) => PrincipalClaims | VerifiedPrincipal | null | Promise<PrincipalClaims | VerifiedPrincipal | null>;
/** @deprecated */
export type ManagementAuthorizationResult = boolean | { readonly allowed: boolean };
/** @deprecated Rejected: a second authorization layer beside AuthBoundry is not permitted. */
export type ManagementAuthorizationAdapter = (
  capability: ApiKeyManagementCapability,
  context: ManagementAuthorizationContext,
) => ManagementAuthorizationResult | Promise<ManagementAuthorizationResult>;

export interface ManagementServices {
  readonly apiKeys?: Pick<ApiKeyService, 'createApiKey' | 'listApiKeys' | 'revokeApiKey'>;
  readonly configuration?: ConfigurationService;
  readonly webhooks?: Pick<WebhookService, 'createWebhookEndpoint' | 'listWebhookEndpoints' | 'disableWebhookEndpoint'>;
  readonly jobs?: Pick<JobService, 'enqueue' | 'listJobs' | 'retry'>;
  readonly notifications?: Pick<NotificationService, 'create' | 'list' | 'markRead' | 'dismiss' | 'delete'>;
  readonly files?: Pick<FileService, 'create' | 'list' | 'update' | 'delete'>;
  readonly schedules?: Pick<ScheduleService, 'create' | 'list' | 'disable'>;
}

export interface CreateManagementRouterOptions {
  /** The existing service instance. No services or persistence runtimes are created by this router. */
  readonly services: ManagementServices;
  /** The services' Policy Enforcement Point. Reads and identity branding go through it. */
  readonly authority: ServiceGateway;
  /** Authenticates the host request. Return null when no host identity is present. */
  readonly authenticate: ManagementAuthenticationAdapter;
  /** @deprecated Rejected with a migration error. AuthBoundry authorizes every operation through the gateway. */
  readonly authorize?: ManagementAuthorizationAdapter;
  /** Serve the packaged management UI and configuration routes. Defaults to true. */
  readonly includeConfiguration?: boolean;
  readonly includeUi?: boolean;
}

export const APPPORT_UI_CONTRIBUTIONS = Object.freeze([{
  protocol: 'AppPort/ui/1',
  id: 'api-keys',
  requiredCapabilities: Object.freeze(Object.values(API_KEY_MANAGEMENT_CAPABILITIES)),
}] as const);

export class ManagementAuthenticationError extends Error {
  readonly status = 401;
  readonly code = 'UNAUTHENTICATED';
  constructor() { super('Authentication is required'); this.name = 'ManagementAuthenticationError'; }
}

/** @deprecated Denials are reported as ServiceAuthorityError with code DENIED. */
export class ManagementAuthorizationError extends Error {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
  constructor(readonly capability: ApiKeyManagementCapability) {
    super(`The ${capability} capability is required`);
    this.name = 'ManagementAuthorizationError';
  }
}

/** Mount AppPort Services management routes into an existing authenticated Express host. */
export function createManagementRouter(options: CreateManagementRouterOptions): Router {
  if (options.authorize !== undefined) {
    throw new ServiceMigrationError('createManagementRouter no longer accepts an authorize adapter. Configure the AuthBoundry authorizer on the services; the router is a thin adapter.');
  }
  if (!options.authority) throw new Error('createManagementRouter requires the services\' authority (ServiceGateway)');
  const gateway = options.authority;
  const router = Router();

  router.use(jsonBody());

  router.use(async (req, _res, next) => {
    try {
      const identity = await options.authenticate(req);
      if (identity) req.auth = isVerifiedPrincipal(identity) ? identity : gateway.identify(identity) ?? undefined;
      next();
    } catch (error) { next(error); }
  });

  if (options.services.apiKeys) router.get('/api-keys', async (req, _res, next) => {
    try {
      const principal = requirePrincipal(req);
      // The packaged page drives all three operations; AuthBoundry must allow each.
      for (const capability of Object.values(API_KEY_MANAGEMENT_CAPABILITIES)) {
        await gateway.authorize(capability, principal, { type: 'api_key', tenantId: principal.tenantId });
      }
      next();
    } catch (error) { next(error); }
  });

  mountExistingServiceRoutes(router, options.services, gateway);

  if (options.includeConfiguration !== false && options.services.configuration) {
    router.use('/v1/configuration', createConfigurationRouter(options.services.configuration));
  }
  if (options.includeUi !== false) {
    const ui = createConfigurationUiRouter();
    const supportedUiPaths = new Set([
      ...(options.services.apiKeys ? ['/api-keys'] : []),
      ...(options.includeConfiguration !== false && options.services.configuration ? ['/configuration', '/secrets'] : []),
      ...(options.services.webhooks ? ['/webhooks'] : []),
      ...(options.services.jobs ? ['/jobs'] : []),
      ...(options.services.schedules ? ['/schedules'] : []),
      ...(options.services.files ? ['/files'] : []),
      ...(options.services.notifications ? ['/notifications'] : []),
    ]);
    if (supportedUiPaths.size > 2) supportedUiPaths.add('/services');
    router.use((req, res, next) => supportedUiPaths.has(req.path) ? ui(req, res, next) : next());
  }

  router.use(managementErrorHandler);
  return router;
}

export function managementErrorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (isServiceAuthorityError(error)) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ManagementAuthenticationError || error instanceof ManagementAuthorizationError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ConfigurationAuthorizationError) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: error.message } });
    return;
  }
  if (error instanceof ConfigurationValidationError) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: error.message } });
    return;
  }
  if (error instanceof FileAuthorizationError || error instanceof NotificationAuthorizationError || error instanceof ScheduleAuthorizationError) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: error.message } });
    return;
  }
  const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500;
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'MANAGEMENT_OPERATION_FAILED';
  const message = status < 500 && error instanceof Error ? error.message : 'Management operation failed';
  res.status(status).json({ error: { code, message } });
}

function mountExistingServiceRoutes(router: Router, services: ManagementServices, gateway: ServiceGateway): void {
  const handler = (work: (req: Request, principal: VerifiedPrincipal) => Promise<{ status?: number; body?: unknown }>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const principal = requirePrincipal(req);
        // Ownership comes from the verified principal; a different caller-supplied tenant is refused, not ignored.
        if (req.body?.tenantId !== undefined && req.body.tenantId !== principal.tenantId) {
          throw new ServiceAuthorityError('DENIED', 'Cross-tenant service operation denied', { reason: 'tenant_mismatch' });
        }
        const result = await work(req, principal);
        const status = result.status ?? 200;
        if (status === 204) res.status(204).end();
        else res.status(status).json(result.body);
      } catch (error) { next(error); }
    };
  // Tenant-keyed observation APIs are wrapped in an explicit AuthBoundry read authorization.
  const read = <T>(capability: string, type: string, principal: VerifiedPrincipal, work: () => Promise<T>) =>
    gateway.execute(capability, principal, { type, tenantId: principal.tenantId }, { service: type }, work);

  if (services.apiKeys) {
    const keys = services.apiKeys;
    router.get('/_appport/api/keys', handler(async (_req, principal) => ({ body: (await read('apikeys.read', 'api_key', principal, () => keys.listApiKeys(principal.tenantId))).filter((key) => !key.revokedAt) })));
    router.post('/_appport/api/keys', handler(async (req, principal) => ({ status: 201, body: await keys.createApiKey({ name: requiredText(req.body?.name, 'name'), ...(req.body?.scopes === undefined ? {} : { scopes: stringList(req.body.scopes, 'scopes') }), ...(req.body?.tenantId === undefined ? {} : { tenantId: req.body.tenantId }), ...(req.body?.createdBy === undefined ? {} : { createdBy: req.body.createdBy }) }, principal) })));
    router.delete('/_appport/api/keys/:id', handler(async (req, principal) => { await keys.revokeApiKey({ id: req.params.id }, principal); return { status: 204 }; }));
  }
  if (services.webhooks) {
    const hooks = services.webhooks;
    router.get('/_appport/webhooks', handler(async (_req, principal) => ({ body: await read('webhooks.read', 'webhook_endpoint', principal, () => hooks.listWebhookEndpoints(principal.tenantId)) })));
    router.post('/_appport/webhooks', handler(async (req, principal) => ({ status: 201, body: await hooks.createWebhookEndpoint({ url: requiredText(req.body?.url, 'url'), events: stringList(req.body?.events, 'events'), signingCredentialRef: requiredText(req.body?.signingCredentialRef, 'signingCredentialRef') }, principal) })));
    router.delete('/_appport/webhooks/:id', handler(async (req, principal) => { await hooks.disableWebhookEndpoint({ id: req.params.id }, principal); return { status: 204 }; }));
  }
  if (services.jobs) {
    const jobs = services.jobs;
    router.get('/_appport/jobs', handler(async (_req, principal) => ({ body: await read('jobs.read', 'job', principal, () => jobs.listJobs(principal.tenantId)) })));
    router.post('/_appport/jobs', handler(async (req, principal) => ({ status: 201, body: await jobs.enqueue({ type: requiredText(req.body?.type, 'type'), payload: objectValue(req.body?.payload ?? {}, 'payload'), ...(req.body?.maxAttempts === undefined ? {} : { maxAttempts: nonNegativeInteger(req.body.maxAttempts, 'maxAttempts') }) }, principal) })));
    router.post('/_appport/jobs/:id/retry', handler(async (req, principal) => ({ body: await jobs.retry(principal.tenantId, req.params.id, principal) })));
  }
  if (services.schedules) {
    const schedules = services.schedules;
    router.get('/_appport/schedules', handler(async (_req, principal) => ({ body: await schedules.list(principal.tenantId, principal) })));
    router.post('/_appport/schedules', handler(async (req, principal) => ({ status: 201, body: await schedules.create({ type: requiredText(req.body?.type, 'type'), payload: objectValue(req.body?.payload ?? {}, 'payload'), interval: requiredText(req.body?.interval, 'interval'), ...(req.body?.createdBy === undefined ? {} : { createdBy: req.body.createdBy }) }, principal) })));
    router.delete('/_appport/schedules/:id', handler(async (req, principal) => ({ body: await schedules.disable(principal.tenantId, req.params.id, principal) })));
  }
  if (services.files) {
    const files = services.files;
    router.get('/_appport/files', handler(async (req, principal) => ({ body: await files.list(principal.tenantId, principal, { ...(typeof req.query.owner === 'string' ? { owner: req.query.owner } : {}) }) })));
    router.post('/_appport/files', handler(async (req, principal) => ({ status: 201, body: await files.create({ ...(typeof req.body?.owner === 'string' ? { owner: req.body.owner } : {}), name: requiredText(req.body?.name, 'name'), size: nonNegativeInteger(req.body?.size, 'size'), storageKey: requiredText(req.body?.storageKey, 'storageKey'), ...(req.body?.contentType === undefined ? {} : { contentType: requiredText(req.body.contentType, 'contentType') }), ...(req.body?.checksum === undefined ? {} : { checksum: requiredText(req.body.checksum, 'checksum') }), ...(req.body?.metadata === undefined ? {} : { metadata: objectValue(req.body.metadata, 'metadata') }) }, principal) })));
    const updateFile = handler(async (req, principal) => ({ body: await files.update({ id: req.params.id, ...(req.body?.name === undefined ? {} : { name: requiredText(req.body.name, 'name') }), ...(req.body?.storageKey === undefined ? {} : { storageKey: requiredText(req.body.storageKey, 'storageKey') }), ...(req.body?.size === undefined ? {} : { size: nonNegativeInteger(req.body.size, 'size') }), ...(req.body?.contentType === undefined ? {} : { contentType: requiredText(req.body.contentType, 'contentType') }), ...(req.body?.checksum === undefined ? {} : { checksum: requiredText(req.body.checksum, 'checksum') }), ...(req.body?.metadata === undefined ? {} : { metadata: objectValue(req.body.metadata, 'metadata') }) }, principal) }));
    router.patch('/_appport/files/:id', updateFile);
    router.put('/_appport/files/:id', updateFile);
    router.delete('/_appport/files/:id', handler(async (req, principal) => { await files.delete(principal.tenantId, req.params.id, principal); return { status: 204 }; }));
  }
  if (services.notifications) {
    const notifications = services.notifications;
    router.get('/_appport/notifications', handler(async (req, principal) => ({ body: await notifications.list(principal.tenantId, { limit: Number(req.query.limit ?? 50), cursor: stringQuery(req.query.cursor), recipient: stringQuery(req.query.recipient), type: stringQuery(req.query.type), unread: req.query.unread === 'true' }, principal) })));
    router.post('/_appport/notifications', handler(async (req, principal) => ({ status: 201, body: await notifications.create(objectValue(req.body ?? {}, 'body') as never, principal) })));
    router.post('/_appport/notifications/:id/read', handler(async (req, principal) => ({ body: await notifications.markRead(principal.tenantId, req.params.id, principal) })));
    router.post('/_appport/notifications/:id/dismiss', handler(async (req, principal) => ({ body: await notifications.dismiss(principal.tenantId, req.params.id, principal) })));
    router.delete('/_appport/notifications/:id', handler(async (req, principal) => { await notifications.delete(principal.tenantId, req.params.id, principal); return { status: 204 }; }));
  }
}

function requirePrincipal(request: Request): VerifiedPrincipal {
  if (!request.auth) throw new ManagementAuthenticationError();
  return request.auth;
}

function requiredText(value: unknown, property: string): string {
  if (typeof value !== 'string' || !value.trim()) throw inputError(`${property} must be a non-empty string`);
  return value;
}

function stringList(value: unknown, property: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw inputError(`${property} must be an array of strings`);
  return value;
}

function objectValue(value: unknown, property: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw inputError(`${property} must be an object`);
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, property: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw inputError(`${property} must be a non-negative integer`);
  return Number(value);
}

function stringQuery(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function inputError(message: string): Error & { status: number; code: string } {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_INPUT' });
}
