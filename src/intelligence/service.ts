import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { CredentialRef } from '../authority/credentials.js';
import type { WebhookDestinationPolicy } from '../authority/destination.js';
import { sendOutboundRequest } from '../authority/outbound.js';
import { requireVerifiedPrincipal } from '../authority/principal.js';
import { secretText } from '../connectors/service.js';
import {
  INTELLIGENCE_MODALITIES, OpenAICompatibleProvider,
  type EmbeddingResult, type IntelligenceModality, type IntelligenceProviderAdapter, type IntelligenceProviderIO, type TranscriptionResult, type TranscriptionSegment,
} from './providers.js';
import {
  INTELLIGENCE_USAGE_EXAMINATION_LIMIT, priceFor, summarizeUsage, validatePrices,
  type IntelligencePrice, type IntelligenceUsageRecord, type IntelligenceUsageStore, type IntelligenceUsageSummary, type IntelligenceUsageUnit,
} from './usage.js';
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

/** Configuration names per modality: `chat` keeps the original names. */
export const INTELLIGENCE_CONFIGURATION_NAMES: Readonly<Record<IntelligenceModality, { readonly selection: string; readonly credential: string }>> = Object.freeze({
  chat: Object.freeze({ selection: INTELLIGENCE_SELECTION_NAME, credential: INTELLIGENCE_CREDENTIAL_NAME }),
  transcription: Object.freeze({ selection: 'INTELLIGENCE_TRANSCRIPTION_CONFIG', credential: 'INTELLIGENCE_TRANSCRIPTION_CREDENTIAL' }),
  embeddings: Object.freeze({ selection: 'INTELLIGENCE_EMBEDDINGS_CONFIG', credential: 'INTELLIGENCE_EMBEDDINGS_CREDENTIAL' }),
});

/** Largest audio `transcribe` accepts in one call (25 MiB, the common provider limit). */
export const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;
/** Most inputs in one `embed` call. */
export const MAX_EMBEDDING_INPUTS = 256;
/** Longest single embedding input, in characters. */
export const MAX_EMBEDDING_INPUT_LENGTH = 32_768;

type Scope = { tenantId?: string; applicationId?: string; environment?: ConfigurationEnvironment; modality?: IntelligenceModality };

export interface TranscribeInput extends Scope {
  /** Audio bytes (in process), or `audioBase64` (through invoke). Or `fileId` of a stored file. */
  readonly audio?: Uint8Array;
  readonly audioBase64?: string;
  readonly fileId?: string;
  /** Default `application/octet-stream`, or the stored file's type. */
  readonly contentType?: string;
  /** Default `audio`, or the stored file's name. */
  readonly filename?: string;
  readonly language?: string;
  readonly prompt?: string;
}

export interface TranscribeResult extends TranscriptionResult {
  readonly provider: string;
  readonly model: string;
  readonly usage: IntelligenceCallUsage;
}

export interface EmbedInput extends Scope {
  /** One text or several. */
  readonly input: string | readonly string[];
  readonly dimensions?: number;
}

export interface EmbedResult {
  readonly provider: string;
  readonly model: string;
  readonly vectors: readonly (readonly number[])[];
  readonly usage: IntelligenceCallUsage;
}

/** What one call was metered as. */
export interface IntelligenceCallUsage {
  readonly unit: IntelligenceUsageUnit;
  readonly units: number;
  readonly estimated: boolean;
  readonly costMicros: number;
  readonly currency: string;
  readonly priced: boolean;
}

export interface IntelligenceUsageQuery {
  readonly tenantId?: string;
  readonly environment?: ConfigurationEnvironment;
  readonly modality?: 'transcription' | 'embeddings';
  /** ISO time, inclusive. */
  readonly since?: string;
  /** ISO time, exclusive. */
  readonly until?: string;
}

/** Reads a stored file's bytes for `transcribe({ fileId })`, as the caller. */
export type IntelligenceFileReader = (tenantId: string, fileId: string, caller: VerifiedPrincipal) => Promise<{ readonly bytes: Uint8Array; readonly contentType?: string; readonly name: string }>;
export type IntelligenceWriteInput = Scope & { provider: string; model: string; endpoint?: string | null; credentialRef?: string };
export type IntelligenceCredentialInput = Scope & { credentialRef: string };

export class IntelligenceValidationError extends ConfigurationValidationError {
  constructor(message: string) { super(message); this.name = 'IntelligenceValidationError'; }
}

