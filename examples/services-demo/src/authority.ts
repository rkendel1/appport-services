import type { ServiceAuthorizationDecision, ServiceAuthorizationRequest, ServiceAuthorizer } from '@appport/runtime';

/**
 * DEVELOPMENT ONLY. A stand-in for your AuthBoundry client that allows the
 * capabilities this demo uses. AppPort Services enforces tenant and
 * application ownership before asking, and never decides on its own.
 */
const DEMO_CAPABILITIES = new Set(['webhooks.emit', 'webhooks.deliver', 'jobs.create', 'jobs.execute']);

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
    };
  },
};
