import { randomUUID } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type {
  ConfigurationAuditEvent, ConfigurationDeclaration, ConfigurationEnvironment, ConfigurationList, ConfigurationScope,
  ConfigurationSecret, ConfigurationSecretView, ConfigurationVariable, ConfigurationVariableView,
} from './models.js';
import { CONFIGURATION_ENVIRONMENTS } from './models.js';
import type { ConfigurationStore } from './storage.js';

const NAME = /^[A-Z][A-Z0-9_]*$/;
type Input = ConfigurationScope & { name: string; required?: boolean; value: string };

export class ConfigurationAuthorizationError extends Error { constructor() { super('Configuration operation is not authorized'); this.name = 'ConfigurationAuthorizationError'; } }
export class ConfigurationValidationError extends Error { constructor(message: string) { super(message); this.name = 'ConfigurationValidationError'; } }

export interface ConfigurationServiceOptions {
  readonly store: ConfigurationStore;
  readonly declarations?: readonly ConfigurationDeclaration[];
  readonly now?: () => Date;
}

export class ConfigurationService {
  private readonly now: () => Date;
  constructor(private readonly options: ConfigurationServiceOptions) { this.now = options.now ?? (() => new Date()); }

  async list(scope: ConfigurationScope, principal: AuthenticatedPrincipal): Promise<ConfigurationList> {
    this.authorize(principal, scope.tenantId, 'configuration.read');
    validateScope(scope);
    const [variables, secrets] = await Promise.all([this.options.store.listVariables(scope), this.options.store.listSecrets(scope)]);
    return { variables: variables.map(variableView), secrets: secrets.map(secretView), declarations: this.options.declarations ?? [] };
  }

  async createVariable(input: Input, principal: AuthenticatedPrincipal): Promise<ConfigurationVariableView> {
    this.authorize(principal, input.tenantId, 'configuration.write');
    validateInput(input);
    const current = await this.options.store.getVariable(input, input.name);
    const secret = await this.options.store.getSecret(input, input.name);
    if (current || secret) throw new ConfigurationValidationError(`Configuration ${input.name} already exists`);
    const timestamp = this.now().toISOString();
    const item: ConfigurationVariable = { ...input, id: randomUUID(), required: input.required ?? false, createdAt: timestamp, updatedAt: timestamp, createdBy: principal.principalId, __version: 1 };
    await this.options.store.saveVariable(item);
    await this.record('configuration.created', item, 'variable', principal.principalId, 'created', 'configured');
    return variableView(item);
  }

  async updateVariable(input: Input, principal: AuthenticatedPrincipal): Promise<ConfigurationVariableView> {
    this.authorize(principal, input.tenantId, 'configuration.write');
    validateInput(input);
    const current = await this.options.store.getVariable(input, input.name);
    if (!current) throw new ConfigurationValidationError(`Configuration ${input.name} not found`);
    const item = { ...current, value: input.value, required: input.required ?? current.required, updatedAt: this.now().toISOString(), __version: current.__version + 1 };
    await this.options.store.saveVariable(item, current.__version);
    await this.record('configuration.updated', item, 'variable', principal.principalId, 'updated', 'configured');
    return variableView(item);
  }

  async createSecret(input: Input, principal: AuthenticatedPrincipal): Promise<ConfigurationSecretView> {
    this.authorize(principal, input.tenantId, 'configuration.write');
    validateInput(input);
    const current = await this.options.store.getSecret(input, input.name);
    const variable = await this.options.store.getVariable(input, input.name);
    if (current || variable) throw new ConfigurationValidationError(`Configuration ${input.name} already exists`);
    const timestamp = this.now().toISOString();
    const item: ConfigurationSecret = { ...input, id: randomUUID(), required: input.required ?? false, createdAt: timestamp, updatedAt: timestamp, createdBy: principal.principalId, __version: 1 };
    await this.options.store.saveSecret(item);
    await this.record('secret.created', item, 'secret', principal.principalId, 'created', 'configured');
    return secretView(item);
  }

  async rotateSecret(input: Input, principal: AuthenticatedPrincipal): Promise<ConfigurationSecretView> {
    this.authorize(principal, input.tenantId, 'secret.rotate');
    validateInput(input);
    const current = await this.options.store.getSecret(input, input.name);
    if (!current) throw new ConfigurationValidationError(`Configuration ${input.name} not found`);
    const item = { ...current, value: input.value, required: input.required ?? current.required, updatedAt: this.now().toISOString(), __version: current.__version + 1 };
    await this.options.store.saveSecret(item, current.__version);
    await this.record('secret.rotated', item, 'secret', principal.principalId, 'rotated', 'configured');
    return secretView(item);
  }

  async delete(scope: ConfigurationScope & { name: string; kind: 'variable' | 'secret' }, principal: AuthenticatedPrincipal): Promise<void> {
    this.authorize(principal, scope.tenantId, 'configuration.delete');
    validateScope(scope);
    const item = scope.kind === 'variable' ? await this.options.store.getVariable(scope, scope.name) : await this.options.store.getSecret(scope, scope.name);
    if (!item) return;
    if (scope.kind === 'variable') await this.options.store.deleteVariable(item as ConfigurationVariable);
    else await this.options.store.deleteSecret(item as ConfigurationSecret);
    await this.record(scope.kind === 'secret' ? 'secret.deleted' : 'configuration.deleted', item, scope.kind, principal.principalId, 'deleted', 'deleted');
  }

  private authorize(principal: AuthenticatedPrincipal, tenantId: string, scope: string) {
    if (principal.tenantId !== tenantId || !principal.scopes.includes(scope) && !principal.scopes.includes('configuration.admin')) throw new ConfigurationAuthorizationError();
  }
  private async record(type: ConfigurationAuditEvent['type'], item: ConfigurationVariable | ConfigurationSecret, kind: 'variable' | 'secret', actor: string, operation: string, status: ConfigurationAuditEvent['status']) {
    await this.options.store.audit({ id: randomUUID(), type, tenantId: item.tenantId, applicationId: item.applicationId, environment: item.environment, name: item.name, kind, actor, timestamp: this.now().toISOString(), operation, status });
  }
}

function validateInput(input: Input) {
  if (!NAME.test(input.name)) throw new ConfigurationValidationError('Name must be an uppercase configuration identifier');
  if (typeof input.value !== 'string' || input.value.length === 0) throw new ConfigurationValidationError('Value is required');
  validateScope(input);
}
function validateScope(scope: ConfigurationScope) {
  if (!CONFIGURATION_ENVIRONMENTS.includes(scope.environment)) throw new ConfigurationValidationError('Invalid environment');
  if (!scope.applicationId) throw new ConfigurationValidationError('Application is required');
}
function variableView(item: ConfigurationVariable): ConfigurationVariableView { const { __version: _, ...view } = item; return { ...view, kind: 'variable' }; }
function secretView(item: ConfigurationSecret): ConfigurationSecretView { const { value: _value, __version: _version, ...view } = item; return { ...view, kind: 'secret', configured: true }; }
