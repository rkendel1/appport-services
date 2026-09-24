import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ConfigurationService,
  createFeltDbRuntime,
  FeltDbConfigurationStore,
} from '../src/_internal.js';
import { ConfigurationValidationError } from '../src/configuration/service.js';
import { configurationCollectionNames } from '../src/configuration/storage.js';
import { ServiceMigrationError } from '../src/authority/errors.js';
import { principal as verified, testGateway } from './support/authority.js';

const scope = { tenantId: 'tenant-a', applicationId: 'factory', environment: 'production' as const };
const principal = verified({ principalId: 'operator-a', principalType: 'api_key', tenantId: scope.tenantId, credentialId: 'key-a' });

async function persistedConfiguration() {
  const path = await mkdtemp(join(tmpdir(), 'appport-configuration-'));
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: `configuration-${Math.random()}`, path });
  const store = new FeltDbConfigurationStore(runtime.db);
  return { runtime, store, service: new ConfigurationService({ store, authority: testGateway(runtime.db, { application: 'factory' }) }) };
}

test('FeltDB variable lifecycle ignores mutation fields in identity lookups', async () => {
  const { runtime, store, service } = await persistedConfiguration();
  try {
    await service.createVariable({ ...scope, name: 'PUBLIC_ORIGIN', value: 'https://old.example', required: true }, principal);

    const updated = await service.updateVariable({ ...scope, name: 'PUBLIC_ORIGIN', value: 'https://updated.example', required: false }, principal);
    assert.equal(updated.value, 'https://updated.example');
    assert.equal(updated.required, false);

    const listed = await service.list(scope, principal);
    assert.equal(listed.variables.length, 1);
    assert.equal(listed.variables[0]?.value, 'https://updated.example');

    const deleteInput = {
      ...scope,
      name: 'PUBLIC_ORIGIN',
      kind: 'variable' as const,
      value: 'mutation-field-must-not-be-a-predicate',
      required: true,
    };
    await service.delete(deleteInput, principal);

    assert.equal(await store.getVariable(scope, 'PUBLIC_ORIGIN'), null);
    assert.equal((await service.list(scope, principal)).variables.length, 0);
  } finally {
    await runtime.db.close();
  }
});

test('FeltDB credential bindings store only credential references and refuse raw values', async () => {
  const { runtime, store, service } = await persistedConfiguration();
  const raw = `raw-${crypto.randomUUID()}`;
  try {
    await assert.rejects(service.createSecret({ ...scope, name: 'API_TOKEN', value: raw } as never, principal), ServiceMigrationError);

    const created = await service.createSecret({ ...scope, name: 'API_TOKEN', credentialRef: 'credential-ref:cred_original' }, principal);
    assert.equal('value' in created, false);
    assert.equal(created.credentialRef, 'credential-ref:cred_original');

    const metadata = await service.rotateSecret({ ...scope, name: 'API_TOKEN', credentialRef: 'credential-ref:cred_rotated', required: true }, principal);
    assert.equal(metadata.credentialRef, 'credential-ref:cred_rotated');
    assert.equal(metadata.required, true);
    await assert.rejects(service.rotateSecret({ ...scope, name: 'API_TOKEN', credentialRef: raw }, principal), ServiceMigrationError);

    const listed = await service.list(scope, principal);
    assert.equal(listed.secrets.length, 1);
    assert.equal(listed.secrets[0]?.name, 'API_TOKEN');

    await assert.rejects(service.createSecret({ ...scope, name: 'API_TOKEN', credentialRef: 'credential-ref:cred_duplicate' }, principal), ConfigurationValidationError);

    await service.delete({ ...scope, name: 'API_TOKEN', kind: 'secret' as const }, principal);
    assert.equal(await store.getSecret(scope, 'API_TOKEN'), null);
    assert.equal((await service.list(scope, principal)).secrets.length, 0);
    await assert.rejects(service.rotateSecret({ ...scope, name: 'API_TOKEN', credentialRef: 'credential-ref:cred_absent' }, principal), ConfigurationValidationError);

    const auditRecords = await runtime.db.collection(configurationCollectionNames.audit).list();
    const stored = await runtime.db.collection(configurationCollectionNames.secrets).list();
    assert.equal(JSON.stringify({ created, metadata, listed, auditRecords, stored }).includes(raw), false);
  } finally {
    await runtime.db.close();
  }
});

test('FeltDB rejects duplicate names when mutation values differ', async () => {
  const { runtime, service } = await persistedConfiguration();
  try {
    await service.createVariable({ ...scope, name: 'PUBLIC_ORIGIN', value: 'https://one.example' }, principal);
    await assert.rejects(
      service.createVariable({ ...scope, name: 'PUBLIC_ORIGIN', value: 'https://two.example' }, principal),
      ConfigurationValidationError,
    );

    await service.createSecret({ ...scope, name: 'DEPLOY_TOKEN', credentialRef: 'credential-ref:first' }, principal);
    await assert.rejects(
      service.createSecret({ ...scope, name: 'DEPLOY_TOKEN', credentialRef: 'credential-ref:second' }, principal),
      ConfigurationValidationError,
    );
  } finally {
    await runtime.db.close();
  }
});

test('FeltDB preserves the shared variable and secret name namespace', async () => {
  const { runtime, service } = await persistedConfiguration();
  try {
    await service.createVariable({ ...scope, name: 'API_TOKEN', value: 'public-value' }, principal);
    await assert.rejects(
      service.createSecret({ ...scope, name: 'API_TOKEN', credentialRef: 'credential-ref:secret' }, principal),
      ConfigurationValidationError,
    );
  } finally {
    await runtime.db.close();
  }
});
