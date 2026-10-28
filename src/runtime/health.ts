import type { StateFirstDB } from '@feltdb/core';

import type { ConfigurationDeclaration } from '../configuration/models.js';
import { boundedFind } from '../storage/bounded.js';
import { getIntelligenceProvider } from '../intelligence/catalog.js';
import { INTELLIGENCE_CREDENTIAL_NAME, INTELLIGENCE_SELECTION_NAME } from '../intelligence/service.js';
import { isCredentialRef } from '../authority/credentials.js';
import type { SecretCustody } from '../secrets/protocol.js';

/**
 * Per-service state.
 *
 * - `ok`: configured and nothing needs attention.
 * - `degraded`: running, but something needs an operator (failed work, a
 *   missing credential binding, a webhook endpoint that cannot be signed for).
 * - `unconfigured`: nothing set up yet (no endpoints, no schedules, no
 *   configuration). Not a failure.
 * - `disabled`: cannot run, or was turned off: every endpoint or schedule is
 *   disabled, or no AuthBoundry authorizer is configured (every effect fails
 *   closed).
 */
export type ServiceHealthState = 'ok' | 'degraded' | 'unconfigured' | 'disabled';

export interface ServiceHealthOptions {
  /** Count one tenant only. Without it, every tenant of this application in the namespace. */
  readonly tenantId?: string;
  /**
   * Upper bound for every count (each is one bounded query). Default 1000, at
   * most 10000. A count equal to the limit means "at least this many"; its
   * path is listed in `cappedCounts`.
   */
  readonly countLimit?: number;
}

interface ServiceHealthBase<C> {
  readonly state: ServiceHealthState;
  /** Machine-readable reasons for a state other than `ok` (for example `failed_deliveries`). */
  readonly reasons: readonly string[];
  readonly counts: Readonly<C>;
}

export interface AuthorityHealth {
  /** `unconfigured` without an AuthBoundry authorizer: every service effect fails closed. `degraded` without credential custody. */
  readonly state: ServiceHealthState;
  readonly reasons: readonly string[];
  readonly authorizer: boolean;
  readonly credentials: boolean;
}

export type ApiKeysHealth = ServiceHealthBase<{ keys: number; active: number; revoked: number; expired: number }>;
export type WebhooksHealth = ServiceHealthBase<{ endpoints: number; activeEndpoints: number; disabledEndpoints: number; pendingDeliveries: number; retryingDeliveries: number; failedDeliveries: number }>;
export type JobsHealth = ServiceHealthBase<{ pending: number; running: number; retrying: number; failed: number }>;
export type SchedulesHealth = ServiceHealthBase<{ enabled: number; disabled: number }>;
export type NotificationsHealth = ServiceHealthBase<{ failedNotifications: number; pendingDeliveries: number; retryingDeliveries: number; failedDeliveries: number }>;
export type FilesHealth = ServiceHealthBase<{ files: number }>;
export type ConfigurationHealth = ServiceHealthBase<{
  variables: number;
  secrets: number;
  /** Required declarations with no binding (only with `tenantId`, in each environment that has configuration). */
  missingRequired: number;
  /** Credential bindings that still hold a pre-reference raw value. Rotate them to a `credential-ref:`. */
  legacySecretValues: number;
  /**
   * Bindings whose custody reports no usable material (`missing` or `revoked`).
   * Present only when the host's custody is a `SecretCustody`.
   */
  missingMaterial?: number;
}> & {
  /**
   * Custody status of each counted binding, when the host's custody is a
   * `SecretCustody`: the binding's name and the material's state, never the
   * value or the credential reference. `unknown` when custody could not answer.
   */
  readonly bindings?: readonly CredentialBindingHealth[];
};

export interface CredentialBindingHealth {
  readonly tenantId: string;
  readonly environment: string;
  readonly name: string;
  readonly state: 'set' | 'missing' | 'revoked' | 'unknown';
  readonly version?: number;
  readonly location?: string;
  readonly writable?: boolean;
}
export type IntelligenceHealth = ServiceHealthBase<{ configured: number; missingCredentials: number }>;

