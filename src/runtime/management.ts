import { Router, json as jsonBody, type NextFunction, type Request, type Response } from 'express';

import type { ApiKeyService } from '../api-keys/service.js';
import type { AuthenticatedPrincipal } from '../contract/principals.js';
import { createConfigurationRouter } from '../configuration/http.js';
import { createConfigurationUiRouter } from '../configuration/ui.js';
import { ConfigurationAuthorizationError, ConfigurationService, ConfigurationValidationError } from '../configuration/service.js';
import { FileAuthorizationError, type FileService } from '../files/service.js';
import type { JobService } from '../jobs/service.js';
import { notificationListOptions } from '../notifications/http.js';
import { NotificationAuthorizationError, NotificationNotFoundError, NotificationSensitiveDataError, NotificationValidationError, type NotificationService } from '../notifications/service.js';
import { ScheduleAuthorizationError, type ScheduleService } from '../schedules/service.js';
import type { WebhookService } from '../webhooks/service.js';

export const API_KEY_MANAGEMENT_CAPABILITIES = {
  read: 'apikeys.read',
  create: 'apikeys.create',
  revoke: 'apikeys.revoke',
} as const;

export type ApiKeyManagementCapability = typeof API_KEY_MANAGEMENT_CAPABILITIES[keyof typeof API_KEY_MANAGEMENT_CAPABILITIES];

export interface ManagementAuthorizationContext {
  readonly principal: AuthenticatedPrincipal;
  readonly tenantId: string;
  readonly request: Request;
}

export type ManagementAuthenticationAdapter = (request: Request) => AuthenticatedPrincipal | null | Promise<AuthenticatedPrincipal | null>;
export type ManagementAuthorizationResult = boolean | { readonly allowed: boolean };
export type ManagementAuthorizationAdapter = (
  capability: ApiKeyManagementCapability,
  context: ManagementAuthorizationContext,
) => ManagementAuthorizationResult | Promise<ManagementAuthorizationResult>;

export interface ManagementServices {
  readonly apiKeys?: Pick<ApiKeyService, 'createApiKey' | 'listApiKeys' | 'revokeApiKey'>;
  readonly configuration?: ConfigurationService;
  readonly webhooks?: Pick<WebhookService, 'createWebhookEndpoint' | 'listWebhookEndpoints' | 'disableWebhookEndpoint'>;
  readonly jobs?: Pick<JobService, 'enqueue' | 'listJobs' | 'retry'>;
  readonly notifications?: Pick<NotificationService, 'notify' | 'get' | 'list' | 'deliveries' | 'markRead' | 'acknowledge' | 'dismiss' | 'delete'>;
  readonly files?: Pick<FileService, 'create' | 'list' | 'update' | 'delete'>;
  readonly schedules?: Pick<ScheduleService, 'create' | 'list' | 'disable'>;
}

