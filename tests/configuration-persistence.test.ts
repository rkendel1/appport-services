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
import type { AuthenticatedPrincipal } from '../src/contract/principals.js';

const scope = { tenantId: 'tenant-a', applicationId: 'factory', environment: 'production' as const };
const principal: AuthenticatedPrincipal = {
  principalId: 'operator-a',
  principalType: 'api_key',
  tenantId: scope.tenantId,
  scopes: ['configuration.read', 'configuration.write', 'configuration.delete', 'secret.rotate'],
  credentialId: 'key-a',
};

async function persistedConfiguration() {
  const path = await mkdtemp(join(tmpdir(), 'appport-configuration-'));
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: `configuration-${Math.random()}`, path });
  const store = new FeltDbConfigurationStore(runtime.db);
  return { runtime, store, service: new ConfigurationService({ store }) };
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

test('FeltDB secret lifecycle keeps values out of metadata, errors, and audit records', async () => {
  const { runtime, store, service } = await persistedConfiguration();
  const original = `original-${crypto.randomUUID()}`;
  const rotated = `rotated-${crypto.randomUUID()}`;
  const duplicate = `duplicate-${crypto.randomUUID()}`;
  const absent = `absent-${crypto.randomUUID()}`;
  const secretValues = [original, rotated, duplicate, absent];
  try {
    const created = await service.createSecret({ ...scope, name: 'API_TOKEN', value: original }, principal);
    assert.equal('value' in created, false);

    const metadata = await service.rotateSecret({ ...scope, name: 'API_TOKEN', value: rotated, required: true }, principal);
    assert.equal('value' in metadata, false);
    assert.equal(metadata.required, true);

    const listed = await service.list(scope, principal);
    assert.equal(listed.secrets.length, 1);
    assert.equal(listed.secrets[0]?.name, 'API_TOKEN');
    assert.equal('value' in listed.secrets[0]!, false);

    await assert.rejects(
      service.createSecret({ ...scope, name: 'API_TOKEN', value: duplicate }, principal),
      (error) => {
        assert.ok(error instanceof ConfigurationValidationError);
        for (const value of secretValues) assert.equal(String(error).includes(value), false);
        return true;
      },
    );

    const deleteInput = {
      ...scope,
      name: 'API_TOKEN',
      kind: 'secret' as const,
      value: 'mutation-field-must-not-be-a-predicate',
      required: false,
    };
    await service.delete(deleteInput, principal);

    assert.equal(await store.getSecret(scope, 'API_TOKEN'), null);
    assert.equal((await service.list(scope, principal)).secrets.length, 0);

    await assert.rejects(
      service.rotateSecret({ ...scope, name: 'API_TOKEN', value: absent }, principal),
      (error) => {
        assert.ok(error instanceof ConfigurationValidationError);
        for (const value of secretValues) assert.equal(String(error).includes(value), false);
        return true;
      },
    );
    const auditRecords = await runtime.db.collection(configurationCollectionNames.audit).list();
    const externallyVisible = JSON.stringify({ created, metadata, listed, auditRecords });
    for (const value of secretValues) assert.equal(externallyVisible.includes(value), false);
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

    await service.createSecret({ ...scope, name: 'DEPLOY_TOKEN', value: 'first-secret' }, principal);
    await assert.rejects(
      service.createSecret({ ...scope, name: 'DEPLOY_TOKEN', value: 'second-secret' }, principal),
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
      service.createSecret({ ...scope, name: 'API_TOKEN', value: 'secret-value' }, principal),
      ConfigurationValidationError,
    );
  } finally {
    await runtime.db.close();
  }
});
