import { Router, type Request } from 'express';
import type { ConfigurationEnvironment } from './models.js';
import { ConfigurationAuthorizationError, ConfigurationService, ConfigurationValidationError } from './service.js';
import { isServiceAuthorityError } from '../authority/errors.js';
import { createConfigurationUiRouter } from './ui.js';

const environments = ['development', 'staging', 'production'] as const;
// Tenant comes from the verified principal. The application is this deployment's;
// a different ?application= is passed through so the service can deny it.
const scope = (req: Request) => ({
  tenantId: req.auth!.tenantId,
  ...(typeof req.query.application === 'string' ? { applicationId: req.query.application } : {}),
  environment: (typeof req.query.environment === 'string' ? req.query.environment : 'production') as ConfigurationEnvironment,
});
const bodyInput = (req: Request) => ({ ...scope(req), name: req.body?.name, value: req.body?.value, required: req.body?.required });
const credentialInput = (req: Request) => ({ ...scope(req), name: req.body?.name, credentialRef: req.body?.credentialRef, required: req.body?.required, ...(req.body?.value === undefined ? {} : { value: req.body.value }) });

export function createConfigurationRouter(service: ConfigurationService): Router {
  const router = Router();
  router.use((req, _res, next) => {
    if (!req.auth) return next(new ConfigurationAuthorizationError());
    next();
  });
  router.get('/', async (req, res, next) => { try { res.json(await service.list(scope(req), req.auth!)); } catch (error) { next(error); } });
  router.post('/variables', async (req, res, next) => { try { res.status(201).json(await service.createVariable(bodyInput(req), req.auth!)); } catch (error) { next(error); } });
  router.patch('/variables/:name', async (req, res, next) => { try { res.json(await service.updateVariable({ ...bodyInput(req), name: req.params.name }, req.auth!)); } catch (error) { next(error); } });
  router.post('/secrets', async (req, res, next) => { try { res.status(201).json(await service.createSecret(credentialInput(req), req.auth!)); } catch (error) { next(error); } });
  // credential.store: the value goes to the host's custody; the answer never contains it.
  router.post('/credentials', async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
      res.status(201).json(await service.storeCredential({
        ...scope(req),
        ref: body.ref as string,
        value: body.value as string,
        ...(body.provider === undefined ? {} : { provider: body.provider as string }),
        ...(body.kind === undefined ? {} : { kind: body.kind as string }),
        ...(body.name === undefined || body.name === '' ? {} : { name: body.name as string }),
        ...(body.required === undefined ? {} : { required: body.required === true }),
      }, req.auth!));
    } catch (error) { next(error); }
  });
  // credential.status: ?ref=credential-ref:a&ref=credential-ref:b
  router.get('/credentials/status', async (req, res, next) => {
    try {
      const refs = ([] as unknown[]).concat(req.query.ref ?? []).filter((ref): ref is string => typeof ref === 'string');
      res.json(await service.credentialStatus({ ...scope(req), refs, ...(typeof req.query.provider === 'string' ? { provider: req.query.provider } : {}) }, req.auth!));
    } catch (error) { next(error); }
  });
  router.put('/secrets/:name', async (req, res, next) => { try { res.json(await service.rotateSecret({ ...credentialInput(req), name: req.params.name }, req.auth!)); } catch (error) { next(error); } });
  router.delete('/:kind/:name', async (req, res, next) => {
    try {
      if (req.params.kind !== 'variables' && req.params.kind !== 'secrets') throw new ConfigurationValidationError('Invalid configuration kind');
      await service.delete({ ...scope(req), name: req.params.name, kind: req.params.kind === 'secrets' ? 'secret' : 'variable' }, req.auth!);
      res.status(204).end();
    } catch (error) { next(error); }
  });
  return router;
}

export function createConfigurationManagementRouter(service: ConfigurationService): Router {
  const router = Router();
  router.use('/v1/configuration', createConfigurationRouter(service));
  router.use('/', createConfigurationUiRouter());
  return router;
}

export function configurationErrorHandler(error: unknown, _req: Request, res: { status(code: number): { json(body: unknown): void } }): void {
  // A body that is not JSON: the parser's message quotes the body, which may be a credential.
  if (isBodyParseError(error)) { res.status(400).json({ error: 'Request body is not valid JSON', code: 'INVALID_INPUT' }); return; }
  if (isServiceAuthorityError(error)) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  if (error instanceof ConfigurationAuthorizationError) { res.status(403).json({ error: error.message }); return; }
  if (error instanceof ConfigurationValidationError) { res.status(400).json({ error: error.message }); return; }
  res.status(500).json({ error: 'Configuration operation failed' });
}

/** An Express/body-parser failure to read the body. Its message may quote the body, so it is never echoed. */
export function isBodyParseError(error: unknown): boolean {
  const type = typeof error === 'object' && error ? (error as { type?: unknown }).type : undefined;
  return typeof type === 'string' && /^(entity|request|stream|encoding|charset|parameters)\./.test(type);
}

export { environments };
