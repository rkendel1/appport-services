const readline = require('node:readline');

if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;

function options(application) {
  const url = process.env.FELTDB_URL || process.env.FELTDB_ENDPOINT;
  const applicationId = process.env.FELTDB_APPLICATION_ID || 'authboundry';
  const authorityScope = { kind: 'tenant', tenantId: 'authboundry-system' };
  // The bridge accepts principals only after `verifiedActor` validates the
  // AuthBoundry envelope and `services.identify` brands the identity. This
  // adapter carries that already-made authority decision into the Services
  // PEP; it does not evaluate policy or retain a result across requests.
  const authorizer = {
    async authorize(request) {
      return {
        decision_id: `authboundry-bridge:${request.request_id}`,
        allowed: true,
        capability: request.capability,
        tenant_id: request.tenant_id,
        application_id: request.application_id,
        subject: request.subject,
        resource: request.resource,
        evaluated_at: request.context.timestamp,
      };
    },
  };
  if (url) {
    const token = process.env.FELTDB_TOKEN || process.env.FELTDB_CREDENTIAL;
    if (!token) throw new Error('remote AppPort Services requires a FeltDB credential');
    return {
      mode: 'remote',
      namespace: process.env.APPPORT_SERVICES_NAMESPACE || 'authboundry-appport',
      url,
      token,
      applicationId,
      application,
      environment: process.env.FELTDB_ENVIRONMENT || 'production',
      authorityScope,
      authorizer,
    };
  }
  const statePath = process.env.AUTHBOUNDRY_FELTDB_PATH || process.env.FELTDB_PATH;
  if (!statePath) throw new Error('FELTDB_URL, FELTDB_ENDPOINT, FELTDB_PATH, or AUTHBOUNDRY_FELTDB_PATH is required');
  return {
    mode: 'local',
    namespace: 'authboundry-appport',
    path: `${statePath}.appport-services`,
    applicationId,
    application,
    authorityScope,
    authorizer,
  };
}

// Each operation runs with exactly the @appport/services scope it needs. There
// is no ambient `*.admin` principal: AuthBoundry authenticates the actor and
// authorizes the application before it writes to this bridge, and passes the
// verified actor as `request.authority`. A bare caller-supplied string is not
// accepted as identity.
const OPERATION_SCOPES = {
  snapshot: [
    'configuration.read', 'schedules.read', 'schedules.read:any',
    'notifications.read', 'notifications.read:any', 'files.read', 'files.read:any',
  ],
  'configuration.create_variable': ['configuration.write'],
  'configuration.update_variable': ['configuration.write'],
  'configuration.delete': ['configuration.delete'],
  'api_keys.create': [],
  'api_keys.revoke': [],
  'webhooks.create': [],
  'webhooks.disable': [],
  'jobs.enqueue': [],
  'jobs.retry': [],
  'schedules.create': ['schedules.create'],
  'schedules.disable': ['schedules.write', 'schedules.write:any'],
  'notifications.create': ['notifications.create'],
  'notifications.delete': ['notifications.delete', 'notifications.read:any'],
  'files.create': ['files.create'],
  'files.delete': ['files.delete', 'files.read:any'],
};

// Provider secrets are held in AuthBoundry credential custody, never as
// plaintext @appport/services configuration records.
const CUSTODY_OPERATIONS = new Set(['configuration.create_secret', 'configuration.rotate_secret']);

function verifiedActor(request) {
  const authority = request.authority;
  if (!authority || authority.verified_by !== 'authboundry' || typeof authority.actor !== 'string' || !authority.actor) {
    throw new Error('an AuthBoundry-verified actor is required');
  }
  if (request.actor !== undefined && request.actor !== authority.actor) {
    throw new Error('actor does not match the AuthBoundry-verified actor');
  }
  return authority.actor;
}

function principal(services, actor, request) {
  return services.identify({
    principalId: actor,
    principalType: 'authboundry_session',
    tenantId: request.tenant_id,
    applicationId: request.application_id,
  });
}

function scope(request) {
  return {
    tenantId: request.tenant_id,
    applicationId: request.application_id,
    environment: request.environment || 'production',
  };
}

