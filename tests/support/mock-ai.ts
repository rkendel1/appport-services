import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockAiRequest { readonly path: string; readonly authorization?: string; readonly contentType?: string; readonly body: Buffer }

/**
 * A local OpenAI-compatible server: `POST /v1/audio/transcriptions` (multipart)
 * and `POST /v1/embeddings` (JSON). Requires `Authorization: Bearer <apiKey>`
 * when `apiKey` is set. Records every request.
 */
export interface MockAi {
  readonly url: string;
  readonly requests: MockAiRequest[];
  /** Status to answer with instead of 200 (provider failure tests). */
  status: number;
  /** Omit `usage` / `duration` from responses (estimation tests). */
  omitUsage: boolean;
  close(): Promise<void>;
}

export async function mockAi(options: { readonly apiKey?: string } = {}): Promise<MockAi> {
  const state = { status: 200, omitUsage: false };
  const requests: MockAiRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    requests.push({ path: req.url ?? '', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), ...(req.headers['content-type'] ? { contentType: req.headers['content-type'] } : {}), body });
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (options.apiKey && req.headers.authorization !== `Bearer ${options.apiKey}`) return json(401, { error: { message: 'Incorrect API key provided' } });
    if (state.status !== 200) return json(state.status, { error: { message: 'mock failure' } });
    if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
      const text = body.toString('latin1');
      const model = /name="model"\r\n\r\n([^\r]*)/.exec(text)?.[1];
      if (!model || !/name="file"; filename="/.test(text)) return json(400, { error: { message: 'model and file are required' } });
      return json(200, { text: `transcript of ${body.length} bytes`, language: 'en', ...(state.omitUsage ? {} : { duration: 12.5 }), segments: [{ start: 0, end: 12.5, text: 'hello world' }] });
    }
    if (req.method === 'POST' && req.url === '/v1/embeddings') {
      const parsed = JSON.parse(body.toString('utf8')) as { model: string; input: string[] };
      const data = parsed.input.map((input, index) => ({ object: 'embedding', index, embedding: [input.length, index, 0.5] }));
      return json(200, { object: 'list', data: [...data].reverse(), model: parsed.model, ...(state.omitUsage ? {} : { usage: { prompt_tokens: parsed.input.join(' ').split(/\s+/).length, total_tokens: 0 } }) });
    }
    json(404, { error: { message: 'not found' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    get status() { return state.status; },
    set status(value: number) { state.status = value; },
    get omitUsage() { return state.omitUsage; },
    set omitUsage(value: boolean) { state.omitUsage = value; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function read(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