export interface CreateManagementRouterOptions {
  /** The existing service instance. No services or persistence runtimes are created by this router. */
  readonly services: ManagementServices;
  /** Authenticates the host request. Return null when no host identity is present. */
  readonly authenticate: ManagementAuthenticationAdapter;
  /** Host authorization authority. Principal scopes are not treated as authorization decisions. */
  readonly authorize: ManagementAuthorizationAdapter;
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

export class ManagementAuthorizationError extends Error {
  readonly status = 403;
  readonly code = 'FORBIDDEN';
  constructor(readonly capability: ApiKeyManagementCapability) {
    super(`The ${capability} capability is required`);
    this.name = 'ManagementAuthorizationError';
  }
}

interface ApiKeyOperationContext {
  readonly principal: AuthenticatedPrincipal | null;
  readonly authorize: (capability: ApiKeyManagementCapability, principal: AuthenticatedPrincipal) => ManagementAuthorizationResult | Promise<ManagementAuthorizationResult>;
}

export async function executeApiKeyManagementOperation(
  service: NonNullable<ManagementServices['apiKeys']>,
  context: ApiKeyOperationContext,
  operation: 'list' | 'create' | 'revoke',
  input: { readonly name?: unknown; readonly scopes?: unknown; readonly id?: string },
): Promise<{ readonly status: number; readonly body?: unknown }> {
  const principal = context.principal;
  if (!principal) throw new ManagementAuthenticationError();
  const capability = API_KEY_MANAGEMENT_CAPABILITIES[operation === 'list' ? 'read' : operation];
  const decision = await context.authorize(capability, principal);
  if (!(typeof decision === 'boolean' ? decision : decision.allowed)) throw new ManagementAuthorizationError(capability);

  if (operation === 'list') {
    const keys = await service.listApiKeys(principal.tenantId);
    return { status: 200, body: keys.filter((key) => !key.revokedAt) };
  }
  if (operation === 'create') {
    const name = requiredText(input.name, 'name');
    const scopes = stringList(input.scopes, 'scopes');
    return {
      status: 201,
      body: await service.createApiKey({ tenantId: principal.tenantId, name, scopes, createdBy: principal.principalId }),
    };
  }
  await service.revokeApiKey({ tenantId: principal.tenantId, id: input.id!, revokedBy: principal.principalId });
  return { status: 204 };
}

/** Mount AppPort Services management routes into an existing authenticated Express host. */
export function createManagementRouter(options: CreateManagementRouterOptions): Router {
  const router = Router();

  router.use(jsonBody());

  router.use(async (req, _res, next) => {
    try {
      const principal = await options.authenticate(req);
      if (principal) req.auth = principal;
      next();
    } catch (error) { next(error); }
  });

  const run = (operation: 'list' | 'create' | 'revoke') => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await executeApiKeyManagementOperation(options.services.apiKeys!, {
        principal: req.auth ?? null,
        authorize: (capability, principal) => options.authorize(capability, {
          principal,
          tenantId: principal.tenantId,
          request: req,
        }),
      }, operation, { name: req.body?.name, scopes: req.body?.scopes, id: req.params.id });
      if (result.status === 204) res.status(204).end();
      else res.status(result.status).json(result.body);
    } catch (error) { next(error); }
  };

  if (options.services.apiKeys) {
    router.get('/_appport/api/keys', run('list'));
    router.post('/_appport/api/keys', run('create'));
    router.delete('/_appport/api/keys/:id', run('revoke'));
  }

  if (options.services.apiKeys) router.get('/api-keys', async (req, _res, next) => {
    try {
      if (!req.auth) throw new ManagementAuthenticationError();
      for (const capability of Object.values(API_KEY_MANAGEMENT_CAPABILITIES)) {
        const decision = await options.authorize(capability, { principal: req.auth, tenantId: req.auth.tenantId, request: req });
        if (!(typeof decision === 'boolean' ? decision : decision.allowed)) throw new ManagementAuthorizationError(capability);
      }
      next();
    } catch (error) { next(error); }
  });

  mountExistingServiceRoutes(router, options.services);

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
  if (error instanceof NotificationValidationError || error instanceof NotificationSensitiveDataError) {
    res.status(400).json({ error: { code: 'INVALID_INPUT', message: error.message } });
    return;
  }
  if (error instanceof NotificationNotFoundError) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: error.message } });
    return;
  }
  const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500;
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'MANAGEMENT_OPERATION_FAILED';
  const message = status < 500 && error instanceof Error ? error.message : 'Management operation failed';
  res.status(status).json({ error: { code, message } });
}

