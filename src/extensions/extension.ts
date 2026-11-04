/**
 * Management extensions: how another AppPort package adds pages, navigation, routes and the
 * capabilities they need to an AppPort Services host, without a second Services instance, FeltDB
 * instance, identity, authorization layer or UI shell.
 *
 * An extension is data plus two functions, registered once, in code, by the host:
 *
 *   const services = createServices({ db, authorizer, extensions: [notesExtension] });
 *   app.use(createManagementRouter({ services, authority: services.gateway, extensions: services.extensions, authenticate }));
 *
 * - **Capabilities** it declares join the gateway's manifest. They are authorized by the host's
 *   AuthBoundry authorizer and recorded as effect evidence exactly like the built-in services'.
 *   Their names are namespaced by the extension id and may not reuse a built-in name.
 * - **Routes** are mounted under `/v1/extensions/<id>` on the management router, behind the host's
 *   authentication adapter. They receive the host's FeltDB instance and gateway; an extension
 *   never opens a database or creates services of its own.
 * - **Pages** join the packaged management UI: a navigation entry, the `AppPort/ui/1`
 *   contribution, and a renderer script that draws into the same shell with the same helpers the
 *   built-in pages use. A page is served only to a caller the gateway allows every capability the
 *   page declares.
 *
 * There is no discovery, loading or execution of code from anywhere else: a host lists the
 * extensions it trusts, as it lists its other dependencies.
 */
import type { Router } from 'express';
import type { StateFirstDB } from '@feltdb/core';
import type { ServiceCapability, ServiceEffect } from '../authority/manifest.js';
import { getServiceCapability } from '../authority/manifest.js';
import type { ServiceGateway } from '../authority/gateway.js';

/** One operation an extension performs, authorized through the host's gateway. */
export interface ServicesExtensionCapability {
  /** `<extension id>.<name>`, e.g. `notes.read`. */
  readonly name: string;
  /** The operation it names, for evidence and AuthBoundry policy. */
  readonly operation: string;
  readonly effect: ServiceEffect;
  /** The resource type the capability applies to (`ServiceResource.type`). */
  readonly resource: string;
}

/** One management page an extension contributes. */
export interface ServicesExtensionPage {
  /** Unique among all pages; namespaced by the extension (`notes`, `notes-settings`). */
  readonly id: string;
  readonly title: string;
  /** Where the page is served, under the router: `/<extension id>` or `/<extension id>/…`. */
  readonly route: string;
  /** Place in the navigation (the built-in pages use 0–80). */
  readonly order: number;
  /** Shown on the overview. */
  readonly description: string;
  /** Every capability the page drives. The page is served only when all are allowed. */
  readonly capabilities: readonly string[];
  /**
   * The page's renderer, as a script the page includes before the shared page script. It
   * registers itself with `window.AppPortServicesPages[<page id>] = (ui) => node`, where `ui`
   * holds the shared helpers (`S`, `el`, `request`, `at`, `failureOf`, `config`). It is the
   * extension's own code, shipped in its package, never fetched or evaluated from data.
   */
  readonly script: string;
}

/** What the host gives an extension: its existing instances, nothing new. */
export interface ServicesExtensionContext {
  /** The host's FeltDB instance, the one every service uses. */
  readonly db: StateFirstDB;
  /** The host's Policy Enforcement Point: `authorize` and `execute` with the extension's capabilities. */
  readonly gateway: ServiceGateway;
  /** The application the host serves. */
  readonly application: string;
}

export interface ServicesExtension {
  /** Lowercase, `[a-z][a-z0-9-]{1,30}`; the namespace of its capabilities, routes and pages. */
  readonly id: string;
  readonly capabilities?: readonly ServicesExtensionCapability[];
  readonly pages?: readonly ServicesExtensionPage[];
  /** Mounts the extension's JSON routes. `router` is already under `/v1/extensions/<id>` and authenticated. */
  readonly routes?: (router: Router, context: ServicesExtensionContext) => void;
}

/** An extension as `createServices` registered it: bound to that host's instances. */
export interface RegisteredServicesExtension {
  readonly extension: ServicesExtension;
  readonly context: ServicesExtensionContext;
}

const ID = /^[a-z][a-z0-9-]{1,30}$/;
const SEGMENT = /^[a-z][a-z0-9_]*$/;
const MAX_SCRIPT = 256 * 1024;
/** Ids, routes and resources the built-in services use: an extension may not take them. */
const RESERVED_IDS = new Set(['overview', 'services', 'api-keys', 'webhooks', 'jobs', 'schedules', 'notifications', 'files', 'configuration', 'intelligence', 'secrets', 'extensions', 'v1', '_appport']);

export class ServicesExtensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServicesExtensionError';
  }
}