/** Everything needing an operator, as one flat summary. */
export interface HealthAttention {
  readonly failedWebhookDeliveries: number;
  readonly disabledWebhookEndpoints: number;
  readonly failedJobs: number;
  readonly failedNotifications: number;
  readonly failedNotificationDeliveries: number;
  /** Required configuration secrets without a binding, plus intelligence selections whose provider needs a credential that is not bound. */
  readonly missingSecrets: number;
  readonly legacySecretValues: number;
  /** Bindings whose material is missing or revoked in custody. Present only with a `SecretCustody`. */
  readonly missingCredentialMaterial?: number;
}

export interface AppPortServicesHealth {
  /** `unconfigured` without an authorizer; otherwise `degraded` when any service is degraded; otherwise `ok`. */
  readonly status: 'ok' | 'degraded' | 'unconfigured';
  readonly checkedAt: string;
  readonly application: string;
  readonly tenantId?: string;
  readonly version: string;
  readonly countLimit: number;
  /** Count paths (for example `webhooks.failedDeliveries`) that reached `countLimit`. */
  readonly cappedCounts: readonly string[];
  readonly authority: AuthorityHealth;
  readonly services: {
    readonly apiKeys: ApiKeysHealth;
    readonly webhooks: WebhooksHealth;
    readonly jobs: JobsHealth;
    readonly schedules: SchedulesHealth;
    readonly notifications: NotificationsHealth;
    readonly files: FilesHealth;
    readonly configuration: ConfigurationHealth;
    readonly intelligence: IntelligenceHealth;
  };
  readonly attention: HealthAttention;
}

export interface HealthSources {
  readonly db: StateFirstDB;
  readonly application: string;
  readonly version: string;
  readonly authorizer: boolean;
  readonly credentials: boolean;
  /** When present, every counted binding's material is checked with `status()`. */
  readonly custody?: SecretCustody;
  readonly declarations?: readonly ConfigurationDeclaration[];
  readonly now?: () => Date;
}

export const DEFAULT_HEALTH_COUNT_LIMIT = 1000;
export const MAX_HEALTH_COUNT_LIMIT = 10_000;

// The services' own durable collections (see src/storage, src/jobs/store.ts, src/configuration/storage.ts).
const COLLECTIONS = {
  apiKeys: 'api_keys',
  endpoints: 'webhook_endpoints',
  deliveries: 'webhook_deliveries',
  jobs: 'jobs',
  schedules: 'job_schedules',
  notifications: 'notifications',
  notificationDeliveries: 'notification_deliveries',
  files: 'files',
  variables: 'ConfigurationVariables',
  secrets: 'ConfigurationSecrets',
} as const;

type Row = Record<string, unknown>;

/**
 * Derive service health from durable state with bounded queries only: every
 * count is an equality query at the storage boundary that stops after
 * `countLimit + 1` rows, so the cost does not grow with history.
 *
 * Records that carry an `applicationId` are counted for this application only.
 * Webhook and notification deliveries carry none; they are counted for every
 * application sharing the namespace (and tenant, when given).
 */