function mountExistingServiceRoutes(router: Router, services: ManagementServices): void {
  const handler = (work: (req: Request, principal: AuthenticatedPrincipal) => Promise<{ status?: number; body?: unknown }>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const principal = requirePrincipal(req);
        const result = await work(req, principal);
        const status = result.status ?? 200;
        if (status === 204) res.status(204).end();
        else res.status(status).json(result.body);
      } catch (error) { next(error); }
    };

  if (services.webhooks) {
    router.get('/_appport/webhooks', handler(async (_req, principal) => ({ body: await services.webhooks!.listWebhookEndpoints(principal.tenantId) })));
    router.post('/_appport/webhooks', handler(async (req, principal) => ({ status: 201, body: await services.webhooks!.createWebhookEndpoint({ tenantId: principal.tenantId, url: requiredText(req.body?.url, 'url'), events: stringList(req.body?.events, 'events'), createdBy: principal.principalId }) })));
    router.delete('/_appport/webhooks/:id', handler(async (req, principal) => { await services.webhooks!.disableWebhookEndpoint({ tenantId: principal.tenantId, id: req.params.id, disabledBy: principal.principalId }); return { status: 204 }; }));
  }
  if (services.jobs) {
    router.get('/_appport/jobs', handler(async (_req, principal) => ({ body: await services.jobs!.listJobs(principal.tenantId) })));
    router.post('/_appport/jobs', handler(async (req, principal) => ({ status: 201, body: await services.jobs!.enqueue({ tenantId: principal.tenantId, type: requiredText(req.body?.type, 'type'), payload: objectValue(req.body?.payload ?? {}, 'payload'), ...(req.body?.maxAttempts === undefined ? {} : { maxAttempts: nonNegativeInteger(req.body.maxAttempts, 'maxAttempts') }) }) })));
    router.post('/_appport/jobs/:id/retry', handler(async (req, principal) => ({ body: await services.jobs!.retry(principal.tenantId, req.params.id) })));
  }
  if (services.schedules) {
    router.get('/_appport/schedules', handler(async (_req, principal) => ({ body: await services.schedules!.list(principal.tenantId, principal) })));
    router.post('/_appport/schedules', handler(async (req, principal) => ({ status: 201, body: await services.schedules!.create({ tenantId: principal.tenantId, type: requiredText(req.body?.type, 'type'), payload: objectValue(req.body?.payload ?? {}, 'payload'), interval: requiredText(req.body?.interval, 'interval'), createdBy: principal.principalId }, principal) })));
    router.delete('/_appport/schedules/:id', handler(async (req, principal) => ({ body: await services.schedules!.disable(principal.tenantId, req.params.id, principal) })));
  }
  if (services.files) {
    router.get('/_appport/files', handler(async (req, principal) => ({ body: await services.files!.list(principal.tenantId, principal, { ...(typeof req.query.owner === 'string' ? { owner: req.query.owner } : {}) }) })));
    router.post('/_appport/files', handler(async (req, principal) => ({ status: 201, body: await services.files!.create({ tenantId: principal.tenantId, owner: typeof req.body?.owner === 'string' ? req.body.owner : principal.principalId, name: requiredText(req.body?.name, 'name'), size: nonNegativeInteger(req.body?.size, 'size'), storageKey: requiredText(req.body?.storageKey, 'storageKey'), ...(req.body?.contentType === undefined ? {} : { contentType: requiredText(req.body.contentType, 'contentType') }), ...(req.body?.checksum === undefined ? {} : { checksum: requiredText(req.body.checksum, 'checksum') }), ...(req.body?.metadata === undefined ? {} : { metadata: objectValue(req.body.metadata, 'metadata') }) }, principal) })));
    const updateFile = handler(async (req, principal) => ({ body: await services.files!.update({ tenantId: principal.tenantId, id: req.params.id, ...(req.body?.name === undefined ? {} : { name: requiredText(req.body.name, 'name') }), ...(req.body?.storageKey === undefined ? {} : { storageKey: requiredText(req.body.storageKey, 'storageKey') }), ...(req.body?.size === undefined ? {} : { size: nonNegativeInteger(req.body.size, 'size') }), ...(req.body?.contentType === undefined ? {} : { contentType: requiredText(req.body.contentType, 'contentType') }), ...(req.body?.checksum === undefined ? {} : { checksum: requiredText(req.body.checksum, 'checksum') }), ...(req.body?.metadata === undefined ? {} : { metadata: objectValue(req.body.metadata, 'metadata') }) }, principal) }));
    router.patch('/_appport/files/:id', updateFile);
    router.put('/_appport/files/:id', updateFile);
    router.delete('/_appport/files/:id', handler(async (req, principal) => { await services.files!.delete(principal.tenantId, req.params.id, principal); return { status: 204 }; }));
  }
  if (services.notifications) {
    router.get('/_appport/notifications', handler(async (req, principal) => ({ body: await services.notifications!.list(principal.tenantId, notificationListOptions(req.query), principal) })));
    router.post('/_appport/notifications', handler(async (req, principal) => {
      const result = await services.notifications!.notify({ ...objectValue(req.body, 'body'), tenantId: principal.tenantId } as unknown as Parameters<NotificationService['notify']>[0], principal);
      return { status: result.created ? 201 : 200, body: { notification: result.notification, deliveries: result.deliveries } };
    }));
    router.get('/_appport/notifications/:id', handler(async (req, principal) => ({ body: await services.notifications!.get(principal.tenantId, req.params.id, principal) })));
    router.get('/_appport/notifications/:id/deliveries', handler(async (req, principal) => ({ body: { items: await services.notifications!.deliveries(principal.tenantId, req.params.id, principal) } })));
    router.post('/_appport/notifications/:id/read', handler(async (req, principal) => ({ body: await services.notifications!.markRead(principal.tenantId, req.params.id, principal) })));
    router.post('/_appport/notifications/:id/acknowledge', handler(async (req, principal) => ({ body: await services.notifications!.acknowledge(principal.tenantId, req.params.id, principal) })));
    router.post('/_appport/notifications/:id/dismiss', handler(async (req, principal) => ({ body: await services.notifications!.dismiss(principal.tenantId, req.params.id, principal) })));
    router.delete('/_appport/notifications/:id', handler(async (req, principal) => { await services.notifications!.delete(principal.tenantId, req.params.id, principal); return { status: 204 }; }));
  }
}

function requirePrincipal(request: Request): AuthenticatedPrincipal {
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
