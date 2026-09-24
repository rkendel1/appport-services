import { randomUUID } from 'node:crypto';

import type { ResolvedSecret, ScopedSecretsResolver, SecretReference } from '../secrets/index.js';
import { SecretError } from '../secrets/errors.js';
import type { ServiceAuthorizationDecision, ServiceAuthorizationRequest, ServiceAuthorizer } from './authorizer.js';
import { assertExecutionContext, mintExecutionContext, resourceUri, type ServiceExecutionContext, type ServiceResource } from './context.js';
import { credentialReference, type CredentialRef } from './credentials.js';
import { ServiceAuthorityError, isServiceAuthorityError } from './errors.js';
import type { EffectEvidence, EffectEvidenceStore } from './evidence.js';
import { getServiceCapability } from './manifest.js';
import { mintVerifiedPrincipal, requireVerifiedPrincipal, type DurablePrincipal, type PrincipalClaims, type VerifiedPrincipal } from './principal.js';

const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 5_000;
const CONTEXT_TTL_MS = 60_000;

export interface ServiceGatewayOptions {
  /** Application this gateway enforces for. Requests from other applications are denied. */
  readonly application: string;
  /** AuthBoundry client. Without one every protected operation fails with AUTHORITY_UNAVAILABLE. */
  readonly authorizer?: ServiceAuthorizer;
  /** AuthBoundry credential custody. Without one no provider credential can be resolved. */
  readonly credentials?: ScopedSecretsResolver;
  readonly evidence: EffectEvidenceStore;
  readonly authorizationTimeoutMs?: number;
  readonly now?: () => Date;
}

export interface ExecuteOptions {
  readonly service: string;
  readonly provider?: string;
  readonly credentialRef?: CredentialRef;
  readonly requestId?: string;
}

export interface EffectTools {
  /** Resolve a credential through AuthBoundry custody for this authorized effect only. */
  withCredential<T>(ref: CredentialRef, purpose: string, use: (secret: ResolvedSecret) => T | Promise<T>): Promise<T>;
}

/**
 * Policy Enforcement Point for every protected service operation.
 *
 * Order is fixed: validate request, require a verified principal, enforce
 * tenant/application ownership, resolve the declared capability, ask
 * AuthBoundry, then (only when allowed) resolve credentials and perform the
 * effect, recording durable evidence. Nothing here caches grants,
 * decisions, delegation status, or credential validity.
 */
export class ServiceGateway {
  readonly application: string;
  private readonly authorizer?: ServiceAuthorizer;
  private readonly credentials?: ScopedSecretsResolver;
  private readonly evidence: EffectEvidenceStore;
  private readonly timeoutMs: number;
  private readonly now: () => Date;

