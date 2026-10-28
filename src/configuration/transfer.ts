import { isCredentialRef } from '../authority/credentials.js';
import { ServiceAuthorityError, ServiceMigrationError, isServiceAuthorityError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { requireVerifiedPrincipal, type VerifiedPrincipal } from '../authority/principal.js';
import type { Schedule } from '../schedules/models.js';
import type { ScheduleService } from '../schedules/service.js';
import type { WebhookEndpoint } from '../webhooks/models.js';
import type { WebhookService } from '../webhooks/service.js';
import { VERSION } from '../version.js';
import type { ConfigurationEnvironment, ConfigurationList } from './models.js';
import { CONFIGURATION_ENVIRONMENTS } from './models.js';

/** `format` of every configuration export document. */
export const CONFIGURATION_EXPORT_FORMAT = 'appport.configuration-export';
/** The only `formatVersion` this release writes and reads. A different version is refused, never guessed at. */
export const CONFIGURATION_EXPORT_FORMAT_VERSION = 1;

/**
 * Non-secret configuration of one tenant + application + environment, as JSON.
 *
 * Secret material never appears: credential bindings and webhook endpoints
 * carry only their `credential-ref:<id>` reference into AuthBoundry custody
 * (a pointer, not a value), and no signing secret, token, or legacy raw value
 * is read into it. The tenant is not part of the document: an import applies
 * to the importing principal's tenant.
 */
export interface ConfigurationExportDocument {
  readonly format: typeof CONFIGURATION_EXPORT_FORMAT;
  readonly formatVersion: typeof CONFIGURATION_EXPORT_FORMAT_VERSION;
  readonly exportedAt: string;
  readonly source: {
    readonly application: string;
    readonly environment: ConfigurationEnvironment;
    readonly servicesVersion: string;
  };
  /** Configuration variables (non-secret by contract) with their values. */
  readonly variables: readonly ConfigurationExportVariable[];
  /** Credential bindings: names and references only. */
  readonly secrets: readonly ConfigurationExportSecret[];
  /** Active webhook endpoints of the tenant. Disabled endpoints are not exported. */
  readonly webhookEndpoints: readonly ConfigurationExportWebhookEndpoint[];
  /** Enabled recurring schedules of the tenant. */
  readonly schedules: readonly ConfigurationExportSchedule[];
}

export interface ConfigurationExportVariable { readonly name: string; readonly value: string; readonly required: boolean }
export interface ConfigurationExportSecret { readonly name: string; readonly required: boolean; readonly credentialRef: string }
export interface ConfigurationExportWebhookEndpoint { readonly url: string; readonly events: readonly string[]; readonly signingCredentialRef?: string }
export interface ConfigurationExportSchedule { readonly type: string; readonly interval: string; readonly payload: Record<string, unknown> }

export interface ConfigurationExportOptions {
  /** The verified caller. Reads are authorized as `configuration.read`, `webhooks.read` and `schedules.read`. */
  readonly principal: VerifiedPrincipal;
  /** Defaults to `production`. */
  readonly environment?: ConfigurationEnvironment;
}

export interface ConfigurationImportOptions {
  /** The verified caller. Writes are authorized as `configuration.write`, `webhooks.register`/`webhooks.remove` and `schedules.create`/`schedules.cancel`. */
  readonly principal: VerifiedPrincipal;
  /** Plan only: read the target, write nothing. Default false. */
  readonly dryRun?: boolean;
  /** Replace differing variables, endpoints and schedules instead of reporting a conflict. Default false. */
  readonly overwrite?: boolean;
  /** Target environment. Defaults to the document's source environment. */
  readonly environment?: ConfigurationEnvironment;
}

export type ConfigurationImportKind = 'variable' | 'secret' | 'webhookEndpoint' | 'schedule';
/**
 * - `create` / `update`: planned (dry run) or applied.
 * - `unchanged`: the target already matches.
 * - `conflict`: the target differs and `overwrite` is off, or the change is never automatic.
 * - `missing`: a credential binding the target lacks; it is reported in `missingSecrets` and never created by an import.
 * - `skip`: not importable (for example an endpoint exported without a signing reference).
 */
export type ConfigurationImportAction = 'create' | 'update' | 'unchanged' | 'conflict' | 'missing' | 'skip';

export interface ConfigurationImportItem {
  readonly kind: ConfigurationImportKind;
  /** Variable/secret name, endpoint URL, or `type@interval` for a schedule. */
  readonly key: string;
  readonly action: ConfigurationImportAction;
  readonly reason?: string;
  /** True when the action was written. Always false in a dry run and for unchanged/conflict/missing/skip. */
  readonly applied: boolean;
  /** Set when applying this item failed; the import continues with the next item. */
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ConfigurationMissingSecret {
  readonly name: string;
  readonly required: boolean;
  /** The reference the source environment uses. It names a credential in the source's custody; attach the target's own credential. */
  readonly sourceCredentialRef: string;
}

export interface ConfigurationImportReport {
  readonly formatVersion: typeof CONFIGURATION_EXPORT_FORMAT_VERSION;
  readonly dryRun: boolean;
  readonly overwrite: boolean;
  readonly environment: ConfigurationEnvironment;
  readonly items: readonly ConfigurationImportItem[];
  readonly summary: Readonly<Record<ConfigurationImportAction, number>> & { readonly failed: number };
  /** Credential bindings to attach in the target (`credential.attach`) before the configuration is complete. */
  readonly missingSecrets: readonly ConfigurationMissingSecret[];
}

/** What export/import needs from the configuration service and its siblings. */
export interface ConfigurationTransferDependencies {
  readonly gateway: () => ServiceGateway;
  readonly configuration: {
    list(scope: { environment: ConfigurationEnvironment }, caller: VerifiedPrincipal): Promise<ConfigurationList>;
    createVariable(input: { environment: ConfigurationEnvironment; name: string; value: string; required?: boolean }, caller: VerifiedPrincipal): Promise<unknown>;
    updateVariable(input: { environment: ConfigurationEnvironment; name: string; value: string; required?: boolean }, caller: VerifiedPrincipal): Promise<unknown>;
  };
  readonly webhooks?: Pick<WebhookService, 'listWebhookEndpoints' | 'createWebhookEndpoint' | 'disableWebhookEndpoint'>;
  readonly schedules?: Pick<ScheduleService, 'list' | 'create' | 'disable'>;
  readonly now?: () => Date;
}

export async function exportConfiguration(deps: ConfigurationTransferDependencies, options: ConfigurationExportOptions): Promise<ConfigurationExportDocument> {
  const principal = requireVerifiedPrincipal(options?.principal);
  const environment = options.environment ?? 'production';
  requireEnvironment(environment);
  const gateway = deps.gateway();
  const list = await deps.configuration.list({ environment }, principal);
  const endpoints = deps.webhooks ? await readEndpoints(gateway, deps.webhooks, principal) : [];
  const schedules = deps.schedules ? await deps.schedules.list(principal.tenantId, principal) : [];
  return {
    format: CONFIGURATION_EXPORT_FORMAT,
    formatVersion: CONFIGURATION_EXPORT_FORMAT_VERSION,
    exportedAt: (deps.now ?? (() => new Date()))().toISOString(),
    source: { application: gateway.application, environment, servicesVersion: VERSION },
    // Fields are copied one by one: nothing unlisted (a legacy raw value, a version, an audit field) can ride along.
    variables: list.variables.map((variable) => ({ name: variable.name, value: variable.value, required: variable.required })).sort(byKey((item) => item.name)),
    secrets: list.secrets.map((secret) => ({ name: secret.name, required: secret.required, credentialRef: secret.credentialRef })).sort(byKey((item) => item.name)),
    webhookEndpoints: endpoints.filter((endpoint) => !endpoint.disabledAt)
      .map((endpoint) => ({ url: endpoint.url, events: [...endpoint.events].sort(), ...(endpoint.signingCredentialRef ? { signingCredentialRef: endpoint.signingCredentialRef } : {}) }))
      .sort(byKey((item) => item.url)),
    schedules: schedules.filter((schedule) => schedule.enabled)
      .map((schedule) => ({ type: schedule.type, interval: schedule.interval, payload: payloadOf(schedule.payload) }))
      .sort(byKey(scheduleKey)),
  };
}

export async function importConfiguration(deps: ConfigurationTransferDependencies, input: unknown, options: ConfigurationImportOptions): Promise<ConfigurationImportReport> {
  const principal = requireVerifiedPrincipal(options?.principal);
  const document = parseExportDocument(input);
  const environment = options.environment ?? document.source.environment;
  requireEnvironment(environment);
  const dryRun = options.dryRun === true;
  const overwrite = options.overwrite === true;
  const gateway = deps.gateway();

  // Plan against the target as it is now (authorized reads), then apply item by item.
  const current = await deps.configuration.list({ environment }, principal);
  const endpoints = deps.webhooks && document.webhookEndpoints.length ? (await readEndpoints(gateway, deps.webhooks, principal)).filter((endpoint) => !endpoint.disabledAt) : [];
  const schedules = deps.schedules && document.schedules.length ? (await deps.schedules.list(principal.tenantId, principal)).filter((schedule) => schedule.enabled) : [];

  const items: ConfigurationImportItem[] = [];
  const missingSecrets: ConfigurationMissingSecret[] = [];
  const apply = async (planned: Omit<ConfigurationImportItem, 'applied'>, write: () => Promise<unknown>): Promise<void> => {
    if (dryRun || (planned.action !== 'create' && planned.action !== 'update')) { items.push({ ...planned, applied: false }); return; }
    try {
      await write();
      items.push({ ...planned, applied: true });
    } catch (error) {
      items.push({ ...planned, applied: false, error: errorOf(error) });
    }
  };

  const variables = new Map(current.variables.map((variable) => [variable.name, variable]));
  const secrets = new Map(current.secrets.map((secret) => [secret.name, secret]));
  for (const variable of document.variables) {
    const existing = variables.get(variable.name);
    if (secrets.has(variable.name)) { await apply({ kind: 'variable', key: variable.name, action: 'conflict', reason: 'the target binds this name to a credential' }, async () => undefined); continue; }
    if (!existing) { await apply({ kind: 'variable', key: variable.name, action: 'create' }, () => deps.configuration.createVariable({ environment, name: variable.name, value: variable.value, required: variable.required }, principal)); continue; }
    if (existing.value === variable.value && existing.required === variable.required) { await apply({ kind: 'variable', key: variable.name, action: 'unchanged' }, async () => undefined); continue; }
    if (!overwrite) { await apply({ kind: 'variable', key: variable.name, action: 'conflict', reason: 'the target has a different value or required flag' }, async () => undefined); continue; }
    await apply({ kind: 'variable', key: variable.name, action: 'update' }, () => deps.configuration.updateVariable({ environment, name: variable.name, value: variable.value, required: variable.required }, principal));
  }

  for (const secret of document.secrets) {
    if (variables.has(secret.name)) { await apply({ kind: 'secret', key: secret.name, action: 'conflict', reason: 'the target uses this name for a variable' }, async () => undefined); continue; }
    const existing = secrets.get(secret.name);
    if (existing) {
      await apply({ kind: 'secret', key: secret.name, action: 'unchanged', ...(existing.credentialRef === secret.credentialRef ? {} : { reason: 'bound in the target to its own credential reference' }) }, async () => undefined);
      continue;
    }
    // A credential lives in an environment's custody: an import never attaches one.
    missingSecrets.push({ name: secret.name, required: secret.required, sourceCredentialRef: secret.credentialRef });
    await apply({ kind: 'secret', key: secret.name, action: 'missing', reason: 'attach the credential in the target with credential.attach' }, async () => undefined);
  }

  if (document.webhookEndpoints.length && !deps.webhooks) {
    for (const endpoint of document.webhookEndpoints) items.push({ kind: 'webhookEndpoint', key: endpoint.url, action: 'skip', reason: 'webhooks are not mounted in the target', applied: false });
  } else if (deps.webhooks) {
    const hooks = deps.webhooks;
    for (const endpoint of document.webhookEndpoints) {
      const existing = endpoints.find((candidate) => candidate.url === endpoint.url);
      const events = [...endpoint.events].sort();
      const sameEvents = existing && sameList([...existing.events].sort(), events);
      const signingCredentialRef = endpoint.signingCredentialRef ?? existing?.signingCredentialRef;
      if (existing && sameEvents) { await apply({ kind: 'webhookEndpoint', key: endpoint.url, action: 'unchanged' }, async () => undefined); continue; }
      if (!signingCredentialRef) { await apply({ kind: 'webhookEndpoint', key: endpoint.url, action: 'skip', reason: 'exported without a signing credential reference; register it with one' }, async () => undefined); continue; }
      if (!existing) {
        await apply({ kind: 'webhookEndpoint', key: endpoint.url, action: 'create' }, () => hooks.createWebhookEndpoint({ url: endpoint.url, events, signingCredentialRef }, principal));
        continue;
      }
      if (!overwrite) { await apply({ kind: 'webhookEndpoint', key: endpoint.url, action: 'conflict', reason: 'the target endpoint subscribes to different events' }, async () => undefined); continue; }
      // Endpoints are immutable: replace = register the new subscription, then disable the old one.
      await apply({ kind: 'webhookEndpoint', key: endpoint.url, action: 'update', reason: 'registers a new endpoint and disables the old one' }, async () => {
        await hooks.createWebhookEndpoint({ url: endpoint.url, events, signingCredentialRef }, principal);
        await hooks.disableWebhookEndpoint({ id: existing.id }, principal);
      });
    }
  }

  if (document.schedules.length && !deps.schedules) {
    for (const schedule of document.schedules) items.push({ kind: 'schedule', key: scheduleKey(schedule), action: 'skip', reason: 'schedules are not mounted in the target', applied: false });
  } else if (deps.schedules) {
    const scheduler = deps.schedules;
    for (const schedule of document.schedules) {
      const key = scheduleKey(schedule);
      const sameSlot = schedules.filter((candidate) => scheduleKey(candidate) === key);
      if (sameSlot.some((candidate) => stableJson(payloadOf(candidate.payload)) === stableJson(schedule.payload))) { await apply({ kind: 'schedule', key, action: 'unchanged' }, async () => undefined); continue; }
      if (sameSlot.length === 0) { await apply({ kind: 'schedule', key, action: 'create' }, () => scheduler.create({ type: schedule.type, interval: schedule.interval, payload: schedule.payload }, principal)); continue; }
      if (!overwrite) { await apply({ kind: 'schedule', key, action: 'conflict', reason: 'the target has this schedule with a different payload' }, async () => undefined); continue; }
      await apply({ kind: 'schedule', key, action: 'update', reason: 'creates the schedule and cancels the one it replaces' }, async () => {
        await scheduler.create({ type: schedule.type, interval: schedule.interval, payload: schedule.payload }, principal);
        for (const replaced of sameSlot) await scheduler.disable(principal.tenantId, replaced.id, principal);
      });
    }
  }

  const summary = { create: 0, update: 0, unchanged: 0, conflict: 0, missing: 0, skip: 0, failed: 0 };
  for (const item of items) {
    summary[item.action] += 1;
    if (item.error) summary.failed += 1;
  }
  return { formatVersion: CONFIGURATION_EXPORT_FORMAT_VERSION, dryRun, overwrite, environment, items, summary, missingSecrets };
}

/** Validate an untrusted document. Unknown versions and any secret-value field are refused. */
export function parseExportDocument(input: unknown): ConfigurationExportDocument {
  const fail = (message: string): never => { throw new ServiceAuthorityError('INVALID_REQUEST', `Invalid configuration export: ${message}`); };
  const doc = typeof input === 'string' ? safeJson(input, fail) : input;
  if (!isObject(doc)) return fail('expected an object');
  if (doc.format !== CONFIGURATION_EXPORT_FORMAT) return fail(`format must be "${CONFIGURATION_EXPORT_FORMAT}"`);
  if (doc.formatVersion !== CONFIGURATION_EXPORT_FORMAT_VERSION) return fail(`formatVersion ${String(doc.formatVersion)} is not supported (this release reads ${CONFIGURATION_EXPORT_FORMAT_VERSION})`);
  const source = isObject(doc.source) ? doc.source : fail('source is required');
  const environment = source.environment;
  if (typeof environment !== 'string' || !(CONFIGURATION_ENVIRONMENTS as readonly string[]).includes(environment)) fail('source.environment is invalid');
  const array = (key: string): Record<string, unknown>[] => {
    const value = doc[key] ?? [];
    if (!Array.isArray(value) || value.some((entry) => !isObject(entry))) return fail(`${key} must be an array of objects`);
    return value as Record<string, unknown>[];
  };
  const text = (value: unknown, what: string): string => typeof value === 'string' && value ? value : fail(`${what} must be a non-empty string`);
  const ref = (value: unknown, what: string): string => {
    const reference = text(value, what);
    return isCredentialRef(reference) ? reference : fail(`${what} must be a credential-ref:<id> reference`);
  };
  const variables = array('variables').map((entry, index) => ({ name: text(entry.name, `variables[${index}].name`), value: text(entry.value, `variables[${index}].value`), required: entry.required === true }));
  const secrets = array('secrets').map((entry, index) => {
    for (const forbidden of ['value', 'secret', 'plaintext']) {
      if (entry[forbidden] !== undefined) throw new ServiceMigrationError(`secrets[${index}] carries "${forbidden}": secret values are never imported. Attach the credential in the target with credential.attach.`);
    }
    return { name: text(entry.name, `secrets[${index}].name`), required: entry.required === true, credentialRef: ref(entry.credentialRef, `secrets[${index}].credentialRef`) };
  });
  const webhookEndpoints = array('webhookEndpoints').map((entry, index) => {
    for (const forbidden of ['secret', 'signingSecret']) {
      if (entry[forbidden] !== undefined) throw new ServiceMigrationError(`webhookEndpoints[${index}] carries "${forbidden}": signing secrets are never imported; pass signingCredentialRef.`);
    }
    const events = Array.isArray(entry.events) && entry.events.length && entry.events.every((event) => typeof event === 'string' && event) ? entry.events as string[] : fail(`webhookEndpoints[${index}].events must be a non-empty array of event names`);
    return { url: text(entry.url, `webhookEndpoints[${index}].url`), events, ...(entry.signingCredentialRef === undefined ? {} : { signingCredentialRef: ref(entry.signingCredentialRef, `webhookEndpoints[${index}].signingCredentialRef`) }) };
  });
  const schedules = array('schedules').map((entry, index) => ({
    type: text(entry.type, `schedules[${index}].type`),
    interval: text(entry.interval, `schedules[${index}].interval`),
    payload: entry.payload === undefined ? {} : isObject(entry.payload) ? entry.payload : fail(`schedules[${index}].payload must be an object`),
  }));
  return {
    format: CONFIGURATION_EXPORT_FORMAT,
    formatVersion: CONFIGURATION_EXPORT_FORMAT_VERSION,
    exportedAt: typeof doc.exportedAt === 'string' ? doc.exportedAt : '',
    source: { application: typeof source.application === 'string' ? source.application : '', environment: environment as ConfigurationEnvironment, servicesVersion: typeof source.servicesVersion === 'string' ? source.servicesVersion : '' },
    variables, secrets, webhookEndpoints, schedules,
  };
}

/** Endpoints of the caller's tenant and this application, under `webhooks.read`. */
async function readEndpoints(gateway: ServiceGateway, webhooks: Pick<WebhookService, 'listWebhookEndpoints'>, principal: VerifiedPrincipal): Promise<readonly WebhookEndpoint[]> {
  return gateway.execute('webhooks.read', principal, { type: 'webhook_endpoint', tenantId: principal.tenantId }, { service: 'webhook_endpoint' },
    async (context) => (await webhooks.listWebhookEndpoints(principal.tenantId)).filter((endpoint) => endpoint.applicationId === context.application));
}

function requireEnvironment(environment: string): void {
  if (!(CONFIGURATION_ENVIRONMENTS as readonly string[]).includes(environment)) throw new ServiceAuthorityError('INVALID_REQUEST', 'Invalid environment');
}

function scheduleKey(schedule: Pick<Schedule, 'type' | 'interval'>): string {
  return `${schedule.type}@${schedule.interval}`;
}

function payloadOf(payload: unknown): Record<string, unknown> {
  return isObject(payload) ? payload : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeJson(text: string, fail: (message: string) => never): unknown {
  try { return JSON.parse(text); } catch { return fail('not valid JSON'); }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** JSON with object keys sorted, so payload comparison ignores key order. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => isObject(item) ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

function byKey<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => key(a).localeCompare(key(b));
}

function errorOf(error: unknown): { code: string; message: string } {
  if (isServiceAuthorityError(error)) return { code: error.code, message: error.message };
  return { code: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'IMPORT_FAILED', message: error instanceof Error ? error.message : String(error) };
}
