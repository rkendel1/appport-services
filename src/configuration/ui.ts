import { readFileSync } from 'node:fs';

import { Router } from 'express';

import { createUiPages, type UiPage } from '../runtime/ui.js';

/**
 * The packaged management pages, on the shared Stack design system.
 *
 * Every page is one HTML document: the vendored design-system styles and
 * stateless classic script (`vendor/stack-ui`, checked against its
 * `SHA256SUMS`; it has no theme preference, so the pages keep nothing in
 * browser storage and follow the operating system's colour scheme), this
 * package's page styles and script (`ui/`), and a JSON description of the page
 * and its navigation. The navigation is the list of surfaces actually mounted,
 * so it never links to a page this host does not serve. The browser renders the
 * page with the design system's DOM helpers; nothing is parsed as markup.
 *
 * No route is added: the assets are inlined, and each page is served at the
 * route its surface declares, exactly as before.
 */

export interface ConfigurationUiOptions {
  /** The mounted pages, in navigation order. Defaults to every page this package can serve. */
  readonly pages?: readonly UiPage[];
  /**
   * Prefix for every URL the pages use: their API requests (`/_appport/...`,
   * `/v1/...`) and their navigation links. `''` (the default) keeps them
   * root-relative. A path (`/services-admin`) or an origin
   * (`https://services.example.com`, optionally with a path); no trailing slash.
   */
  readonly basePath?: string;
}

/** Validate and normalize a page `basePath`. Exported for the management router. */
export function normalizeBasePath(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string') throw new TypeError('basePath must be a string');
  const trimmed = value.replace(/\/+$/, '');
  if (trimmed === '') return '';
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    if (!/^(\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)+$/.test(trimmed)) throw new TypeError('basePath must be a URL path such as /services-admin');
    return trimmed;
  }
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new TypeError('basePath must be a path starting with / or an http(s) origin'); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
    throw new TypeError('basePath must be an http(s) origin with an optional path, and no credentials, query or fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** What each page is for, shown on the overview. */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  'api-keys': 'Application caller identities. AuthBoundry authorizes what they may do.',
  webhooks: 'Register durable event endpoints.',
  jobs: 'Queue durable work and retry failed records.',
  schedules: 'Create recurring work using plain English intervals.',
  notifications: 'Create and manage durable notifications.',
  files: 'Create and update durable file metadata.',
  configuration: 'Variables and secret references for each environment.',
  intelligence: 'Provider, model, endpoint and credential for AI features. Optional.',
  secrets: 'Provider-neutral secret metadata.',
};

interface Assets { readonly style: string; readonly designSystem: string; readonly page: string }
let assets: Assets | undefined;

/** The page assets, read once. Paths are relative to `dist/src/configuration/`. */
function loadAssets(): Assets {
  if (assets) return assets;
  const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
  assets = {
    style: [read('vendor/stack-ui/tokens.css'), read('vendor/stack-ui/core.css'), read('ui/management.css')].join('\n'),
    // The stateless build: these pages keep nothing in browser storage.
    designSystem: read('vendor/stack-ui/stack-ui-core-stateless.js'),
    page: read('ui/management.js'),
  };
  return assets;
}

/** JSON that is safe inside a <script> element: no `<`, and no line separators. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const escapeText = (value: string) => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** One management page. Exported for tests. */
export function renderManagementPage(page: UiPage, pages: readonly UiPage[], options: { readonly basePath?: string } = {}): string {
  const { style, designSystem, page: pageScript } = loadAssets();
  const title = page.id === 'overview' ? 'AppPort Services' : `AppPort Services · ${page.title}`;
  const basePath = normalizeBasePath(options.basePath);
  const description = {
    page: page.id,
    ...(basePath ? { basePath } : {}),
    navigation: pages.map(({ id, title: label, route, order }) => ({ id, label, route, order })),
    descriptions: DESCRIPTIONS,
  };
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${escapeText(title)}</title><style>${style}</style></head><body>`
    + `<noscript><p class="appport-noscript">The ${escapeText(page.title)} page needs JavaScript.</p></noscript>`
    + `<script type="application/json" id="appport-page">${scriptJson(description)}</script>`
    + `<script>${designSystem}</script><script>${pageScript}</script>`
    + '</body></html>';
}

export function createConfigurationUiRouter(options: ConfigurationUiOptions = {}): Router {
  const pages = options.pages ?? createUiPages();
  const basePath = normalizeBasePath(options.basePath);
  const router = Router();
  for (const page of pages) {
    router.get(page.route, (_req, res) => {
      res.type('html').send(renderManagementPage(page, pages, { basePath }));
    });
  }
  return router;
}
