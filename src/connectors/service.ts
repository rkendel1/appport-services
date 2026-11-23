import type { AuthenticatedPrincipal } from '../contract/principals.js';
import { isCredentialRef, type CredentialRef } from '../authority/credentials.js';
import type { WebhookDestinationPolicy } from '../authority/destination.js';
import { ServiceAuthorityError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { sendOutboundRequest, type OutboundHttpResponse } from '../authority/outbound.js';
import { requireVerifiedPrincipal, resolveTenant } from '../authority/principal.js';

/** How a connector presents its credential. The material comes from custody, by reference, per request. */
export type ConnectorAuth =
  /** `Authorization: Bearer <secret>` */
  | { readonly type: 'bearer' }
  /** `<name>: [prefix ]<secret>`, e.g. `{ type: 'header', name: 'xi-api-key' }` */
  | { readonly type: 'header'; readonly name: string; readonly prefix?: string }
  /** `Authorization: Basic base64(<secret>)`; the secret is `user:password`. */
  | { readonly type: 'basic' }
  /** `?<name>=<secret>` on the query string. */
  | { readonly type: 'query'; readonly name: string };

/**
 * One outbound HTTP integration the host trusts (TURN credentials, speech to
 * text, calendars, ...). Declared by the host in code (`createServices({
 * connectors })`), never by a request: the allowed hosts, credential reference
 * and limits are trusted configuration.
 */
export interface ConnectorDefinition {
  /** Lower-case identifier, e.g. `calendar`. Requests name it; evidence records it as `provider`. */
  readonly id: string;
  /** Base URL; a request's `path` is resolved against it. */
  readonly baseUrl: string;
  /** Exact host names a request may reach (default: the base URL's host). No wildcards. */
  readonly allowedHosts?: readonly string[];
  /** Upper-case methods a request may use (default GET, POST, PUT, PATCH, DELETE). */
  readonly allowedMethods?: readonly string[];
  /** Credential reference into custody. Never a raw secret. */
  readonly credentialRef?: string;
  /** How the credential is presented (default `bearer` when `credentialRef` is set). */
  readonly auth?: ConnectorAuth;
  /** Fixed, non-secret headers sent with every request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Default 30 s. */
  readonly timeoutMs?: number;
  /** Default 10 MiB. */
  readonly maxResponseBytes?: number;
}

/** What `connectors.read` shows: the definition without anything secret (the reference is a pointer, not a value). */
export interface ConnectorView {
  readonly id: string;
  readonly baseUrl: string;
  readonly allowedHosts: readonly string[];
  readonly allowedMethods: readonly string[];
  readonly credentialConfigured: boolean;
  readonly auth?: ConnectorAuth['type'];
}

export interface ConnectorRequestInput {
  /** Optional; must equal the caller's tenant. */
  readonly tenantId?: string;
  readonly connector: string;
  /** Default GET. */
  readonly method?: string;
  /** Path (and optional query) resolved against the connector's base URL; or an absolute URL on an allowed host. */
  readonly path?: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  /** Non-credential headers. Authorization, cookies and API-key headers are refused: use the connector's credential. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Raw body (string or bytes). Exclusive with `json`. */
  readonly body?: string | Uint8Array;
  /** JSON body; sets `Content-Type: application/json`. */
  readonly json?: unknown;
  /** Bytes as base64 in the response instead of text. Default `text`. */
  readonly responseType?: 'text' | 'base64';
  /** Correlation id; evidence records it as the request id. */
  readonly requestId?: string;
}

export interface ConnectorResponse {
  readonly connector: string;
  readonly status: number;
  readonly ok: boolean;
  /** Lower-case names; `set-cookie` is dropped. */
  readonly headers: Readonly<Record<string, string>>;
  /** UTF-8 text, or base64 with `responseType: "base64"`. */
  readonly body: string;
  /** Parsed body when the response is JSON. */
  readonly json?: unknown;
}

export interface ConnectorServiceOptions {
  readonly connectors?: readonly ConnectorDefinition[];
  readonly authority?: ServiceGateway;
  /** Destination policy (trusted host code only): private networks are refused unless allowed here. */
  readonly destinationPolicy?: WebhookDestinationPolicy;
}

const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const HEADER = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const DEFAULT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const FORBIDDEN_REQUEST_HEADERS = /^(authorization|proxy-authorization|cookie|host|content-length|connection|transfer-encoding|x-api-key|api-key|x-auth-token)$/i;
const CREDENTIAL_HEADER = /(token|secret|password|api[-_]?key|credential)/i;

/**
 * Outbound HTTP through the gateway (`connectors.request`). Each request is
 * authorized as the caller (resource attributes: connector, method, host,
 * path), sent only to the connector's allowed hosts after destination
 * validation (no private or metadata addresses, the connection pinned to the
 * validated address, no redirects followed), with the credential resolved from
 * custody by reference for that request only, and recorded as effect evidence
 * (`service: "connectors"`, `provider: <connector id>`, the credential-ref).
 */
export class ConnectorService {
  private readonly connectors = new Map<string, ConnectorDefinition & { readonly hosts: ReadonlySet<string>; readonly methods: readonly string[] }>();

  constructor(private readonly options: ConnectorServiceOptions = {}) {
    for (const definition of options.connectors ?? []) this.define(definition);
  }

  /** Register a connector (trusted host code). Ids are unique. */
  define(definition: ConnectorDefinition): void {
    if (!definition || typeof definition !== 'object' || typeof definition.id !== 'string' || !ID.test(definition.id)) throw new TypeError('Connector id must be a lower-case identifier');
    if (this.connectors.has(definition.id)) throw new TypeError(`Connector "${definition.id}" is already defined`);
    let base: URL;
    try { base = new URL(definition.baseUrl); } catch { throw new TypeError(`Connector "${definition.id}": baseUrl must be a URL`); }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new TypeError(`Connector "${definition.id}": baseUrl must be http or https`);
    if (base.username || base.password) throw new TypeError(`Connector "${definition.id}": baseUrl must not embed credentials`);
    if (definition.credentialRef !== undefined && !isCredentialRef(definition.credentialRef)) throw new TypeError(`Connector "${definition.id}": credentialRef must be a credential-ref:<id>, never a raw secret`);
    if (definition.auth && !definition.credentialRef) throw new TypeError(`Connector "${definition.id}": auth needs a credentialRef`);
    if (definition.auth?.type === 'header' && (!HEADER.test(definition.auth.name) || /^(host|content-length|connection)$/i.test(definition.auth.name))) throw new TypeError(`Connector "${definition.id}": auth header name is invalid`);
    if (definition.auth?.type === 'query' && !/^[A-Za-z0-9_.-]{1,64}$/.test(definition.auth.name)) throw new TypeError(`Connector "${definition.id}": auth query name is invalid`);
    for (const [name, value] of Object.entries(definition.headers ?? {})) {
      if (!HEADER.test(name) || FORBIDDEN_REQUEST_HEADERS.test(name) || CREDENTIAL_HEADER.test(name) || typeof value !== 'string') throw new TypeError(`Connector "${definition.id}": header "${name}" is not allowed in fixed headers; use credentialRef`);
    }
    const hosts = new Set((definition.allowedHosts?.length ? definition.allowedHosts : [base.hostname]).map((host) => normalizeHost(host)));
    for (const host of hosts) if (!host || host.includes('*')) throw new TypeError(`Connector "${definition.id}": allowedHosts must be exact host names`);
    if (!hosts.has(normalizeHost(base.hostname))) throw new TypeError(`Connector "${definition.id}": the base URL's host must be allowed`);
    const methods = (definition.allowedMethods?.length ? definition.allowedMethods : DEFAULT_METHODS).map((method) => method.toUpperCase());
    this.connectors.set(definition.id, Object.freeze({ ...definition, hosts, methods: Object.freeze(methods) }));
  }

  /** The connectors this application defines (`connectors.read`). No credential material. */
  async list(input: { readonly tenantId?: string }, caller: AuthenticatedPrincipal): Promise<readonly ConnectorView[]> {
    const principal = requireVerifiedPrincipal(caller);
    const tenantId = resolveTenant(input ?? {}, principal);
    return this.gateway().execute('connectors.read', principal, { type: 'connector', tenantId }, { service: 'connectors' }, async () =>
      [...this.connectors.values()].map((connector) => ({
        id: connector.id,
        baseUrl: connector.baseUrl,
        allowedHosts: [...connector.hosts],
        allowedMethods: [...connector.methods],
        credentialConfigured: Boolean(connector.credentialRef),
        ...(connector.credentialRef ? { auth: connector.auth?.type ?? 'bearer' } : {}),
      })));
  }

  /** Send one request through a connector (`connectors.request`). */
  async request(input: ConnectorRequestInput, caller: AuthenticatedPrincipal): Promise<ConnectorResponse> {
    const principal = requireVerifiedPrincipal(caller);
    if (!input || typeof input !== 'object') throw invalid('connectors.request input must be an object');
    const tenantId = resolveTenant(input, principal);
    const connector = typeof input.connector === 'string' ? this.connectors.get(input.connector) : undefined;
    if (!connector) throw new ServiceAuthorityError('NOT_FOUND', `Connector "${String(input.connector)}" is not defined`, { reason: 'connector_unknown' });
    const method = (input.method ?? 'GET').toUpperCase();
    if (!connector.methods.includes(method)) throw invalid(`Connector "${connector.id}" does not allow ${method}`);
    const url = this.resolveUrl(connector, input);
    const headers = requestHeaders(connector, input);
    const body = requestBody(input, headers);
    const credentialRef = connector.credentialRef as CredentialRef | undefined;
    const attributes = { connector: connector.id, method, host: url.hostname, path: url.pathname, ...(credentialRef ? { credentialRef } : {}) };
    return this.gateway().execute('connectors.request', principal, { type: 'connector', tenantId, id: connector.id, attributes },
      { service: 'connectors', provider: connector.id, ...(credentialRef ? { credentialRef } : {}), ...(typeof input.requestId === 'string' && input.requestId ? { requestId: input.requestId } : {}) },
      async (_context, tools) => {
        const send = (finalUrl: URL, finalHeaders: Record<string, string>) => sendOutboundRequest({
          url: finalUrl.toString(), method, headers: finalHeaders, ...(body !== undefined ? { body } : {}),
          ...(connector.timeoutMs ? { timeoutMs: connector.timeoutMs } : {}),
          ...(connector.maxResponseBytes ? { maxResponseBytes: connector.maxResponseBytes } : {}),
        }, this.options.destinationPolicy);
        const response = credentialRef
          ? await tools.withCredential(credentialRef, `connector:${connector.id}`, (secret) => {
            const authorized = applyAuth(connector.auth ?? { type: 'bearer' }, secretText(secret.value), url, headers);
            return send(authorized.url, authorized.headers);
          })
          : await send(url, headers);
        return toResponse(connector.id, response, input.responseType);
      });
  }

  private resolveUrl(connector: ConnectorDefinition & { readonly hosts: ReadonlySet<string> }, input: ConnectorRequestInput): URL {
    let url: URL;
    try {
      const base = connector.baseUrl.endsWith('/') ? connector.baseUrl : `${connector.baseUrl}/`;
      const path = typeof input.path === 'string' ? input.path : '';
      url = /^[a-z][a-z0-9+.-]*:/i.test(path) ? new URL(path) : new URL(path.replace(/^\/+/, ''), base);
    } catch {
      throw invalid('path does not form a valid URL');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw invalid('Connector requests use http or https');
    if (url.username || url.password) throw invalid('Connector URLs must not embed credentials');
    if (!connector.hosts.has(normalizeHost(url.hostname))) {
      throw new ServiceAuthorityError('DENIED', `Host ${url.hostname} is not allowed for connector "${connector.id}"`, { capability: 'connectors.request', reason: 'host_not_allowed' });
    }
    for (const [name, value] of Object.entries(input.query ?? {})) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) throw invalid(`query.${name} must be a string, number or boolean`);
      url.searchParams.append(name, String(value));
    }
    return url;
  }

  private gateway(): ServiceGateway {
    if (!this.options.authority) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Connectors have no AuthBoundry authority configured');
    return this.options.authority;
  }
}

