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
 * Every store reads within a tenant (`where tenantId = …`). An application-scoped authority
 * answers a query filtered on a tenant-scope field only through a schema-declared equality
 * index, so each collection declares one on `tenantId` (`<collection>_by_tenant`).
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

/** A FeltDB application-contract equality index. */
export interface ServicesContractIndex {
  readonly name: string;
  readonly collection: string;
  readonly fields: readonly string[];
}

export interface ServicesContractFragment {
  readonly collections: readonly ServicesContractCollection[];
  readonly indexes: readonly ServicesContractIndex[];
}

/** The services, by the names hosts enable them with. */
export type ServiceName = 'files' | 'notifications' | 'configuration' | 'apiKeys' | 'webhooks' | 'jobs' | 'schedules' | 'intelligence';
export const SERVICE_NAMES: readonly ServiceName[] = Object.freeze(['files', 'notifications', 'configuration', 'apiKeys', 'webhooks', 'jobs', 'schedules', 'intelligence']);

/**
 * Bumped when a declaration changes in a way a promoted contract must follow.
 * 2: `job_audit_events.jobType` and `webhook_audit_events.eventType`, written by the transaction
 * context (`queueJob`, `queueWebhookDeliveries`) and undeclared in 1.
 * 3: `files_by_storage_key` on `files.storageKey`, which `FileService.references` queries (an
 * application-scoped authority answers that query only through a declared index).
 * 4: `notifications_by_recipient` on `notifications.[tenantId, recipient, createdAt]` and
 * `notifications_by_recipient_type` on `notifications.[tenantId, recipient, type, createdAt]`,
 * which `NotificationService.inbox`, `unreadCount` and `markAllRead` read (newest first).
 * 5: file bytes (`file_objects`, `file_object_chunks`), resumable uploads (`file_uploads`, with
 * `file_uploads_by_status`), per-tenant file usage (`file_usage`), intelligence metering
 * (`intelligence_usage`); new fields `files.[objectStore, status, uploadId, retainUntil, expiresAt]`,
 * `jobs.runAs`, `job_schedules.runAs`, `notifications.contact`, `webhook_deliveries.[applicationId,
 * replayedBy, replayedAt]`, `service_effect_evidence.enqueuedBy`, `jobs.[idempotencyKey, inputHash, refusal]`.
 */
export const SERVICES_CONTRACT_VERSION = 5;

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
    runId:text enqueuedBy:text capability:text capabilityVersion:integer resource:text decision:text decisionId:text credentialRef:text
    credentialVersion:integer service:text provider:text requestId:text startedAt:text completedAt:text outcome:text failureCode:text`),
  collection('files', `id:text tenantId:text applicationId:text owner:text name:text contentType:text size:integer checksum:text
    storageKey:text metadata:json createdAt:text updatedAt:text deletedAt:text objectStore:text status:text uploadId:text retainUntil:text
    expiresAt:text`),
  collection('file_objects', 'id:text tenantId:text storageKey:text size:integer checksum:text contentType:text chunks:json createdAt:text'),
  collection('file_object_chunks', 'id:text tenantId:text objectId:text index:integer size:integer data:text'),
  collection('file_uploads', `id:text tenantId:text applicationId:text fileId:text owner:text storageKey:text objectStore:text providerUploadId:text
    size:integer partSize:integer partCount:integer parts:json status:text createdAt:text updatedAt:text expiresAt:text createdBy:text`),
  collection('file_usage', 'id:text tenantId:text applicationId:text bytes:integer files:integer updatedAt:text'),
  collection('intelligence_usage', `id:text tenantId:text applicationId:text environment:text modality:text provider:text model:text unit:text
    units:number estimated:boolean costMicros:integer currency:text priced:boolean requests:integer principalId:text requestId:text createdAt:text`),
  collection('file_audit_events', 'id:text type:text fileId:text tenantId:text owner:text principalId:text timestamp:text result:text'),
  collection('notifications', `id:text tenantId:text applicationId:text recipient:text contact:json type:text title:text body:text data:json source:json
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
  collection('webhook_deliveries', `id:text tenantId:text applicationId:text endpointId:text eventId:text eventType:text payload:json status:text
    attemptCount:integer nextAttemptAt:text createdAt:text lastAttemptAt:text deliveredAt:text lastStatusCode:integer lastError:text
    principal:json replayedBy:text replayedAt:text`),
  collection('webhook_audit_events', `id:text type:text endpointId:text deliveryId:text integrationId:text tenantId:text principalId:text
    timestamp:text result:text reason:text eventType:text`),
  collection('webhook_integrations', `id:text tenantId:text applicationId:text provider:text principalId:text signingCredentialRef:text
    createdAt:text createdBy:text disabledAt:text`),
  collection('inbound_webhook_events', `id:text integrationId:text provider:text eventId:text eventTimestamp:text acceptedAt:text tenantId:text
    state:text attempts:integer leaseUntil:text lastAttemptAt:text processedAt:text deadAt:text failures:json`),
  collection('jobs', `id:text tenantId:text applicationId:text type:text payload:json status:text runAt:text attemptCount:integer
    maxAttempts:integer createdAt:text startedAt:text completedAt:text nextAttemptAt:text leaseOwner:text leaseExpiresAt:text
    lastError:text principal:json runAs:text idempotencyKey:text inputHash:text refusal:json`),
  collection('job_schedules', `id:text tenantId:text applicationId:text type:text payload:json interval:text nextRunAt:text enabled:boolean
    createdAt:text createdBy:text principal:json runAs:text`),
  collection('job_audit_events', 'id:text type:text jobId:text scheduleId:text tenantId:text principalId:text timestamp:text result:text details:json jobType:text'),
].map((c) => [c.name, c])));

