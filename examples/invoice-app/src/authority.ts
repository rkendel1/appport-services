import type {
  AppPortServices,
  ResolvedSecret,
  ScopedResolveSecretInput,
  ScopedSecretsResolver,
  ServiceAuthorizationDecision,
  ServiceAuthorizationRequest,
  ServiceAuthorizer,
  ServiceExecutionContext,
  VerifiedPrincipal,
  WebhookDestinationPolicy,
} from '@appport/services';

/**
 * DEVELOPMENT ONLY. A stand-in for your AuthBoundry client.
 *
 * AppPort Services never decides who may cause an effect; it asks the
 * configured ServiceAuthorizer. This stand-in allows exactly the capabilities
 * the invoice demo uses. The gateway has already enforced tenant and
 * application ownership before this is called. Replace it with a real
 * AuthBoundry client in any deployed environment.
 */
const DEMO_CAPABILITIES = new Set([
  'webhooks.register', 'webhooks.read', 'webhooks.emit', 'webhooks.deliver',
  'jobs.create', 'jobs.read', 'jobs.execute',
]);

export const developmentAuthorizer: ServiceAuthorizer = {
  async authorize(request: ServiceAuthorizationRequest): Promise<ServiceAuthorizationDecision> {
    const allowed = DEMO_CAPABILITIES.has(request.capability);
    return {
      decision_id: `dev_${crypto.randomUUID()}`,
      allowed,
      capability: request.capability,
      tenant_id: request.tenant_id,
      application_id: request.application_id,
      subject: request.subject,
      resource: request.resource,
      reason: allowed ? 'development allow-list' : 'not in development allow-list',
      policy_version: 'invoice-demo-dev',
    };
  },
};

/** The demo signs webhooks with a credential held outside service configuration. */
export const DEMO_SIGNING_REF = 'credential-ref:invoice-demo-webhook-signing';

/**
 * DEVELOPMENT ONLY. A stand-in for AuthBoundry credential custody. It
 * resolves the demo signing secret from the environment, and only for a
 * request that carries an authorization decision. Replace it with your
 * AuthBoundry credential resolver.
 */
export const developmentCredentials: ScopedSecretsResolver = {
  async withSecret<T>(input: ScopedResolveSecretInput, use: (secret: ResolvedSecret) => T | Promise<T>): Promise<T> {
    if (!input.context.authorizationRef) throw new Error('credential resolution requires an authorization decision');
    if (`credential-ref:${input.reference.secretId}` !== DEMO_SIGNING_REF) throw new Error(`unknown credential ${input.reference.secretId}`);
    const value = process.env.INVOICE_WEBHOOK_SIGNING_SECRET;
    if (!value) throw new Error('INVOICE_WEBHOOK_SIGNING_SECRET is not set');
    return use({ value, secretId: input.reference.secretId, version: 1 });
  },
};

/** Local development delivers to localhost; never set this in production. */
export const DEVELOPMENT_DESTINATIONS: WebhookDestinationPolicy = { allowPrivateNetworks: true };

/** The demo's own service identity, established by the host (this process), not by request input. */
export function invoiceAppPrincipal(services: AppPortServices, tenantId: string): VerifiedPrincipal {
  const principal = services.identify({ principalId: 'invoice-app', principalType: 'service', tenantId });
  if (!principal) throw new Error('invoice-app identity unavailable');
  return principal;
}

/** Pre-authorize the webhook fan-out and job enqueue that an invoice transaction performs. */
export async function authorizeInvoiceEffects(services: AppPortServices, principal: VerifiedPrincipal): Promise<{ emit: ServiceExecutionContext; enqueue: ServiceExecutionContext }> {
  return {
    emit: await services.authorize('webhooks.emit', principal, { type: 'webhook_event', attributes: { eventType: 'invoice.created' } }),
    enqueue: await services.authorize('jobs.create', principal, { type: 'job', attributes: { jobType: 'invoice.process' } }),
  };
}
