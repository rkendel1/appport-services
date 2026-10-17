import type { ServiceResource } from './context.js';
import { ServiceAuthorityError, isServiceAuthorityError } from './errors.js';
import type { VerifiedPrincipal } from './principal.js';

/**
 * Re-validates the credential behind a principal for one requested operation.
 * Resolves when the credential is still live and permits the operation;
 * throws DENIED (or AUTHORITY_UNAVAILABLE) otherwise.
 */
export type CredentialCheck = (capability: string, resource: ServiceResource) => Promise<void>;

// Module-private, like the principal brand: the binding is invisible on the
// principal object and cannot be forged or copied by spreading it.
const bindings = new WeakMap<VerifiedPrincipal, CredentialCheck>();

/** @internal Only the API-key authentication path binds a check. */
export function bindCredentialCheck(principal: VerifiedPrincipal, check: CredentialCheck): void {
  bindings.set(principal, check);
}

/**
 * Called by the gateway before AuthBoundry is asked. A credential-backed
 * principal is checked against the authoritative store on every operation,
 * so revocation, expiry, and restriction changes made by any process apply
 * immediately. It can only deny; it never grants.
 */
export async function enforceCredential(principal: VerifiedPrincipal, capability: string, resource: ServiceResource): Promise<void> {
  const check = bindings.get(principal);
  if (!check) {
    if (principal.verifiedBy === 'api_key') {
      throw new ServiceAuthorityError('DENIED', 'API-key principal is not bound to a live credential', { capability, reason: 'credential_unbound' });
    }
    return;
  }
  try {
    await check(capability, resource);
  } catch (error) {
    if (isServiceAuthorityError(error)) throw error;
    throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'API-key credential state could not be read', { capability, reason: 'credential_store_unavailable' });
  }
}
