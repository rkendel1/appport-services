import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import type { SecretsProtocol } from '../src/index.js';

const root = join(process.cwd());

test('Secrets protocol is exported without an execution implementation', async () => {
  const protocol: SecretsProtocol = {
    registerSecret: async (input) => ({
      id: 'secret-id',
      tenantId: input.tenantId,
      name: input.name,
      currentVersion: 1,
      status: 'active',
      providerRef: input.providerRef,
      createdAt: new Date(0).toISOString(),
      createdBy: input.createdBy,
    }),
    describeSecret: async () => null,
    listSecrets: async () => [],
    resolveSecret: async () => undefined,
    rotateSecret: async () => { throw new Error('implementation boundary'); },
    revokeSecret: async () => { throw new Error('implementation boundary'); },
    retireSecret: async () => { throw new Error('implementation boundary'); },
  };
  assert.equal(typeof protocol.registerSecret, 'function');
  assert.equal(typeof protocol.resolveSecret, 'function');
});

test('Secrets package has no provider, authorization, or storage implementation', () => {
  const source = readFileSync(join(root, 'src/secrets/index.ts'), 'utf8');
  assert.equal(source.includes('Service'), false);
  assert.equal(source.includes('Store'), false);
  assert.equal(readFileSync(join(root, 'src/secrets/protocol.ts'), 'utf8').includes('authorize'), false);
  assert.equal(readFileSync(join(root, 'src/secrets/protocol.ts'), 'utf8').includes('process.env'), false);
});

test('Secrets durable contract excludes secret material and provider credentials', () => {
  const flow = readFileSync(join(root, 'appport.flow'), 'utf8');
  for (const forbidden of ['secret_value', 'plaintext', 'decrypted_value', 'provider_password', 'provider_token']) {
    assert.equal(flow.includes(forbidden), false, `appport.flow must not contain ${forbidden}`);
  }
  assert.match(flow, /collection Secrets/);
  assert.match(flow, /collection SecretVersions/);
  assert.match(flow, /collection SecretAuditEvents/);
});

test('package dependencies remain implementation-neutral', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  const dependencies = Object.keys(packageJson.dependencies);
  assert.equal(dependencies.some((name) => /vault|aws|gcp|fly|authboundry|appboundry/i.test(name)), false);
});
