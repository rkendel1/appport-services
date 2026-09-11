import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { AppPortApplication, AppPortRouteHandler } from './appport.js';

export interface AppPortEvent<T = unknown> { readonly id: number; readonly type: string; readonly tenantId: string; readonly data: T; readonly timestamp: string }
export interface EventSubscription { close(): void }

export class AppPortEvents {
  private sequence = 0;
  private readonly history: AppPortEvent[] = [];
  private readonly subscribers = new Set<(event: AppPortEvent) => void>();
  constructor(private readonly maxHistory = 1_000) {}
  publish<T>(type: string, data: T, tenantId: string): AppPortEvent<T> {
    const event = { id: ++this.sequence, type, tenantId, data, timestamp: new Date().toISOString() };
    this.history.push(event); if (this.history.length > this.maxHistory) this.history.shift();
    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }
  subscribe(handler: (event: AppPortEvent) => void, options: { tenantId?: string; type?: string; after?: number } = {}): EventSubscription {
    const deliver = (event: AppPortEvent) => { if ((!options.tenantId || event.tenantId === options.tenantId) && (!options.type || event.type === options.type)) handler(event); };
    for (const event of this.history) if (event.id > (options.after ?? this.sequence)) deliver(event);
    this.subscribers.add(deliver); return { close: () => this.subscribers.delete(deliver) };
  }
  overview(): { sequence: number; retained: number; subscribers: number } { return { sequence: this.sequence, retained: this.history.length, subscribers: this.subscribers.size }; }
  close(): void { this.subscribers.clear(); }
}

export class AppPortTenantContext {
  private readonly storage = new AsyncLocalStorage<string>();
  constructor(private readonly defaultTenant?: string) {}
  current(): string { const tenant = this.storage.getStore() ?? this.defaultTenant; if (!tenant) throw new Error('Tenant context is required'); return tenant; }
  run<T>(tenantId: string, callback: () => T): T { return this.storage.run(tenantId, callback); }
}

export interface AppPortHttpRuntime { readonly url: string; readonly port: number; close(): Promise<void> }

export async function startHttpRuntime(application: AppPortApplication, routes: Readonly<Record<string, AppPortRouteHandler>>): Promise<AppPortHttpRuntime> {
  const config = application.contract;
  const server = createServer((request, response) => void dispatch(application, routes, request, response));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.http.port, config.http.host, () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); const port = typeof address === 'object' && address ? address.port : config.http.port;
  return { url: `http://${config.http.host}:${port}`, port, close: () => closeServer(server) };
}

