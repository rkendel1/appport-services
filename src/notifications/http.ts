import { Router, type Request } from 'express';
import type { NotificationListOptions } from './models.js';
import { NotificationAuthorizationError, NotificationNotFoundError, NotificationSensitiveDataError, NotificationService, NotificationValidationError } from './service.js';

export function createNotificationRouter(service: NotificationService): Router {
  const router = Router();
  // Fail closed: no authenticated principal, no notification access.
  router.use((req, _res, next) => req.auth ? next() : next(new NotificationAuthorizationError()));
  router.post('/', async (req, res, next) => {
    try {
      const result = await service.notify({ ...objectBody(req.body), tenantId: req.auth!.tenantId } as unknown as Parameters<NotificationService['notify']>[0], req.auth!);
      res.status(result.created ? 201 : 200).json({ notification: result.notification, deliveries: result.deliveries });
    } catch (error) { next(error); }
  });
  router.get('/', async (req, res, next) => {
    try { res.json(await service.list(req.auth!.tenantId, notificationListOptions(req.query), req.auth!)); } catch (error) { next(error); }
  });
  router.get('/:id', async (req, res, next) => { try { res.json(await service.get(req.auth!.tenantId, req.params.id, req.auth!)); } catch (error) { next(error); } });
  router.get('/:id/deliveries', async (req, res, next) => { try { res.json({ items: await service.deliveries(req.auth!.tenantId, req.params.id, req.auth!) }); } catch (error) { next(error); } });
  router.post('/:id/read', async (req, res, next) => { try { res.json(await service.markRead(req.auth!.tenantId, req.params.id, req.auth!)); } catch (error) { next(error); } });
  router.post('/:id/acknowledge', async (req, res, next) => { try { res.json(await service.acknowledge(req.auth!.tenantId, req.params.id, req.auth!)); } catch (error) { next(error); } });
  router.post('/:id/dismiss', async (req, res, next) => { try { res.json(await service.dismiss(req.auth!.tenantId, req.params.id, req.auth!)); } catch (error) { next(error); } });
  router.post('/:id/deliveries/:channel/retry', async (req, res, next) => { try { res.json(await service.retryDelivery(req.auth!.tenantId, req.params.id, req.params.channel, req.auth!)); } catch (error) { next(error); } });
  router.delete('/:id', async (req, res, next) => { try { await service.delete(req.auth!.tenantId, req.params.id, req.auth!); res.status(204).end(); } catch (error) { next(error); } });
  return router;
}

/** Parse the shared notification query conventions from a request query string. */
export function notificationListOptions(query: Request['query']): NotificationListOptions {
  const text = (name: string): string | undefined => typeof query[name] === 'string' ? query[name] as string : undefined;
  const limit = text('limit');
  return {
    recipient: text('recipient'), type: text('type'), status: text('status') as NotificationListOptions['status'],
    priority: text('priority') as NotificationListOptions['priority'], sourceType: text('sourceType'), cursor: text('cursor'),
    createdAfter: text('createdAfter'), createdBefore: text('createdBefore'),
    unread: query.unread === 'true', unacknowledged: query.unacknowledged === 'true',
    limit: limit ? Number(limit) : undefined,
  };
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NotificationValidationError('Request body must be a JSON object');
  return value as Record<string, unknown>;
}

/** Express error handler. It declares four parameters because Express only routes errors to four-argument handlers. */
export function notificationErrorHandler(error: unknown, _req: Request, res: { status(code: number): { json(body: unknown): void } }, _next?: unknown): void {
  if (error instanceof NotificationAuthorizationError) { res.status(403).json({ error: error.message }); return; }
  if (error instanceof NotificationNotFoundError) { res.status(404).json({ error: error.message }); return; }
  if (error instanceof NotificationValidationError || error instanceof NotificationSensitiveDataError) { res.status(400).json({ error: error.message }); return; }
  res.status(500).json({ error: 'Notification operation failed' });
}
