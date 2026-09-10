import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { ApiKeyService } from '../api-keys/service.js';
import { authenticateBearerToken } from './api-keys.js';

export interface HttpRequest {
  readonly headers: Record<string, string | string[] | undefined>;
}

export interface HttpResponse {
  readonly statusCode?: number;
}

export interface AuthenticationResult {
  readonly principal: AuthenticatedPrincipal | null;
  readonly reason?: 'missing' | 'malformed' | 'invalid';
}

export class ApiKeyAuthAdapter {
  constructor(private readonly service: ApiKeyService) {}

  async authenticateRequest(request: HttpRequest): Promise<AuthenticationResult> {
    const authHeader = getAuthorizationHeader(request);
    if (!authHeader) {
      return { principal: null, reason: 'missing' };
    }

    if (!isValidAuthorizationFormat(authHeader)) {
      return { principal: null, reason: 'malformed' };
    }

    try {
      const principal = await authenticateBearerToken(authHeader, this.service);
      if (!principal) {
        return { principal: null, reason: 'invalid' };
      }
      return { principal };
    } catch {
      return { principal: null, reason: 'invalid' };
    }
  }

  async require(request: HttpRequest): Promise<AuthenticatedPrincipal> {
    const result = await this.authenticateRequest(request);
    if (!result.principal) {
      const reason = result.reason || 'invalid';
      throw new AuthenticationError(reason);
    }
    return result.principal;
  }

  async authenticate(request: HttpRequest): Promise<AuthenticatedPrincipal | null> {
    const result = await this.authenticateRequest(request);
    return result.principal;
  }
}

export class AuthenticationError extends Error {
  readonly reason: 'missing' | 'malformed' | 'invalid';

  constructor(reason: 'missing' | 'malformed' | 'invalid') {
    super(`Authentication ${reason}`);
    this.reason = reason;
    this.name = 'AuthenticationError';
  }
}

export interface RequestContextStorage {
  principal?: AuthenticatedPrincipal;
}

export class RequestContext {
  private storage: RequestContextStorage = {};

  getPrincipal(): AuthenticatedPrincipal | undefined {
    return this.storage.principal;
  }

  setPrincipal(principal: AuthenticatedPrincipal): void {
    this.storage.principal = principal;
  }

  clear(): void {
    this.storage = {};
  }
}

export function createApiKeyAuth(options: { readonly service: ApiKeyService }): ApiKeyAuthAdapter {
  return new ApiKeyAuthAdapter(options.service);
}

export function assertTenant(principal: AuthenticatedPrincipal, tenantId: string): void {
  if (principal.tenantId !== tenantId) {
    throw new TenantMismatchError(principal.tenantId, tenantId);
  }
}

export class TenantMismatchError extends Error {
  constructor(
    readonly principalTenant: string,
    readonly expectedTenant: string,
  ) {
    super('Tenant mismatch');
    this.name = 'TenantMismatchError';
  }
}

function getAuthorizationHeader(request: HttpRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string') {
    return header;
  }
  if (Array.isArray(header) && header.length > 0) {
    return header[0];
  }
  return null;
}

function isValidAuthorizationFormat(authHeader: string): boolean {
  const parts = authHeader.split(/\s+/, 2);
  return parts.length === 2;
}