async function dispatch(application: AppPortApplication, routes: Readonly<Record<string, AppPortRouteHandler>>, request: IncomingMessage, response: ServerResponse): Promise<void> {
  applyCors(application, request, response);
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  try {
    const url = new URL(request.url ?? '/', 'http://appport.local');
    if (url.pathname === '/_appport/health') { json(response, 200, { ok: true, application: application.contract.application.name }); return; }
    const principal = await authenticate(application, request);
    const tenantId = principal?.tenantId ?? header(request, 'x-appport-tenant') ?? application.contract.tenant.default;
    if (!tenantId && application.contract.tenant.mode === 'required') throw httpError(400, 'TENANT_REQUIRED', 'A tenant is required');
    if (url.pathname === '/_appport/events' && request.method === 'GET' && application.contract.events.streaming.enabled) { streamEvents(application, request, response, tenantId ?? 'default'); return; }
    if (url.pathname === '/_appport/overview') { json(response, 200, application.overview()); return; }
    if (url.pathname === '/_appport/api/keys' && request.method === 'GET') { json(response, 200, await application.api.keys.listApiKeys(tenantId!)); return; }
    if (url.pathname === '/_appport/api/keys' && request.method === 'POST') { const body = record(await readJson(request)); const created = await application.api.keys.createApiKey({ tenantId: tenantId!, name: text(body.name, 'name'), scopes: texts(body.scopes, 'scopes'), createdBy: principal?.principalId ?? text(body.createdBy, 'createdBy') }); json(response, 201, created); return; }
    if (url.pathname === '/_appport/webhooks' && request.method === 'GET') { json(response, 200, await application.webhooks.listWebhookEndpoints(tenantId!)); return; }
    if (url.pathname === '/_appport/webhooks' && request.method === 'POST') { const body = record(await readJson(request)); const created = await application.webhooks.createWebhookEndpoint({ tenantId: tenantId!, url: text(body.url, 'url'), events: texts(body.events, 'events'), createdBy: principal?.principalId ?? text(body.createdBy, 'createdBy') }); json(response, 201, created); return; }
    if (url.pathname === '/_appport/jobs' && request.method === 'GET') { json(response, 200, await application.jobs.listJobs(tenantId!)); return; }
    if (url.pathname === '/_appport/jobs' && request.method === 'POST') { const body = record(await readJson(request)); const created = await application.jobs.enqueue({ tenantId: tenantId!, type: text(body.type, 'type'), payload: record(body.payload ?? {}), ...(body.maxAttempts === undefined ? {} : { maxAttempts: Number(body.maxAttempts) }) }); json(response, 201, created); return; }
    if (url.pathname === '/_appport/events' && request.method === 'POST') { const body = record(await readJson(request)); const event = await application.publish(text(body.type, 'type'), record(body.data ?? {}), tenantId!); json(response, 201, event); return; }
    const handler = routes[`${request.method ?? 'GET'} ${url.pathname}`];
    if (!handler) throw httpError(404, 'NOT_FOUND', 'Route not found');
    const body = await readJson(request);
    const resolvedTenant = tenantId ?? 'default';
    const result = await application.tenant.run(resolvedTenant, () => handler({ application, services: application.forTenant(resolvedTenant), request, body, tenantId: resolvedTenant, principal }));
    json(response, 200, result ?? null);
  } catch (error) {
    const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500;
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : 'INTERNAL_ERROR';
    json(response, status, { error: { code, message: error instanceof Error ? error.message : String(error) } });
  }
}

async function authenticate(application: AppPortApplication, request: IncomingMessage): Promise<AuthenticatedPrincipal | null> {
  if (!application.contract.authorization.enabled) return null;
  const authorization = header(request, 'authorization');
  if (!authorization?.startsWith('Bearer ')) { if (application.contract.authorization.default === 'deny') throw httpError(401, 'UNAUTHENTICATED', 'Bearer credential required'); return null; }
  const principal = await application.api.keys.authenticateApiKey(authorization.slice(7));
  if (!principal) throw httpError(403, 'INVALID_CREDENTIAL', 'Credential is invalid');
  return principal;
}
function streamEvents(application: AppPortApplication, request: IncomingMessage, response: ServerResponse, tenantId: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const after = Number(header(request, 'last-event-id') ?? 0);
  const subscription = application.events.subscribe((event) => response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`), { tenantId, after });
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
  request.once('close', () => { clearInterval(heartbeat); subscription.close(); });
}
function applyCors(application: AppPortApplication, request: IncomingMessage, response: ServerResponse): void { if (!application.contract.cors.enabled) return; const origin = header(request, 'origin'); const origins = application.contract.cors.origins; if (origins.includes('*')) response.setHeader('access-control-allow-origin', '*'); else if (origin && origins.includes(origin)) response.setHeader('access-control-allow-origin', origin); response.setHeader('access-control-allow-headers', 'authorization, content-type, x-appport-tenant'); response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS'); }
function header(request: IncomingMessage, name: string): string | undefined { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }
async function readJson(request: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); if (!chunks.length) return undefined; try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'INVALID_JSON', 'Request body must be valid JSON'); } }
function json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); }
function httpError(status: number, code: string, message: string): Error & { status: number; code: string } { return Object.assign(new Error(message), { status, code }); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'INVALID_INPUT', 'Expected a JSON object'); return value as Record<string, unknown>; }
function text(value: unknown, property: string): string { if (typeof value !== 'string' || !value) throw httpError(400, 'INVALID_INPUT', `${property} must be a non-empty string`); return value; }
function texts(value: unknown, property: string): string[] { if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw httpError(400, 'INVALID_INPUT', `${property} must be an array of strings`); return value as string[]; }
function closeServer(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
