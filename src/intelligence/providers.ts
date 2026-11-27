import { randomUUID } from 'node:crypto';

import { ServiceAuthorityError } from '../authority/errors.js';
import type { OutboundHttpRequest, OutboundHttpResponse } from '../authority/outbound.js';

/** What an application runs through intelligence beyond configuration. `chat` is configuration only: an executor (FeltKit's ModelHost, the AppBoundry host) runs it with `streamGeneration`. */
export type IntelligenceModality = 'chat' | 'transcription' | 'embeddings';
export const INTELLIGENCE_MODALITIES: readonly IntelligenceModality[] = Object.freeze(['chat', 'transcription', 'embeddings']);

/**
 * What a provider adapter gets for one call. `send` is the gateway's outbound
 * client (destination policy, pinned address, no redirects, bounded response);
 * `apiKey` is the credential resolved from custody for this call only.
 */
export interface IntelligenceProviderIO {
  readonly provider: string;
  readonly model: string;
  /** The configured endpoint, without a trailing slash. */
  readonly endpoint: string;
  readonly apiKey?: string;
  send(request: OutboundHttpRequest): Promise<OutboundHttpResponse>;
}

export interface TranscriptionRequest {
  readonly audio: Uint8Array;
  readonly contentType: string;
  readonly filename: string;
  /** ISO-639-1 hint. */
  readonly language?: string;
  readonly prompt?: string;
}

export interface TranscriptionSegment { readonly start: number; readonly end: number; readonly text: string }

export interface TranscriptionResult {
  readonly text: string;
  readonly language?: string;
  /** Audio duration the provider reports; metering counts it. */
  readonly durationSeconds?: number;
  readonly segments?: readonly TranscriptionSegment[];
}

export interface EmbeddingRequest {
  readonly inputs: readonly string[];
  readonly dimensions?: number;
}

export interface EmbeddingResult {
  readonly vectors: readonly (readonly number[])[];
  /** Input tokens the provider reports; metering counts them. */
  readonly inputTokens?: number;
}

/**
 * A provider adapter: how one provider (or protocol) performs speech to text
 * and embeddings over HTTP. Replaceable: a host registers its own adapters
 * (`createServices({ intelligenceProviders })`) by provider id or protocol.
 */
export interface IntelligenceProviderAdapter {
  /** A provider id from the catalog (`openai`, `ollama`, `custom`, ...) or a protocol (`openai`, `openai-compatible`). */
  readonly id: string;
  transcribe?(request: TranscriptionRequest, io: IntelligenceProviderIO): Promise<TranscriptionResult>;
  embed?(request: EmbeddingRequest, io: IntelligenceProviderIO): Promise<EmbeddingResult>;
}

/**
 * OpenAI-compatible HTTP adapter: `POST {endpoint}/audio/transcriptions`
 * (multipart, `response_format=verbose_json`) and `POST {endpoint}/embeddings`.
 * Works with OpenAI and the many servers that implement the same API.
 */
export class OpenAICompatibleProvider implements IntelligenceProviderAdapter {
  constructor(readonly id: string = 'openai-compatible') {}

  async transcribe(request: TranscriptionRequest, io: IntelligenceProviderIO): Promise<TranscriptionResult> {
    const form = new MultipartForm();
    form.field('model', io.model);
    form.field('response_format', 'verbose_json');
    if (request.language) form.field('language', request.language);
    if (request.prompt) form.field('prompt', request.prompt);
    form.file('file', request.filename, request.contentType, request.audio);
    const response = await io.send({
      url: `${io.endpoint}/audio/transcriptions`,
      method: 'POST',
      headers: { 'Content-Type': form.contentType, Accept: 'application/json', ...auth(io) },
      body: form.body(),
      timeoutMs: 300_000,
    });
    const body = providerJson(response, io.provider) as { text?: unknown; language?: unknown; duration?: unknown; segments?: unknown };
    if (typeof body.text !== 'string') throw providerError(io.provider, 'transcription response has no text');
    const segments = Array.isArray(body.segments)
      ? body.segments.filter((segment): segment is { start: number; end: number; text: string } => !!segment && typeof segment.start === 'number' && typeof segment.end === 'number' && typeof segment.text === 'string')
        .map((segment) => ({ start: segment.start, end: segment.end, text: segment.text }))
      : undefined;
    return {
      text: body.text,
      ...(typeof body.language === 'string' ? { language: body.language } : {}),
      ...(typeof body.duration === 'number' && Number.isFinite(body.duration) && body.duration >= 0 ? { durationSeconds: body.duration } : {}),
      ...(segments ? { segments } : {}),
    };
  }