export async function collectHealth(sources: HealthSources, options: ServiceHealthOptions = {}): Promise<AppPortServicesHealth> {
  const limit = options.countLimit ?? DEFAULT_HEALTH_COUNT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HEALTH_COUNT_LIMIT) throw new RangeError(`countLimit must be an integer from 1 to ${MAX_HEALTH_COUNT_LIMIT}`);
  if (options.tenantId !== undefined && (typeof options.tenantId !== 'string' || !options.tenantId)) throw new TypeError('tenantId must be a non-empty string');
  const { db, application } = sources;
  const now = (sources.now ?? (() => new Date()))();
  const capped = new Set<string>();
  const tenant = options.tenantId ? { tenantId: options.tenantId } : {};
  const owned = { ...tenant, applicationId: application };

  /** One bounded read: at most `limit` rows, plus one to know whether it was capped. */
  const rows = async (collection: string, where: Row, path: string): Promise<Row[]> => {
    const found = await boundedFind<Row>(db, collection, where, limit + 1);
    if (found.length > limit) capped.add(path);
    return found.slice(0, limit);
  };
  const count = async (collection: string, where: Row, path: string) => (await rows(collection, where, path)).length;

  const [keys, endpoints, pendingDeliveries, retryingDeliveries, failedDeliveries, pendingJobs, runningJobs, retryingJobs, failedJobs,
    enabledSchedules, disabledSchedules, failedNotifications, pendingNotificationDeliveries, retryingNotificationDeliveries, failedNotificationDeliveries,
    files, variables, secrets] = await Promise.all([
    rows(COLLECTIONS.apiKeys, owned, 'apiKeys.keys'),
    rows(COLLECTIONS.endpoints, owned, 'webhooks.endpoints'),
    count(COLLECTIONS.deliveries, { ...tenant, status: 'pending' }, 'webhooks.pendingDeliveries'),
    count(COLLECTIONS.deliveries, { ...tenant, status: 'retrying' }, 'webhooks.retryingDeliveries'),
    count(COLLECTIONS.deliveries, { ...tenant, status: 'failed' }, 'webhooks.failedDeliveries'),
    count(COLLECTIONS.jobs, { ...owned, status: 'pending' }, 'jobs.pending'),
    count(COLLECTIONS.jobs, { ...owned, status: 'running' }, 'jobs.running'),
    count(COLLECTIONS.jobs, { ...owned, status: 'retrying' }, 'jobs.retrying'),
    count(COLLECTIONS.jobs, { ...owned, status: 'failed' }, 'jobs.failed'),
    count(COLLECTIONS.schedules, { ...owned, enabled: true }, 'schedules.enabled'),
    count(COLLECTIONS.schedules, { ...owned, enabled: false }, 'schedules.disabled'),
    count(COLLECTIONS.notifications, { ...owned, status: 'failed' }, 'notifications.failedNotifications'),
    count(COLLECTIONS.notificationDeliveries, { ...tenant, status: 'pending' }, 'notifications.pendingDeliveries'),
    count(COLLECTIONS.notificationDeliveries, { ...tenant, status: 'retrying' }, 'notifications.retryingDeliveries'),
    count(COLLECTIONS.notificationDeliveries, { ...tenant, status: 'failed' }, 'notifications.failedDeliveries'),
    rows(COLLECTIONS.files, owned, 'files.files'),
    rows(COLLECTIONS.variables, owned, 'configuration.variables'),
    rows(COLLECTIONS.secrets, owned, 'configuration.secrets'),
  ]);

  const authority: AuthorityHealth = {
    state: !sources.authorizer ? 'unconfigured' : sources.credentials ? 'ok' : 'degraded',
    reasons: [...(!sources.authorizer ? ['authorizer_unconfigured'] : []), ...(!sources.credentials ? ['credentials_unconfigured'] : [])],
    authorizer: sources.authorizer,
    credentials: sources.credentials,
  };
  // Without an authorizer every effect fails closed, whatever the state says.
  const gate = (state: ServiceHealthState, reasons: string[]): { state: ServiceHealthState; reasons: string[] } =>
    sources.authorizer ? { state, reasons } : { state: 'disabled', reasons: ['authorizer_unconfigured', ...reasons] };

  // API keys
  const nowIso = now.toISOString();
  const revoked = keys.filter((key) => key.revokedAt).length;
  const expired = keys.filter((key) => !key.revokedAt && typeof key.expiresAt === 'string' && key.expiresAt <= nowIso).length;
  const active = keys.length - revoked - expired;
  const apiKeys: ApiKeysHealth = { ...gate(keys.length === 0 ? 'unconfigured' : 'ok', keys.length === 0 ? ['no_keys'] : []), counts: { keys: keys.length, active, revoked, expired } };

  // Webhooks
  const disabledEndpoints = endpoints.filter((endpoint) => endpoint.disabledAt).length;
  const activeEndpoints = endpoints.length - disabledEndpoints;
  const webhookReasons = [
    ...(failedDeliveries > 0 ? ['failed_deliveries'] : []),
    ...(activeEndpoints > 0 && !sources.credentials ? ['credentials_unconfigured'] : []),
  ];
  const webhookState: ServiceHealthState = endpoints.length === 0 ? 'unconfigured'
    : webhookReasons.length ? 'degraded'
      : activeEndpoints === 0 ? 'disabled' : 'ok';
  const webhooks: WebhooksHealth = {
    ...gate(webhookState, endpoints.length === 0 ? ['no_endpoints'] : webhookState === 'disabled' ? ['all_endpoints_disabled'] : webhookReasons),
    counts: { endpoints: endpoints.length, activeEndpoints, disabledEndpoints, pendingDeliveries, retryingDeliveries, failedDeliveries },
  };

  const jobs: JobsHealth = { ...gate(failedJobs > 0 ? 'degraded' : 'ok', failedJobs > 0 ? ['failed_jobs'] : []), counts: { pending: pendingJobs, running: runningJobs, retrying: retryingJobs, failed: failedJobs } };

  const scheduleState: ServiceHealthState = enabledSchedules + disabledSchedules === 0 ? 'unconfigured' : enabledSchedules === 0 ? 'disabled' : 'ok';
  const schedules: SchedulesHealth = {
    ...gate(scheduleState, scheduleState === 'unconfigured' ? ['no_schedules'] : scheduleState === 'disabled' ? ['all_schedules_disabled'] : []),
    counts: { enabled: enabledSchedules, disabled: disabledSchedules },
  };

  const notificationReasons = [...(failedNotificationDeliveries > 0 ? ['failed_deliveries'] : []), ...(failedNotifications > 0 ? ['failed_notifications'] : [])];
  const notifications: NotificationsHealth = {
    ...gate(notificationReasons.length ? 'degraded' : 'ok', notificationReasons),
    counts: { failedNotifications, pendingDeliveries: pendingNotificationDeliveries, retryingDeliveries: retryingNotificationDeliveries, failedDeliveries: failedNotificationDeliveries },
  };

  const liveFiles = files.filter((file) => !file.deletedAt).length;
  const filesHealth: FilesHealth = { ...gate('ok', []), counts: { files: liveFiles } };

  // Configuration: missing required declarations need a tenant, and are checked in each environment that has configuration.
  const legacySecretValues = secrets.filter((secret) => secret.value !== undefined && secret.value !== null).length;
  let missingRequired = 0;
  let missingRequiredSecrets = 0;
  if (options.tenantId && sources.declarations?.length) {
    const environments = new Set([...variables, ...secrets].map((row) => String(row.environment)));
    if (environments.size === 0) environments.add('production');
    for (const environment of environments) {
      const present = new Set([...variables, ...secrets].filter((row) => row.environment === environment).map((row) => String(row.name)));
      for (const declaration of sources.declarations) {
        if (declaration.required && !present.has(declaration.name)) {
          missingRequired += 1;
          if (declaration.kind === 'secret') missingRequiredSecrets += 1;
        }
      }
    }
  }
  // Material: a binding is only as good as what custody holds for it. Status never reveals the value.
  const bindings = sources.custody ? await materialStatus(sources.custody, secrets) : undefined;
  const missingMaterial = bindings?.filter((binding) => binding.state === 'missing' || binding.state === 'revoked').length;
  const configurationReasons = [
    ...(missingRequired > 0 ? ['missing_required'] : []),
    ...(legacySecretValues > 0 ? ['legacy_secret_values'] : []),
    ...(missingMaterial ? ['missing_material'] : []),
  ];
  const configurationState: ServiceHealthState = configurationReasons.length ? 'degraded' : variables.length + secrets.length === 0 ? 'unconfigured' : 'ok';
  const configuration: ConfigurationHealth = {
    ...gate(configurationState, configurationState === 'unconfigured' ? ['no_configuration'] : configurationReasons),
    counts: { variables: variables.length, secrets: secrets.length, missingRequired, legacySecretValues, ...(bindings ? { missingMaterial } : {}) },
    ...(bindings ? { bindings } : {}),
  };

  // Intelligence: a selection whose provider requires a credential needs the credential binding in the same scope.
  const scopeKey = (row: Row) => `${String(row.tenantId)}\u0000${String(row.environment)}`;
  const selections = variables.filter((row) => row.name === INTELLIGENCE_SELECTION_NAME);
  const boundCredentials = new Set(secrets.filter((row) => row.name === INTELLIGENCE_CREDENTIAL_NAME).map(scopeKey));
  const missingCredentials = selections.filter((row) => {
    const provider = providerOf(row.value);
    return provider !== undefined && getIntelligenceProvider(provider)?.credential === 'required' && !boundCredentials.has(scopeKey(row));
  }).length;
  const intelligenceState: ServiceHealthState = selections.length === 0 ? 'unconfigured' : missingCredentials > 0 ? 'degraded' : 'ok';
  const intelligence: IntelligenceHealth = {
    ...gate(intelligenceState, intelligenceState === 'unconfigured' ? ['not_configured'] : missingCredentials > 0 ? ['missing_credential'] : []),
    counts: { configured: selections.length, missingCredentials },
  };

  const services = { apiKeys, webhooks, jobs, schedules, notifications, files: filesHealth, configuration, intelligence };
  const status: AppPortServicesHealth['status'] = !sources.authorizer ? 'unconfigured'
    : Object.values(services).some((service) => service.state === 'degraded') ? 'degraded' : 'ok';

  return {
    status,
    checkedAt: nowIso,
    application,
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    version: sources.version,
    countLimit: limit,
    cappedCounts: [...capped].sort(),
    authority,
    services,
    attention: {
      failedWebhookDeliveries: failedDeliveries,
      disabledWebhookEndpoints: disabledEndpoints,
      failedJobs,
      failedNotifications,
      failedNotificationDeliveries,
      missingSecrets: missingRequiredSecrets + missingCredentials,
      legacySecretValues,
      ...(bindings ? { missingCredentialMaterial: missingMaterial } : {}),
    },
  };
}

