import { readFileSync } from 'node:fs';
import {
  UI_DISCOVERY_PATH,
  UI_PROTOCOL_ID,
  filterUiContribution,
  validateUiContribution,
  type UiContribution,
  type UiDiscoveryDocument,
} from '@appport/protocol';

/**
 * The UI contract is `AppPort/ui/1`, owned by `@appport/protocol`
 * (`packages/protocol/src/ui.ts` in rkendel1/appport). This module only
 * *describes* this package's surfaces in that shape and validates the result
 * with the protocol's own validator; it defines no schema of its own.
 *
 * `GET /v1/ui` is caller-contextual in the protocol: the server returns the
 * contribution **filtered by the capabilities the caller holds**
 * (`filterUiContribution`; `appport` `Server.uiDiscovery`). There is no public
 * mode. A surface that needs no capability is visible to everyone; one that
 * needs capabilities appears only for a caller who holds them all.
 */
export { UI_DISCOVERY_PATH, UI_PROTOCOL_ID };

/** The services a host has mounted, as far as the UI is concerned. */
export interface UiMountedServices {
  readonly apiKeys?: unknown;
  readonly webhooks?: unknown;
  readonly jobs?: unknown;
  readonly schedules?: unknown;
  readonly files?: unknown;
  readonly notifications?: unknown;
  readonly configuration?: unknown;
  readonly intelligence?: unknown;
}

interface SurfaceDefinition {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  readonly order: number;
  readonly mounted: (services: UiMountedServices, includeConfiguration: boolean) => boolean;
  /** The capabilities the packaged page drives; each is a manifest capability. */
  readonly capabilities: readonly string[];
}

const SURFACES: readonly SurfaceDefinition[] = [
  // The landing page: it only links to the pages below, each of which
  // authenticates and authorizes its own caller, so it needs no capability.
  { id: 'overview', title: 'AppPort Services', route: '/services', order: 0, mounted: (s, c) => countPages(s, c) > 2, capabilities: [] },
  { id: 'api-keys', title: 'API Keys', route: '/api-keys', order: 10, mounted: (s) => Boolean(s.apiKeys), capabilities: ['apikeys.read', 'apikeys.create', 'apikeys.revoke'] },
  { id: 'webhooks', title: 'Webhooks', route: '/webhooks', order: 20, mounted: (s) => Boolean(s.webhooks), capabilities: ['webhooks.read', 'webhooks.register', 'webhooks.remove'] },
  { id: 'jobs', title: 'Jobs', route: '/jobs', order: 30, mounted: (s) => Boolean(s.jobs), capabilities: ['jobs.read', 'jobs.create', 'jobs.retry'] },
  { id: 'schedules', title: 'Schedules', route: '/schedules', order: 40, mounted: (s) => Boolean(s.schedules), capabilities: ['schedules.read', 'schedules.create', 'schedules.cancel'] },
  { id: 'notifications', title: 'Notifications', route: '/notifications', order: 50, mounted: (s) => Boolean(s.notifications), capabilities: ['notifications.read', 'notifications.send', 'notifications.update', 'notifications.delete'] },
  { id: 'files', title: 'Files', route: '/files', order: 60, mounted: (s) => Boolean(s.files), capabilities: ['files.read', 'files.write', 'files.delete'] },
  { id: 'configuration', title: 'Configuration', route: '/configuration', order: 70, mounted: (s, c) => c && Boolean(s.configuration), capabilities: ['configuration.read', 'configuration.write', 'configuration.delete'] },
  { id: 'intelligence', title: 'Intelligence', route: '/intelligence', order: 75, mounted: (s, c) => c && Boolean(s.intelligence), capabilities: ['intelligence.catalog', 'intelligence.read', 'intelligence.write', 'intelligence.credential.set', 'intelligence.credential.remove'] },
  { id: 'secrets', title: 'Secrets', route: '/secrets', order: 80, mounted: (s, c) => c && Boolean(s.configuration), capabilities: ['configuration.read', 'credential.attach', 'credential.rotate', 'credential.detach'] },
];

/** The number of management pages (everything but the overview) that are mounted. */
function countPages(services: UiMountedServices, includeConfiguration: boolean): number {
  return SURFACES.filter((surface) => surface.id !== 'overview' && surface.mounted(services, includeConfiguration)).length;
}

const PRODUCT_ID = 'appport-services';
const GROUP = 'AppPort Services';

function packageVersion(): string {
  try {
    const url = new URL('../../../package.json', import.meta.url);
    const parsed = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version) return parsed.version;
  } catch { /* fall through */ }
  return '0.0.0';
}

/**
 * The `AppPort/ui/1` contribution for the surfaces that are actually mounted,
 * or `undefined` when none are. The result is validated by the protocol's own
 * validator before it is returned.
 */
export function createUiContribution(services: UiMountedServices, options: { readonly includeConfiguration?: boolean } = {}): UiContribution | undefined {
  const includeConfiguration = options.includeConfiguration !== false;
  const mounted = SURFACES.filter((surface) => surface.mounted(services, includeConfiguration));
  if (mounted.length === 0) return undefined;
  return validateUiContribution({
    protocol: UI_PROTOCOL_ID,
    product: { id: PRODUCT_ID, version: packageVersion() },
    surfaces: mounted.map(({ id, title, route, capabilities }) => ({ id, title, route, capabilities: [...capabilities] })),
    navigation: mounted.map(({ id, title, order }) => ({ id: `appport-services.${id}`, label: title, group: GROUP, order, surface: id })),
    // Discovery is anonymous (like `/_appport/capabilities`): it names pages and
    // the capabilities they need, and grants nothing. Each page authenticates
    // and authorizes its own caller.
    composition: { requires: [] },
  });
}

/**
 * The document `GET /v1/ui` returns for a caller holding `callerCapabilities`.
 *
 * `@appport/services` has no way to ask "may this caller?" without side effects
 * (`ServiceGateway.authorize` throws on denial and records refusal evidence), so
 * the router passes none: the caller is treated as holding no capabilities and
 * the protocol's own filter leaves only capability-free surfaces (the overview).
 * A host that knows its callers' capabilities can pass them here, or hand
 * `APPPORT_UI_CONTRIBUTIONS` to the AppPort protocol server's `ui` option and
 * get the protocol's per-caller filtering unchanged.
 */
export function createUiDiscoveryDocument(
  services: UiMountedServices,
  options: { readonly includeConfiguration?: boolean; readonly callerCapabilities?: readonly string[] } = {},
): UiDiscoveryDocument | undefined {
  const contribution = createUiContribution(services, options);
  if (!contribution) return undefined;
  return filterUiContribution(contribution, options.callerCapabilities ?? []);
}

/** Every surface this package can contribute, for hosts that mount everything. */
export const APPPORT_UI_CONTRIBUTIONS: readonly UiContribution[] = Object.freeze(
  [createUiContribution({ apiKeys: true, webhooks: true, jobs: true, schedules: true, files: true, notifications: true, configuration: true, intelligence: true })!],
);
