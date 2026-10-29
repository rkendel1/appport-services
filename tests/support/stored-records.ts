/**
 * The record type each collection stores, by collection name: what the stores pass to
 * FeltDB (`db.collection<T>(NAME)`, or a transaction's `value`). The contract tests read
 * these types with the TypeScript compiler, so a field added to or removed from a stored
 * record must be declared in (or removed from) SERVICES_CONTRACT. Names only; no fields.
 */
import type { ApiKey, ApiKeyAuditEvent } from '../../src/api-keys/models.js';
import type { EffectEvidence } from '../../src/authority/evidence.js';
import type { ConfigurationAuditEvent, ConfigurationSecret, ConfigurationVariable } from '../../src/configuration/models.js';
import type { File, FileAuditEvent } from '../../src/files/models.js';
import type { Job, JobAuditEvent, JobSchedule } from '../../src/jobs/models.js';
import type { Notification, NotificationAuditEvent, NotificationDelivery } from '../../src/notifications/models.js';
import type { Secret, SecretAuditEvent, SecretVersion } from '../../src/secrets/models.js';
import type { ApiKeyPrefixRecord } from '../../src/storage/api-keys.js';
import type { InboundWebhookReplayStore } from '../../src/storage/webhooks.js';
import type { WebhookAuditEvent, WebhookDelivery, WebhookEndpoint, WebhookIntegration } from '../../src/webhooks/models.js';

export interface StoredRecords {
  service_effect_evidence: EffectEvidence;
  files: File;
  file_audit_events: FileAuditEvent;
  notifications: Notification;
  notification_deliveries: NotificationDelivery;
  notification_audit_events: NotificationAuditEvent;
  ConfigurationVariables: ConfigurationVariable;
  ConfigurationSecrets: ConfigurationSecret;
  ConfigurationAuditEvents: ConfigurationAuditEvent;
  Secrets: Secret;
  SecretVersions: SecretVersion;
  SecretAuditEvents: SecretAuditEvent;
  api_keys: ApiKey;
  api_key_prefixes: ApiKeyPrefixRecord;
  api_key_audit_events: ApiKeyAuditEvent;
  webhook_endpoints: WebhookEndpoint;
  webhook_deliveries: WebhookDelivery;
  webhook_audit_events: WebhookAuditEvent;
  webhook_integrations: WebhookIntegration;
  inbound_webhook_events: Parameters<InboundWebhookReplayStore['accept']>[0];
  jobs: Job;
  job_schedules: JobSchedule;
  job_audit_events: JobAuditEvent;
}