export interface IntelligenceServiceOptions {
  /** The existing configuration store holds the selections and credential bindings. */
  readonly store: ConfigurationStore;
  readonly authority?: ServiceGateway;
  readonly now?: () => Date;
  /** Where metered usage is recorded (`intelligence_usage`). Without it, transcribe/embed refuse. */
  readonly usage?: IntelligenceUsageStore;
  /** Provider adapters by provider id or protocol; the OpenAI-compatible adapter is built in. */
  readonly providers?: readonly IntelligenceProviderAdapter[];
  /** Per-unit prices for metering (see `IntelligencePrice`). Unpriced calls are recorded with cost 0. */
  readonly prices?: readonly IntelligencePrice[];
  /** Destination policy for provider calls (trusted host code only). */
  readonly destinationPolicy?: WebhookDestinationPolicy;
  /** Reads stored files for `transcribe({ fileId })`. */
  readonly files?: IntelligenceFileReader;
}

/**
 * Canonical provider/model/endpoint/credential configuration. It describes
 * and validates configuration; it never executes a model and never holds
 * credential material (only a credential-ref into AuthBoundry custody).
 */
export class IntelligenceService {
  private readonly now: () => Date;
  private readonly adapters = new Map<string, IntelligenceProviderAdapter>();
  private readonly prices: readonly IntelligencePrice[];
  constructor(private readonly options: IntelligenceServiceOptions) {
    this.now = options.now ?? (() => new Date());
    const builtIn = new OpenAICompatibleProvider('openai-compatible');
    this.adapters.set('openai', builtIn);
    this.adapters.set('openai-compatible', builtIn);
    for (const adapter of options.providers ?? []) {
      if (!adapter || typeof adapter.id !== 'string' || !adapter.id) throw new TypeError('An intelligence provider adapter needs an id');
      this.adapters.set(adapter.id, adapter);
    }
    this.prices = validatePrices(options.prices ?? []);
  }

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
    const selection = validateSelection(input, owned.modality);
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

  /**
   * Speech to text (`intelligence.transcribe`): the tenant's `transcription`
   * selection (provider, model, endpoint, credential-ref) through its provider
   * adapter. The credential is resolved from custody for this call only; the
   * call is effect evidence (`provider`, credential-ref), and its usage is
   * metered per tenant (`audio_second`, cost from the price table).
   */
  async transcribe(input: TranscribeInput, caller: AuthenticatedPrincipal): Promise<TranscribeResult> {
    rejectRawCredentialFields(input);
    const { principal, owned } = this.own({ ...input, modality: 'transcription' }, caller);
    const audio = await this.audioOf(input, owned.tenantId, principal);
    const language = optionalText(input.language, 'language', 16);
    const prompt = optionalText(input.prompt, 'prompt', 2_000);
    return this.run(owned, principal, 'intelligence.transcribe', 'transcribe', async (adapter, io) => {
      const result = await adapter.transcribe!({ audio: audio.bytes, contentType: audio.contentType, filename: audio.filename, ...(language ? { language } : {}), ...(prompt ? { prompt } : {}) }, io);
      if (typeof result?.text !== 'string') throw new ServiceAuthorityError('PROVIDER_ERROR', 'Transcription provider returned no text');
      const units = typeof result.durationSeconds === 'number' && result.durationSeconds >= 0 ? result.durationSeconds : undefined;
      return { result, unit: 'audio_second' as const, units: units ?? 0, estimated: units === undefined, requests: 1 };
    }, (result, usage, selection) => ({
      provider: selection.provider, model: selection.model, text: result.text,
      ...(result.language ? { language: result.language } : {}),
      ...(result.durationSeconds !== undefined ? { durationSeconds: result.durationSeconds } : {}),
      ...(result.segments ? { segments: result.segments.map((segment: TranscriptionSegment) => ({ start: segment.start, end: segment.end, text: segment.text })) } : {}),
      usage,
    }));
  }

