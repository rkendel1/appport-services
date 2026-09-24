import { createHmac } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { StateFirstDB } from '@feltdb/core';

import { createServices, type AppPortServices } from '../../src/_internal.js';
import type { ServiceAuthorizer } from '../../src/authority/authorizer.js';
import type { WebhookDestinationPolicy } from '../../src/authority/destination.js';
import type { ScopedSecretsResolver } from '../../src/secrets/protocol.js';

export interface Stack {
  readonly services: AppPortServices;
  readonly db: StateFirstDB;
  readonly path: string;
  close(): Promise<void>;
}

export async function openStack(options: {
  path?: string;
  application?: string;
  authorizer?: ServiceAuthorizer;
  credentials?: ScopedSecretsResolver;
  timeoutMs?: number;
  destinations?: WebhookDestinationPolicy;
} = {}): Promise<Stack> {
  const path = options.path ?? await mkdtemp(join(tmpdir(), 'appport-boundary-'));
  const services = createServices({
    mode: 'local',
    namespace: 'boundary',
    path,
    application: options.application ?? 'boundary-app',
    authorizer: options.authorizer,
    credentials: options.credentials,
    authorizationTimeoutMs: options.timeoutMs,
    webhookDestinationPolicy: options.destinations ?? { allowPrivateNetworks: true },
  });
  const db = services['_getDb'] as StateFirstDB;
  return { services, db, path, close: () => Promise.resolve(db.close()) };
}

export interface Receiver {
  readonly url: string;
  readonly requests: { headers: http.IncomingHttpHeaders; body: string }[];
  status: number;
  headers: Record<string, string>;
  close(): Promise<void>;
}

/** Local webhook destination that records what reached it. */
export async function receiver(): Promise<Receiver> {
  const state: Receiver = {
    url: '',
    requests: [],
    status: 200,
    headers: {},
    close: async () => undefined,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      state.requests.push({ headers: req.headers, body });
      res.writeHead(state.status, { 'content-type': 'application/json', ...state.headers });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return Object.assign(state, {
    url: `http://127.0.0.1:${port}/hook`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  });
}

export function signInbound(secret: string, body: string, eventId: string, timestamp = new Date().toISOString()): Record<string, string> {
  return {
    'x-appport-event-id': eventId,
    'x-appport-timestamp': timestamp,
    'x-appport-signature': createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'),
  };
}

export async function scratchPath(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}
