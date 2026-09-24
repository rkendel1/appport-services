import { ServiceAuthorityError, ServiceMigrationError } from './errors.js';

/** How the identity was established. None of these values grants authority. */
export type PrincipalVerification = 'api_key' | 'host' | 'job' | 'delivery' | 'integration';

/**
 * An identity that an authentication path established. It says who is
 * calling. It does not say what the caller may do: that is always an
 * AuthBoundry decision made per operation.
 */
export interface VerifiedPrincipal {
  readonly principalId: string;
  /** Host-defined identity kind. AppPort Services never grants authority from it. */
  readonly principalType: string;
  readonly tenantId: string;
  /** Application the identity belongs to. Omitted for host identities of the running application. */
  readonly applicationId?: string;
  /** Present for principals authenticated with an AppPort API key. */
  readonly credentialId?: string;
  /** Delegation that a job or agent runs under; AuthBoundry checks it on every effect. */
  readonly delegationId?: string;
  /** Durable run identity for job executions. */
  readonly runId?: string;
  readonly verifiedBy: PrincipalVerification;
}

/** Identity claims produced by a trusted authentication adapter, before branding. */
export interface PrincipalClaims {
  readonly principalId: string;
  readonly principalType: string;
  readonly tenantId: string;
  readonly applicationId?: string;
  readonly credentialId?: string;
  readonly delegationId?: string;
  readonly runId?: string;
}

// Module-private brand. Only principals minted by the authentication paths in
// this package are members; object literals and strings never are.
const verified = new WeakSet<object>();

/** @internal Only authentication paths (API keys, host adapters, durable job/integration records) call this. */
export function mintVerifiedPrincipal(claims: PrincipalClaims, verifiedBy: PrincipalVerification): VerifiedPrincipal {
  for (const field of ['principalId', 'principalType', 'tenantId'] as const) {
    if (typeof claims[field] !== 'string' || !claims[field].trim()) {
      throw new ServiceAuthorityError('UNAUTHENTICATED', `Authenticated identity is missing ${field}`);
    }
  }
  const principal: VerifiedPrincipal = Object.freeze({
    principalId: claims.principalId,
    principalType: claims.principalType,
    tenantId: claims.tenantId,
    ...(claims.applicationId ? { applicationId: claims.applicationId } : {}),
    ...(claims.credentialId ? { credentialId: claims.credentialId } : {}),
    ...(claims.delegationId ? { delegationId: claims.delegationId } : {}),
    ...(claims.runId ? { runId: claims.runId } : {}),
    verifiedBy,
  });
  verified.add(principal);
  return principal;
}

export function isVerifiedPrincipal(value: unknown): value is VerifiedPrincipal {
  return typeof value === 'object' && value !== null && verified.has(value);
}

/** Reject anything that did not come from an authentication path. */
export function requireVerifiedPrincipal(value: unknown): VerifiedPrincipal {
  if (isVerifiedPrincipal(value)) return value;
  if (typeof value === 'string') {
    throw new ServiceMigrationError('An actor string is not an identity. Pass the principal returned by authentication.');
  }
  if (value && typeof value === 'object' && 'scopes' in value) {
    throw new ServiceMigrationError('Principals carrying scopes are no longer authority. Pass the principal returned by authentication; AuthBoundry authorizes each capability.');
  }
  throw new ServiceAuthorityError('UNAUTHENTICATED', 'A verified principal is required for this service operation');
}

const ACTOR_FIELDS = ['actor', 'createdBy', 'revokedBy', 'disabledBy', 'replayedBy', 'principalId'] as const;

/**
 * Caller-supplied actor fields are accepted only when they restate the
 * verified caller. Any other value is an attempt to choose an identity.
 */
export function rejectCallerActor(input: unknown, principal: VerifiedPrincipal): void {
  if (!input || typeof input !== 'object') return;
  const record = input as Record<string, unknown>;
  for (const field of ACTOR_FIELDS) {
    const value = record[field];
    if (value !== undefined && value !== principal.principalId) {
      throw new ServiceMigrationError(`Caller-supplied "${field}" cannot establish identity; the actor is the verified principal.`);
    }
  }
  if (record.principal !== undefined) {
    throw new ServiceMigrationError('Caller-supplied "principal" cannot establish identity.');
  }
  if (record.scopes !== undefined && !(Array.isArray(record.scopes) && record.scopes.length === 0)) {
    throw new ServiceMigrationError('Caller-supplied scopes do not grant authority.');
  }
}

/** Tenant is resolved from the verified principal; a different caller-supplied tenant is a cross-tenant request. */
export function resolveTenant(input: unknown, principal: VerifiedPrincipal): string {
  const supplied = input && typeof input === 'object' ? (input as Record<string, unknown>).tenantId : undefined;
  if (supplied !== undefined && supplied !== principal.tenantId) {
    throw new ServiceAuthorityError('DENIED', 'Cross-tenant service operation denied', { reason: 'tenant_mismatch' });
  }
  return principal.tenantId;
}

/** Durable identity an effect runs as, captured from an authorized execution context. */
export interface DurablePrincipal {
  readonly principalId: string;
  readonly principalType: string;
  readonly tenantId: string;
  readonly applicationId?: string;
  readonly delegationId?: string;
  readonly credentialId?: string;
  /**
   * AuthBoundry decision that authorized creating this record. A durable
   * principal is honoured only if allow-evidence for this decision exists.
   */
  readonly authorizedBy?: string;
}

export function toDurablePrincipal(principal: VerifiedPrincipal, delegationId = principal.delegationId, authorizedBy?: string): DurablePrincipal {
  return {
    principalId: principal.principalId,
    principalType: principal.principalType,
    tenantId: principal.tenantId,
    ...(principal.applicationId ? { applicationId: principal.applicationId } : {}),
    ...(delegationId ? { delegationId } : {}),
    ...(principal.credentialId ? { credentialId: principal.credentialId } : {}),
    ...(authorizedBy ? { authorizedBy } : {}),
  };
}