  constructor(options: ServiceGatewayOptions) {
    if (!options.application?.trim()) throw new Error('ServiceGateway requires an application');
    this.application = options.application;
    this.authorizer = options.authorizer;
    this.credentials = options.credentials;
    this.evidence = options.evidence;
    this.timeoutMs = options.authorizationTimeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** Brand identity claims produced by a trusted host authentication adapter. */
  identify(claims: PrincipalClaims | null | undefined): VerifiedPrincipal | null {
    if (!claims) return null;
    // Minting copies identity fields only; any scopes on host claims are dropped.
    if (claims.applicationId && claims.applicationId !== this.application) {
      throw new ServiceAuthorityError('DENIED', 'Identity belongs to a different application', { reason: 'application_mismatch' });
    }
    return mintVerifiedPrincipal(claims, 'host');
  }

  /** Ask AuthBoundry and return a single-use execution context. Does not perform or record an effect. */
  async authorize(capabilityName: string, principalInput: unknown, resource: ServiceResource, requestId: string = randomUUID()): Promise<ServiceExecutionContext> {
    const capability = getServiceCapability(capabilityName);
    if (!capability) throw new ServiceAuthorityError('INVALID_REQUEST', `Capability "${capabilityName}" is not declared in the service capability manifest`);
    const principal = requireVerifiedPrincipal(principalInput);
    this.assertOwnership(principal, resource, capabilityName);
    const uri = resourceUri(this.application, resource);
    const request: ServiceAuthorizationRequest = {
      request_id: requestId,
      subject: { kind: principal.principalType, id: principal.principalId },
      tenant_id: resource.tenantId,
      application_id: this.application,
      capability: capability.name,
      capability_version: capability.version,
      resource: { uri, ...(resource.attributes ? { attributes: { ...resource.attributes } } : {}) },
      context: {
        timestamp: this.now().getTime(),
        execution_id: requestId,
        verified_by: principal.verifiedBy,
        ...(principal.delegationId ? { delegation_id: principal.delegationId } : {}),
        ...(principal.runId ? { run_id: principal.runId } : {}),
        ...(principal.credentialId ? { credential_id: principal.credentialId } : {}),
      },
    };
    const decision = await this.decide(request);
    if (decision.allowed !== true) {
      throw new ServiceAuthorityError('DENIED', `AuthBoundry denied ${capability.name}`, { capability: capability.name, decisionId: decision.decision_id, reason: decision.reason });
    }
    return mintExecutionContext({
      application: this.application,
      tenantId: resource.tenantId,
      principal,
      capability: capability.name,
      capabilityVersion: capability.version,
      requestId,
      resource,
      resourceUri: uri,
      authorization: {
        decision: 'allow',
        decisionId: decision.decision_id,
        decidedAt: this.now().toISOString(),
        ...(decision.policy_version ? { policyVersion: decision.policy_version } : {}),
        ...(decision.reason ? { reason: decision.reason } : {}),
      },
      expiresAt: new Date(this.now().getTime() + CONTEXT_TTL_MS).toISOString(),
    });
  }

  /**
   * Authorize and perform one effect. Denials and authority failures are
   * recorded without executing; successful and failed effects are recorded
   * with their outcome.
   */
  async execute<T>(capabilityName: string, principalInput: unknown, resource: ServiceResource, options: ExecuteOptions, effect: (context: ServiceExecutionContext, tools: EffectTools) => Promise<T>): Promise<T> {
    const requestId = options.requestId ?? randomUUID();
    const startedAt = this.now().toISOString();
    let context: ServiceExecutionContext;
    try {
      context = await this.authorize(capabilityName, principalInput, resource, requestId);
    } catch (error) {
      await this.recordRefusal(capabilityName, principalInput, resource, options, requestId, startedAt, error);
      throw error;
    }
    return this.run(context, options, effect, startedAt);
  }

  /** Perform an effect under an already-issued context (used by transactions and job runs). */
  async run<T>(contextInput: ServiceExecutionContext, options: ExecuteOptions, effect: (context: ServiceExecutionContext, tools: EffectTools) => Promise<T>, startedAt = this.now().toISOString()): Promise<T> {
    const context = assertExecutionContext(contextInput, contextInput?.capability, undefined, this.now());
    const evidenceId = randomUUID();
    await this.evidence.record(this.evidenceFor(context, options, evidenceId, startedAt, 'started'));
    const resolvedRefs: CredentialRef[] = [];
    const tools: EffectTools = {
      withCredential: (ref, purpose, use) => {
        resolvedRefs.push(ref);
        return this.withCredential(context, ref, purpose, use, options.provider);
      },
    };
    try {
      const result = await effect(context, tools);
      await this.evidence.complete(evidenceId, { outcome: 'succeeded', completedAt: this.now().toISOString(), ...refUpdate(options, resolvedRefs) });
      return result;
    } catch (error) {
      const outcome = isServiceAuthorityError(error)
        ? (error.code === 'PROVIDER_ERROR' ? 'provider_error' : error.code === 'DENIED' ? 'denied' : 'failed')
        : 'failed';
      await this.evidence.complete(evidenceId, {
        outcome,
        completedAt: this.now().toISOString(),
        failureCode: isServiceAuthorityError(error) ? error.code : 'EFFECT_FAILED',
        ...refUpdate(options, resolvedRefs),
      }).catch(() => undefined);
      throw error;
    }
  }

  /** Record evidence for an effect already committed atomically elsewhere (transactions). */
  evidenceFor(context: ServiceExecutionContext, options: ExecuteOptions, id: string, startedAt: string, outcome: EffectEvidence['outcome']): EffectEvidence {
    return {
      id,
      application: context.application,
      tenantId: context.tenantId,
      principalId: context.principal.principalId,
      principalType: context.principal.principalType,
      ...(context.principal.delegationId ? { delegationId: context.principal.delegationId } : {}),
      ...(context.principal.runId ? { runId: context.principal.runId } : {}),
      capability: context.capability,
      capabilityVersion: context.capabilityVersion,
      resource: context.resourceUri,
      decision: 'allow',
      decisionId: context.authorization.decisionId,
      ...(options.credentialRef ? { credentialRef: options.credentialRef } : {}),
      service: options.service,
      ...(options.provider ? { provider: options.provider } : {}),
      requestId: context.requestId,
      startedAt,
      ...(outcome === 'started' ? {} : { completedAt: startedAt }),
      outcome,
    };
  }

  /**
   * Resolve a credential through AuthBoundry custody. Only callable with a
   * live execution context: credential access never precedes authorization.
   */
  async withCredential<T>(contextInput: ServiceExecutionContext, ref: CredentialRef, purpose: string, use: (secret: ResolvedSecret) => T | Promise<T>, provider?: string): Promise<T> {
    const context = assertExecutionContext(contextInput, contextInput?.capability, undefined, this.now());
    if (!this.credentials) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'No AuthBoundry credential resolver is configured', { capability: context.capability });
    const reference: SecretReference = credentialReference(ref, context.tenantId, provider);
    const marker = { failed: false as boolean, error: undefined as unknown };
    try {
      return await this.credentials.withSecret({
        reference,
        context: { tenantId: context.tenantId, principalId: context.principal.principalId, purpose, authorizationRef: context.authorization.decisionId },
      }, async (secret) => {
        try {
          return await use(secret);
        } catch (error) {
          marker.failed = true;
          marker.error = error;
          throw error;
        }
      });
    } catch (error) {
      if (marker.failed) throw marker.error;
      throw mapCredentialFailure(error, context.capability);
    }
  }

