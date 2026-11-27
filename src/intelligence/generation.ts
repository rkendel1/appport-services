/**
 * Model generation: open-ended text, streamed, with tool calls, over a resolved connection.
 *
 * Intelligence holds the model selection; this module runs one generation with it. It speaks the
 * two provider protocols Intelligence's catalog describes for chat:
 *
 *   - OpenAI chat completions with `stream: true` (OpenAI and every OpenAI-compatible server)
 *   - Anthropic Messages with `stream: true`
 *
 * It has no provider SDK and no state, and it never resolves a credential: the caller passes the
 * connection, with the secret held only for the call. The same code serves a standalone application
 * runtime (FeltKit) and a host that runs generations for its guests (AppBoundry `model@1`).
 *
 * A model's tool call is data, a name and an input; nothing here runs it.
 *
 * Cancellation: the caller's AbortSignal aborts the provider request. A cancelled generation is a
 * result (finish "cancelled", with the text received so far), not an error.
 */
import { createHash } from 'node:crypto';

export type GenerationRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  /** The provider's id for this call, used to send its result back. */
  id: string;
  /** The capability name ("tasks.create"), not the provider-safe tool name. */
  name: string;
  input: Record<string, unknown>;
}

export interface GenerationMessage {
  role: GenerationRole;
  content: string;
  /** role "assistant": the tool calls the model made in this turn. */
  toolCalls?: ToolCall[];
  /** role "tool": which call this is the result of. */
  toolCallId?: string;
}

export interface ToolDefinition {
  /** An AppPort capability name, e.g. "tasks.create". */
  name: string;
  description?: string;
  /** JSON Schema of the capability's input (an object schema). */
  inputSchema: Record<string, unknown>;
}

