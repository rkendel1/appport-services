/**
 * A scriptable streaming model on loopback, speaking OpenAI chat completions and Anthropic Messages
 * server-sent events (both `stream: true`). Each request takes the next script; requests are recorded.
 * `hangAfter: n` sends n text chunks, then holds the connection until the client goes away (counted
 * in `closed`); `dropAfter: n` sends n chunks, then drops the connection. Ported from FeltKit.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Script {
  text?: string[];
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  hangAfter?: number;
  /** Send this many text chunks, then drop the connection (a provider disconnect mid-stream). */
  dropAfter?: number;
  /** Send the first text chunk, then wait for this before sending the rest. */
  gate?: Promise<void>;
  usage?: { input: number; output: number };
  /** Send no usage at all (OpenAI protocol): a provider that does not report token counts. */
  noUsage?: boolean;
  /** Answer this HTTP status with a body that echoes the request's credential (to test that it is scrubbed). */
  status?: number;
}

export async function startStreamingModel() {
  const scripts: Script[] = [];
  const requests: Array<{ path: string; headers: Record<string, unknown>; body: any }> = [];
  let closed = 0;
  const server: Server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || '{}');
    requests.push({ path: req.url ?? '', headers: req.headers, body });
    const script = scripts.shift() ?? { text: ['ok'] };
    if (script.status) {
      res.writeHead(script.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `bad key ${String(req.headers.authorization ?? req.headers['x-api-key'] ?? '')}` } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (data: unknown, event?: string) => res.write(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
    const anthropic = (req.url ?? '').includes('/messages');
    const chunks = script.text ?? [];
    const until = script.hangAfter ?? chunks.length;
    if (anthropic) {
      send({ type: 'message_start', message: { usage: { input_tokens: script.usage?.input ?? 11 } } }, 'message_start');
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
    }
    let sent = 0;
    for (const chunk of chunks.slice(0, until)) {
      if (anthropic) send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }, 'content_block_delta');
      else send({ choices: [{ index: 0, delta: { content: chunk } }] });
      sent += 1;
      if (script.dropAfter !== undefined && sent >= script.dropAfter) {
        await new Promise((r) => setTimeout(r, 20));
        res.socket?.destroy();
        return;
      }
      if (sent === 1 && script.gate) await script.gate;
    }
    if (script.hangAfter !== undefined) {
      res.on('close', () => (closed += 1));
      return; // never finishes; the client must cancel
    }
    (script.toolCalls ?? []).forEach((call, i) => {
      if (anthropic) {
        send({ type: 'content_block_start', index: i + 1, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } }, 'content_block_start');
        for (let k = 0; k < call.args.length; k += 7) send({ type: 'content_block_delta', index: i + 1, delta: { type: 'input_json_delta', partial_json: call.args.slice(k, k + 7) } }, 'content_block_delta');
      } else {
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] } }] });
        for (let k = 0; k < call.args.length; k += 7) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: i, function: { arguments: call.args.slice(k, k + 7) } }] } }] });
      }
    });
    const stop = script.toolCalls?.length ? 'tool' : 'stop';
    if (anthropic) {
      send({ type: 'message_delta', delta: { stop_reason: stop === 'tool' ? 'tool_use' : 'end_turn' }, usage: { output_tokens: script.usage?.output ?? 7 } }, 'message_delta');
      send({ type: 'message_stop' }, 'message_stop');
    } else {
      send({ choices: [{ index: 0, delta: {}, finish_reason: stop === 'tool' ? 'tool_calls' : 'stop' }] });
      if (!script.noUsage) send({ choices: [], usage: { prompt_tokens: script.usage?.input ?? 11, completion_tokens: script.usage?.output ?? 7 } });
      send('[DONE]');
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    scripts,
    requests,
    get closed() {
      return closed;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
