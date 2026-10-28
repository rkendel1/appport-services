import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import vm from 'node:vm';

import express from 'express';

import { createManagementRouter, createServices } from '../src/index.js';
import { normalizeBasePath, renderManagementPage } from '../src/configuration/ui.js';
import { createUiPages } from '../src/runtime/ui.js';
import { TestAuthority } from './support/authority.js';

const PAGE_SCRIPT = readFileSync(new URL('../../ui/management.js', import.meta.url), 'utf8');

/** The page description the server embeds for the browser script. */
function description(html: string): { page: string; basePath?: string; navigation: Array<{ route: string }> } {
  const match = /<script type="application\/json" id="appport-page">(.*?)<\/script>/s.exec(html);
  assert.ok(match, 'the page embeds its description');
  return JSON.parse(match[1]!.replace(/\\u003c/g, '<'));
}

/**
 * Run the packaged page script against a minimal DOM and StackUI stub, and
 * record the URLs it fetches and links to. No browser is needed to see which
 * URLs the script builds.
 */
async function runPage(config: unknown): Promise<{ fetched: string[]; links: string[] }> {
  const fetched: string[] = [];
  const links: string[] = [];
  const node = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {
      setAttribute: (name: string, value: string) => { if (name === 'href') links.push(value); },
      append: () => undefined, prepend: () => undefined, replaceChildren: () => undefined, addEventListener: () => undefined,
      querySelectorAll: () => [], closest: () => self, classList: { add: () => undefined, remove: () => undefined }, style: {}, dataset: {},
    };
    return self;
  };
  const component = (props?: { href?: string; homeHref?: string; product?: { homeHref?: string }; navigation?: Array<{ href: string }> }) => {
    if (props?.product?.homeHref) links.push(props.product.homeHref);
    for (const item of props?.navigation ?? []) links.push(item.href);
    return node();
  };
  const stackUi = { dom: new Proxy({}, { get: () => component }), formatTime: String, confirmAction: async () => false };
  const document = {
    getElementById: () => ({ textContent: JSON.stringify(config) }),
    createElement: node, createTextNode: node, querySelectorAll: () => [], body: node(),
  };
  const context = vm.createContext({
    window: { StackUI: stackUi }, document, console,
    fetch: async (url: string) => { fetched.push(url); return { status: 200, ok: true, json: async () => [] }; },
    setTimeout, clearTimeout, URLSearchParams, Promise, JSON, Object, Array, Error, Date, Number, String, Boolean, Math, Set, Map,
  });
  vm.runInContext(PAGE_SCRIPT, context);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return { fetched, links };
}

test('normalizeBasePath accepts paths and http(s) origins and refuses anything else', () => {
  assert.equal(normalizeBasePath(undefined), '');
  assert.equal(normalizeBasePath(''), '');
  assert.equal(normalizeBasePath('/'), '');
  assert.equal(normalizeBasePath('/services-admin/'), '/services-admin');
  assert.equal(normalizeBasePath('/a/b'), '/a/b');
  assert.equal(normalizeBasePath('https://services.example.com'), 'https://services.example.com');
  assert.equal(normalizeBasePath('https://services.example.com/admin/'), 'https://services.example.com/admin');
  for (const bad of ['//evil.example.com', 'javascript:alert(1)', 'services', 'https://user:pass@example.com', 'https://example.com/?q=1', '/a b', '/a"b', 42]) {
    assert.throws(() => normalizeBasePath(bad), TypeError, String(bad));
  }
});

test('without basePath the page description is unchanged and the script fetches root-relative paths', async () => {
  const pages = createUiPages();
  const jobs = pages.find((page) => page.id === 'jobs')!;
  const config = description(renderManagementPage(jobs, pages));
  assert.equal('basePath' in config, false);
  const { fetched, links } = await runPage(config);
  assert.deepEqual(fetched, ['/_appport/jobs']);
  assert.ok(links.includes('/jobs') && links.every((link) => link.startsWith('/') || link === '#'));
});

test('with basePath every request and navigation link of the pages is prefixed', async () => {
  const pages = createUiPages();
  for (const basePath of ['/services-admin', 'https://services.example.com']) {
    const jobs = description(renderManagementPage(pages.find((page) => page.id === 'jobs')!, pages, { basePath }));
    assert.equal(jobs.basePath, basePath);
    const ran = await runPage(jobs);
    assert.deepEqual(ran.fetched, [`${basePath}/_appport/jobs`]);
    assert.ok(ran.links.length > 0 && ran.links.every((link) => link.startsWith(`${basePath}/`)), ran.links.join(','));

    const configuration = description(renderManagementPage(pages.find((page) => page.id === 'configuration')!, pages, { basePath }));
    const configurationRun = await runPage(configuration);
    assert.ok(configurationRun.fetched.length > 0, 'the configuration page reads on load');
    assert.ok(configurationRun.fetched.every((url) => url.startsWith(`${basePath}/v1/configuration`)), configurationRun.fetched.join(','));
  }
});

test('createManagementRouter({ basePath }) serves pages that prefix their requests; routes do not move', async () => {
  const services = createServices({ memory: true, namespace: `base-path-${crypto.randomUUID()}`, authorizer: new TestAuthority({ allowAll: true }) });
  assert.throws(() => createManagementRouter({ services, authority: services.gateway, authenticate: () => null, basePath: '//evil.example.com' }), TypeError);
  const app = express();
  app.use('/services-admin', createManagementRouter({ services, authority: services.gateway, authenticate: () => null, basePath: '/services-admin' }));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    const page = await fetch(`${base}/services-admin/services`);
    assert.equal(page.status, 200);
    assert.equal(description(await page.text()).basePath, '/services-admin');
    assert.equal((await fetch(`${base}/services-admin/v1/ui`)).status, 200, 'discovery is served where the router is mounted');
    assert.equal((await fetch(`${base}/services-admin/_appport/jobs`)).status, 401, 'the API the pages call is at the prefixed path');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await services.apiKeys.close();
  }
});
