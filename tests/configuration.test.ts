import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigurationAuthorizationError, ConfigurationService, ConfigurationValidationError } from '../src/configuration/service.js';
import type { ConfigurationAuditEvent, ConfigurationSecret, ConfigurationVariable } from '../src/configuration/models.js';
import type { ConfigurationStore } from '../src/configuration/storage.js';
import type { AuthenticatedPrincipal } from '../src/contract/principals.js';

class MemoryConfigurationStore implements ConfigurationStore {
  variables: ConfigurationVariable[] = [];
  secrets: ConfigurationSecret[] = [];
  auditEvents: ConfigurationAuditEvent[] = [];
  async listVariables(s: any) { return this.variables.filter((v) => v.tenantId === s.tenantId && v.applicationId === s.applicationId && v.environment === s.environment); }
  async getVariable(s: any, name: string) { return this.variables.find((v) => v.tenantId === s.tenantId && v.applicationId === s.applicationId && v.environment === s.environment && v.name === name) ?? null; }
  async saveVariable(item: ConfigurationVariable) { const i = this.variables.findIndex((v) => v.id === item.id); if (i < 0) this.variables.push(item); else this.variables[i] = item; return item; }
  async deleteVariable(item: ConfigurationVariable) { this.variables = this.variables.filter((v) => v.id !== item.id); }
  async listSecrets(s: any) { return this.secrets.filter((v) => v.tenantId === s.tenantId && v.applicationId === s.applicationId && v.environment === s.environment); }
  async getSecret(s: any, name: string) { return this.secrets.find((v) => v.tenantId === s.tenantId && v.applicationId === s.applicationId && v.environment === s.environment && v.name === name) ?? null; }
  async saveSecret(item: ConfigurationSecret) { const i = this.secrets.findIndex((v) => v.id === item.id); if (i < 0) this.secrets.push(item); else this.secrets[i] = item; return item; }
  async deleteSecret(item: ConfigurationSecret) { this.secrets = this.secrets.filter((v) => v.id !== item.id); }
  async audit(event: ConfigurationAuditEvent) { this.auditEvents.push(event); }
}

const principal = (tenantId = 'tenant-a', scopes = ['configuration.read', 'configuration.write', 'configuration.delete', 'secret.rotate']): AuthenticatedPrincipal => ({ principalId: 'actor', principalType: 'api_key', tenantId, scopes, credentialId: 'key' });
const input = { tenantId: 'tenant-a', applicationId: 'app', environment: 'production' as const };

test('configuration variables and secrets have separate safe read models', async () => {
  const store = new MemoryConfigurationStore();
  const service = new ConfigurationService({ store, now: () => new Date('2026-09-19T00:00:00Z') });
  const variable = await service.createVariable({ ...input, name: 'LOG_LEVEL', value: 'info' }, principal());
  const secret = await service.createSecret({ ...input, name: 'API_TOKEN', value: 'never-return-this' }, principal());
  assert.equal(variable.value, 'info');
  assert.equal('value' in secret, false);
  assert.equal(JSON.stringify(await service.list(input, principal())).includes('never-return-this'), false);
  assert.equal(JSON.stringify(store.auditEvents).includes('never-return-this'), false);
  await service.rotateSecret({ ...input, name: 'API_TOKEN', value: 'also-never-return-this' }, principal());
  assert.equal(JSON.stringify(store.auditEvents).includes('also-never-return-this'), false);
});

test('configuration enforces names, duplicate scope, authorization, and tenant isolation', async () => {
  const store = new MemoryConfigurationStore();
  const service = new ConfigurationService({ store });
  await service.createVariable({ ...input, name: 'PORT', value: '8080' }, principal());
  await assert.rejects(() => service.createSecret({ ...input, name: 'PORT', value: 'secret' }, principal()), ConfigurationValidationError);
  await assert.rejects(() => service.createVariable({ ...input, name: 'bad-name', value: 'x' }, principal()), ConfigurationValidationError);
  await assert.rejects(() => service.list(input, principal('other-tenant')), ConfigurationAuthorizationError);
  await assert.rejects(() => service.createVariable({ ...input, name: 'OTHER', value: 'x' }, principal('other-tenant')), ConfigurationAuthorizationError);
  assert.equal((await service.list({ ...input, tenantId: 'other-tenant' }, principal('other-tenant'))).variables.length, 0);
});
