/**
 * What AppPort Services stores, as FeltDB application-contract entries.
 *
 * An application-scoped FeltDB authority (Managed FeltDB) stores only the collections and
 * fields its promoted contract declares: a record with an undeclared field, or a value of
 * the wrong type, is refused. A host that runs services there composes these entries with
 * its own, exactly as it composes FeltDB's agent state (`FELTDB_AGENT_STATE_CONTRACT`):
 *
 *   const services = servicesContract(['files', 'jobs']);
 *   { collections: [...mine, ...services.collections], indexes: [...myIndexes, ...services.indexes] }
 *
 * The package owns these declarations; a host never lists the services' collections itself.
 * Each collection is declared once, here, with every field of the record its store writes.
 * Following FeltDB's convention, `id` is required text and every other field is nullable
 * and optional; numbers are `integer` where the service only ever writes counts or
 * versions. Policies stay the host's decision.
 *
 * Kept current by tests: tests/services-contract.test.ts drives every write path of every
 * service and requires each committed collection and field to be declared, with a value of
 * the declared type, and compares each declaration with the TypeScript type of the record
 * its store writes, so neither can change without the other.
 */

/** A FeltDB application-contract field (the shape of `ManifestField` in @feltdb/core). */
export interface ServicesContractField {
  readonly name: string;
  readonly type: 'text' | 'integer' | 'number' | 'boolean' | 'json';
  readonly required: boolean;
  readonly nullable: boolean;
}

/** A FeltDB application-contract collection (the shape of `ManifestCollection`). */
export interface ServicesContractCollection {
  readonly name: string;
  readonly fields: readonly ServicesContractField[];
}

export interface ServicesContractFragment {
  readonly collections: readonly ServicesContractCollection[];
  /** The services declare no indexes; present so a fragment composes like FeltDB's. */
  readonly indexes: readonly { readonly name: string; readonly collection: string; readonly fields: readonly string[] }[];
}

/** The services, by the names hosts enable them with. */
export type ServiceName = 'files' | 'notifications' | 'configuration' | 'apiKeys' | 'webhooks' | 'jobs' | 'schedules' | 'intelligence';
export const SERVICE_NAMES: readonly ServiceName[] = Object.freeze(['files', 'notifications', 'configuration', 'apiKeys', 'webhooks', 'jobs', 'schedules', 'intelligence']);

/** Bumped when a declaration changes in a way a promoted contract must follow. */
export const SERVICES_CONTRACT_VERSION = 1;

const collection = (name: string, spec: string): ServicesContractCollection => Object.freeze({
  name,
  fields: Object.freeze(spec.trim().split(/\s+/).map((entry) => {
    const [field, type] = entry.split(':') as [string, ServicesContractField['type']];
    return Object.freeze(field === 'id' ? { name: field, type, required: true, nullable: false } : { name: field, type, required: false, nullable: true });
  })),
});

