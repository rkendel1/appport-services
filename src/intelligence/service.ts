import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { ConfigurationEnvironment, ConfigurationSecret, ConfigurationVariable } from '../configuration/models.js';
import { ConfigurationValidationError, resolveConfigurationOwnership } from '../configuration/service.js';
import type { ConfigurationStore } from '../configuration/storage.js';
import { rejectRawCredentialFields, requireCredentialRef } from '../authority/credentials.js';
import { ServiceAuthorityError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import type { VerifiedPrincipal } from '../authority/principal.js';
import { findIntelligenceModel, getIntelligenceProvider, INTELLIGENCE_CATALOG, type IntelligenceProvider } from './catalog.js';
import type { IntelligenceConfigurationView, IntelligenceRuntimeConfiguration, IntelligenceSelection } from './models.js';

/** The selection is one configuration variable; the credential is one configuration secret binding. */
export const INTELLIGENCE_SELECTION_NAME = 'INTELLIGENCE_CONFIG';
export const INTELLIGENCE_CREDENTIAL_NAME = 'INTELLIGENCE_CREDENTIAL';

type Scope = { tenantId?: string; applicationId?: string; environment?: ConfigurationEnvironment };
export type IntelligenceWriteInput = Scope & { provider: string; model: string; endpoint?: string | null; credentialRef?: string };
export type IntelligenceCredentialInput = Scope & { credentialRef: string };

export class IntelligenceValidationError extends ConfigurationValidationError {
  constructor(message: string) { super(message); this.name = 'IntelligenceValidationError'; }
}

export interface IntelligenceServiceOptions {
  /** The existing configuration store. Intelligence adds no collection of its own. */
  readonly store: ConfigurationStore;
  readonly authority?: ServiceGateway;
  readonly now?: () => Date;
}

/**
 * Canonical provider/model/endpoint/credential configuration. It describes
 * and validates configuration; it never executes a model and never holds
 * credential material (only a credential-ref into AuthBoundry custody).
 */
export class IntelligenceService {
  private readonly now: () => Date;
  constructor(private readonly options: IntelligenceServiceOptions) { this.now = options.now ?? (() => new Date()); }

  /** Discovery metadata. Static and never persisted. */
  async catalog(scope: Scope, caller: AuthenticatedPrincipal): Promise<readonly IntelligenceProvider[]> {
    const { principal, owned } = this.own(scope, caller);
    return this.gateway().execute('intelligence.catalog', principal, resource(owned), { service: 'intelligence' }, async () => INTELLIGENCE_CATALOG);
  }

  async get(scope: Scope, caller: AuthenticatedPrincipal): Promise<IntelligenceConfigurationView> {
    const { principal, owned } = this.own(scope, caller);
    return this.gateway().execute('intelligence.read', principal, resource(owned), { service: 'intelligence' }, async () => {
      const current = await this.load(owned);
      if (!current.selection) return { configured: false, environment: owned.environment, credentialConfigured: false } as const;
      return view(owned.environment, current.selection, current.variable!.updatedAt, Boolean(current.secret));
    });
  }

  async set(input: IntelligenceWriteInput, caller: AuthenticatedPrincipal): Promise<IntelligenceConfigurationView> {
    rejectRawCredentialFields(input);
    const { principal, owned } = this.own(input, caller);
    const selection = validateSelection(input);
    const credentialRef = input.credentialRef === undefined ? undefined : requireCredentialRef(input.credentialRef);
    const resourceRef = resource(owned, 'intelligence', credentialRef);
    return this.gateway().execute('intelligence.write', principal, resourceRef, { service: 'intelligence', provider: selection.provider, ...(credentialRef ? { credentialRef } : {}) }, async () => {
      const current = await this.load(owned);
      const provider = getIntelligenceProvider(selection.provider)!;
      if (provider.credential === 'none' && credentialRef) throw new IntelligenceValidationError(`Provider ${provider.id} does not use a credential`);
      // A credential is bound to the provider and endpoint it was configured for. Moving it to a
      // different destination without a new credential would hand it to a host the user never chose.
      const destinationChanged = !current.selection
        || current.selection.provider !== selection.provider
        || resolveEndpoint(provider, current.selection.endpoint) !== resolveEndpoint(provider, selection.endpoint);
      const keepCredential = Boolean(current.secret) && !credentialRef && !destinationChanged;
      if (provider.credential === 'required' && !credentialRef && !keepCredential) {
        throw new IntelligenceValidationError(`Provider ${provider.id} requires a credential${current.secret ? ' (the existing credential is not carried over to a different provider or endpoint)' : ''}`);
      }
      if (current.secret && !credentialRef && !keepCredential) await this.detach(owned, current.secret, principal);
      if (credentialRef) await this.bind(owned, current.secret, credentialRef, principal);
      await this.save(owned, current.variable, selection, principal);
      return view(owned.environment, selection, this.now().toISOString(), Boolean(credentialRef) || keepCredential);
    });
  }

  /** Replace the credential without reading the previous one. */
  async setCredential(input: IntelligenceCredentialInput, caller: AuthenticatedPrincipal): Promise<IntelligenceConfigurationView> {
    rejectRawCredentialFields(input);
    const { principal, owned } = this.own(input, caller);
    const credentialRef = requireCredentialRef(input.credentialRef);
    return this.gateway().execute('intelligence.credential.set', principal, resource(owned, 'credential', credentialRef), { service: 'intelligence', credentialRef }, async () => {
      const current = await this.load(owned);
      if (!current.selection) throw new IntelligenceValidationError('Intelligence is not configured; set a provider and model first');
      if (getIntelligenceProvider(current.selection.provider)!.credential === 'none') throw new IntelligenceValidationError('This provider does not use a credential');
      await this.bind(owned, current.secret, credentialRef, principal);
      return view(owned.environment, current.selection, current.variable!.updatedAt, true);
    });
  }

  async removeCredential(scope: Scope, caller: AuthenticatedPrincipal): Promise<IntelligenceConfigurationView> {
    const { principal, owned } = this.own(scope, caller);
    return this.gateway().execute('intelligence.credential.remove', principal, resource(owned, 'credential'), { service: 'intelligence' }, async () => {
      const current = await this.load(owned);
      if (!current.selection) throw new IntelligenceValidationError('Intelligence is not configured');
      if (getIntelligenceProvider(current.selection.provider)!.credential === 'required') throw new IntelligenceValidationError('This provider requires a credential; replace it instead of removing it');
      if (current.secret) await this.detach(owned, current.secret, principal);
      return view(owned.environment, current.selection, current.variable!.updatedAt, false);
    });
  }

  /**
   * The form the execution boundary consumes. Runtime-internal (not invocable
   * from clients); it returns the credential reference, never the credential.
   * Returns null when no intelligence is configured: the platform works without it.
   */
  async resolveRuntime(scope: Scope, caller: AuthenticatedPrincipal): Promise<IntelligenceRuntimeConfiguration | null> {
    const { principal, owned } = this.own(scope, caller);
    return this.gateway().execute('intelligence.resolve', principal, resource(owned), { service: 'intelligence' }, async () => {
      const { selection, secret } = await this.load(owned);
      if (!selection) return null;
      const provider = getIntelligenceProvider(selection.provider)!;
      return { provider: provider.id, protocol: provider.protocol, model: selection.model, endpoint: resolveEndpoint(provider, selection.endpoint), ...(secret ? { credentialRef: secret.credentialRef } : {}) };
    });
  }

  private async load(owned: Owned) {
    const [variable, secret] = await Promise.all([this.options.store.getVariable(owned, INTELLIGENCE_SELECTION_NAME), this.options.store.getSecret(owned, INTELLIGENCE_CREDENTIAL_NAME)]);
    return { variable, secret, selection: variable ? parseSelection(variable.value) : null };
  }

  private async save(owned: Owned, current: ConfigurationVariable | null, selection: IntelligenceSelection, principal: VerifiedPrincipal) {
    const timestamp = this.now().toISOString();
    const value = JSON.stringify(selection);
    if (current) {
      const item = { ...current, value, updatedAt: timestamp, __version: current.__version + 1 };
      await this.options.store.saveVariable(item, current.__version);
      await this.record('configuration.updated', item, 'variable', principal, 'updated', 'configured');
    } else {
      const item: ConfigurationVariable = { ...owned, name: INTELLIGENCE_SELECTION_NAME, value, id: randomUUID(), required: false, createdAt: timestamp, updatedAt: timestamp, createdBy: principal.principalId, __version: 1 };
      await this.options.store.saveVariable(item);
      await this.record('configuration.created', item, 'variable', principal, 'created', 'configured');
    }
  }

  private async bind(owned: Owned, current: ConfigurationSecret | null, credentialRef: ConfigurationSecret['credentialRef'], principal: VerifiedPrincipal) {
    const timestamp = this.now().toISOString();
    if (current) {
      const item: ConfigurationSecret = { ...current, credentialRef, updatedAt: timestamp, __version: current.__version + 1 };
      await this.options.store.saveSecret(item, current.__version);
      await this.record('secret.rotated', item, 'secret', principal, 'rotated', 'configured');
    } else {
      const item: ConfigurationSecret = { ...owned, name: INTELLIGENCE_CREDENTIAL_NAME, credentialRef, id: randomUUID(), required: false, createdAt: timestamp, updatedAt: timestamp, createdBy: principal.principalId, __version: 1 };
      await this.options.store.saveSecret(item);
      await this.record('secret.created', item, 'secret', principal, 'created', 'configured');
    }
  }

  private async detach(_owned: Owned, current: ConfigurationSecret, principal: VerifiedPrincipal) {
    await this.options.store.deleteSecret(current);
    await this.record('secret.deleted', current, 'secret', principal, 'deleted', 'deleted');
  }

  private async record(type: Parameters<ConfigurationStore['audit']>[0]['type'], item: ConfigurationVariable | ConfigurationSecret, kind: 'variable' | 'secret', principal: VerifiedPrincipal, operation: string, status: 'configured' | 'deleted') {
    await this.options.store.audit({ id: randomUUID(), type, tenantId: item.tenantId, applicationId: item.applicationId, environment: item.environment, name: item.name, kind, actor: principal.principalId, timestamp: this.now().toISOString(), operation, status });
  }

  private gateway(): ServiceGateway {
    if (!this.options.authority) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Intelligence has no AuthBoundry authority configured');
    return this.options.authority;
  }

  private own(scope: Scope, caller: AuthenticatedPrincipal) {
    return resolveConfigurationOwnership(this.gateway(), { ...scope, environment: scope.environment ?? 'production' }, caller);
  }
}

type Owned = { tenantId: string; applicationId: string; environment: ConfigurationEnvironment };

function resource(scope: Owned, type: 'intelligence' | 'credential' = 'intelligence', credentialRef?: string) {
  return {
    type,
    tenantId: scope.tenantId,
    id: `${scope.environment}/${type === 'credential' ? INTELLIGENCE_CREDENTIAL_NAME : INTELLIGENCE_SELECTION_NAME}`,
    attributes: { applicationId: scope.applicationId, environment: scope.environment, ...(credentialRef ? { credentialRef } : {}) },
  };
}

function view(environment: ConfigurationEnvironment, selection: IntelligenceSelection, updatedAt: string, credentialConfigured: boolean): IntelligenceConfigurationView {
  const provider = getIntelligenceProvider(selection.provider);
  if (!provider) throw new IntelligenceValidationError(`Stored provider "${selection.provider}" is no longer known`);
  const endpoint = resolveEndpoint(provider, selection.endpoint);
  const isDefault = !selection.endpoint || selection.endpoint === 'default';
  return { configured: true, environment, provider: provider.id, model: selection.model, endpoint: { kind: isDefault ? 'default' : 'custom', url: endpoint || null }, credentialRequirement: provider.credential, credentialConfigured, updatedAt };
}

/** A stored endpoint is a known endpoint id, absent (default), or a custom URL. */
function resolveEndpoint(provider: IntelligenceProvider, stored: string | undefined): string {
  if (!stored || stored === 'default') return provider.endpoints[0]?.url ?? '';
  return provider.endpoints.find((endpoint) => endpoint.id === stored)?.url ?? stored;
}

function parseSelection(value: string): IntelligenceSelection {
  try {
    const parsed = JSON.parse(value) as Partial<IntelligenceSelection>;
    if (typeof parsed.provider === 'string' && typeof parsed.model === 'string' && (parsed.endpoint === undefined || typeof parsed.endpoint === 'string')) {
      return { provider: parsed.provider, model: parsed.model, ...(parsed.endpoint ? { endpoint: parsed.endpoint } : {}) };
    }
  } catch { /* fall through */ }
  throw new IntelligenceValidationError(`${INTELLIGENCE_SELECTION_NAME} does not contain a valid intelligence selection`);
}

function validateSelection(input: IntelligenceWriteInput): IntelligenceSelection {
  const provider = getIntelligenceProvider(input.provider);
  if (!provider) throw new IntelligenceValidationError(`Unknown provider "${String(input.provider)}"; use "custom" for an OpenAI-compatible provider`);
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!model) throw new IntelligenceValidationError('Model is required');
  if (model.length > 200 || /[\s\u0000-\u001f]/.test(model)) throw new IntelligenceValidationError('Model must be a provider-defined identifier without whitespace');
  if (provider.modelSelection === 'catalog' && !findIntelligenceModel(provider.id, model)) {
    throw new IntelligenceValidationError(`Model "${model}" is not available for provider ${provider.id}`);
  }
  const requested = typeof input.endpoint === 'string' ? input.endpoint.trim() : undefined;
  if (input.endpoint != null && typeof input.endpoint !== 'string') throw new IntelligenceValidationError('Endpoint must be a string');
  if (!requested || requested === 'default') {
    if (!provider.endpoints.length) throw new IntelligenceValidationError(`Provider ${provider.id} requires an endpoint`);
    return { provider: provider.id, model };
  }
  const known = provider.endpoints.find((endpoint) => endpoint.id === requested);
  if (known) return { provider: provider.id, model, ...(known.id === 'default' ? {} : { endpoint: known.id }) };
  if (!provider.customEndpoint) throw new IntelligenceValidationError(`Provider ${provider.id} does not accept a custom endpoint`);
  return { provider: provider.id, model, endpoint: validateEndpointUrl(requested) };
}

function validateEndpointUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new IntelligenceValidationError('Endpoint must be a valid URL'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new IntelligenceValidationError('Endpoint must use http or https');
  if (url.username || url.password) throw new IntelligenceValidationError('Endpoint must not embed credentials');
  if (url.search || url.hash) throw new IntelligenceValidationError('Endpoint must not include a query string or fragment');
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) throw new IntelligenceValidationError('Plain http endpoints are allowed only for local or private-network hosts');
  return value.replace(/\/+$/, '');
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === '::1') return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}