  /**
   * Embeddings (`intelligence.embed`): the tenant's `embeddings` selection
   * through its provider adapter, metered per tenant in input tokens (as the
   * provider reports them, else estimated at four characters per token).
   */
  async embed(input: EmbedInput, caller: AuthenticatedPrincipal): Promise<EmbedResult> {
    rejectRawCredentialFields(input);
    const { principal, owned } = this.own({ ...input, modality: 'embeddings' }, caller);
    const inputs = typeof input.input === 'string' ? [input.input] : Array.isArray(input.input) ? [...input.input] : undefined;
    if (!inputs || inputs.length === 0 || inputs.length > MAX_EMBEDDING_INPUTS || inputs.some((text) => typeof text !== 'string' || !text || text.length > MAX_EMBEDDING_INPUT_LENGTH)) {
      throw new IntelligenceValidationError(`input must be 1 to ${MAX_EMBEDDING_INPUTS} non-empty strings of at most ${MAX_EMBEDDING_INPUT_LENGTH} characters`);
    }
    if (input.dimensions !== undefined && (!Number.isInteger(input.dimensions) || input.dimensions < 1 || input.dimensions > 16_384)) throw new IntelligenceValidationError('dimensions must be an integer from 1 to 16384');
    return this.run(owned, principal, 'intelligence.embed', 'embed', async (adapter, io) => {
      const result: EmbeddingResult = await adapter.embed!({ inputs, ...(input.dimensions ? { dimensions: input.dimensions } : {}) }, io);
      if (!Array.isArray(result?.vectors) || result.vectors.length !== inputs.length) throw new ServiceAuthorityError('PROVIDER_ERROR', 'Embedding provider returned the wrong number of vectors');
      const estimated = result.inputTokens === undefined;
      const units = result.inputTokens ?? inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
      return { result, unit: 'token' as const, units, estimated, requests: inputs.length };
    }, (result, usage, selection) => ({ provider: selection.provider, model: selection.model, vectors: result.vectors, usage }));
  }

  /**
   * Metered usage of the caller's tenant (`intelligence.usage.read`): totals per
   * modality, provider, model and unit, with cost. Bounded: at most
   * INTELLIGENCE_USAGE_EXAMINATION_LIMIT records are read (`complete: false` beyond).
   */
  async usage(query: IntelligenceUsageQuery, caller: AuthenticatedPrincipal): Promise<IntelligenceUsageSummary> {
    const { principal, owned } = this.own({ ...query, environment: query?.environment ?? 'production' }, caller);
    const store = this.usageStore();
    if (query?.modality !== undefined && query.modality !== 'transcription' && query.modality !== 'embeddings') throw new IntelligenceValidationError('modality must be "transcription" or "embeddings"');
    for (const bound of ['since', 'until'] as const) {
      if (query?.[bound] !== undefined && (typeof query[bound] !== 'string' || Number.isNaN(Date.parse(query[bound]!)))) throw new IntelligenceValidationError(`${bound} must be an ISO time`);
    }
    return this.gateway().execute('intelligence.usage.read', principal, { type: 'intelligence', tenantId: owned.tenantId, id: `${owned.environment}/usage`, attributes: { applicationId: owned.applicationId, environment: owned.environment } }, { service: 'intelligence' }, async () => {
      const rows = await store.list(owned.tenantId, owned.applicationId, INTELLIGENCE_USAGE_EXAMINATION_LIMIT + 1);
      const since = query?.since ? new Date(query.since).toISOString() : undefined;
      const until = query?.until ? new Date(query.until).toISOString() : undefined;
      const matching = rows.slice(0, INTELLIGENCE_USAGE_EXAMINATION_LIMIT).filter((row) => row.tenantId === owned.tenantId && row.applicationId === owned.applicationId
        && (query?.environment === undefined || row.environment === owned.environment)
        && (!query?.modality || row.modality === query.modality)
        && (!since || row.createdAt >= since) && (!until || row.createdAt < until));
      return {
        tenantId: owned.tenantId,
        ...(query?.environment ? { environment: owned.environment } : {}),
        ...(since ? { since } : {}),
        ...(until ? { until } : {}),
        totals: summarizeUsage(matching),
        complete: rows.length <= INTELLIGENCE_USAGE_EXAMINATION_LIMIT,
      };
    });
  }

