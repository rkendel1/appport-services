import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

import { validateDestination, type WebhookDestinationPolicy } from './destination.js';
import { ServiceAuthorityError } from './errors.js';

/** One outbound HTTP request made inside an authorized effect. */
export interface OutboundHttpRequest {
  readonly url: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | string;
  /** Default 30 s. */
  readonly timeoutMs?: number;
  /** Largest response body read; a longer response fails with PROVIDER_ERROR. Default 10 MiB. */
  readonly maxResponseBytes?: number;
}

export interface OutboundHttpResponse {
  readonly status: number;
  /** Lower-case header names; repeated headers joined with ", ". */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export const DEFAULT_OUTBOUND_TIMEOUT_MS = 30_000;
export const DEFAULT_OUTBOUND_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Send one HTTP request to a validated destination: the URL is checked against
 * the destination policy (no private, loopback, link-local or metadata address
 * unless the trusted host allows private networks), the connection is pinned to
 * the address that passed, redirects are never followed, and the response is
 * bounded. Callers run it inside a gateway effect, so the request is authorized
 * and recorded as evidence. A network failure or timeout is a PROVIDER_ERROR.
 */
export async function sendOutboundRequest(request: OutboundHttpRequest, policy: WebhookDestinationPolicy = {}): Promise<OutboundHttpResponse> {
  const { url, address } = await validateDestination(request.url, policy);
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if ((options as { all?: boolean }).all) (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  };
  const body = request.body === undefined ? undefined : typeof request.body === 'string' ? Buffer.from(request.body, 'utf8') : Buffer.from(request.body);
  const maxBytes = request.maxResponseBytes ?? DEFAULT_OUTBOUND_MAX_RESPONSE_BYTES;
  const client = url.protocol === 'https:' ? https : http;
  const headers: Record<string, string | number> = { ...(request.headers ?? {}), Connection: 'close' };
  if (body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')) headers['Content-Length'] = body.byteLength;
  return new Promise((resolve, reject) => {
    const fail = (message: string) => reject(new ServiceAuthorityError('PROVIDER_ERROR', message, { reason: 'outbound_request_failed' }));
    const req = client.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: (request.method ?? 'GET').toUpperCase(),
      agent: false,
      lookup: pinned,
      ...(url.protocol === 'https:' ? { servername: url.hostname } : {}),
      headers,
      timeout: request.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBytes) {
          req.destroy();
          fail(`Response is larger than ${maxBytes} bytes`);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const out: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value === undefined) continue;
          out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
        }
        resolve({ status: res.statusCode ?? 502, headers: out, body: Buffer.concat(chunks) });
      });
      res.on('error', (error) => fail(`Network error: ${error.message}`));
    });
    req.on('error', (error) => fail(`Network error: ${error instanceof Error ? error.message : String(error)}`));
    req.on('timeout', () => {
      req.destroy();
      fail('Request timeout');
    });
    req.end(body);
  });
}