function requestHeaders(connector: ConnectorDefinition, input: ConnectorRequestInput): Record<string, string> {
  const headers: Record<string, string> = { ...(connector.headers ?? {}) };
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!HEADER.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw invalid(`Header "${name}" is invalid`);
    if (FORBIDDEN_REQUEST_HEADERS.test(name) || CREDENTIAL_HEADER.test(name)) {
      throw invalid(`Header "${name}" carries credentials or is managed by the connector; credentials come from the connector's credentialRef`);
    }
    headers[name] = value;
  }
  return headers;
}

function requestBody(input: ConnectorRequestInput, headers: Record<string, string>): string | Uint8Array | undefined {
  if (input.json !== undefined && input.body !== undefined) throw invalid('Pass body or json, not both');
  if (input.json !== undefined) {
    if (!Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    return JSON.stringify(input.json);
  }
  if (input.body === undefined) return undefined;
  if (typeof input.body !== 'string' && !(input.body instanceof Uint8Array)) throw invalid('body must be a string or bytes');
  return input.body;
}

function applyAuth(auth: ConnectorAuth, secret: string, url: URL, headers: Record<string, string>): { url: URL; headers: Record<string, string> } {
  switch (auth.type) {
    case 'bearer': return { url, headers: { ...headers, Authorization: `Bearer ${secret}` } };
    case 'basic': return { url, headers: { ...headers, Authorization: `Basic ${Buffer.from(secret, 'utf8').toString('base64')}` } };
    case 'header': return { url, headers: { ...headers, [auth.name]: auth.prefix ? `${auth.prefix} ${secret}` : secret } };
    case 'query': {
      const withSecret = new URL(url.toString());
      withSecret.searchParams.set(auth.name, secret);
      return { url: withSecret, headers };
    }
  }
}

/** A custody value is a string, or an object with one of the usual fields. */
export function secretText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    for (const key of ['value', 'token', 'apiKey', 'secret', 'key']) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === 'string') return candidate;
    }
  }
  throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Credential custody returned material in an unexpected shape', { reason: 'credential_shape' });
}

function toResponse(connector: string, response: OutboundHttpResponse, responseType: ConnectorRequestInput['responseType']): ConnectorResponse {
  const headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) => name !== 'set-cookie'));
  const type = headers['content-type'] ?? '';
  const text = response.body.toString('utf8');
  let json: unknown;
  if (/\bjson\b/i.test(type) && responseType !== 'base64') {
    try { json = JSON.parse(text); } catch { /* not JSON after all */ }
  }
  return {
    connector,
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    headers,
    body: responseType === 'base64' ? response.body.toString('base64') : text,
    ...(json !== undefined ? { json } : {}),
  };
}

function normalizeHost(host: string): string {
  return String(host).replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

function invalid(message: string): ServiceAuthorityError {
  return new ServiceAuthorityError('INVALID_REQUEST', message);
}
