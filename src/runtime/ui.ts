import {
  UI_DISCOVERY_PATH,
  UI_PROTOCOL_ID,
  filterUiContribution,
  validateUiContribution,
  type UiContribution,
  type UiDiscoveryDocument,
} from '@appport/protocol';

import { VERSION } from '../version.js';
import type { ServicesExtension } from '../extensions/extension.js';

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
  { id: 'secrets', title: 'Secrets', route: '/secrets', order: 80, mounted: (s, c) => c && Boolean(s.configuration), capabilities: ['configuration.read', 'credential.attach', 'credential.rotate', 'credential.detach', 'credential.status', 'credential.store'] },
];

/** The number of management pages (everything but the overview) that are mounted. */
function countPages(services: UiMountedServices, includeConfiguration: boolean, extensionPages = 0): number {
  return SURFACES.filter((surface) => surface.id !== 'overview' && surface.mounted(services, includeConfiguration)).length + extensionPages;
}

/** Built-in surfaces plus extension pages, in one list. Without extensions, exactly the built-in surfaces. */
function mountedSurfaces(services: UiMountedServices, includeConfiguration: boolean, extensions: readonly ServicesExtension[]): Array<Pick<SurfaceDefinition, 'id' | 'title' | 'route' | 'order' | 'capabilities'> & { extension?: { id: string; description: string; script: string } }> {
  const pages = extensions.flatMap((extension) => (extension.pages ?? []).map((page) => ({ extension, page })));
  const builtIn = SURFACES.filter((surface) => surface.id === 'overview'
    // With extension pages, the overview is mounted once the host shows more than two pages in all.
    ? (pages.length ? countPages(services, includeConfiguration, pages.length) > 2 : surface.mounted(services, includeConfiguration))
    : surface.mounted(services, includeConfiguration));
  return [
    ...builtIn,
    ...pages.map(({ extension, page }) => ({
      id: page.id, title: page.title, route: page.route, order: page.order, capabilities: page.capabilities,
      extension: { id: extension.id, description: page.description, script: page.script },
    })),
  ];
}

const PRODUCT_ID = 'appport-services';
const GROUP = 'AppPort Services';


/**
 * The `AppPort/ui/1` contribution for the surfaces that are actually mounted,
 * or `undefined` when none are. The result is validated by the protocol's own
 * validator before it is returned.
 */
export function createUiContribution(services: UiMountedServices, options: { readonly includeConfiguration?: boolean; readonly extensions?: readonly ServicesExtension[] } = {}): UiContribution | undefined {
  const includeConfiguration = options.includeConfiguration !== false;
  const mounted = mountedSurfaces(services, includeConfiguration, options.extensions ?? []);
  if (mounted.length === 0) return undefined;
  return validateUiContribution({
    protocol: UI_PROTOCOL_ID,
    product: { id: PRODUCT_ID, version: VERSION },
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
  options: { readonly includeConfiguration?: boolean; readonly callerCapabilities?: readonly string[]; readonly extensions?: readonly ServicesExtension[] } = {},
): UiDiscoveryDocument | undefined {
  const contribution = createUiContribution(services, options);
  if (!contribution) return undefined;
  return filterUiContribution(contribution, options.callerCapabilities ?? []);
}

/** A management page as the packaged pages need it: its surface, title, route and place in the navigation. */
export interface UiPage {
  readonly id: string;
  readonly title: string;
  readonly route: string;
  readonly order: number;
  /** An extension's page: its overview description and its renderer script. Absent for built-in pages. */
  readonly extension?: { readonly id: string; readonly description: string; readonly script: string };
}

const EVERYTHING: UiMountedServices = { apiKeys: true, webhooks: true, jobs: true, schedules: true, files: true, notifications: true, configuration: true, intelligence: true };

/**
 * The pages that are actually mounted, in navigation order: the same surfaces
 * the contribution describes, so the packaged navigation never links to a page
 * this host does not serve. With no services given, every page.
 */
export function createUiPages(services: UiMountedServices = EVERYTHING, options: { readonly includeConfiguration?: boolean; readonly extensions?: readonly ServicesExtension[] } = {}): UiPage[] {
  const includeConfiguration = options.includeConfiguration !== false;
  return mountedSurfaces(services, includeConfiguration, options.extensions ?? [])
    .sort((a, b) => a.order - b.order)
    .map(({ id, title, route, order, extension }) => ({ id, title, route, order, ...(extension ? { extension } : {}) }));
}

/** Every surface this package can contribute, for hosts that mount everything. */
export const APPPORT_UI_CONTRIBUTIONS: readonly UiContribution[] = Object.freeze(
  [createUiContribution(EVERYTHING)!],
);
