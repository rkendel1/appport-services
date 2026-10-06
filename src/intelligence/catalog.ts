/**
 * Provider/model discovery metadata. This is a convenience catalog, not durable
 * state: it is never persisted. The canonical configuration is the selected
 * provider id, model identifier and endpoint. A model identifier is ultimately
 * a provider-defined string.
 */
export type IntelligenceProtocol = 'openai' | 'anthropic' | 'openai-compatible';
export type CredentialRequirement = 'required' | 'optional' | 'none';

export interface IntelligenceModel { readonly id: string; readonly displayName: string }
export interface IntelligenceEndpoint { readonly id: string; readonly displayName: string; readonly url: string }

export interface IntelligenceProvider {
  readonly id: string;
  readonly displayName: string;
  readonly protocol: IntelligenceProtocol;
  readonly models: readonly IntelligenceModel[];
  /** "catalog": the model must be listed. "free": any provider-defined identifier is accepted. */
  readonly modelSelection: 'catalog' | 'free';
  /** Known endpoints; the first is the default. Empty when the endpoint is always user-supplied. */
  readonly endpoints: readonly IntelligenceEndpoint[];
  readonly customEndpoint: boolean;
  readonly credential: CredentialRequirement;
}

const frozen = <T extends object>(value: T): T => Object.freeze(value);
const provider = (value: IntelligenceProvider): IntelligenceProvider => frozen({ ...value, models: frozen([...value.models].map(frozen)), endpoints: frozen([...value.endpoints].map(frozen)) });

export const CUSTOM_PROVIDER_ID = 'custom';

export const INTELLIGENCE_CATALOG: readonly IntelligenceProvider[] = frozen([
  provider({
    id: 'openai', displayName: 'OpenAI', protocol: 'openai', modelSelection: 'free', credential: 'required', customEndpoint: false,
    models: [{ id: 'gpt-4o', displayName: 'GPT-4o' }, { id: 'gpt-4o-mini', displayName: 'GPT-4o mini' }],
    endpoints: [{ id: 'default', displayName: 'Default', url: 'https://api.openai.com/v1' }],
  }),
  provider({
    id: 'anthropic', displayName: 'Anthropic', protocol: 'anthropic', modelSelection: 'catalog', credential: 'required', customEndpoint: false,
    models: [
      { id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' },
      { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
    ],
    endpoints: [{ id: 'default', displayName: 'Default', url: 'https://api.anthropic.com' }],
  }),
  provider({
    id: 'opencode', displayName: 'OpenCode', protocol: 'openai-compatible', modelSelection: 'free', credential: 'required', customEndpoint: true,
    models: [], endpoints: [{ id: 'default', displayName: 'Default', url: 'https://opencode.ai/zen/v1' }],
  }),
  provider({
    id: 'ollama', displayName: 'Ollama (local)', protocol: 'openai-compatible', modelSelection: 'free', credential: 'optional', customEndpoint: true,
    models: [], endpoints: [{ id: 'default', displayName: 'Local', url: 'http://localhost:11434/v1' }],
  }),
  provider({
    id: CUSTOM_PROVIDER_ID, displayName: 'Custom (OpenAI-compatible)', protocol: 'openai-compatible', modelSelection: 'free', credential: 'optional', customEndpoint: true,
    models: [], endpoints: [],
  }),
]);

export function getIntelligenceProvider(id: unknown): IntelligenceProvider | undefined {
  return typeof id === 'string' ? INTELLIGENCE_CATALOG.find((entry) => entry.id === id) : undefined;
}

export function findIntelligenceModel(providerId: string, modelId: string): IntelligenceModel | undefined {
  return getIntelligenceProvider(providerId)?.models.find((model) => model.id === modelId);
}
