import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(process.cwd());

test('boundary audit documents actual legacy implementation exceptions', () => {
  const audit = readFileSync(join(root, 'docs/boundary-audit.md'), 'utf8');
  for (const term of ['API Keys', 'Webhooks', 'Jobs', 'Secrets', 'Follow-up required', 'pre-existing']) {
    assert.equal(audit.includes(term), true, `audit should contain ${term}`);
  }
  assert.match(audit, /API Key authentication and principal creation/);
  assert.match(audit, /Webhook signing, secret handling, HTTP delivery/);
  assert.match(audit, /Job claiming, leasing, execution, retry/);
});

test('AppPort has no implementation-specific package dependencies', () => {
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const names = [...Object.keys(packageJson.dependencies), ...Object.keys(packageJson.devDependencies)];
  assert.equal(names.some((name) => /authboundry|appboundry|vault|aws-sdk|gcp|fly/i.test(name)), false);
});

test('Secrets source remains protocol-only', () => {
  const secrets = [
    readFileSync(join(root, 'src/secrets/models.ts'), 'utf8'),
    readFileSync(join(root, 'src/secrets/protocol.ts'), 'utf8'),
    readFileSync(join(root, 'src/secrets/errors.ts'), 'utf8'),
  ].join('\n');
  assert.equal(/class\s+SecretsService|class\s+InMemorySecret|SecretProvider\s*\{/.test(secrets), false);
  assert.equal(/authorize|policy|role|claim/i.test(secrets), false);
  for (const forbidden of ['secret_value', 'plaintext', 'decrypted_value', 'provider_password', 'provider_token']) {
    assert.equal(secrets.includes(forbidden), false);
  }
});
