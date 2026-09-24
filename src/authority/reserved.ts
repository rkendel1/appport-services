import { ServiceAuthorityError } from './errors.js';

/**
 * Collections owned by AppPort Services. Their records carry durable
 * identity (job and delivery principals), credential references, and
 * evidence, so application-level raw writes would let data become authority.
 * Only the services' own authorized paths write them.
 */
export const SERVICE_OWNED_COLLECTIONS: ReadonlySet<string> = new Set([
  'api_keys', 'api_key_prefixes', 'api_key_audit_events',
  'webhook_endpoints', 'webhook_deliveries', 'webhook_audit_events', 'webhook_integrations', 'inbound_webhook_events',
  'jobs', 'job_schedules', 'job_audit_events',
  'notifications', 'notification_deliveries', 'notification_audit_events',
  'files', 'file_audit_events',
  'ConfigurationVariables', 'ConfigurationSecrets', 'ConfigurationAuditEvents',
  'service_effect_evidence',
]);

export function assertApplicationCollection(name: string): void {
  if (SERVICE_OWNED_COLLECTIONS.has(name)) {
    throw new ServiceAuthorityError('DENIED', `Collection "${name}" is owned by AppPort Services; use the service capability instead of writing it directly`, { reason: 'reserved_collection' });
  }
}
