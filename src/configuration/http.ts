import { Router, type Request } from 'express';
import type { ConfigurationEnvironment } from './models.js';
import { ConfigurationAuthorizationError, ConfigurationService, ConfigurationValidationError } from './service.js';
import { createConfigurationUiRouter } from './ui.js';

const environments = ['development', 'staging', 'production'] as const;
const scope = (req: Request) => ({
  tenantId: req.auth!.tenantId,
  applicationId: typeof req.query.application === 'string' ? req.query.application : 'default',
  environment: (typeof req.query.environment === 'string' ? req.query.environment : 'production') as ConfigurationEnvironment,
});
const bodyInput = (req: Request) => ({ ...scope(req), name: req.body?.name, value: req.body?.value, required: req.body?.required });

export function createConfigurationRouter(service: ConfigurationService): Router {
  const router = Router();
  router.use((req, _res, next) => {
    if (!req.auth) return next(new ConfigurationAuthorizationError());
    next();
  });
  router.get('/', async (req, res, next) => { try { res.json(await service.list(scope(req), req.auth!)); } catch (error) { next(error); } });
  router.post('/variables', async (req, res, next) => { try { res.status(201).json(await service.createVariable(bodyInput(req), req.auth!)); } catch (error) { next(error); } });
  router.patch('/variables/:name', async (req, res, next) => { try { res.json(await service.updateVariable({ ...bodyInput(req), name: req.params.name }, req.auth!)); } catch (error) { next(error); } });
  router.post('/secrets', async (req, res, next) => { try { res.status(201).json(await service.createSecret(bodyInput(req), req.auth!)); } catch (error) { next(error); } });
  router.put('/secrets/:name', async (req, res, next) => { try { res.json(await service.rotateSecret({ ...bodyInput(req), name: req.params.name }, req.auth!)); } catch (error) { next(error); } });
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
  if (error instanceof ConfigurationAuthorizationError) { res.status(403).json({ error: error.message }); return; }
  if (error instanceof ConfigurationValidationError) { res.status(400).json({ error: error.message }); return; }
  res.status(500).json({ error: 'Configuration operation failed' });
}

export { environments };