/** Every collection the services store, each declared once. */
export const SERVICE_COLLECTIONS: Readonly<Record<string, ServicesContractCollection>> = Object.freeze(Object.fromEntries([
  // The gateway's evidence for every effect, whichever service runs it.
  collection('service_effect_evidence', `id:text application:text tenantId:text principalId:text principalType:text delegationId:text
    runId:text capability:text capabilityVersion:integer resource:text decision:text decisionId:text credentialRef:text
    credentialVersion:integer service:text provider:text requestId:text startedAt:text completedAt:text outcome:text failureCode:text`),
  collection('files', `id:text tenantId:text applicationId:text owner:text name:text contentType:text size:integer checksum:text
    storageKey:text metadata:json createdAt:text updatedAt:text deletedAt:text`),
  collection('file_audit_events', 'id:text type:text fileId:text tenantId:text owner:text principalId:text timestamp:text result:text'),
  collection('notifications', `id:text tenantId:text applicationId:text recipient:text type:text title:text body:text data:json source:json
    priority:text channels:json status:text idempotencyKey:text createdAt:text createdBy:text expiresAt:text deliveredAt:text
    failedAt:text expiredAt:text readAt:text acknowledgedAt:text dismissedAt:text`),
  collection('notification_deliveries', `id:text tenantId:text notificationId:text recipient:text channel:text status:text
    idempotencyKey:text attemptCount:integer maxAttempts:integer createdAt:text lastAttemptAt:text nextAttemptAt:text deliveredAt:text
    failedAt:text failureReason:text externalId:text`),
  collection('notification_audit_events', `id:text type:text notificationId:text tenantId:text recipient:text principalId:text
    timestamp:text result:text channel:text deliveryId:text`),
  collection('ConfigurationVariables', `id:text tenantId:text applicationId:text environment:text name:text value:text required:boolean
    createdAt:text updatedAt:text createdBy:text`),
  collection('ConfigurationSecrets', `id:text tenantId:text applicationId:text environment:text name:text credentialRef:text
    required:boolean createdAt:text updatedAt:text createdBy:text`),
  collection('ConfigurationAuditEvents', `id:text type:text tenantId:text applicationId:text environment:text name:text kind:text
    actor:text timestamp:text operation:text status:text`),
  collection('Secrets', `id:text tenantId:text name:text currentVersion:integer status:text providerRef:text provider:text accountId:text
    kind:text createdAt:text expiresAt:text revokedAt:text retiredAt:text createdBy:text`),
  collection('SecretVersions', `id:text secretId:text tenantId:text version:integer providerRef:text status:text createdAt:text
    expiresAt:text revokedAt:text createdBy:text`),
  collection('SecretAuditEvents', `id:text type:text secretId:text version:integer tenantId:text principalId:text timestamp:text
    result:text purpose:text provider:text reason:text`),
  collection('api_keys', `id:text tenantId:text applicationId:text name:text keyPrefix:text secretHash:text scopes:json restrictions:json
    createdAt:text expiresAt:text revokedAt:text revokedBy:text lastUsedAt:text updatedAt:text updatedBy:text rotatedFrom:text
    rotatedTo:text rotatedAt:text createdBy:text`),
  collection('api_key_prefixes', 'id:text apiKeyId:text tenantId:text createdAt:text'),
  collection('api_key_audit_events', `id:text type:text credentialId:text tenantId:text principalId:text timestamp:text result:text
    changes:json relatedCredentialId:text`),
  collection('webhook_endpoints', `id:text tenantId:text applicationId:text url:text events:json signingCredentialRef:text createdAt:text
    createdBy:text disabledAt:text`),
  collection('webhook_deliveries', `id:text tenantId:text endpointId:text eventId:text eventType:text payload:json status:text
    attemptCount:integer nextAttemptAt:text createdAt:text lastAttemptAt:text deliveredAt:text lastStatusCode:integer lastError:text
    principal:json`),
  collection('webhook_audit_events', `id:text type:text endpointId:text deliveryId:text integrationId:text tenantId:text principalId:text
    timestamp:text result:text reason:text`),
  collection('webhook_integrations', `id:text tenantId:text applicationId:text provider:text principalId:text signingCredentialRef:text
    createdAt:text createdBy:text disabledAt:text`),
  collection('inbound_webhook_events', 'id:text integrationId:text provider:text eventId:text eventTimestamp:text acceptedAt:text tenantId:text'),
  collection('jobs', `id:text tenantId:text applicationId:text type:text payload:json status:text runAt:text attemptCount:integer
    maxAttempts:integer createdAt:text startedAt:text completedAt:text nextAttemptAt:text leaseOwner:text leaseExpiresAt:text
    lastError:text principal:json`),
  collection('job_schedules', `id:text tenantId:text applicationId:text type:text payload:json interval:text nextRunAt:text enabled:boolean
    createdAt:text createdBy:text principal:json`),
  collection('job_audit_events', 'id:text type:text jobId:text scheduleId:text tenantId:text principalId:text timestamp:text result:text details:json'),
].map((c) => [c.name, c])));

/** Stored by every service: the gateway records evidence for each effect. */
const SHARED = ['service_effect_evidence'] as const;

/**
 * What each service stores, and the services it needs. Intelligence keeps its selection in
 * configuration's collections; configuration's credential writes keep secret metadata;
 * schedules create jobs.
 */
export const SERVICE_REQUIREMENTS: Readonly<Record<ServiceName, { readonly collections: readonly string[]; readonly requires: readonly ServiceName[] }>> = Object.freeze({
  files: { collections: ['files', 'file_audit_events'], requires: [] },
  notifications: { collections: ['notifications', 'notification_deliveries', 'notification_audit_events'], requires: [] },
  configuration: { collections: ['ConfigurationVariables', 'ConfigurationSecrets', 'ConfigurationAuditEvents', 'Secrets', 'SecretVersions', 'SecretAuditEvents'], requires: [] },
  apiKeys: { collections: ['api_keys', 'api_key_prefixes', 'api_key_audit_events'], requires: [] },
  webhooks: { collections: ['webhook_endpoints', 'webhook_deliveries', 'webhook_audit_events', 'webhook_integrations', 'inbound_webhook_events'], requires: [] },
  jobs: { collections: ['jobs', 'job_audit_events'], requires: [] },
  schedules: { collections: ['job_schedules'], requires: ['jobs'] },
  intelligence: { collections: ['ConfigurationVariables', 'ConfigurationSecrets', 'ConfigurationAuditEvents'], requires: [] },
});

/**
 * The contract entries for `services` (and the services they need): every collection they
 * store, each once, in name order, so the same set always yields the same fragment,
 * whatever order it is given in. No services, no entries. An unknown name is refused.
 */
export function servicesContract(services: Iterable<ServiceName> | 'all'): ServicesContractFragment {
  const wanted = new Set<ServiceName>();
  const add = (name: ServiceName) => {
    if (!(name in SERVICE_REQUIREMENTS)) throw new TypeError(`Unknown AppPort service "${String(name)}". Services: ${SERVICE_NAMES.join(', ')}.`);
    if (wanted.has(name)) return;
    wanted.add(name);
    for (const required of SERVICE_REQUIREMENTS[name].requires) add(required);
  };
  for (const name of services === 'all' ? SERVICE_NAMES : services) add(name);
  if (wanted.size === 0) return Object.freeze({ collections: Object.freeze([]), indexes: Object.freeze([]) });
  const names = new Set<string>(SHARED);
  for (const name of wanted) for (const c of SERVICE_REQUIREMENTS[name].collections) names.add(c);
  return Object.freeze({
    collections: Object.freeze([...names].sort().map((name) => SERVICE_COLLECTIONS[name]!)),
    indexes: Object.freeze([]),
  });
}