  /**
   * A durable principal (on a job, schedule, or delivery) is identity only if
   * it is bound to allow-evidence of the authorized effect that created it.
   * A record written any other way is not honoured.
   */
  async attest(durable: DurablePrincipal | undefined, creatingCapabilities: readonly string[]): Promise<void> {
    if (!durable?.authorizedBy) {
      throw new ServiceAuthorityError('DENIED', 'Durable principal is not bound to an AuthBoundry decision', { reason: 'unattested_principal' });
    }
    const rows = await this.evidence.findByDecision(durable.authorizedBy);
    const attested = rows.some((row) => row.decision === 'allow'
      && row.application === this.application
      && row.tenantId === durable.tenantId
      && row.principalId === durable.principalId
      && row.principalType === durable.principalType
      && creatingCapabilities.includes(row.capability)
      && (row.outcome === 'started' || row.outcome === 'succeeded'));
    if (!attested) {
      throw new ServiceAuthorityError('DENIED', 'Durable principal does not match an authorized effect', { reason: 'unattested_principal', decisionId: durable.authorizedBy });
    }
  }

  private assertOwnership(principal: VerifiedPrincipal, resource: ServiceResource, capability: string): void {
    if (!resource.tenantId || principal.tenantId !== resource.tenantId) {
      throw new ServiceAuthorityError('DENIED', 'Cross-tenant service operation denied', { capability, reason: 'tenant_mismatch' });
    }
    if (principal.applicationId && principal.applicationId !== this.application) {
      throw new ServiceAuthorityError('DENIED', 'Principal belongs to a different application', { capability, reason: 'application_mismatch' });
    }
  }

