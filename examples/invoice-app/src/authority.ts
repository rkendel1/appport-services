import type {
  AppPortServices,
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
