import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { ApiKeyService } from '../api-keys/service.js';

export async function authenticateBearerToken(
  authorizationHeader: string,
  service: ApiKeyService,
): Promise<AuthenticatedPrincipal | null> {
  const [scheme, token] = authorizationHeader.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return null;
  }
  return service.authenticateApiKey(token);
}
