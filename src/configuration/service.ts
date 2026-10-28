import { randomUUID } from 'node:crypto';
import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type {
  ConfigurationAuditEvent, ConfigurationDeclaration, ConfigurationList, ConfigurationScope,
  ConfigurationSecret, ConfigurationSecretView, ConfigurationVariable, ConfigurationVariableView,
} from './models.js';
import { CONFIGURATION_ENVIRONMENTS } from './models.js';
import type { ConfigurationStore } from './storage.js';
import {
  exportConfiguration, importConfiguration,
  type ConfigurationExportDocument, type ConfigurationExportOptions, type ConfigurationImportOptions, type ConfigurationImportReport, type ConfigurationTransferDependencies,
} from './transfer.js';
import { requireCredentialRef } from '../authority/credentials.js';
import { ServiceAuthorityError, ServiceMigrationError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { rejectCallerActor, requireVerifiedPrincipal, resolveTenant, type VerifiedPrincipal } from '../authority/principal.js';

const NAME = /^[A-Z][A-Z0-9_]*$/;
type Scope = Omit<ConfigurationScope, 'tenantId' | 'applicationId'> & { tenantId?: string; applicationId?: string };
type VariableInput = Scope & { name: string; required?: boolean; value: string };
type CredentialInput = Scope & { name: string; required?: boolean; credentialRef: string };

/** @deprecated Denials are reported as ServiceAuthorityError with code DENIED. */
export class ConfigurationAuthorizationError extends Error { constructor() { super('Configuration operation is not authorized'); this.name = 'ConfigurationAuthorizationError'; } }
export class ConfigurationValidationError extends Error { constructor(message: string) { super(message); this.name = 'ConfigurationValidationError'; } }

export interface ConfigurationServiceOptions {
  readonly store: ConfigurationStore;
  readonly declarations?: readonly ConfigurationDeclaration[];
  /** Sibling services whose non-secret state `export()`/`import()` carry. Without them only variables and credential bindings are carried. */
  readonly transfer?: Pick<ConfigurationTransferDependencies, 'webhooks' | 'schedules'>;
  /** Policy Enforcement Point. Ownership (tenant + application) and every change are enforced through it. */
  readonly authority?: ServiceGateway;
  readonly now?: () => Date;
}

/**
 * Configuration is durably owned by tenant + application + environment.
 * Ownership comes from the verified principal and the gateway's application,
 * never from caller-selected identifiers. Configuration is not authority:
 * attaching a credential reference does not let anyone use it.
 */
export class ConfigurationService {
  private readonly now: () => Date;
  constructor(private readonly options: ConfigurationServiceOptions) { this.now = options.now ?? (() => new Date()); }

  async list(scope: Scope, caller: AuthenticatedPrincipal): Promise<ConfigurationList> {
    const { principal, owned } = this.own(scope, caller);
    return this.gateway().execute('configuration.read', principal, resource(owned), { service: 'configuration' }, async () => {
      const [variables, secrets] = await Promise.all([this.options.store.listVariables(owned), this.options.store.listSecrets(owned)]);
      return { variables: variables.map(variableView), secrets: secrets.map(secretView), declarations: this.options.declarations ?? [] };
    });
  }

  async createVariable(input: VariableInput, caller: AuthenticatedPrincipal): Promise<ConfigurationVariableView> {
    const { principal, owned } = this.own(input, caller);
    validateVariable(input);
    return this.gateway().execute('configuration.write', principal, resource(owned, input.name), { service: 'configuration' }, async () => {
      const current = await this.options.store.getVariable(owned, input.name);
      const secret = await this.options.store.getSecret(owned, input.name);
      if (current || secret) throw new ConfigurationValidationError(`Configuration ${input.name} already exists`);
      const timestamp = this.now().toISOString();
      const item: ConfigurationVariable = { ...owned, name: input.name, value: input.value, id: randomUUID(), required: input.required ?? false, createdAt: timestamp, updatedAt: timestamp, createdBy: principal.principalId, __version: 1 };
      await this.options.store.saveVariable(item);
      await this.record('configuration.created', item, 'variable', principal.principalId, 'created', 'configured');
      return variableView(item);
    });
  }

  async updateVariable(input: VariableInput, caller: AuthenticatedPrincipal): Promise<ConfigurationVariableView> {
    const { principal, owned } = this.own(input, caller);
    validateVariable(input);
    return this.gateway().execute('configuration.write', principal, resource(owned, input.name), { service: 'configuration' }, async () => {
      const current = await this.options.store.getVariable(owned, input.name);
      if (!current) throw new ConfigurationValidationError(`Configuration ${input.name} not found`);
      const item = { ...current, value: input.value, required: input.required ?? current.required, updatedAt: this.now().toISOString(), __version: current.__version + 1 };
      await this.options.store.saveVariable(item, current.__version);
      await this.record('configuration.updated', item, 'variable', principal.principalId, 'updated', 'configured');
      return variableView(item);
    });
  }

  /** Attach a credential reference (credential.attach). Raw values are refused. */
  async createSecret(input: CredentialInput, caller: AuthenticatedPrincipal): Promise<ConfigurationSecretView> {
    rejectRawSecret(input);
    const { principal, owned } = this.own(input, caller);
    validateName(input.name);
    const credentialRef = requireCredentialRef(input.credentialRef);
    return this.gateway().execute('credential.attach', principal, resource(owned, input.name, 'credential', credentialRef), { service: 'configuration', credentialRef }, async () => {
      const current = await this.options.store.getSecret(owned, input.name);
      const variable = await this.options.store.getVariable(owned, input.name);
      if (current || variable) throw new ConfigurationValidationError(`Configuration ${input.name} already exists`);
      const timestamp = this.now().toISOString();
      const item: ConfigurationSecret = { ...owned, name: input.name, credentialRef, id: randomUUID(), required: input.required ?? false, createdAt: timestamp, updatedAt: timestamp, createdBy: principal.principalId, __version: 1 };
      await this.options.store.saveSecret(item);
      await this.record('secret.created', item, 'secret', principal.principalId, 'created', 'configured');
      return secretView(item);
    });
  }

  /** Point a credential binding at a new credential reference (credential.rotate). */
  async rotateSecret(input: CredentialInput, caller: AuthenticatedPrincipal): Promise<ConfigurationSecretView> {
    rejectRawSecret(input);
    const { principal, owned } = this.own(input, caller);
    validateName(input.name);
    const credentialRef = requireCredentialRef(input.credentialRef);
    return this.gateway().execute('credential.rotate', principal, resource(owned, input.name, 'credential', credentialRef), { service: 'configuration', credentialRef }, async () => {
      const current = await this.options.store.getSecret(owned, input.name);
      if (!current) throw new ConfigurationValidationError(`Configuration ${input.name} not found`);
      // Legacy rows stored raw values; rotation drops them so only the reference remains durable.
      const { value: _legacyValue, ...binding } = current as ConfigurationSecret & { value?: unknown };
      const item: ConfigurationSecret = { ...binding, credentialRef, required: input.required ?? current.required, updatedAt: this.now().toISOString(), __version: current.__version + 1 };
      // FeltDB updates merge fields; an explicit undefined is what deletes the legacy key.
      if ('value' in current) Object.assign(item, { value: undefined });
      await this.options.store.saveSecret(item, current.__version);
      await this.record('secret.rotated', item, 'secret', principal.principalId, 'rotated', 'configured');
      return secretView(item);
    });
  }

  async delete(scope: Scope & { name: string; kind: 'variable' | 'secret' }, caller: AuthenticatedPrincipal): Promise<void> {
    const { principal, owned } = this.own(scope, caller);
    const capability = scope.kind === 'secret' ? 'credential.detach' : 'configuration.delete';
    await this.gateway().execute(capability, principal, resource(owned, scope.name, scope.kind === 'secret' ? 'credential' : 'configuration'), { service: 'configuration' }, async () => {
      const item = scope.kind === 'variable' ? await this.options.store.getVariable(owned, scope.name) : await this.options.store.getSecret(owned, scope.name);
      if (!item) return;
      if (scope.kind === 'variable') await this.options.store.deleteVariable(item as ConfigurationVariable);
      else await this.options.store.deleteSecret(item as ConfigurationSecret);
      await this.record(scope.kind === 'secret' ? 'secret.deleted' : 'configuration.deleted', item, scope.kind, principal.principalId, 'deleted', 'deleted');
    });
  }

  /** Required configuration declarations, if any were configured. */
  get declarations(): readonly ConfigurationDeclaration[] {
    return this.options.declarations ?? [];
  }

  /**
   * Export the non-secret configuration of the caller's tenant in one
   * environment as a versioned JSON document: variables, credential binding
   * names and references, active webhook endpoints (with their signing
   * credential reference, never a secret) and enabled schedules. Every read is
   * authorized (`configuration.read`, `webhooks.read`, `schedules.read`).
   */
  export(options: ConfigurationExportOptions): Promise<ConfigurationExportDocument> {
    return exportConfiguration(this.transferDependencies(), options);
  }

  /**
   * Plan, and unless `dryRun`, apply an export document to the caller's
   * tenant. Returns the creates/updates/conflicts and the credential bindings
   * the target still needs. Each write goes through its own capability
   * (`configuration.write`, `webhooks.register`, `webhooks.remove`,
   * `schedules.create`, `schedules.cancel`); credential bindings are never
   * created, and secret values are refused. Not atomic: a failed item is
   * reported and the next one is tried.
   */
  import(document: ConfigurationExportDocument | unknown, options: ConfigurationImportOptions): Promise<ConfigurationImportReport> {
    return importConfiguration(this.transferDependencies(), document, options);
  }

  private transferDependencies(): ConfigurationTransferDependencies {
    return {
      gateway: () => this.gateway(),
      configuration: this,
      ...(this.options.transfer?.webhooks ? { webhooks: this.options.transfer.webhooks } : {}),
      ...(this.options.transfer?.schedules ? { schedules: this.options.transfer.schedules } : {}),
      now: this.now,
    };
  }

  private gateway(): ServiceGateway {
    if (!this.options.authority) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Configuration has no AuthBoundry authority configured');
    return this.options.authority;
  }

  /** Resolve durable ownership from the verified principal and this deployment's application. */
  private own(scope: Scope, caller: AuthenticatedPrincipal): { principal: VerifiedPrincipal; owned: ConfigurationScope } {
    return resolveConfigurationOwnership(this.gateway(), scope, caller);
  }

  private async record(type: ConfigurationAuditEvent['type'], item: ConfigurationVariable | ConfigurationSecret, kind: 'variable' | 'secret', actor: string, operation: string, status: ConfigurationAuditEvent['status']) {
    await this.options.store.audit({ id: randomUUID(), type, tenantId: item.tenantId, applicationId: item.applicationId, environment: item.environment, name: item.name, kind, actor, timestamp: this.now().toISOString(), operation, status });
  }
}

/**
 * Ownership comes from the verified principal and the gateway's application,
 * never from caller-selected identifiers. Shared by every service that keeps
 * durable state in the configuration store.
 */
export function resolveConfigurationOwnership(gateway: ServiceGateway, scope: Scope, caller: AuthenticatedPrincipal): { principal: VerifiedPrincipal; owned: ConfigurationScope } {
  const principal = requireVerifiedPrincipal(caller);
  rejectCallerActor(scope, principal);
  const tenantId = resolveTenant(scope, principal);
  const application = gateway.application;
  if (scope.applicationId !== undefined && scope.applicationId !== application) {
    throw new ServiceAuthorityError('DENIED', 'Configuration belongs to a different application', { reason: 'application_mismatch' });
  }
  if (!CONFIGURATION_ENVIRONMENTS.includes(scope.environment)) throw new ConfigurationValidationError('Invalid environment');
  return { principal, owned: { tenantId, applicationId: application, environment: scope.environment } };
}

function resource(scope: ConfigurationScope, name?: string, type: 'configuration' | 'credential' = 'configuration', credentialRef?: string) {
  return {
    type,
    tenantId: scope.tenantId,
    ...(name ? { id: `${scope.environment}/${name}` } : {}),
    attributes: { applicationId: scope.applicationId, environment: scope.environment, ...(credentialRef ? { credentialRef } : {}) },
  };
}

function rejectRawSecret(input: object): void {
  if ('value' in input && (input as { value?: unknown }).value !== undefined) {
    throw new ServiceMigrationError('Secret values are no longer stored in configuration. Register the credential with AuthBoundry and pass credentialRef: "credential-ref:<id>".');
  }
}
function validateName(name: unknown) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new ConfigurationValidationError('Name must be an uppercase configuration identifier');
}
function validateVariable(input: VariableInput) {
  validateName(input.name);
  if (typeof input.value !== 'string' || input.value.length === 0) throw new ConfigurationValidationError('Value is required');
}
function variableView(item: ConfigurationVariable): ConfigurationVariableView { const { __version: _, ...view } = item; return { ...view, kind: 'variable' }; }
function secretView(item: ConfigurationSecret): ConfigurationSecretView {
  const { __version: _version, ...view } = item;
  // Legacy rows stored raw values; never return them.
  delete (view as { value?: unknown }).value;
  return { ...view, kind: 'secret', configured: true };
}