  private async decide(request: ServiceAuthorizationRequest): Promise<ServiceAuthorizationDecision> {
    const authorizer = this.authorizer;
    if (!authorizer) {
      throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'No AuthBoundry authorizer is configured; service effects are disabled', { capability: request.capability });
    }
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    // A late answer after the timeout settles nothing: the race has already
    // rejected and the decision promise's result is discarded.
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ServiceAuthorityError('AUTHORIZATION_TIMEOUT', `AuthBoundry did not decide ${request.capability} within ${this.timeoutMs}ms`, { capability: request.capability }));
      }, this.timeoutMs);
    });
    const decision = (async () => {
      try {
        return await authorizer.authorize(request, { signal: controller.signal });
      } catch (error) {
        if (isServiceAuthorityError(error)) throw error;
        throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'AuthBoundry authorization failed', { capability: request.capability });
      }
    })();
    try {
      const result = await Promise.race([decision, timeout]);
      validateDecision(request, result);
      return result;
    } finally {
      clearTimeout(timer);
      decision.catch(() => undefined);
    }
  }

  private async recordRefusal(capability: string, principalInput: unknown, resource: ServiceResource, options: ExecuteOptions, requestId: string, startedAt: string, error: unknown): Promise<void> {
    if (!isServiceAuthorityError(error) || error.code === 'INVALID_REQUEST' || error.code === 'UNAUTHENTICATED') return;
    const principal = principalInput as VerifiedPrincipal;
    await this.evidence.record({
      id: randomUUID(),
      application: this.application,
      tenantId: resource.tenantId,
      principalId: principal.principalId,
      principalType: principal.principalType,
      ...(principal.delegationId ? { delegationId: principal.delegationId } : {}),
      ...(principal.runId ? { runId: principal.runId } : {}),
      capability,
      capabilityVersion: getServiceCapability(capability)?.version ?? 0,
      resource: resourceUri(this.application, resource),
      decision: error.details.decisionId ? 'deny' : 'none',
      ...(error.details.decisionId ? { decisionId: error.details.decisionId } : {}),
      service: options.service,
      ...(options.provider ? { provider: options.provider } : {}),
      requestId,
      startedAt,
      completedAt: this.now().toISOString(),
      outcome: 'denied',
      failureCode: error.code,
    }).catch(() => undefined);
  }
}

function refUpdate(options: ExecuteOptions, resolved: readonly CredentialRef[]): { credentialRef?: CredentialRef } {
  const ref = options.credentialRef ?? resolved[0];
  return ref ? { credentialRef: ref } : {};
}

function validateDecision(request: ServiceAuthorizationRequest, decision: ServiceAuthorizationDecision): void {
  const valid = decision
    && typeof decision.decision_id === 'string' && decision.decision_id.length > 0
    && typeof decision.allowed === 'boolean'
    && decision.capability === request.capability
    && decision.tenant_id === request.tenant_id
    && decision.application_id === request.application_id
    && decision.subject?.id === request.subject.id
    && decision.resource?.uri === request.resource.uri;
  if (!valid) {
    throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'AuthBoundry returned a decision that does not match the request', { capability: request.capability });
  }
}

function mapCredentialFailure(error: unknown, capability: string): ServiceAuthorityError {
  if (isServiceAuthorityError(error)) return error;
  const code = error instanceof SecretError ? error.code : undefined;
  switch (code) {
    case 'secret_resolution_denied':
    case 'tenant_mismatch':
    case 'provider_mismatch':
      return new ServiceAuthorityError('DENIED', 'Credential resolution denied by AuthBoundry', { capability, reason: code });
    case 'secret_revoked':
    case 'secret_inactive':
    case 'secret_expired':
      return new ServiceAuthorityError('DENIED', 'Credential is revoked or inactive', { capability, reason: code });
    case 'secret_not_found':
      return new ServiceAuthorityError('DENIED', 'Credential reference is unknown', { capability, reason: code });
    default:
      return new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Credential custody is unavailable', { capability, reason: code ?? 'unknown' });
  }
}
