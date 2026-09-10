import type { Request, Response, NextFunction } from 'express';
import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { ApiKeyService } from '../api-keys/service.js';
import { ApiKeyAuthAdapter, RequestContext } from './http-adapter.js';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedPrincipal;
      authContext?: RequestContext;
    }
  }
}

export function apiKeyAuth(service: ApiKeyService) {
  const adapter = new ApiKeyAuthAdapter(service);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = new RequestContext();
    req.authContext = context;

    try {
      const principal = await adapter.authenticate(req);
      if (principal) {
        req.auth = principal;
        context.setPrincipal(principal);
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireApiKeyAuth(service: ApiKeyService) {
  const adapter = new ApiKeyAuthAdapter(service);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const context = new RequestContext();
    req.authContext = context;

    try {
      const principal = await adapter.require(req);
      req.auth = principal;
      context.setPrincipal(principal);
      next();
    } catch (error) {
      next(error);
    }
  };
}
