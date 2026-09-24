import { randomUUID } from 'node:crypto';

import type { StateFirstDB } from '@feltdb/core';

import type { ServiceAuthorizationDecision, ServiceAuthorizationRequest, ServiceAuthorizer } from '../../src/authority/authorizer.js';
import { FeltDbEffectEvidenceStore } from '../../src/authority/evidence.js';
import { ServiceGateway } from '../../src/authority/gateway.js';
import { mintVerifiedPrincipal, type PrincipalClaims, type PrincipalVerification, type VerifiedPrincipal } from '../../src/authority/principal.js';
import { SecretResolutionDeniedError, SecretRevokedError, SecretNotFoundError, SecretTenantMismatchError } from '../../src/secrets/errors.js';
import type { ResolvedSecret, ScopedResolveSecretInput, ScopedSecretsResolver } from '../../src/secrets/index.js';

export interface Grant {
  readonly subject: string;
  readonly capability: string;
  readonly tenantId?: string;
  readonly delegationId?: string;
  /** Match resource attributes exactly (e.g. owner). */
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * Test AuthBoundry. Grants live in an array by default, or in a FeltDB
 * collection when `db` is given (to prove revocation survives restart).
 * `allowAll` models a permissive policy for functional tests.
 */
export class TestAuthority implements ServiceAuthorizer {
  readonly requests: ServiceAuthorizationRequest[] = [];
  mode: 'grants' | 'allow-all' | 'unavailable' | 'hang' = 'grants';
  delayMs = 0;
  private readonly grants: Grant[] = [];
  private readonly revokedDelegations = new Set<string>();

  constructor(private readonly options: { readonly allowAll?: boolean; readonly db?: StateFirstDB } = {}) {
    if (options.allowAll) this.mode = 'allow-all';
  }

  async grant(grant: Grant): Promise<void> {
    if (this.options.db) await this.options.db.collection<Grant & { id: string }>('test_authboundry_grants').insert({ ...grant, id: randomUUID() });
    else this.grants.push(grant);
  }

  clearGrants(): void {
    this.grants.length = 0;
  }

  async revokeDelegation(delegationId: string): Promise<void> {
    if (this.options.db) await this.options.db.collection<{ id: string }>('test_authboundry_revocations').insert({ id: delegationId }, delegationId);
    else this.revokedDelegations.add(delegationId);
  }

  async authorize(request: ServiceAuthorizationRequest, options: { readonly signal: AbortSignal }): Promise<ServiceAuthorizationDecision> {
    this.requests.push(request);
    if (this.mode === 'unavailable') throw new Error('authboundry down');
    if (this.mode === 'hang') await new Promise((resolve) => options.signal.addEventListener('abort', resolve));
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const allowed = this.mode === 'allow-all' ? !(await this.isRevoked(request.context.delegation_id)) : await this.matches(request);
    return decision(request, allowed);
  }

  private async isRevoked(delegationId?: string): Promise<boolean> {
    if (!delegationId) return false;
    if (this.options.db) return Boolean(await this.options.db.collection('test_authboundry_revocations').get(delegationId));
    return this.revokedDelegations.has(delegationId);
  }

  private async matches(request: ServiceAuthorizationRequest): Promise<boolean> {
    if (await this.isRevoked(request.context.delegation_id)) return false;
    const grants = this.options.db ? await this.options.db.collection<Grant>('test_authboundry_grants').list() : this.grants;
    return grants.some((grant) => grant.subject === request.subject.id
      && grant.capability === request.capability
      && (grant.tenantId === undefined || grant.tenantId === request.tenant_id)
      && (grant.delegationId === undefined || grant.delegationId === request.context.delegation_id)
      && Object.entries(grant.attributes ?? {}).every(([key, value]) => request.resource.attributes?.[key] === value));
  }
}

export function decision(request: ServiceAuthorizationRequest, allowed: boolean): ServiceAuthorizationDecision {
  return {
    decision_id: `dec_${randomUUID()}`,
    allowed,
    capability: request.capability,
    tenant_id: request.tenant_id,
    application_id: request.application_id,
    subject: request.subject,
    resource: request.resource,
    reason: allowed ? 'granted' : 'no_grant',
    policy_version: 'test-1',
    evaluated_at: Date.now(),
  };
}

/** Test AuthBoundry credential custody. It refuses resolution without an authorization reference. */
export class TestCredentials implements ScopedSecretsResolver<unknown> {
  readonly resolutions: ScopedResolveSecretInput[] = [];
  private readonly secrets = new Map<string, { value: unknown; tenantId: string; revoked?: boolean }>();

  put(secretId: string, tenantId: string, value: unknown): string {
    this.secrets.set(secretId, { value, tenantId });
    return `credential-ref:${secretId}`;
  }

  revoke(secretId: string): void {
    const secret = this.secrets.get(secretId);
    if (secret) secret.revoked = true;
  }

  async withSecret<TResult>(input: ScopedResolveSecretInput, use: (secret: ResolvedSecret<unknown>) => TResult | Promise<TResult>): Promise<TResult> {
    this.resolutions.push(input);
    if (!input.context.authorizationRef) throw new SecretResolutionDeniedError(input.reference.secretId);
    const secret = this.secrets.get(input.reference.secretId);
    if (!secret) throw new SecretNotFoundError(input.reference.secretId);
    if (secret.tenantId !== input.reference.tenantId || secret.tenantId !== input.context.tenantId) throw new SecretTenantMismatchError(input.reference.secretId);
    if (secret.revoked) throw new SecretRevokedError(input.reference.secretId);
    return use({ value: secret.value, secretId: input.reference.secretId, version: 1 });
  }
}

export function principal(claims: Partial<PrincipalClaims> & { principalId?: string } = {}, verifiedBy: PrincipalVerification = 'host'): VerifiedPrincipal {
  return mintVerifiedPrincipal({
    principalId: claims.principalId ?? 'user-1',
    principalType: claims.principalType ?? 'user',
    tenantId: claims.tenantId ?? 'tenant-a',
    ...(claims.applicationId ? { applicationId: claims.applicationId } : {}),
    ...(claims.delegationId ? { delegationId: claims.delegationId } : {}),
    ...(claims.credentialId ? { credentialId: claims.credentialId } : {}),
  }, verifiedBy);
}

export function testGateway(db: StateFirstDB, options: { authorizer?: ServiceAuthorizer; credentials?: ScopedSecretsResolver; application?: string; timeoutMs?: number } = {}): ServiceGateway {
  return new ServiceGateway({
    application: options.application ?? 'test-app',
    authorizer: options.authorizer ?? new TestAuthority({ allowAll: true }),
    credentials: options.credentials,
    evidence: new FeltDbEffectEvidenceStore(db),
    authorizationTimeoutMs: options.timeoutMs,
  });
}

/** Permissive loopback policy for tests that deliver to local servers. */
export const LOCAL_DESTINATIONS = { allowPrivateNetworks: true } as const;
