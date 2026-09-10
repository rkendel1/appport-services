#!/usr/bin/env node

import process from 'node:process';

import { createApiKeyService } from './index.js';
import type { ApiKeyService } from './api-keys/service.js';

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
    if (group !== 'api-key') {
      writeLine(io.stderr, 'Usage: appport api-key <create|list|revoke>');
      return 1;
    }

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
  } finally {
    await closeQuietly(service);
  }
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