  /** Authorize, resolve the credential, call the adapter, meter, and shape the result: one effect. */
  private async run<R, T>(
    owned: Owned,
    principal: VerifiedPrincipal,
    capability: 'intelligence.transcribe' | 'intelligence.embed',
    operation: 'transcribe' | 'embed',
    call: (adapter: IntelligenceProviderAdapter, io: IntelligenceProviderIO) => Promise<{ result: R; unit: IntelligenceUsageUnit; units: number; estimated: boolean; requests: number }>,
    shape: (result: R, usage: IntelligenceCallUsage, selection: IntelligenceSelection) => T,
  ): Promise<T> {
    const store = this.usageStore();
    const modality = owned.modality as 'transcription' | 'embeddings';
    const current = await this.load(owned);
    if (!current.selection) throw new IntelligenceValidationError(`Intelligence ${modality} is not configured; set a provider and model with modality "${modality}"`);
    const selection = current.selection;
    const provider = getIntelligenceProvider(selection.provider);
    if (!provider) throw new IntelligenceValidationError(`Stored provider "${selection.provider}" is no longer known`);
    const adapter = this.adapters.get(provider.id) ?? this.adapters.get(provider.protocol);
    if (!adapter || typeof adapter[operation] !== 'function') throw new IntelligenceValidationError(`No ${modality} adapter is registered for provider ${provider.id}`);
    const credentialRef = current.secret?.credentialRef as CredentialRef | undefined;
    if (provider.credential === 'required' && !credentialRef) throw new IntelligenceValidationError(`Provider ${provider.id} requires a credential for ${modality}`);
    const endpoint = resolveEndpoint(provider, selection.endpoint).replace(/\/+$/, '');
    const attributes = { applicationId: owned.applicationId, environment: owned.environment, modality, provider: provider.id, model: selection.model, ...(credentialRef ? { credentialRef } : {}) };
    return this.gateway().execute(capability, principal, { type: 'intelligence', tenantId: owned.tenantId, id: `${owned.environment}/${INTELLIGENCE_CONFIGURATION_NAMES[modality].selection}`, attributes },
      { service: 'intelligence', provider: provider.id, ...(credentialRef ? { credentialRef } : {}) },
      async (context, tools) => {
        const io = (apiKey?: string): IntelligenceProviderIO => ({
          provider: provider.id, model: selection.model, endpoint, ...(apiKey ? { apiKey } : {}),
          send: (request) => sendOutboundRequest(request, this.options.destinationPolicy),
        });
        const outcome = credentialRef
          ? await tools.withCredential(credentialRef, capability, (secret) => call(adapter, io(secretText(secret.value))))
          : await call(adapter, io());
        const price = priceFor(this.prices, provider.id, selection.model, modality, outcome.unit);
        const usage: IntelligenceCallUsage = {
          unit: outcome.unit,
          units: outcome.units,
          estimated: outcome.estimated,
          costMicros: price ? Math.ceil(outcome.units * price.microsPerUnit) : 0,
          currency: price?.currency ?? 'USD',
          priced: Boolean(price),
        };
        const record: IntelligenceUsageRecord = {
          id: randomUUID(), tenantId: owned.tenantId, applicationId: owned.applicationId, environment: owned.environment,
          modality, provider: provider.id, model: selection.model, ...usage, requests: outcome.requests,
          principalId: principal.principalId, requestId: context.requestId, createdAt: this.now().toISOString(),
        };
        await store.record(record);
        return shape(outcome.result, usage, selection);
      });
  }

