#!/usr/bin/env node

import process from 'node:process';

import { createApiKeyService } from './index.js';
import type { ApiKeyService } from './api-keys/service.js';
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
} from './index.js';

interface CommandIo {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

export async function runCli(
  argv: readonly string[],
  io: CommandIo = { stdout: process.stdout, stderr: process.stderr },
  service = createApiKeyService(),
): Promise<number> {
  try {
    const [group, action, ...rest] = argv;
    if (group === 'api-key') {
      return handleApiKeyCommand(action, rest, io, service);
    } else if (group === 'webhook') {
      return handleWebhookCommand(action, rest, io);
    } else if (group === 'job') {
      return handleJobCommand(action, rest, io);
    } else {
      writeLine(
        io.stderr,
        'Usage: appport <api-key|webhook|job> <command>',
      );
      return 1;
    }
  } finally {
    await closeQuietly(service);
  }
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

  writeLine(io.stderr, 'Usage: appport api-key <create|list|revoke>');
  return 1;
}

async function handleWebhookCommand(
  action: string,
  rest: readonly string[],
  io: CommandIo,
): Promise<number> {
  const runtime = createFeltDbRuntime();
  const webhookService = new WebhookService({
    endpointStore: new FeltDbWebhookEndpointStore(runtime.db),
    deliveryStore: new FeltDbWebhookDeliveryStore(runtime.db),
    auditSink: new FeltDbWebhookAuditSink(runtime.db),
    secretStore: new EncryptedWebhookSecretStore(),
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

    writeLine(io.stderr, 'Usage: appport webhook <create|list|disable|deliveries|replay>');
    return 1;
  } finally {
    await runtime.db.close();
  }
}

async function handleJobCommand(
  action: string,
  rest: readonly string[],
  io: CommandIo,
): Promise<number> {
  const runtime = createFeltDbRuntime();
  const jobService = new JobService({
    jobStore: new FeltDbJobStore(runtime.db),
    scheduleStore: new FeltDbJobScheduleStore(runtime.db),
    auditSink: new FeltDbJobAuditSink(runtime.db),
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

    writeLine(io.stderr, 'Usage: appport job <enqueue|schedule|schedule-recurring|list|get|retry|schedules|disable-schedule>');
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