  async embed(request: EmbeddingRequest, io: IntelligenceProviderIO): Promise<EmbeddingResult> {
    const response = await io.send({
      url: `${io.endpoint}/embeddings`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...auth(io) },
      body: JSON.stringify({ model: io.model, input: request.inputs, ...(request.dimensions ? { dimensions: request.dimensions } : {}) }),
      timeoutMs: 120_000,
    });
    const body = providerJson(response, io.provider) as { data?: unknown; usage?: { prompt_tokens?: unknown; total_tokens?: unknown } };
    if (!Array.isArray(body.data)) throw providerError(io.provider, 'embeddings response has no data');
    const rows = [...body.data] as { index?: unknown; embedding?: unknown }[];
    rows.sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
    const vectors = rows.map((row) => {
      if (!Array.isArray(row.embedding) || !row.embedding.every((value) => typeof value === 'number')) throw providerError(io.provider, 'embedding is not a list of numbers');
      return row.embedding as number[];
    });
    if (vectors.length !== request.inputs.length) throw providerError(io.provider, `expected ${request.inputs.length} embeddings, received ${vectors.length}`);
    const tokens = body.usage?.prompt_tokens ?? body.usage?.total_tokens;
    return { vectors, ...(typeof tokens === 'number' && Number.isInteger(tokens) && tokens >= 0 ? { inputTokens: tokens } : {}) };
  }
}

function auth(io: IntelligenceProviderIO): Record<string, string> {
  return io.apiKey ? { Authorization: `Bearer ${io.apiKey}` } : {};
}

function providerJson(response: OutboundHttpResponse, provider: string): unknown {
  if (response.status < 200 || response.status >= 300) {
    // The provider's message is not echoed: it can quote the request.
    throw providerError(provider, `HTTP ${response.status}`);
  }
  try {
    return JSON.parse(response.body.toString('utf8'));
  } catch {
    throw providerError(provider, 'response is not JSON');
  }
}

function providerError(provider: string, message: string): ServiceAuthorityError {
  return new ServiceAuthorityError('PROVIDER_ERROR', `Intelligence provider ${provider} failed: ${message}`, { reason: 'provider_failed' });
}

/** Minimal multipart/form-data encoder (fields and one file). */
class MultipartForm {
  private readonly boundary = `appport-${randomUUID()}`;
  private readonly parts: Buffer[] = [];

  get contentType(): string {
    return `multipart/form-data; boundary=${this.boundary}`;
  }

  field(name: string, value: string): void {
    this.parts.push(Buffer.from(`--${this.boundary}\r\nContent-Disposition: form-data; name="${escape(name)}"\r\n\r\n${value}\r\n`, 'utf8'));
  }

  file(name: string, filename: string, contentType: string, data: Uint8Array): void {
    this.parts.push(Buffer.from(`--${this.boundary}\r\nContent-Disposition: form-data; name="${escape(name)}"; filename="${escape(filename)}"\r\nContent-Type: ${contentType.replace(/[\r\n]/g, '')}\r\n\r\n`, 'utf8'));
    this.parts.push(Buffer.from(data));
    this.parts.push(Buffer.from('\r\n', 'utf8'));
  }

  body(): Buffer {
    return Buffer.concat([...this.parts, Buffer.from(`--${this.boundary}--\r\n`, 'utf8')]);
  }
}

function escape(value: string): string {
  return value.replace(/["\r\n\\]/g, '_');
}