  private async audioOf(input: TranscribeInput, tenantId: string, principal: VerifiedPrincipal): Promise<{ bytes: Uint8Array; contentType: string; filename: string }> {
    const sources = [input.audio !== undefined, input.audioBase64 !== undefined, input.fileId !== undefined].filter(Boolean).length;
    if (sources !== 1) throw new IntelligenceValidationError('Pass exactly one of audio, audioBase64 or fileId');
    let bytes: Uint8Array;
    let contentType = input.contentType;
    let filename = input.filename;
    if (input.fileId !== undefined) {
      if (typeof input.fileId !== 'string' || !input.fileId) throw new IntelligenceValidationError('fileId must be a file id');
      if (!this.options.files) throw new IntelligenceValidationError('Files are not available to intelligence on this host');
      const file = await this.options.files(tenantId, input.fileId, principal);
      bytes = file.bytes;
      contentType ??= file.contentType;
      filename ??= file.name;
    } else if (input.audioBase64 !== undefined) {
      if (typeof input.audioBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.audioBase64)) throw new IntelligenceValidationError('audioBase64 must be base64');
      bytes = Buffer.from(input.audioBase64, 'base64');
    } else {
      if (!(input.audio instanceof Uint8Array)) throw new IntelligenceValidationError('audio must be bytes');
      bytes = input.audio;
    }
    if (bytes.byteLength === 0) throw new IntelligenceValidationError('audio is empty');
    if (bytes.byteLength > MAX_TRANSCRIPTION_BYTES) throw new IntelligenceValidationError(`audio is larger than ${MAX_TRANSCRIPTION_BYTES} bytes`);
    contentType = optionalText(contentType, 'contentType', 255) ?? 'application/octet-stream';
    filename = optionalText(filename, 'filename', 255) ?? 'audio';
    return { bytes, contentType, filename };
  }

  private usageStore(): IntelligenceUsageStore {
    if (!this.options.usage) throw new IntelligenceValidationError('Intelligence usage metering is not configured on this host');
    return this.options.usage;
  }

  private async load(owned: Owned) {
    const names = INTELLIGENCE_CONFIGURATION_NAMES[owned.modality];
    const [variable, secret] = await Promise.all([this.options.store.getVariable(owned, names.selection), this.options.store.getSecret(owned, names.credential)]);
    return { variable, secret, selection: variable ? parseSelection(variable.value, names.selection) : null };
  }

  private async save(owned: Owned, current: ConfigurationVariable | null, selection: IntelligenceSelection, principal: VerifiedPrincipal) {
    const timestamp = this.now().toISOString();
    const value = JSON.stringify(selection);
    if (current) {
      const item = { ...current, value, updatedAt: timestamp, __version: current.__version + 1 };
      await this.options.store.saveVariable(item, current.__version);
      await this.record('configuration.updated', item, 'variable', principal, 'updated', 'configured');
    } else {
      const item: ConfigurationVariable = { ...scopeOf(owned), name: INTELLIGENCE_CONFIGURATION_NAMES[owned.modality].selection, value, id: randomUUID(), required: false, createdAt: timestamp, updatedAt: timestamp, createdBy: principal.principalId, __version: 1 };
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
      const item: ConfigurationSecret = { ...scopeOf(owned), name: INTELLIGENCE_CONFIGURATION_NAMES[owned.modality].credential, credentialRef, id: randomUUID(), required: false, createdAt: timestamp, updatedAt: timestamp, createdBy: principal.principalId, __version: 1 };
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

  private own(scope: Scope, caller: AuthenticatedPrincipal): { principal: VerifiedPrincipal; owned: Owned } {
    const modality = scope?.modality ?? 'chat';
    if (!INTELLIGENCE_MODALITIES.includes(modality)) throw new IntelligenceValidationError('modality must be "chat", "transcription" or "embeddings"');
    const { modality: _modality, ...rest } = scope ?? {};
    const { principal, owned } = resolveConfigurationOwnership(this.gateway(), { ...rest, environment: scope?.environment ?? 'production' }, caller);
    return { principal: requireVerifiedPrincipal(principal), owned: { ...owned, modality } };
  }
}

type Owned = { tenantId: string; applicationId: string; environment: ConfigurationEnvironment; modality: IntelligenceModality };

function scopeOf(owned: Owned): { tenantId: string; applicationId: string; environment: ConfigurationEnvironment } {
  return { tenantId: owned.tenantId, applicationId: owned.applicationId, environment: owned.environment };
}

function resource(scope: Owned, type: 'intelligence' | 'credential' = 'intelligence', credentialRef?: string) {
  const names = INTELLIGENCE_CONFIGURATION_NAMES[scope.modality];
  return {
    type,
    tenantId: scope.tenantId,
    id: `${scope.environment}/${type === 'credential' ? names.credential : names.selection}`,
    attributes: {
      applicationId: scope.applicationId, environment: scope.environment,
      // `chat` requests keep their original attributes.
      ...(scope.modality !== 'chat' ? { modality: scope.modality } : {}),
      ...(credentialRef ? { credentialRef } : {}),
    },
  };
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > max || /[\r\n]/.test(value)) throw new IntelligenceValidationError(`${field} must be a string of at most ${max} characters`);
  return value;
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

function parseSelection(value: string, name: string = INTELLIGENCE_SELECTION_NAME): IntelligenceSelection {
  try {
    const parsed = JSON.parse(value) as Partial<IntelligenceSelection>;
    if (typeof parsed.provider === 'string' && typeof parsed.model === 'string' && (parsed.endpoint === undefined || typeof parsed.endpoint === 'string')) {
      return { provider: parsed.provider, model: parsed.model, ...(parsed.endpoint ? { endpoint: parsed.endpoint } : {}) };
    }
  } catch { /* fall through */ }
  throw new IntelligenceValidationError(`${name} does not contain a valid intelligence selection`);
}

function validateSelection(input: IntelligenceWriteInput, modality: IntelligenceModality = 'chat'): IntelligenceSelection {
  const provider = getIntelligenceProvider(input.provider);
  if (!provider) throw new IntelligenceValidationError(`Unknown provider "${String(input.provider)}"; use "custom" for an OpenAI-compatible provider`);
  if (!provider.modalities.includes(modality)) throw new IntelligenceValidationError(`Provider ${provider.id} does not offer ${modality}`);
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  if (!model) throw new IntelligenceValidationError('Model is required');
  if (model.length > 200 || /[\s\u0000-\u001f]/.test(model)) throw new IntelligenceValidationError('Model must be a provider-defined identifier without whitespace');
  if (provider.modelSelection === 'catalog' && modality === 'chat' && !findIntelligenceModel(provider.id, model)) {
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