/** Checks an extension's declaration and returns it frozen. Throws `ServicesExtensionError` on the first problem. */
export function defineServicesExtension(extension: ServicesExtension): ServicesExtension {
  const fail = (message: string): never => { throw new ServicesExtensionError(`Extension "${String(extension?.id)}": ${message}`); };
  if (!extension || typeof extension.id !== 'string' || !ID.test(extension.id)) fail('id must match [a-z][a-z0-9-]{1,30}');
  if (RESERVED_IDS.has(extension.id)) fail('id is reserved by AppPort Services');
  const capabilities = extension.capabilities ?? [];
  const names = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability?.name !== 'string' || !capability.name.startsWith(`${extension.id}.`)) fail(`capability "${capability?.name}" must be named "${extension.id}.<name>"`);
    const rest = capability.name.slice(extension.id.length + 1);
    if (!rest.split('.').every((part) => SEGMENT.test(part))) fail(`capability "${capability.name}" has an invalid name`);
    if (getServiceCapability(capability.name)) fail(`capability "${capability.name}" is a built-in capability`);
    if (names.has(capability.name)) fail(`capability "${capability.name}" is declared twice`);
    if (capability.effect !== 'observation' && capability.effect !== 'consequential') fail(`capability "${capability.name}" needs an effect`);
    if (typeof capability.operation !== 'string' || !capability.operation) fail(`capability "${capability.name}" needs an operation`);
    if (typeof capability.resource !== 'string' || !SEGMENT.test(capability.resource)) fail(`capability "${capability.name}" needs a resource type`);
    names.add(capability.name);
  }
  const pageIds = new Set<string>();
  for (const page of extension.pages ?? []) {
    if (typeof page?.id !== 'string' || !(page.id === extension.id || page.id.startsWith(`${extension.id}-`)) || !ID.test(page.id)) fail(`page "${page?.id}" must be "${extension.id}" or "${extension.id}-<name>"`);
    if (pageIds.has(page.id)) fail(`page "${page.id}" is declared twice`);
    if (typeof page.route !== 'string' || !(page.route === `/${extension.id}` || page.route.startsWith(`/${extension.id}/`)) || !/^(\/[a-z0-9-]+)+$/.test(page.route)) fail(`page "${page.id}" route must be /${extension.id} or under it`);
    if (typeof page.title !== 'string' || !page.title.trim()) fail(`page "${page.id}" needs a title`);
    if (!Number.isFinite(page.order)) fail(`page "${page.id}" needs an order`);
    if (!Array.isArray(page.capabilities) || page.capabilities.length === 0) fail(`page "${page.id}" must declare the capabilities it drives`);
    for (const name of page.capabilities) if (!names.has(name)) fail(`page "${page.id}" uses "${name}", which the extension does not declare`);
    if (typeof page.script !== 'string' || !page.script.trim() || page.script.length > MAX_SCRIPT) fail(`page "${page.id}" needs a renderer script under ${MAX_SCRIPT} characters`);
    if (/<\/script/i.test(page.script)) fail(`page "${page.id}" script may not contain "</script"`);
    pageIds.add(page.id);
  }
  if (extension.routes !== undefined && typeof extension.routes !== 'function') fail('routes must be a function');
  return Object.freeze({
    ...extension,
    capabilities: Object.freeze(capabilities.map((c) => Object.freeze({ ...c }))),
    pages: Object.freeze((extension.pages ?? []).map((p) => Object.freeze({ ...p, capabilities: Object.freeze([...p.capabilities]) }))),
  });
}

/** Checks a set of extensions together: ids, capability names and page ids are unique across them. */
export function defineServicesExtensions(extensions: readonly ServicesExtension[]): readonly ServicesExtension[] {
  const defined = extensions.map(defineServicesExtension);
  const ids = new Set<string>();
  const pages = new Set<string>();
  for (const extension of defined) {
    if (ids.has(extension.id)) throw new ServicesExtensionError(`Extension "${extension.id}" is registered twice`);
    ids.add(extension.id);
    for (const page of extension.pages ?? []) {
      if (pages.has(page.id)) throw new ServicesExtensionError(`Page "${page.id}" is contributed twice`);
      pages.add(page.id);
    }
  }
  return defined;
}

/** The gateway capabilities an extension's declarations become. Not invocable through `invoke()`: extensions call `gateway.execute` from their routes. */
export function extensionCapabilities(extension: ServicesExtension): ServiceCapability[] {
  return (extension.capabilities ?? []).map((capability) => ({
    name: capability.name,
    version: 1,
    service: `extension:${extension.id}`,
    operation: capability.operation,
    effect: capability.effect,
    invocable: false,
    authorization: { required: true as const, resource: capability.resource },
  }));
}
