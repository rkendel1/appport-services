import { type StateFirstDB } from '@feltdb/core';
import type { ConfigurationAuditEvent, ConfigurationEnvironment, ConfigurationSecret, ConfigurationVariable } from './models.js';

export interface ConfigurationStore {
  listVariables(scope: { tenantId: string; applicationId: string; environment: ConfigurationEnvironment }): Promise<readonly ConfigurationVariable[]>;
  getVariable(scope: { tenantId: string; applicationId: string; environment: ConfigurationEnvironment }, name: string): Promise<ConfigurationVariable | null>;
  saveVariable(item: ConfigurationVariable, expectedVersion?: number): Promise<ConfigurationVariable>;
  deleteVariable(item: ConfigurationVariable): Promise<void>;
  listSecrets(scope: { tenantId: string; applicationId: string; environment: ConfigurationEnvironment }): Promise<readonly ConfigurationSecret[]>;
  getSecret(scope: { tenantId: string; applicationId: string; environment: ConfigurationEnvironment }, name: string): Promise<ConfigurationSecret | null>;
  saveSecret(item: ConfigurationSecret, expectedVersion?: number): Promise<ConfigurationSecret>;
  deleteSecret(item: ConfigurationSecret): Promise<void>;
  audit(event: ConfigurationAuditEvent): Promise<void>;
}

const VARIABLES = 'ConfigurationVariables';
const SECRETS = 'ConfigurationSecrets';
const AUDIT = 'ConfigurationAuditEvents';

type Scope = { tenantId: string; applicationId: string; environment: ConfigurationEnvironment };
export class FeltDbConfigurationStore implements ConfigurationStore {
  private readonly variables;
  private readonly secrets;
  private readonly auditEvents;

  constructor(private readonly db: StateFirstDB) {
    this.variables = db.collection<ConfigurationVariable>(VARIABLES);
    this.secrets = db.collection<ConfigurationSecret>(SECRETS);
    this.auditEvents = db.collection<ConfigurationAuditEvent>(AUDIT);
  }

  async listVariables(scope: Scope) {
    return this.variables.find({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      environment: scope.environment,
    });
  }
  getVariable(scope: Scope, name: string) {
    return this.variables.find({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      environment: scope.environment,
      name,
    }).then((items) => items[0] ?? null);
  }
  async saveVariable(item: ConfigurationVariable, expectedVersion?: number): Promise<ConfigurationVariable> {
    if (expectedVersion === undefined) {
      await this.variables.insert(item, item.id);
      return item;
    }
    const result = await this.variables.updateIfVersion(item.id, expectedVersion, item);
    if (!result.updated || !result.item) throw new Error('Configuration changed concurrently');
    return result.item;
  }
  async deleteVariable(item: ConfigurationVariable) { await this.variables.delete(item.id); }
  async listSecrets(scope: Scope) {
    return this.secrets.find({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      environment: scope.environment,
    });
  }
  getSecret(scope: Scope, name: string) {
    return this.secrets.find({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      environment: scope.environment,
      name,
    }).then((items) => items[0] ?? null);
  }
  async saveSecret(item: ConfigurationSecret, expectedVersion?: number): Promise<ConfigurationSecret> {
    if (expectedVersion === undefined) {
      await this.secrets.insert(item, item.id);
      return item;
    }
    const result = await this.secrets.updateIfVersion(item.id, expectedVersion, item);
    if (!result.updated || !result.item) throw new Error('Configuration changed concurrently');
    return result.item;
  }
  async deleteSecret(item: ConfigurationSecret) { await this.secrets.delete(item.id); }
  async audit(event: ConfigurationAuditEvent) { await this.auditEvents.insert(event, event.id); }
}

export const configurationCollectionNames = { variables: VARIABLES, secrets: SECRETS, audit: AUDIT } as const;
