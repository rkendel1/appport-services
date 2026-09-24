import { ServiceAuthorityError } from './errors.js';
import type { VerifiedPrincipal } from './principal.js';

export interface ServiceResource {
  readonly type: string;
  readonly tenantId: string;
  readonly id?: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface AuthorizationEvidence {
  readonly decision: 'allow';
  readonly decisionId: string;
  readonly decidedAt: string;
  readonly policyVersion?: string;
  readonly reason?: string;
}

/**
 * Authoritative context for one protected service operation. Only the
 * service gateway mints these, after AuthBoundry allowed the exact
 * principal + capability + resource. It is frozen, short-lived, and bound to
 * the capability it was issued for.
 */
export interface ServiceExecutionContext {
  readonly application: string;
  readonly tenantId: string;
  readonly principal: VerifiedPrincipal;
  readonly capability: string;
  readonly capabilityVersion: number;
  readonly requestId: string;
  readonly resource: ServiceResource;
  readonly resourceUri: string;
  readonly authorization: AuthorizationEvidence;
  readonly expiresAt: string;
}

const issued = new WeakSet<object>();
const consumed = new WeakSet<object>();

/** @internal Only the service gateway mints execution contexts. */
export function mintExecutionContext(context: ServiceExecutionContext): ServiceExecutionContext {
  const frozen = Object.freeze({ ...context, resource: freezeResource(context.resource), authorization: Object.freeze({ ...context.authorization }) });
  issued.add(frozen);
  return frozen;
}

export function isExecutionContext(value: unknown): value is ServiceExecutionContext {
  return typeof value === 'object' && value !== null && issued.has(value);
}

/** Validate that a context was issued by the gateway for this capability and tenant and is still live. */
export function assertExecutionContext(value: unknown, capability: string, tenantId?: string, now = new Date()): ServiceExecutionContext {
  if (!isExecutionContext(value)) {
    throw new ServiceAuthorityError('UNAUTHENTICATED', 'A gateway-issued execution context is required', { capability });
  }
  if (value.capability !== capability) {
    throw new ServiceAuthorityError('DENIED', `Execution context was authorized for ${value.capability}, not ${capability}`, { capability });
  }
  if (tenantId !== undefined && value.tenantId !== tenantId) {
    throw new ServiceAuthorityError('DENIED', 'Cross-tenant service operation denied', { capability, reason: 'tenant_mismatch' });
  }
  if (new Date(value.expiresAt).getTime() <= now.getTime()) {
    throw new ServiceAuthorityError('DENIED', 'Execution context has expired', { capability, decisionId: value.authorization.decisionId });
  }
  return value;
}

/** Mark a context as used. A context authorizes one effect only. */
export function consumeExecutionContext(value: unknown, capability: string, tenantId?: string): ServiceExecutionContext {
  const context = assertExecutionContext(value, capability, tenantId);
  if (consumed.has(context)) {
    throw new ServiceAuthorityError('DENIED', 'Execution context has already been used', { capability, decisionId: context.authorization.decisionId });
  }
  consumed.add(context);
  return context;
}

export function resourceUri(application: string, resource: ServiceResource): string {
  const segment = (value: string) => encodeURIComponent(value);
  return `appport://${segment(application)}/tenants/${segment(resource.tenantId)}/${segment(resource.type)}/${segment(resource.id ?? '*')}`;
}

function freezeResource(resource: ServiceResource): ServiceResource {
  return Object.freeze({ ...resource, ...(resource.attributes ? { attributes: Object.freeze({ ...resource.attributes }) } : {}) });
}