/** Ask custody about each binding, one at a time, never failing health on a custody error. */
async function materialStatus(custody: SecretCustody, secrets: readonly Row[]): Promise<CredentialBindingHealth[]> {
  const results: CredentialBindingHealth[] = [];
  for (const row of secrets) {
    const credentialRef = row.credentialRef;
    const base = { tenantId: String(row.tenantId), environment: String(row.environment), name: String(row.name) };
    if (!isCredentialRef(credentialRef)) { results.push({ ...base, state: 'unknown' }); continue; }
    try {
      const tenantId = String(row.tenantId);
      const status = await custody.status({
        reference: { secretId: credentialRef.slice('credential-ref:'.length), tenantId },
        // Health is a trusted in-process host API; there is no caller decision to reference.
        context: { tenantId, principalId: 'appport-services:health', purpose: 'health' },
      });
      const state = status?.state === 'set' || status?.state === 'missing' || status?.state === 'revoked' ? status.state : 'unknown';
      results.push({
        ...base, state,
        ...(Number.isInteger(status?.version) ? { version: status.version } : {}),
        ...(typeof status?.location === 'string' ? { location: status.location } : {}),
        ...(typeof status?.writable === 'boolean' ? { writable: status.writable } : {}),
      });
    } catch {
      results.push({ ...base, state: 'unknown' });
    }
  }
  return results;
}

function providerOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as { provider?: unknown };
    return typeof parsed.provider === 'string' ? parsed.provider : undefined;
  } catch {
    return undefined;
  }
}