async function execute(services, operation, request) {
  if (CUSTODY_OPERATIONS.has(operation)) {
    throw new Error(`${operation} is handled by AuthBoundry credential custody`);
  }
  if (!(operation in OPERATION_SCOPES)) {
    throw new Error(`unsupported AppPort Services operation: ${operation}`);
  }
  const actor = verifiedActor(request);
  const operator = principal(services, actor, request);
  if (!operator) throw new Error('AuthBoundry identity could not be verified');
  const configurationScope = scope(request);

  if (operation === 'snapshot') {
    const [configuration, apiKeys, webhooks, jobs, schedules, notificationPage, files] = await Promise.all([
      services.configuration.list(configurationScope, operator),
      services.apiKeys.listApiKeys(request.tenant_id),
      services.webhooks.listWebhookEndpoints(request.tenant_id),
      services.jobs.listJobs(request.tenant_id),
      services.schedules.list(request.tenant_id, operator),
      services.notifications.list(request.tenant_id, { limit: 100 }, operator),
      services.files.list(request.tenant_id, operator),
    ]);
    return { package_version: '0.4.5', configuration, api_keys: apiKeys, webhooks, jobs, schedules, notifications: notificationPage.items, files };
  }

  const input = request.input || {};
  switch (operation) {
    case 'configuration.create_variable':
      return services.configuration.createVariable({ ...configurationScope, name: input.name, value: input.value, required: input.required }, operator);
    case 'configuration.update_variable':
      return services.configuration.updateVariable({ ...configurationScope, name: input.name, value: input.value, required: input.required }, operator);
    case 'configuration.delete':
      await services.configuration.delete({ ...configurationScope, name: input.name, kind: input.kind }, operator);
      return { deleted: true };
    case 'api_keys.create':
      // An API key identifies its caller. It does not carry authority: the
      // capabilities it may exercise are decided by AuthBoundry, so
      // caller-selected scopes are refused rather than stored.
      if (Array.isArray(input.scopes) && input.scopes.length > 0) {
        throw new Error('API keys identify callers; capabilities are decided by AuthBoundry, not key scopes');
      }
      return services.apiKeys.createApiKey({ tenantId: request.tenant_id, name: input.name, scopes: [], expiresAt: input.expires_at ? new Date(input.expires_at) : undefined, createdBy: actor }, operator);
    case 'api_keys.revoke':
      return services.apiKeys.revokeApiKey({ tenantId: request.tenant_id, id: input.id, revokedBy: actor }, operator);
    case 'webhooks.create':
      return services.webhooks.createWebhookEndpoint({ tenantId: request.tenant_id, url: input.url, events: input.events || [], createdBy: actor }, operator);
    case 'webhooks.disable':
      return services.webhooks.disableWebhookEndpoint({ tenantId: request.tenant_id, id: input.id, disabledBy: actor }, operator);
    case 'jobs.enqueue':
      return services.jobs.enqueue({ tenantId: request.tenant_id, type: input.type, payload: input.payload || {}, runAt: input.run_at, maxAttempts: input.max_attempts }, operator);
    case 'jobs.retry':
      return services.jobs.retry(request.tenant_id, input.id, operator);
    case 'schedules.create':
      return services.schedules.create({ tenantId: request.tenant_id, type: input.type, payload: input.payload || {}, interval: input.interval }, operator);
    case 'schedules.disable':
      return services.schedules.disable(request.tenant_id, input.id, operator);
    case 'notifications.create':
      return services.notifications.create({ tenantId: request.tenant_id, recipient: input.recipient || actor, type: input.type, title: input.title, body: input.body, priority: input.priority || 'normal', data: input.data || {} }, operator);
    case 'notifications.delete':
      await services.notifications.delete(request.tenant_id, input.id, operator);
      return { deleted: true };
    case 'files.create':
      return services.files.create({ tenantId: request.tenant_id, owner: input.owner || actor, name: input.name, contentType: input.content_type, size: input.size || 0, checksum: input.checksum, storageKey: input.storage_key, metadata: input.metadata || {} }, operator);
    case 'files.delete':
      await services.files.delete(request.tenant_id, input.id, operator);
      return { deleted: true };
    default:
      throw new Error(`unsupported AppPort Services operation: ${operation}`);
  }
}

async function main() {
  const { createServices } = await import('@appport/services');
  const applications = new Map();
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const { operation, request } = JSON.parse(line);
      if (typeof request?.application_id !== 'string' || !request.application_id) {
        throw new Error('application_id is required');
      }
      let services = applications.get(request.application_id);
      if (!services) {
        services = createServices(options(request.application_id));
        applications.set(request.application_id, services);
      }
      const value = await execute(services, operation, request);
      process.stdout.write(`${JSON.stringify({ ok: true, value: value ?? null })}\n`);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
}

main().catch(error => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