/** The equality index each collection's tenant-scoped reads use. */
export const SERVICE_INDEXES: Readonly<Record<string, ServicesContractIndex>> = Object.freeze(Object.fromEntries(
  Object.values(SERVICE_COLLECTIONS).map((c) => [c.name, Object.freeze({ name: `${c.name}_by_tenant`, collection: c.name, fields: Object.freeze(['tenantId']) })]),
));

/**
 * Indexes beyond the tenant index: what a service's bounded lookups read. Files are looked up by
 * storage key before their bytes are released (`FileService.references`). A recipient's
 * notifications are paged newest first from their timeline (`NotificationService.inbox`).
 */
export const SERVICE_LOOKUP_INDEXES: Readonly<Record<string, readonly ServicesContractIndex[]>> = Object.freeze({
  files: Object.freeze([Object.freeze({ name: 'files_by_storage_key', collection: 'files', fields: Object.freeze(['storageKey']) })]),
  file_uploads: Object.freeze([Object.freeze({ name: 'file_uploads_by_status', collection: 'file_uploads', fields: Object.freeze(['tenantId', 'status']) })]),
  notifications: Object.freeze([
    Object.freeze({ name: 'notifications_by_recipient', collection: 'notifications', fields: Object.freeze(['tenantId', 'recipient', 'createdAt']) }),
    Object.freeze({ name: 'notifications_by_recipient_type', collection: 'notifications', fields: Object.freeze(['tenantId', 'recipient', 'type', 'createdAt']) }),
  ]),
});

/** Stored by every service: the gateway records evidence for each effect. */
const SHARED = ['service_effect_evidence'] as const;

/**
 * What each service stores, and the services it needs. Intelligence keeps its selection in
 * configuration's collections; configuration's credential writes keep secret metadata;
 * schedules create jobs.
 */
export const SERVICE_REQUIREMENTS: Readonly<Record<ServiceName, { readonly collections: readonly string[]; readonly requires: readonly ServiceName[] }>> = Object.freeze({
  files: { collections: ['files', 'file_audit_events', 'file_objects', 'file_object_chunks', 'file_uploads', 'file_usage'], requires: [] },
  notifications: { collections: ['notifications', 'notification_deliveries', 'notification_audit_events'], requires: [] },
  configuration: { collections: ['ConfigurationVariables', 'ConfigurationSecrets', 'ConfigurationAuditEvents', 'Secrets', 'SecretVersions', 'SecretAuditEvents'], requires: [] },
  apiKeys: { collections: ['api_keys', 'api_key_prefixes', 'api_key_audit_events'], requires: [] },
  webhooks: { collections: ['webhook_endpoints', 'webhook_deliveries', 'webhook_audit_events', 'webhook_integrations', 'inbound_webhook_events'], requires: [] },
  jobs: { collections: ['jobs', 'job_audit_events'], requires: [] },
  schedules: { collections: ['job_schedules'], requires: ['jobs'] },
  intelligence: { collections: ['ConfigurationVariables', 'ConfigurationSecrets', 'ConfigurationAuditEvents', 'intelligence_usage'], requires: [] },
});

/**
 * The contract entries for `services` (and the services they need): every collection they
 * store, each once, in name order, and its tenant index, so the same set always yields the
 * same fragment, whatever order it is given in. No services, no entries. An unknown name is
 * refused.
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
  const sorted = [...names].sort();
  return Object.freeze({
    collections: Object.freeze(sorted.map((name) => SERVICE_COLLECTIONS[name]!)),
    indexes: Object.freeze(sorted.flatMap((name) => [SERVICE_INDEXES[name]!, ...(SERVICE_LOOKUP_INDEXES[name] ?? [])])),
  });
}
