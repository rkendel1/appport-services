import { readFileSync } from 'node:fs';
import TOML from '@iarna/toml';

export type AppPortCapabilityName = 'api' | 'webhooks' | 'jobs';
export type DeploymentMode = 'local' | 'managed' | 'self-hosted';

export interface AppPortConfig {
  readonly version: '1';
  readonly application: { readonly name: string; readonly description: string; readonly runtime: 'node' };
  readonly deployment: { readonly mode: DeploymentMode; readonly storage: 'durable' | 'memory'; readonly distributed: boolean };
  readonly state: { readonly enabled: boolean; readonly authority: 'feltdb'; readonly namespace: string };
  readonly tenant: { readonly mode: 'required' | 'optional' | 'single'; readonly default?: string };
  readonly http: { readonly enabled: boolean; readonly host: string; readonly port: number };
  readonly cors: { readonly enabled: boolean; readonly origins: readonly string[] };
  readonly capabilities: Readonly<Record<AppPortCapabilityName, boolean>>;
  readonly api: { readonly enabled: boolean; readonly keys: { readonly enabled: boolean; readonly scopes: readonly string[] } };
  readonly webhooks: { readonly enabled: boolean; readonly delivery: { readonly enabled: boolean; readonly retries: number; readonly timeout_ms: number }; readonly events: { readonly allowed: readonly string[] } };
  readonly jobs: { readonly enabled: boolean; readonly execution: { readonly enabled: boolean; readonly max_attempts: number }; readonly types: Readonly<Record<string, { readonly timeout_ms: number }>>; readonly max_attempts: number };
  readonly events: { readonly enabled: boolean; readonly streaming: { readonly enabled: boolean; readonly transport: 'sse' } };
  readonly authorization: { readonly enabled: boolean; readonly default: 'allow' | 'deny' };
  readonly observability: { readonly enabled: boolean };
  readonly lifecycle: { readonly managed: boolean };
  readonly development: { readonly mail: string; readonly webhooks: string; readonly jobs: string };
}

export type AppPortContractSnapshot = Readonly<AppPortConfig>;

export class AppPortConfigError extends Error {
  constructor(readonly file: string, readonly property: string, value: unknown, expected: string) {
    super(`${file}: invalid ${property} (${JSON.stringify(value)}); expected ${expected}`);
    this.name = 'AppPortConfigError';
  }
}

export function parseAppPortConfig(filePath: string): AppPortContractSnapshot {
  try {
    return parseAppPortConfigText(readFileSync(filePath, 'utf8'), filePath);
  } catch (error) {
    if (error instanceof AppPortConfigError) throw error;
    throw new Error(`Cannot read appport.toml at ${filePath}: ${String(error)}`);
  }
}

export function parseAppPortConfigText(source: string, file = 'appport.toml'): AppPortContractSnapshot {
  const uses = new Set<AppPortCapabilityName>();
  const tomlLines: string[] = [];
  let useBlock: AppPortCapabilityName | undefined;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (useBlock) {
      if (line === '}') useBlock = undefined;
      else if (line && !line.startsWith('#')) tomlLines.push(`[${useBlock}]`, rawLine);
      continue;
    }
    const use = /^use\s+([a-z][a-z0-9_-]*)(?:\s*\{)?$/.exec(line);
    if (use) {
      if (!['api', 'webhooks', 'jobs'].includes(use[1])) throw new AppPortConfigError(file, 'use', use[1], 'api, webhooks, or jobs');
      uses.add(use[1] as AppPortCapabilityName);
      if (line.endsWith('{')) useBlock = use[1] as AppPortCapabilityName;
      continue;
    }
    tomlLines.push(rawLine);
  }
  let raw: Record<string, unknown>;
  try {
    raw = TOML.parse(tomlLines.join('\n')) as Record<string, unknown>;
  } catch (error) {
    throw new AppPortConfigError(file, 'syntax', String(error), 'valid AppPort TOML');
  }
  return normalizeConfig(raw, uses, file);
}

