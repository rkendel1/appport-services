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
import { isCredentialRef, requireCredentialRef, type CredentialRef } from '../authority/credentials.js';
import type { SecretCustodyStatus } from '../secrets/protocol.js';
import type { SecretMetadataStore } from '../storage/secrets.js';
import { ServiceAuthorityError, ServiceMigrationError, isServiceAuthorityError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { rejectCallerActor, requireVerifiedPrincipal, resolveTenant, type VerifiedPrincipal } from '../authority/principal.js';

const NAME = /^[A-Z][A-Z0-9_]*$/;
type Scope = Omit<ConfigurationScope, 'tenantId' | 'applicationId'> & { tenantId?: string; applicationId?: string };
type VariableInput = Scope & { name: string; required?: boolean; value: string };
type CredentialInput = Scope & { name: string; required?: boolean; credentialRef: string };

/** `credential.store` input. `value` is handed to the host's custody and dropped; it is never stored, echoed, or recorded. */
export interface CredentialStoreInput {
  readonly ref: string;
  readonly value: string;
  readonly provider?: string;
  readonly kind?: string;
  /** Optional configuration binding to create (or point at `ref`) in `environment`, like `credential.attach`. */
  readonly name?: string;
  readonly required?: boolean;
  /** Defaults to production, like the configuration routes. */
  readonly environment?: ConfigurationScope['environment'];
  readonly tenantId?: string;
  readonly applicationId?: string;
}

/** `credential.store` result. Never the value. */
export interface CredentialStoreResult {
  readonly ref: CredentialRef;
  readonly version: number;
  readonly storedAt: string;
  /** The binding created or updated when `name` was given. */
  readonly binding?: ConfigurationSecretView;
}

/** `credential.status` input: one reference or several. */
export interface CredentialStatusInput {
  readonly ref?: string;
  readonly refs?: readonly string[];
  readonly provider?: string;
  readonly environment?: ConfigurationScope['environment'];
  readonly tenantId?: string;
  readonly applicationId?: string;
}

/** One reference's custody status. Never the value. */
export interface CredentialStatusView extends SecretCustodyStatus {
  readonly ref: CredentialRef;
}

/** Longest value accepted by `credential.store` (64 KiB of UTF-16 code units). */
export const MAX_CREDENTIAL_VALUE_LENGTH = 65_536;
const MAX_STATUS_REFS = 100;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

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
  /** Value-free `Secrets` / `SecretVersions` / `SecretAuditEvents` metadata written by `credential.store`. */
  readonly secretMetadata?: SecretMetadataStore;
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

  /**
   * Hand a credential value to the host's custody (`credential.store`) and,
   * when `name` is given, bind it in configuration (`credential.attach`, or
   * `credential.rotate` when the binding points elsewhere). The value is
   * passed to `SecretCustody.store` once, inside the authorized effect, and
   * dropped: it is not stored in FeltDB, not returned, and not part of any
   * evidence, audit event, error, or log. Evidence records the reference and
   * the stored version.
   */
  async storeCredential(input: CredentialStoreInput, caller: AuthenticatedPrincipal): Promise<CredentialStoreResult> {
    const value = (input as { value?: unknown })?.value;
    try {
      return await this.storeCredentialUnredacted(input, caller);
    } catch (error) {
      throw redactValue(error, value);
    }
  }

  private async storeCredentialUnredacted(input: CredentialStoreInput, caller: AuthenticatedPrincipal): Promise<CredentialStoreResult> {
    if (!input || typeof input !== 'object') throw new ServiceAuthorityError('INVALID_REQUEST', 'credential.store input must be an object');
    const ref = requireCredentialRef(input.ref, 'ref');
    validateCredentialValue(input.value);
    const provider = optionalLabel(input.provider, 'provider');
    const kind = optionalLabel(input.kind, 'kind');
    if (input.name !== undefined) validateName(input.name);
    const { principal, owned } = this.own({ ...input, environment: input.environment ?? 'production' }, caller);
    const gateway = this.gateway();
    return gateway.execute('credential.store', principal, resource(owned, input.name, 'credential', ref), { service: 'configuration', credentialRef: ref, ...(provider ? { provider } : {}) }, async (_context, tools) => {
      // A name that is a variable can never become a binding: refuse before anything is stored.
      if (input.name !== undefined && await this.options.store.getVariable(owned, input.name)) {
        throw new ConfigurationValidationError(`Configuration ${input.name} already exists as a variable`);
      }
      // The binding change is authorized before the value reaches custody, so a denial stores nothing.
      const current = input.name !== undefined ? await this.options.store.getSecret(owned, input.name) : null;
      const bindingCapability = input.name === undefined ? undefined : !current ? 'credential.attach' : current.credentialRef !== ref ? 'credential.rotate' : undefined;
      const bindingContext = bindingCapability ? await gateway.authorize(bindingCapability, principal, resource(owned, input.name, 'credential', ref)) : undefined;

      let stored;
      try {
        stored = await tools.storeCredential(ref, input.value, { purpose: 'credential.store', ...(provider ? { provider } : {}), ...(kind ? { kind } : {}) });
      } catch (error) {
        await this.options.secretMetadata?.recordFailure({
          tenantId: owned.tenantId, secretId: ref.slice('credential-ref:'.length), ...(provider ? { provider } : {}),
          principalId: principal.principalId, purpose: 'credential.store', reason: failureReason(error), timestamp: this.now().toISOString(),
        }).catch(() => undefined);
        throw error;
      }
      await this.options.secretMetadata?.recordStored({
        tenantId: owned.tenantId, secretId: ref.slice('credential-ref:'.length), providerRef: ref,
        ...(provider ? { provider } : {}), ...(kind ? { kind } : {}),
        version: stored.version, storedAt: stored.storedAt, principalId: principal.principalId, purpose: 'credential.store',
      });

      let binding: ConfigurationSecretView | undefined;
      if (input.name !== undefined) {
        if (!bindingContext) binding = secretView(current!);
        else binding = await gateway.run(bindingContext, { service: 'configuration', credentialRef: ref }, () => this.bind(owned, input.name!, ref, input.required, principal.principalId, current));
      }
      return { ref, version: stored.version, storedAt: stored.storedAt, ...(binding ? { binding } : {}) };
    });
  }

  /**
   * Whether the host's custody holds material for each reference
   * (`credential.status`, an observation), without revealing it. One
   * authorization per reference.
   */
  async credentialStatus(input: CredentialStatusInput, caller: AuthenticatedPrincipal): Promise<CredentialStatusView[]> {
    if (!input || typeof input !== 'object') throw new ServiceAuthorityError('INVALID_REQUEST', 'credential.status input must be an object');
    const raw = input.refs !== undefined ? input.refs : input.ref !== undefined ? [input.ref] : undefined;
    if (!Array.isArray(raw) || raw.length === 0) throw new ServiceAuthorityError('INVALID_REQUEST', 'credential.status needs ref or a non-empty refs list');
    if (raw.length > MAX_STATUS_REFS) throw new ServiceAuthorityError('INVALID_REQUEST', `credential.status accepts at most ${MAX_STATUS_REFS} references`);
    const refs = [...new Set(raw.map((ref, index) => requireCredentialRef(ref, input.refs !== undefined ? `refs[${index}]` : 'ref')))];
    const provider = optionalLabel(input.provider, 'provider');
    const { principal, owned } = this.own({ ...input, environment: input.environment ?? 'production' }, caller);
    const results: CredentialStatusView[] = [];
    for (const ref of refs) {
      results.push(await this.gateway().execute('credential.status', principal, resource(owned, undefined, 'credential', ref), { service: 'configuration', credentialRef: ref, ...(provider ? { provider } : {}) },
        async (_context, tools) => ({ ref, ...await tools.credentialStatus(ref, { purpose: 'credential.status', ...(provider ? { provider } : {}) }) })));
    }
    return results;
  }

  /** Create or re-point a binding; the caller has already authorized the change. */
  private async bind(owned: ConfigurationScope, name: string, credentialRef: CredentialRef, required: boolean | undefined, actor: string, current: ConfigurationSecret | null): Promise<ConfigurationSecretView> {
    const timestamp = this.now().toISOString();
    if (!current) {
      const item: ConfigurationSecret = { ...owned, name, credentialRef, id: randomUUID(), required: required ?? false, createdAt: timestamp, updatedAt: timestamp, createdBy: actor, __version: 1 };
      await this.options.store.saveSecret(item);
      await this.record('secret.created', item, 'secret', actor, 'created', 'configured');
      return secretView(item);
    }
    const { value: _legacyValue, ...rest } = current as ConfigurationSecret & { value?: unknown };
    const item: ConfigurationSecret = { ...rest, credentialRef, required: required ?? current.required, updatedAt: timestamp, __version: current.__version + 1 };
    if ('value' in current) Object.assign(item, { value: undefined });
    await this.options.store.saveSecret(item, current.__version);
    await this.record('secret.rotated', item, 'secret', actor, 'rotated', 'configured');
    return secretView(item);
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
function validateCredentialValue(value: unknown): asserts value is string {
  // Messages here never include the value.
  if (typeof value !== 'string') throw new ServiceAuthorityError('INVALID_REQUEST', 'value is required and must be a string');
  if (value.trim().length === 0) throw new ServiceAuthorityError('INVALID_REQUEST', 'value must not be empty');
  if (value.length > MAX_CREDENTIAL_VALUE_LENGTH) throw new ServiceAuthorityError('INVALID_REQUEST', `value must be at most ${MAX_CREDENTIAL_VALUE_LENGTH} characters`);
  if (value.trim().startsWith('credential-ref:') || isCredentialRef(value.trim())) {
    throw new ServiceAuthorityError('INVALID_REQUEST', 'value is a credential reference, not credential material. Pass the secret itself as value and the reference as ref, or use credential.attach to bind an existing reference.');
  }
}

function optionalLabel(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !LABEL.test(value)) throw new ServiceAuthorityError('INVALID_REQUEST', `${field} must be a short identifier (letters, digits, . _ : -)`);
  return value;
}

function failureReason(error: unknown) {
  const code = isServiceAuthorityError(error) ? error.code : undefined;
  return code === 'DENIED' ? 'secret_resolution_denied' as const : code === 'CUSTODY_READ_ONLY' ? 'secret_unavailable' as const : 'internal_error' as const;
}

/**
 * Defense in depth: no error leaving `credential.store` may contain the value,
 * whatever raised it. A message that does is replaced; the code is kept.
 */
function redactValue(error: unknown, value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return error;
  const leaks = (text: unknown) => typeof text === 'string' && text.includes(value);
  if (!(error instanceof Error)) return leaks(String(error)) ? new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'credential.store failed') : error;
  const details = isServiceAuthorityError(error) ? error.details : undefined;
  if (!leaks(error.message) && !leaks(error.stack) && !leaks(details?.reason)) return error;
  if (isServiceAuthorityError(error)) return new ServiceAuthorityError(error.code, `credential.store failed (${error.code})`, { ...(details?.capability ? { capability: details.capability } : {}), ...(details?.decisionId ? { decisionId: details.decisionId } : {}) });
  if (error instanceof ConfigurationValidationError) return new ConfigurationValidationError('credential.store input is invalid');
  return new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'credential.store failed');
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
