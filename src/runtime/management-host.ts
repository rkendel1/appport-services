import { createServer, type Server } from 'node:http';

import express from 'express';

import type { ServiceAuthorizer } from '../authority/authorizer.js';
import type { PrincipalClaims } from '../authority/principal.js';
import type { WebhookDestinationPolicy } from '../authority/destination.js';
import type { ScopedSecretsResolver } from '../secrets/protocol.js';
import { authenticateBearerToken } from './api-keys.js';
import { resolveDeployment, DEFAULT_APPLICATION } from './deployment.js';
import { createManagementRouter, type ManagementAuthenticationAdapter } from './management.js';
import { createUiContribution, UI_DISCOVERY_PATH, type UiMountedServices } from './ui.js';
import { createServices, type AppPortServices } from './unified-services.js';

/** The documented default bind address. Loopback by default: the host serves an operator UI, not the public internet. */
export const DEFAULT_MANAGEMENT_HOST = '127.0.0.1';
/** The documented default port for the standalone management host. */
export const DEFAULT_MANAGEMENT_PORT = 4100;

export interface ManagementHostOptions {
  /** Directory holding `appport.toml` and the `.appport/state` deployment. */
  readonly cwd?: string;
  /** Bind address. Defaults to the contract's `http.host`, then loopback. */
  readonly host?: string;
  /** Bind port. `0` binds an ephemeral port. Defaults to the contract's `http.port`, then 4100. */
  readonly port?: number;
  /** Overrides the application identity resolved from the contract. */
  readonly application?: string;
  /** AuthBoundry client. Without one every protected operation fails closed; identity still works. */
  readonly authorizer?: ServiceAuthorizer;
  /** AuthBoundry credential custody. */
  readonly credentials?: ScopedSecretsResolver;
  /** Trusted host-only destination policy override (local development, tests). */
  readonly webhookDestinationPolicy?: WebhookDestinationPolicy;
  /**
   * Optional operator identity adapter, the same contract the CLI uses for
   * `APPPORT_AUTHORITY`. It answers "who is the operator" only; it grants
   * nothing, and every capability is still decided by AuthBoundry.
   */
  readonly identify?: () => PrincipalClaims | null | Promise<PrincipalClaims | null>;
  /** Replaces the built-in authentication boundary entirely. */
  readonly authenticate?: ManagementAuthenticationAdapter;
  /** Environment used to resolve the deployment. */
  readonly env?: NodeJS.ProcessEnv;
  /** Install SIGINT/SIGTERM shutdown handlers. Defaults to true. */
  readonly installSignalHandlers?: boolean;
  /** Receives lifecycle lines. Defaults to writing to stderr. */
  readonly logger?: (line: string) => void;
}

export interface ManagementHostRuntime {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly application: string;
  /** The AppPort/ui/1 contribution the router serves at `GET /v1/ui`. */
  readonly contribution: NonNullable<ReturnType<typeof createUiContribution>>;
  /** The routes the contribution advertises. Derived from the router, never hard-coded. */
  readonly routes: readonly string[];
  readonly services: AppPortServices;
  close(): Promise<void>;
}

/**
 * AppPort Services' own authentication boundary for the standalone host.
 *
 * Two accepted identities, both owned by AppPort Services:
 * 1. An AppPort API key presented as `Authorization: Bearer <secret>`, verified
 *    against this deployment's own durable credential store.
 * 2. An operator identity adapter, when the deployment supplies one.
 *
 * Anything else is unauthenticated. This never consults an external control
 * plane and never accepts an external operator token.
 */
export function createManagementHostAuthenticate(
  services: Pick<AppPortServices, 'apiKeys'>,
  identify?: ManagementHostOptions['identify'],
): ManagementAuthenticationAdapter {
  return async (request): Promise<PrincipalClaims | null> => {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.trim()) {
      // authenticateApiKey returns a principal minted by this package, which the
      // router accepts directly. An API key carries no scopes.
      const principal = await authenticateBearerToken(header, services.apiKeys);
      if (principal) return principal;
    }
    return identify ? identify() : null;
  };
}


/**
 * Start the standalone AppPort Services management host.
 *
 * The host owns its state, gateway, authentication, router, and HTTP server. It
 * mounts the same `createManagementRouter` an embedded host would use, so the
 * management router remains the single source of truth for which routes exist.
 */
export async function startManagementHost(options: ManagementHostOptions = {}): Promise<ManagementHostRuntime> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const log = options.logger ?? ((line: string) => process.stderr.write(`${line}\n`));
  const deployment = resolveDeployment(cwd, env);
  const application = options.application ?? deployment.application ?? DEFAULT_APPLICATION;

  // AppPort Services owns its durable state: the same FeltDB deployment the
  // operator's CLI commands use, never an in-memory or externally-owned store.
  const services = createServices({
    ...deployment.feltdb,
    application,
    ...(options.authorizer ? { authorizer: options.authorizer } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.webhookDestinationPolicy ? { webhookDestinationPolicy: options.webhookDestinationPolicy } : {}),
  });

  const contribution = createUiContribution({
    apiKeys: services.apiKeys,
    webhooks: services.webhooks,
    jobs: services.jobs,
    schedules: services.schedules,
    files: services.files,
    notifications: services.notifications,
    configuration: services.configuration,
  } satisfies UiMountedServices);
  if (!contribution) throw new Error('AppPort Services has no management surfaces to serve');

  const host = express();
  host.disable('x-powered-by');
  host.use(createManagementRouter({
    services,
    authority: services.gateway,
    authenticate: options.authenticate ?? createManagementHostAuthenticate(services, options.identify),
  }));

  const bindHost = options.host ?? deployment.config?.http.host ?? DEFAULT_MANAGEMENT_HOST;
  const bindPort = options.port ?? deployment.config?.http.port ?? DEFAULT_MANAGEMENT_PORT;

  const server = createServer(host);
  let closed = false;
  const onSigint = () => void shutdown('SIGINT');
  const onSigterm = () => void shutdown('SIGTERM');
  const shutdown = (signal: string) => {
    log(`appport-services serve: received ${signal}, shutting down`);
    return runtime.close();
  };

  await listen(server, bindPort, bindHost);
  if (options.installSignalHandlers !== false) {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : bindPort;
  const url = `http://${formatHost(bindHost)}:${port}`;

  const runtime: ManagementHostRuntime = {
    url,
    host: bindHost,
    port,
    application,
    contribution,
    routes: contribution.surfaces.map((surface) => surface.route),
    services,
    async close() {
      if (closed) return;
      closed = true;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      // Drain connections first so an in-flight management write can finish.
      await closeServer(server);
      await services.apiKeys.close().catch(() => undefined);
    },
  };

  log(`appport-services serve: listening on ${url}`);
  log(`appport-services serve: application ${application}, ${runtime.routes.length} management routes`);
  log(`appport-services serve: UI discovery at ${url}${UI_DISCOVERY_PATH}`);
  return runtime;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const onListening = () => {
      server.off('error', onError);
      resolvePromise();
    };
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      // Surface a port collision as an actionable message, not a raw EADDRINUSE.
      if (error.code === 'EADDRINUSE') {
        rejectPromise(new Error(`Cannot start the AppPort Services management host: ${host}:${port} is already in use. Pass a different --port.`));
        return;
      }
      if (error.code === 'EACCES') {
        rejectPromise(new Error(`Cannot start the AppPort Services management host: not permitted to bind ${host}:${port}. Pass a port above 1023.`));
        return;
      }
      rejectPromise(error);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
    // Idle keep-alive sockets would otherwise hold the close open.
    server.closeIdleConnections?.();
  });
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