function normalizeConfig(raw: Record<string, unknown>, uses: Set<AppPortCapabilityName>, file: string): AppPortContractSnapshot {
  const section = (name: string) => object(raw[name], file, name, true);
  const application = section('application'); const deployment = section('deployment'); const state = section('state');
  const tenant = section('tenant'); const http = section('http'); const cors = section('cors');
  const api = section('api'); const apiKeys = typeof api.keys === 'object' ? object(api.keys, file, 'api.keys', true) : {};
  const webhooks = section('webhooks'); const webhookDelivery = object(webhooks.delivery, file, 'webhooks.delivery', true);
  const legacyWebhookEvents = Array.isArray(webhooks.events) ? webhooks.events : undefined;
  const webhookEvents = legacyWebhookEvents ? {} : object(webhooks.events, file, 'webhooks.events', true);
  const jobs = section('jobs'); const jobExecution = object(jobs.execution, file, 'jobs.execution', true); const jobTypes = object(jobs.types, file, 'jobs.types', true);
  const events = section('events'); const streaming = object(events.streaming, file, 'events.streaming', true);
  const authorization = section('authorization'); const observability = section('observability'); const lifecycle = section('lifecycle'); const development = section('development');
  for (const capability of ['api', 'webhooks', 'jobs'] as const) {
    if (bool(object(raw[capability], file, capability, true).enabled, file, `${capability}.enabled`, uses.has(capability) || raw[capability] !== undefined)) uses.add(capability);
  }
  const name = str(application.name, file, 'application.name', 'app');
  const normalizedTypes: Record<string, { timeout_ms: number }> = {};
  for (const [type, value] of Object.entries(jobTypes)) {
    const config = object(value, file, `jobs.types.${type}`);
    normalizedTypes[type] = { timeout_ms: integer(config.timeout_ms, file, `jobs.types.${type}.timeout_ms`, 30_000, 1) };
  }
  const maxAttempts = integer(jobExecution.max_attempts ?? jobs.max_attempts, file, 'jobs.execution.max_attempts', 3, 1);
  return deepFreeze({
    version: enumeration(raw.version, file, 'version', ['1'], '1'),
    application: { name, description: str(application.description, file, 'application.description', 'AppPort application'), runtime: enumeration(application.runtime, file, 'application.runtime', ['node'], 'node') },
    deployment: { mode: enumeration(deployment.mode, file, 'deployment.mode', ['local', 'managed', 'self-hosted'], 'local'), storage: enumeration(deployment.storage, file, 'deployment.storage', ['durable', 'memory'], 'durable'), distributed: bool(deployment.distributed, file, 'deployment.distributed', true) },
    state: { enabled: bool(state.enabled, file, 'state.enabled', true), authority: enumeration(state.authority, file, 'state.authority', ['feltdb'], 'feltdb'), namespace: str(state.namespace, file, 'state.namespace', name) },
    tenant: { mode: enumeration(tenant.mode, file, 'tenant.mode', ['required', 'optional', 'single'], 'required'), ...(tenant.default === undefined ? {} : { default: str(tenant.default, file, 'tenant.default', '') }) },
    http: { enabled: bool(http.enabled, file, 'http.enabled', false), host: str(http.host, file, 'http.host', '127.0.0.1'), port: integer(http.port, file, 'http.port', 8787, 0, 65535) },
    cors: { enabled: bool(cors.enabled, file, 'cors.enabled', false), origins: stringArray(cors.origins, file, 'cors.origins', ['*']) },
    capabilities: { api: uses.has('api'), webhooks: uses.has('webhooks'), jobs: uses.has('jobs') },
    api: { enabled: uses.has('api'), keys: { enabled: bool(apiKeys.enabled ?? api.keys, file, 'api.keys.enabled', uses.has('api')), scopes: stringArray(apiKeys.scopes ?? api.scopes, file, 'api.keys.scopes', []) } },
    webhooks: { enabled: uses.has('webhooks'), delivery: { enabled: bool(webhookDelivery.enabled, file, 'webhooks.delivery.enabled', uses.has('webhooks')), retries: integer(webhookDelivery.retries, file, 'webhooks.delivery.retries', 3, 0), timeout_ms: integer(webhookDelivery.timeout_ms, file, 'webhooks.delivery.timeout_ms', 10_000, 1) }, events: { allowed: stringArray(webhookEvents.allowed ?? legacyWebhookEvents, file, 'webhooks.events.allowed', []) } },
    jobs: { enabled: uses.has('jobs'), execution: { enabled: bool(jobExecution.enabled, file, 'jobs.execution.enabled', uses.has('jobs')), max_attempts: maxAttempts }, types: normalizedTypes, max_attempts: maxAttempts },
    events: { enabled: bool(events.enabled, file, 'events.enabled', false), streaming: { enabled: bool(streaming.enabled, file, 'events.streaming.enabled', false), transport: enumeration(streaming.transport, file, 'events.streaming.transport', ['sse'], 'sse') } },
    authorization: { enabled: bool(authorization.enabled, file, 'authorization.enabled', uses.has('api')), default: enumeration(authorization.default, file, 'authorization.default', ['allow', 'deny'], 'deny') },
    observability: { enabled: bool(observability.enabled, file, 'observability.enabled', true) },
    lifecycle: { managed: bool(lifecycle.managed, file, 'lifecycle.managed', true) },
    development: { mail: str(development.mail, file, 'development.mail', 'local'), webhooks: str(development.webhooks, file, 'development.webhooks', 'local'), jobs: str(development.jobs, file, 'development.jobs', 'local') },
  });
}

function object(value: unknown, file: string, property: string, optional = false): Record<string, unknown> { if (value === undefined && optional) return {}; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppPortConfigError(file, property, value, 'a table'); return value as Record<string, unknown>; }
function str(value: unknown, file: string, property: string, fallback: string): string { if (value === undefined) return fallback; if (typeof value !== 'string' || !value.trim()) throw new AppPortConfigError(file, property, value, 'a non-empty string'); return value; }
function bool(value: unknown, file: string, property: string, fallback: boolean): boolean { if (value === undefined) return fallback; if (typeof value !== 'boolean') throw new AppPortConfigError(file, property, value, 'true or false'); return value; }
function integer(value: unknown, file: string, property: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number { if (value === undefined) return fallback; if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new AppPortConfigError(file, property, value, `an integer from ${min} to ${max}`); return value as number; }
function stringArray(value: unknown, file: string, property: string, fallback: readonly string[]): readonly string[] { if (value === undefined) return [...fallback]; if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new AppPortConfigError(file, property, value, 'an array of strings'); return [...value]; }
function enumeration<T extends string>(value: unknown, file: string, property: string, allowed: readonly T[], fallback: T): T { if (value === undefined) return fallback; if (typeof value !== 'string' || !allowed.includes(value as T)) throw new AppPortConfigError(file, property, value, allowed.join(', ')); return value as T; }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); } return value; }
