import type { VerifiedPrincipal } from '../authority/principal.js';

/**
 * A principal produced by an authentication path (API key, host adapter,
 * durable job or integration record). Identity only: it carries no scopes and
 * grants nothing. AuthBoundry authorizes every capability.
 */
export type AuthenticatedPrincipal = VerifiedPrincipal;
