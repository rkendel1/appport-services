import { Router, type Request } from 'express';
import type { AuthenticatedPrincipal } from '../contract/principals.js';
import { NotificationAuthorizationError, NotificationNotFoundError, NotificationService, NotificationValidationError } from './service.js';

export function createNotificationRouter(service: NotificationService): Router {
  const router = Router();
  router.use((req, _res, next) => req.auth ? next() : next(new NotificationAuthorizationError()));
  router.post('/', async (req, res, next) => {
    try { res.status(201).json(await service.create({ ...req.body, tenantId: req.auth!.tenantId }, req.auth!)); } catch (error) { next(error); }
  });
  router.get('/', async (req, res, next) => {
    try {
      const options = {
        recipient: stringQuery(req, 'recipient'), type: stringQuery(req, 'type'), priority: stringQuery(req, 'priority') as 'low' | 'normal' | 'high' | 'urgent' | undefined,
        sourceType: stringQuery(req, 'sourceType'), cursor: stringQuery(req, 'cursor'),
        unread: req.query.unread === 'true', limit: req.query.limit ? Number(req.query.limit) : undefined,
      };
      res.json(await service.list(req.auth!.tenantId, options, req.auth!));
    } catch (error) { next(error); }
  });
  router.get('/:id', async (req, res, next) => { try { res.json(await service.get(req.auth!.tenantId, req.params.id, req.auth!)); } catch (error) { next(error); } });
  router.post('/:id/read', async (req, res, next) => { try { res.json(await service.markRead(req.auth!.tenantId, req.params.id, req.auth!)); } catch (error) { next(error); } });
  router.post('/:id/dismiss', async (req, res, next) => { try { res.json(await service.dismiss(req.auth!.tenantId, req.params.id, req.auth!)); } catch (error) { next(error); } });
  router.delete('/:id', async (req, res, next) => { try { await service.delete(req.auth!.tenantId, req.params.id, req.auth!); res.status(204).end(); } catch (error) { next(error); } });
  return router;
}

function stringQuery(req: Request, name: string): string | undefined { return typeof req.query[name] === 'string' ? req.query[name] : undefined; }

export function notificationErrorHandler(error: unknown, _req: Request, res: { status(code: number): { json(body: unknown): void } }): void {
  if (error instanceof NotificationAuthorizationError) { res.status(403).json({ error: error.message }); return; }
  if (error instanceof NotificationNotFoundError) { res.status(404).json({ error: error.message }); return; }
  if (error instanceof NotificationValidationError) { res.status(400).json({ error: error.message }); return; }
  res.status(500).json({ error: 'Notification operation failed' });
}