export interface GenerationRequest {
  messages: GenerationMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Called with each piece of text as it arrives. */
  onDelta?: (text: string) => void;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'cancelled' | 'refusal';

export interface GenerationResult {
  text: string;
  toolCalls: ToolCall[];
  finish: FinishReason;
  /** Token counts, and the cost when the provider reports one (e.g. a gateway's usage.cost, in its currency). */
  usage: { inputTokens: number | null; outputTokens: number | null; cost?: number | null };
}

/** Where and how one generation runs. The credential is the resolved secret, held only for the call. */
export interface GenerationConnection {
  provider: string;
  model: string;
  endpoint: string;
  credential?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Why a generation failed. */
export type GenerationProblem = 'unknown_protocol' | 'unsupported' | 'unavailable' | 'credential_refused' | 'provider_error' | 'malformed' | 'timeout';

/** A generation that failed. `partialText` is the text that arrived before the failure, if any. */
export class IntelligenceGenerationError extends Error {
  readonly problem: GenerationProblem;
  readonly details: Record<string, unknown>;
  partialText?: string;
  constructor(problem: GenerationProblem, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'IntelligenceGenerationError';
    this.problem = problem;
    this.details = details;
  }
}

export const DEFAULT_GENERATION_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_TOKENS = 1024;

/** The digest of a generation's input (messages and tool names): identifies it without storing it twice. */
export function generationDigest(request: { messages: GenerationMessage[]; tools?: ToolDefinition[] }): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({ messages: request.messages, tools: (request.tools ?? []).map((t) => t.name) })).digest('hex')}`;
}

const fail = (problem: GenerationProblem, message: string, details: Record<string, unknown> = {}) => new IntelligenceGenerationError(problem, message, details);

/**
 * Provider tool names allow [A-Za-z0-9_-] only. AppPort capability names are dotted lowercase words
 * and never contain "_", so "." ↔ "_" is exact and reversible; a name longer than 64 characters is
 * refused rather than truncated.
 */
export function toolName(capability: string): string {
  const name = capability.replace(/\./g, '_');
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) throw fail('unsupported', `Capability "${capability}" cannot be offered to a model as a tool (its name must map to [a-z0-9_], at most 64 characters).`);
  return name;
}
export const capabilityName = (tool: string) => tool.replace(/_/g, '.');

/** Split a fetch body into SSE events ({ event, data }). Tolerates \r\n and multi-line data. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '');
        let event: string | null = null;
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const val = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = val;
          else if (field === 'data') data.push(val);
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Remove a secret from text that may echo it (provider error bodies, URLs). */
export const scrubSecret = (text: string, secret?: string) => (secret ? text.split(secret).join('[redacted]') : text).replace(/\b(sk|key)-[A-Za-z0-9_-]{12,}/g, '[redacted]');

async function open(connection: GenerationConnection, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  let response: Response;
  try {
    response = await (connection.fetch ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers }, body: JSON.stringify(body), signal });
  } catch (error) {
    if (signal.aborted) throw error;
    const cause = scrubSecret(String((error as { cause?: { code?: string } })?.cause?.code ?? (error as Error)?.message ?? error), connection.credential);
    throw fail('unavailable', `${connection.provider} could not be reached at ${new URL(url).origin} (${cause}).`, { provider: connection.provider });
  }
  if (!response.ok || !response.body) {
    const text = scrubSecret(await response.text().catch(() => ''), connection.credential);
    if (response.status === 401 || response.status === 403) throw fail('credential_refused', `${connection.provider} refused the credential (HTTP ${response.status}).`, { provider: connection.provider, status: response.status });
    throw fail('provider_error', `${connection.provider} answered HTTP ${response.status}: ${text.slice(0, 300)}`, { provider: connection.provider, status: response.status });
  }
  return response.body;
}

function parse(data: string, provider: string): any {
  try {
    return JSON.parse(data);
  } catch {
    throw fail('malformed', `${provider} streamed an event that is not JSON.`, { provider });
  }
}

function parseInput(raw: string, provider: string, name: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // not JSON: refused below
  }
  throw fail('malformed', `${provider} called tool ${name} with input that is not a JSON object.`, { provider });
}

const join = (endpoint: string, path: string) => `${endpoint.replace(/\/+$/, '')}${path}`;

async function openaiStream(connection: GenerationConnection, request: GenerationRequest, signal: AbortSignal): Promise<GenerationResult> {
  const messages = request.messages.map((m) => {
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return { role: 'assistant', content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: toolName(c.name), arguments: JSON.stringify(c.input) } })) };
    }
    return { role: m.role, content: m.content };
  });
  const body: Record<string, unknown> = {
    model: connection.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.tools?.length ? { tools: request.tools.map((t) => ({ type: 'function', function: { name: toolName(t.name), ...(t.description ? { description: t.description } : {}), parameters: t.inputSchema } })) } : {}),
  };
  const stream = await open(connection, join(connection.endpoint, '/chat/completions'), connection.credential ? { authorization: `Bearer ${connection.credential}` } : {}, body, signal);
  let text = '';
  let finish: FinishReason = 'stop';
  const usage: GenerationResult['usage'] = { inputTokens: null, outputTokens: null };
  const calls = new Map<number, { id: string; name: string; args: string }>();
  for await (const event of sseEvents(stream)) {
    if (event.data === '[DONE]') break;
    const chunk = parse(event.data, connection.provider);
    if (chunk?.error) throw fail('provider_error', `${connection.provider} reported: ${scrubSecret(String(chunk.error.message ?? JSON.stringify(chunk.error)), connection.credential).slice(0, 300)}`, { provider: connection.provider });
    if (chunk?.usage) {
      usage.inputTokens = chunk.usage.prompt_tokens ?? null;
      usage.outputTokens = chunk.usage.completion_tokens ?? null;
      if (typeof chunk.usage.cost === 'number') usage.cost = chunk.usage.cost;
    }
    const choice = chunk?.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    if (typeof delta.content === 'string' && delta.content) {
      text += delta.content;
      request.onDelta?.(delta.content);
    }
    for (const call of delta.tool_calls ?? []) {
      const at = calls.get(call.index ?? 0) ?? { id: '', name: '', args: '' };
      if (call.id) at.id = call.id;
      if (call.function?.name) at.name += call.function.name;
      if (call.function?.arguments) at.args += call.function.arguments;
      calls.set(call.index ?? 0, at);
    }
    if (choice.finish_reason) finish = choice.finish_reason === 'tool_calls' ? 'tool_calls' : choice.finish_reason === 'length' ? 'length' : choice.finish_reason === 'content_filter' ? 'refusal' : 'stop';
  }
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => ({ id: c.id, name: capabilityName(c.name), input: parseInput(c.args, connection.provider, c.name) }));
  return { text, toolCalls, finish: toolCalls.length ? 'tool_calls' : finish, usage };
}

async function anthropicStream(connection: GenerationConnection, request: GenerationRequest, signal: AbortSignal): Promise<GenerationResult> {
  const system = request.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];
  for (const m of request.messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const last = messages.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content) && (last.content as Array<{ type: string }>).every((b) => b.type === 'tool_result')) (last.content as unknown[]).push(block);
      else messages.push({ role: 'user', content: [block] });
      continue;
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      messages.push({ role: 'assistant', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: toolName(c.name), input: c.input }))] });
      continue;
    }
    messages.push({ role: m.role as 'user' | 'assistant', content: m.content });
  }
  const base = connection.endpoint.replace(/\/+$/, '');
  const url = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  const body = {
    model: connection.model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    messages,
    ...(system ? { system } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.tools?.length ? { tools: request.tools.map((t) => ({ name: toolName(t.name), ...(t.description ? { description: t.description } : {}), input_schema: t.inputSchema })) } : {}),
  };
  const stream = await open(connection, url, { 'anthropic-version': '2023-06-01', ...(connection.credential ? { 'x-api-key': connection.credential } : {}) }, body, signal);
  let text = '';
  let finish: FinishReason = 'stop';
  const usage: GenerationResult['usage'] = { inputTokens: null, outputTokens: null };
  const blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
  for await (const event of sseEvents(stream)) {
    const data = parse(event.data, connection.provider);
    switch (data?.type) {
      case 'message_start':
        usage.inputTokens = data.message?.usage?.input_tokens ?? null;
        break;
      case 'content_block_start':
        blocks.set(data.index, { type: data.content_block?.type, id: data.content_block?.id, name: data.content_block?.name, json: '' });
        break;
      case 'content_block_delta': {
        const d = data.delta ?? {};
        if (d.type === 'text_delta' && d.text) {
          text += d.text;
          request.onDelta?.(d.text);
        } else if (d.type === 'input_json_delta') {
          const block = blocks.get(data.index);
          if (block) block.json += d.partial_json ?? '';
        }
        break;
      }
      case 'message_delta':
        if (data.usage?.output_tokens !== undefined) usage.outputTokens = data.usage.output_tokens;
        if (data.delta?.stop_reason) finish = data.delta.stop_reason === 'tool_use' ? 'tool_calls' : data.delta.stop_reason === 'max_tokens' ? 'length' : data.delta.stop_reason === 'refusal' ? 'refusal' : 'stop';
        break;
      case 'error':
        throw fail('provider_error', `${connection.provider} reported: ${scrubSecret(String(data.error?.message ?? 'an error'), connection.credential).slice(0, 300)}`, { provider: connection.provider });
    }
  }
  const toolCalls = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, b]) => b.type === 'tool_use')
    .map(([, b]) => ({ id: b.id ?? '', name: capabilityName(b.name ?? ''), input: parseInput(b.json, connection.provider, b.name ?? '') }));
  return { text, toolCalls, finish: toolCalls.length ? 'tool_calls' : finish, usage };
}

const PROTOCOL_STREAMS: Record<string, (c: GenerationConnection, r: GenerationRequest, s: AbortSignal) => Promise<GenerationResult>> = {
  openai: openaiStream,
  'openai-compatible': openaiStream,
  anthropic: anthropicStream,
};

/** Whether `protocol` (an Intelligence provider's) can run generations. */
export function supportsGeneration(protocol: string): boolean {
  return protocol in PROTOCOL_STREAMS;
}

/**
 * Stream one generation over a resolved connection. Cancellation by the caller's signal returns what
 * was received with finish "cancelled"; the timeout is a `timeout` error carrying the partial text.
 */
export async function streamGeneration(protocol: string, connection: GenerationConnection, request: GenerationRequest): Promise<GenerationResult> {
  const run = PROTOCOL_STREAMS[protocol];
  if (!run) throw fail('unknown_protocol', `Generation does not support the "${protocol}" protocol.`, { protocol });
  const timeoutMs = connection.timeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  let text = '';
  const tracked: GenerationRequest = { ...request, onDelta: (d) => ((text += d), request.onDelta?.(d)) };
  const partial = (e: IntelligenceGenerationError) => Object.assign(e, { partialText: text });
  try {
    return await run(connection, tracked, signal);
  } catch (error) {
    if (request.signal?.aborted) return { text, toolCalls: [], finish: 'cancelled', usage: { inputTokens: null, outputTokens: null } };
    if (timeout.aborted) throw partial(fail('timeout', `${connection.provider} did not finish within ${timeoutMs} ms.`, { provider: connection.provider, timeoutMs }));
    if (error instanceof IntelligenceGenerationError) throw partial(error);
    throw partial(fail('unavailable', `The connection to ${connection.provider} ended before the generation finished (${scrubSecret(String((error as Error)?.message ?? error), connection.credential).slice(0, 200)}).`, { provider: connection.provider }));
  }
}
