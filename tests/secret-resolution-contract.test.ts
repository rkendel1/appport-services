import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  SecretProviderMismatchError,
  SecretResolutionDeniedError,
  SecretTenantMismatchError,
  type ScopedSecretsResolver,
} from '../src/index.js';

const MATERIAL = 'provider-held-material-never-in-appport-state';

test('provider-neutral scoped protocol supports server integration without leaking into Work or Evidence', async () => {
  let providerReads = 0;
  const appBoundry: ScopedSecretsResolver<string> = {
    async withSecret(input, use) {
      assert.equal(input.context.authorizationRef, 'authz-decision-7');
      if (input.reference.tenantId !== input.context.tenantId) throw new SecretTenantMismatchError(input.reference.secretId);
      if (input.reference.provider !== 'pipedrive') throw new SecretProviderMismatchError(input.reference.secretId);
      if (input.context.principalId !== 'integration:pipedrive') throw new SecretResolutionDeniedError(input.reference.secretId);
      providerReads += 1;
      return use({
        value: MATERIAL,
        secretId: input.reference.secretId,
        version: 2,
        provider: input.reference.provider,
        kind: input.reference.kind,
      });
    },
  };
  const work = {
    capability: 'person.lookup',
    secretRef: { secretId: 'secret-7', tenantId: 'acme', provider: 'pipedrive', kind: 'api_token' },
  };

  const evidence = await appBoundry.withSecret({
    reference: work.secretRef,
    context: { tenantId: 'acme', principalId: 'integration:pipedrive', purpose: 'person.lookup', authorizationRef: 'authz-decision-7' },
  }, async ({ value }) => ({ person: value === MATERIAL ? { id: 42 } : null }));

  assert.equal(providerReads, 1);
  assert.deepEqual(evidence, { person: { id: 42 } });
  assert.equal(JSON.stringify({ work, evidence }).includes(MATERIAL), false);
});

test('test AppBoundry denies tenant and principal mismatches before provider material access', async () => {
  let providerReads = 0;
  const appBoundry: ScopedSecretsResolver<string> = {
    async withSecret(input, use) {
      if (input.reference.tenantId !== input.context.tenantId) throw new SecretTenantMismatchError(input.reference.secretId);
      if (input.context.authorizationRef !== 'allowed') throw new SecretResolutionDeniedError(input.reference.secretId);
      providerReads += 1;
      return use({ value: MATERIAL, secretId: input.reference.secretId, version: 1 });
    },
  };
  const reference = { secretId: 'secret-7', tenantId: 'tenant-a' };

  await assert.rejects(
    appBoundry.withSecret({ reference, context: { tenantId: 'tenant-b', principalId: 'integration:test', purpose: 'lookup', authorizationRef: 'allowed' } }, () => undefined),
    SecretTenantMismatchError,
  );
  await assert.rejects(
    appBoundry.withSecret({ reference, context: { tenantId: 'tenant-a', principalId: 'integration:test', purpose: 'lookup' } }, () => undefined),
    SecretResolutionDeniedError,
  );
  assert.equal(providerReads, 0);
});

test('Secrets source remains protocol-only and has no material, provider, policy, or persistence implementation', () => {
  const root = process.cwd();
  const files = ['models.ts', 'protocol.ts', 'errors.ts', 'index.ts'];
  const source = files.map((file) => readFileSync(join(root, 'src/secrets', file), 'utf8')).join('\n');
  for (const forbidden of ['node:crypto', 'node:fs', '@feltdb/core', 'process.env', 'CredentialSecretStore', 'EncryptedFile', 'FeltDbSecret', 'class SecretService']) {
    assert.equal(source.includes(forbidden), false, `Secrets contract must not contain ${forbidden}`);
  }
  const flow = readFileSync(join(root, 'appport.flow'), 'utf8');
  for (const forbidden of ['secret_value', 'plaintext', 'decrypted_value', 'provider_password', 'provider_token', 'authorization_header']) {
    assert.equal(flow.includes(forbidden), false, `Flow must not contain ${forbidden}`);
  }
  const runtime = readFileSync(join(root, 'src/runtime/platform.ts'), 'utf8');
  assert.equal(/credentials\/.+value|secrets\/.+value/.test(runtime), false);
});
