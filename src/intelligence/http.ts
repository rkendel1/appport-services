import { Router, type Request } from 'express';
import type { ConfigurationEnvironment } from '../configuration/models.js';
import type { IntelligenceService } from './service.js';

const scope = (req: Request) => ({
  tenantId: req.auth!.tenantId,
  ...(typeof req.query.application === 'string' ? { applicationId: req.query.application } : {}),
  environment: (typeof req.query.environment === 'string' ? req.query.environment : 'production') as ConfigurationEnvironment,
});

/**
 * Thin management adapter (like /v1/configuration) for the packaged page. It
 * adds no behavior: each route calls the same IntelligenceService operation
 * that the `intelligence.*` capabilities reach through invoke().
 */
export function createIntelligenceRouter(service: IntelligenceService): Router {
  const router = Router();
  const handle = (run: (req: Request) => Promise<unknown>) => async (req: Request, res: import('express').Response, next: import('express').NextFunction) => {
    try { if (!req.auth) { res.status(401).json({ error: 'Authentication is required' }); return; } res.json(await run(req)); } catch (error) { next(error); }
  };
  router.get('/', handle((req) => service.get(scope(req), req.auth!)));
  router.get('/catalog', handle((req) => service.catalog(scope(req), req.auth!)));
  router.put('/', handle((req) => service.set({ ...scope(req), ...pick(req.body, ['provider', 'model', 'endpoint', 'credentialRef']), ...rawFields(req.body) } as never, req.auth!)));
  router.put('/credential', handle((req) => service.setCredential({ ...scope(req), ...pick(req.body, ['credentialRef']), ...rawFields(req.body) } as never, req.auth!)));
  router.delete('/credential', handle((req) => service.removeCredential(scope(req), req.auth!)));
  return router;
}

function pick(body: unknown, keys: string[]): Record<string, unknown> {
  const source = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

/** Pass raw-credential-looking fields through so the service rejects them rather than silently dropping them. */
function rawFields(body: unknown): Record<string, unknown> {
  return pick(body, ['value', 'secret', 'password', 'token', 'apiKey', 'credential']);
}
