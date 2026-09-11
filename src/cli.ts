#!/usr/bin/env node

import process from 'node:process';
import { access, copyFile, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { formatFlowSpec, parseFlowSpec } from '@feltdb/core';

import type { ApiKeyService } from './api-keys/service.js';
import { parseAppPortConfig } from './runtime/dsl.js';
import {
  createFeltDbRuntime,
  FeltDbWebhookEndpointStore,
  FeltDbWebhookDeliveryStore,
  FeltDbWebhookAuditSink,
  WebhookService,
  EncryptedWebhookSecretStore,
  FeltDbJobStore,
  FeltDbJobScheduleStore,
  FeltDbJobAuditSink,
  JobService,
  FeltDbApiKeyStore,
  FeltDbAuditSink,
  ApiKeyService as ApiKeyServiceImpl,
} from './_internal.js';

interface CommandIo {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

export async function runCli(
  argv: readonly string[],
  io: CommandIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
  service?: ApiKeyService,
  cwd = process.cwd(),
): Promise<number> {
  let activeService = service;
  try {
    const [group, action, ...rest] = argv;
    if (group === 'init') {
      return handleInitCommand(argv.slice(1), io, cwd);
    } else if (group === 'config' && action === 'migrate') {
      return handleConfigMigrate(io, cwd);
    } else if (group === 'api-key') {
      activeService ??= createConfiguredApiKeyService(cwd);
      return handleApiKeyCommand(action, rest, io, activeService);
    } else if (group === 'webhook') {
      return handleWebhookCommand(action, rest, io, cwd);
    } else if (group === 'job') {
      return handleJobCommand(action, rest, io, cwd);
    } else {
      writeLine(
        io.stderr,
        'Usage: appport-runtime init [--use api,webhooks,jobs] | appport-runtime config migrate | appport-runtime <api-key|webhook|job> <command>',
      );
      return 1;
    }
  } finally {
    if (activeService) {
      await closeQuietly(activeService);
    }
  }
}

async function handleConfigMigrate(io: CommandIo, cwd: string): Promise<number> {
  const path = resolve(cwd, 'appport.toml');
  const flowPath = resolve(cwd, 'feltdb.flow');
  const config = parseAppPortConfig(path);
  const selected = SUPPORTED_CAPABILITIES.filter((capability) => config.capabilities[capability]);
  await copyFile(path, `${path}.bak`);
  const applicationName = config.application.name === 'app' ? await detectFlowApplicationName(cwd) : config.application.name;
  await writeFile(path, canonicalConfig(applicationName, selected), 'utf8');
  try {
    await access(flowPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    await writeFlowContract(flowPath, applicationName, selected);
  }
  writeLine(io.stdout, `Migrated ${path}`);
  writeLine(io.stdout, `Backup: ${path}.bak`);
  return 0;
}

const SUPPORTED_CAPABILITIES = ['api', 'webhooks', 'jobs'] as const;
const CAPABILITY_COLLECTIONS: Record<typeof SUPPORTED_CAPABILITIES[number], readonly string[]> = {
  api: ['ApiKeys', 'ApiKeyPrefixes', 'ApiKeyAuditEvents'],
  webhooks: ['WebhookEndpoints', 'WebhookDeliveries', 'WebhookAuditEvents'],
  jobs: ['Jobs', 'JobSchedules', 'JobAuditEvents'],
};

async function handleInitCommand(
  tokens: readonly string[],
  io: CommandIo,
  cwd: string,
): Promise<number> {
  const options = parseOptions(tokens);
  for (const key of options.keys()) {
    if (key !== 'use') {
      throw new Error(`Unknown option for init: --${key}`);
    }
  }

  const requested = arrayOption(options, 'use').flatMap((value) => value.split(','));
  const capabilities = requested.length > 0
    ? requested.map((value) => value.trim()).filter(Boolean)
    : await configureCapabilities(io);

  if (capabilities.length === 0) {
    throw new Error('--use must include at least one capability');
  }

  const unknown = capabilities.filter(
    (capability) => !SUPPORTED_CAPABILITIES.includes(capability as typeof SUPPORTED_CAPABILITIES[number]),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Unknown capability: ${unknown.join(', ')}. Supported: ${SUPPORTED_CAPABILITIES.join(', ')}`,
    );
  }

  const selected = SUPPORTED_CAPABILITIES.filter((capability) => capabilities.includes(capability));
  const configDestination = resolve(cwd, 'appport.toml');
  const flowDestination = resolve(cwd, 'feltdb.flow');
  await assertFilesDoNotExist([configDestination, flowDestination]);

  const applicationName = await detectFlowApplicationName(cwd);
  const content = canonicalConfig(applicationName, selected);
  await writeFile(configDestination, content, { encoding: 'utf8', flag: 'wx' });
  await writeFlowContract(flowDestination, applicationName, selected, true);

  writeLine(io.stdout, `Created ${configDestination}`);
  writeLine(io.stdout, `Created ${flowDestination}`);
  writeLine(io.stdout, `Enabled: ${selected.join(', ')}`);
  return 0;
}

async function writeFlowContract(destination: string, applicationName: string, selected: readonly typeof SUPPORTED_CAPABILITIES[number][], exclusive = false): Promise<void> {
  const template = parseFlowSpec(await readFile(new URL('../../appport.flow', import.meta.url), 'utf8'));
  const includedCollections = new Set(selected.flatMap((capability) => CAPABILITY_COLLECTIONS[capability]));
  const flowContent = formatFlowSpec({ ...template, app: applicationName, collections: template.collections.filter((collection) => includedCollections.has(collection.name)) });
  await writeFile(destination, flowContent, { encoding: 'utf8', ...(exclusive ? { flag: 'wx' } : {}) });
}

function canonicalConfig(applicationName: string, selected: readonly string[]): string {
  const has = (capability: string) => selected.includes(capability);
  const lines = [
    '# AppPort application contract',
    'version = "1"',
    '',
    '[application]',
    `name = "${applicationName}"`,
    'description = "AppPort application"',
    'runtime = "node"',
    '',
    '[deployment]',
    'mode = "local"',
    'storage = "durable"',
    'distributed = true',
    '',
    '[state]',
    'enabled = true',
    'authority = "feltdb"',
    `namespace = "${applicationName}"`,
    '',
    '[tenant]',
    'mode = "required"',
    'default = "development"',
    '',
    '[http]',
    'enabled = true',
    'host = "127.0.0.1"',
    'port = 8787',
    '',
    '[cors]',
    'enabled = true',
    'origins = ["*"]',
  ];
  if (has('api')) lines.push('', '[api]', 'enabled = true', '', '[api.keys]', 'enabled = true', 'scopes = ["example.read", "example.write"]');
  if (has('webhooks')) lines.push('', '[webhooks]', 'enabled = true', '', '[webhooks.delivery]', 'enabled = true', 'retries = 3', 'timeout_ms = 10000', '', '[webhooks.events]', 'allowed = ["example.created"]');
  if (has('jobs')) lines.push('', '[jobs]', 'enabled = true', '', '[jobs.execution]', 'enabled = true', 'max_attempts = 3', '', '[jobs.types]', '"example.process" = { timeout_ms = 30000 }');
  lines.push(
    '', '[events]', 'enabled = true', '', '[events.streaming]', 'enabled = true', 'transport = "sse"',
    '', '[authorization]', `enabled = ${has('api')}`, 'default = "deny"',
    '', '[observability]', 'enabled = true',
    '', '[lifecycle]', 'managed = true',
    '', '[development]', 'mail = "local"', 'webhooks = "local"', 'jobs = "local"',
    '', ...selected.map((capability) => `use ${capability}`), '',
  );
  return lines.join('\n');
}

function createConfiguredRuntime(cwd: string): { runtime: ReturnType<typeof createFeltDbRuntime>; config?: ReturnType<typeof parseAppPortConfig> } {
  const configPath = resolve(cwd, 'appport.toml');
  if (!existsSync(configPath)) return { runtime: createFeltDbRuntime() };
  const config = parseAppPortConfig(configPath);
  if (config.deployment.storage === 'memory') return { runtime: createFeltDbRuntime({ memory: true, namespace: config.state.namespace }), config };
  if (config.deployment.mode !== 'local' && process.env.FELTDB_URL) {
    return { runtime: createFeltDbRuntime({ namespace: config.state.namespace, server: { url: process.env.FELTDB_URL, token: process.env.FELTDB_TOKEN, applicationId: config.application.name, environment: process.env.FELTDB_ENVIRONMENT } }), config };
  }
  return { runtime: createFeltDbRuntime({ mode: 'local', namespace: config.state.namespace, path: resolve(cwd, '.appport/state') }), config };
}

function createConfiguredApiKeyService(cwd: string): ApiKeyService {
  const { runtime, config } = createConfiguredRuntime(cwd);
  return new ApiKeyServiceImpl({ store: new FeltDbApiKeyStore(runtime.db), auditSink: new FeltDbAuditSink(runtime.db), runtime, allowedScopes: config?.api.keys.scopes });
}

async function configureCapabilities(io: CommandIo): Promise<string[]> {
  if (!io.stdin || !('isTTY' in io.stdin) || !io.stdin.isTTY) {
    return [...SUPPORTED_CAPABILITIES];
  }

  writeLine(io.stdout, 'Configure AppPort capabilities (press Enter to accept each default):');
  const prompts: ReadonlyArray<readonly [typeof SUPPORTED_CAPABILITIES[number], string]> = [
    ['api', 'API keys'],
    ['webhooks', 'Webhooks'],
    ['jobs', 'Jobs'],
  ];
  const selected: string[] = [];
  const readline = createInterface({ input: io.stdin, output: io.stdout, terminal: true });
  try {
    for (const [capability, label] of prompts) {
      const answer = (await readline.question(`Enable ${label}? [Y/n] `)).trim().toLowerCase();
      if (answer === '' || answer === 'y' || answer === 'yes') selected.push(capability);
      else if (answer !== 'n' && answer !== 'no') {
        throw new Error(`Invalid answer "${answer}". Enter y or n.`);
      }
    }
  } finally {
    readline.close();
  }
  return selected;
}

async function assertFilesDoNotExist(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await access(path);
      throw new Error(`${basename(path)} already exists at ${path}`);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }
}

async function detectFlowApplicationName(cwd: string): Promise<string> {
  let candidate = basename(cwd);
  try {
    const manifest = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8')) as { name?: unknown };
    if (typeof manifest.name === 'string' && manifest.name.trim()) {
      candidate = manifest.name.replace(/^@[^/]+\//, '');
    }
  } catch {
    // A package manifest is optional during initialization.
  }
  return candidate.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

async function handleApiKeyCommand(
  action: string,
  rest: readonly string[],
  io: CommandIo,
  service: ApiKeyService,
): Promise<number> {
  if (action === 'create') {
    const options = parseOptions(rest);
    const tenantId = required(options, 'tenant');
    const name = required(options, 'name');
    const createdBy = required(options, 'created-by');
    const scopes = arrayOption(options, 'scope');
    const expiresAtValue = firstOption(options, 'expires-at');
    const created = await service.createApiKey({
      tenantId,
      name,
      scopes,
      expiresAt: expiresAtValue ? new Date(expiresAtValue) : undefined,
      createdBy,
    });
    writeLine(io.stderr, 'WARNING: save this secret now. It will only be shown once.');
    writeLine(io.stdout, `id: ${created.id}`);
    writeLine(io.stdout, `name: ${created.name}`);
    writeLine(io.stdout, `prefix: ${created.prefix}`);
    io.stdout.write(`secret: ${created.secret}\n`);
    return 0;
  }

  if (action === 'list') {
    const options = parseOptions(rest);
    const tenantId = required(options, 'tenant');
    const items = await service.listApiKeys(tenantId);
    for (const item of items) {
      writeLine(
        io.stdout,
        `${item.id}\t${item.name}\t${item.keyPrefix}\t${item.scopes.join(',')}\t${item.revokedAt ? 'revoked' : 'active'}`,
      );
    }
    return 0;
  }

  if (action === 'revoke') {
    const [id, ...optionTokens] = rest;
    if (!id) {
      throw new Error('Missing API key id.');
    }
    const options = parseOptions(optionTokens);
    const tenantId = required(options, 'tenant');
    const revokedBy = required(options, 'revoked-by');
    const revoked = await service.revokeApiKey({ id, tenantId, revokedBy });
    if (!revoked) {
      writeLine(io.stderr, 'API key not found for tenant.');
      return 1;
    }
    writeLine(io.stdout, `revoked: ${revoked.id}`);
    return 0;
  }

  writeLine(io.stderr, 'Usage: appport-runtime api-key <create|list|revoke>');
  return 1;
}

async function handleWebhookCommand(
  action: string,
  rest: readonly string[],
  io: CommandIo,
  cwd: string,
): Promise<number> {
  const { runtime, config } = createConfiguredRuntime(cwd);
  const webhookService = new WebhookService({
    endpointStore: new FeltDbWebhookEndpointStore(runtime.db),
    deliveryStore: new FeltDbWebhookDeliveryStore(runtime.db),
    auditSink: new FeltDbWebhookAuditSink(runtime.db),
    secretStore: new EncryptedWebhookSecretStore(),
    maxRetryAttempts: config?.webhooks.delivery.retries,
    requestTimeoutMs: config?.webhooks.delivery.timeout_ms,
    allowedEvents: config?.webhooks.events.allowed,
  });

  try {
    if (action === 'create') {
      const options = parseOptions(rest);
      const tenantId = required(options, 'tenant');
      const url = required(options, 'url');
      const createdBy = required(options, 'created-by');
      const events = arrayOption(options, 'event');

      if (events.length === 0) {
        throw new Error('At least one --event is required');
      }

      const { endpoint, secret } = await webhookService.createWebhookEndpoint({
        tenantId,
        url,
        events,
        createdBy,
      });

      writeLine(io.stderr, 'WARNING: save this secret now. It will only be shown once.');
      writeLine(io.stdout, `id: ${endpoint.id}`);
      writeLine(io.stdout, `url: ${endpoint.url}`);
      writeLine(io.stdout, `events: ${endpoint.events.join(',')}`);
      io.stdout.write(`secret: ${secret}\n`);
      return 0;
    }

    if (action === 'list') {
      const options = parseOptions(rest);
      const tenantId = required(options, 'tenant');
      const endpoints = await webhookService.listWebhookEndpoints(tenantId);
      for (const ep of endpoints) {
        const status = ep.disabledAt ? 'disabled' : 'active';
        writeLine(
          io.stdout,
          `${ep.id}\t${ep.url}\t${ep.events.join(',')}\t${status}`,
        );
      }
      return 0;
    }

    if (action === 'disable') {
      const [id, ...optionTokens] = rest;
      if (!id) {
        throw new Error('Missing endpoint id.');
      }
      const options = parseOptions(optionTokens);
      const tenantId = required(options, 'tenant');
      const disabledBy = required(options, 'disabled-by');
      const disabled = await webhookService.disableWebhookEndpoint({
        tenantId,
        id,
        disabledBy,
      });
      if (!disabled) {
        writeLine(io.stderr, 'Webhook endpoint not found for tenant.');
        return 1;
      }
      writeLine(io.stdout, `disabled: ${disabled.id}`);
      return 0;
    }

    if (action === 'deliveries') {
      const options = parseOptions(rest);
      const tenantId = required(options, 'tenant');
      const endpointId = firstOption(options, 'endpoint');
      const limit = firstOption(options, 'limit') ? parseInt(firstOption(options, 'limit')!, 10) : 50;
      const deliveries = await webhookService.listWebhookDeliveries(tenantId, endpointId, limit);
      for (const delivery of deliveries) {
        writeLine(
          io.stdout,
          `${delivery.id}\t${delivery.endpointId}\t${delivery.eventType}\t${delivery.status}\tattempts=${delivery.attemptCount}`,
        );
      }
      return 0;
    }

    if (action === 'replay') {
      const [deliveryId, ...optionTokens] = rest;
      if (!deliveryId) {
        throw new Error('Missing delivery id.');
      }
      const options = parseOptions(optionTokens);
      const tenantId = required(options, 'tenant');
      const replayedBy = required(options, 'replayed-by');
      const replayed = await webhookService.replayWebhookDelivery(tenantId, deliveryId, replayedBy);
      if (!replayed) {
        writeLine(io.stderr, 'Webhook delivery not found or endpoint is disabled.');
        return 1;
      }
      writeLine(io.stdout, `replayed: ${replayed.id}`);
      return 0;
    }

    writeLine(io.stderr, 'Usage: appport-runtime webhook <create|list|disable|deliveries|replay>');
    return 1;
  } finally {
    await runtime.db.close();
  }
}

async function handleJobCommand(
  action: string,
  rest: readonly string[],
  io: CommandIo,
  cwd: string,
): Promise<number> {
  const { runtime, config } = createConfiguredRuntime(cwd);
  const jobService = new JobService({
    jobStore: new FeltDbJobStore(runtime.db),
    scheduleStore: new FeltDbJobScheduleStore(runtime.db),
    auditSink: new FeltDbJobAuditSink(runtime.db),
    maxRetryAttempts: config?.jobs.execution.max_attempts,
    allowedTypes: config ? Object.keys(config.jobs.types) : undefined,
  });

  try {
    if (action === 'enqueue') {
      const options = parseOptions(rest);
      const tenantId = required(options, 'tenant');
      const type = required(options, 'type');
      const payload = firstOption(options, 'payload') ? JSON.parse(firstOption(options, 'payload')!) : {};

      const job = await jobService.enqueue({
        tenantId,
        type,
        payload,
      });

      writeLine(io.stdout, `id: ${job.id}`);
      writeLine(io.stdout, `type: ${job.type}`);
      writeLine(io.stdout, `status: ${job.status}`);
      writeLine(io.stdout, `runAt: ${job.runAt}`);
      return 0;
    }

    if (action === 'schedule') {
      const options = parseOptions(rest);
      const tenantId = required(options, 'tenant');
      const type = required(options, 'type');
      const runAt = required(options, 'run-at');
      const payload = firstOption(options, 'payload') ? JSON.parse(firstOption(options, 'payload')!) : {};

      const job = await jobService.schedule({
        tenantId,
        type,
        payload,
        runAt,
      });

      writeLine(io.stdout, `id: ${job.id}`);
      writeLine(io.stdout, `type: ${job.type}`);
      writeLine(io.stdout, `status: ${job.status}`);
      writeLine(io.stdout, `runAt: ${job.runAt}`);
      return 0;
    }

    if (action === 'schedule-recurring') {
      const options = parseOptions(rest);
      const tenantId = required(options, 'tenant');
      const type = required(options, 'type');
      const interval = required(options, 'interval');
      const createdBy = required(options, 'created-by');
      const payload = firstOption(options, 'payload') ? JSON.parse(firstOption(options, 'payload')!) : {};

      const schedule = await jobService.scheduleRecurring({
        tenantId,
        type,
        payload,
        interval,
        createdBy,
      });

      writeLine(io.stdout, `id: ${schedule.id}`);
      writeLine(io.stdout, `type: ${schedule.type}`);
      writeLine(io.stdout, `interval: ${schedule.interval}`);
      writeLine(io.stdout, `nextRunAt: ${schedule.nextRunAt}`);
      return 0;
    }

    if (action === 'list') {
      const options = parseOptions(rest);
      const tenantId = required(options, 'tenant');
      const jobs = await jobService.listJobs(tenantId);

      for (const job of jobs) {
        const status = job.status;
        const runIn = job.status === 'running'
          ? 'now'
          : job.status === 'retrying' && job.nextAttemptAt
          ? getTimeRemaining(job.nextAttemptAt)
          : getTimeRemaining(job.runAt);
        writeLine(
          io.stdout,
          `${job.id}\t${job.type}\t${status}\t${runIn}\tattempt=${job.attemptCount}/${job.maxAttempts}`,
        );
      }
      return 0;
    }

    if (action === 'get') {
      const [jobId, ...optionTokens] = rest;
      if (!jobId) {
        throw new Error('Missing job id.');
      }
      const options = parseOptions(optionTokens);
      const tenantId = required(options, 'tenant');
      const job = await jobService.getJob(tenantId, jobId);

      if (!job) {
        writeLine(io.stderr, 'Job not found.');
        return 1;
      }

      writeLine(io.stdout, `id: ${job.id}`);
      writeLine(io.stdout, `type: ${job.type}`);
      writeLine(io.stdout, `status: ${job.status}`);
      writeLine(io.stdout, `runAt: ${job.runAt}`);
      writeLine(io.stdout, `attemptCount: ${job.attemptCount}`);
      writeLine(io.stdout, `maxAttempts: ${job.maxAttempts}`);
      if (job.lastError) {
        writeLine(io.stdout, `lastError: ${job.lastError}`);
      }
      return 0;
    }

    if (action === 'retry') {
      const [jobId, ...optionTokens] = rest;
      if (!jobId) {
        throw new Error('Missing job id.');
      }
      const options = parseOptions(optionTokens);
      const tenantId = required(options, 'tenant');
      const retried = await jobService.retry(tenantId, jobId);

      if (!retried) {
        writeLine(io.stderr, 'Job not found.');
        return 1;
      }

      writeLine(io.stdout, `retried: ${retried.id}`);
      return 0;
    }

    if (action === 'schedules') {
      const options = parseOptions(rest);
      const tenantId = required(options, 'tenant');
      const schedules = await jobService.listSchedules(tenantId);

      for (const schedule of schedules) {
        const status = schedule.enabled ? 'enabled' : 'disabled';
        writeLine(
          io.stdout,
          `${schedule.id}\t${schedule.type}\t${status}\t${schedule.interval}\tnext=${getTimeRemaining(schedule.nextRunAt)}`,
        );
      }
      return 0;
    }

    if (action === 'disable-schedule') {
      const [scheduleId, ...optionTokens] = rest;
      if (!scheduleId) {
        throw new Error('Missing schedule id.');
      }
      const options = parseOptions(optionTokens);
      const tenantId = required(options, 'tenant');
      const disabled = await jobService.disableSchedule(tenantId, scheduleId);

      if (!disabled) {
        writeLine(io.stderr, 'Schedule not found.');
        return 1;
      }

      writeLine(io.stdout, `disabled: ${disabled.id}`);
      return 0;
    }

    writeLine(io.stderr, 'Usage: appport-runtime job <enqueue|schedule|schedule-recurring|list|get|retry|schedules|disable-schedule>');
    return 1;
  } finally {
    await runtime.db.close();
  }
}

function getTimeRemaining(targetTime: string): string {
  const now = new Date();
  const target = new Date(targetTime);
  const diffMs = target.getTime() - now.getTime();

  if (diffMs < 0) {
    return '-';
  }

  const seconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

async function closeQuietly(service: ApiKeyService): Promise<void> {
  await service.close().catch(() => undefined);
}

function parseOptions(tokens: readonly string[]): Map<string, string[]> {
  const options = new Map<string, string[]>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    const values = options.get(key) ?? [];
    values.push(value);
    options.set(key, values);
    index += 1;
  }
  return options;
}

function required(options: Map<string, string[]>, key: string): string {
  const value = firstOption(options, key);
  if (!value) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

function firstOption(options: Map<string, string[]>, key: string): string | undefined {
  return options.get(key)?.[0];
}

function arrayOption(options: Map<string, string[]>, key: string): readonly string[] {
  return options.get(key) ?? [];
}

function writeLine(stream: NodeJS.WritableStream, line: string): void {
  stream.write(`${line}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
