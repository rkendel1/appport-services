import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import vm from 'node:vm';

import express from 'express';

import { createConfigurationUiRouter } from '../src/_internal.js';
import { renderManagementPage } from '../src/configuration/ui.js';
import { createUiPages } from '../src/index.js';

// The packaged management pages are rendered in the browser from a page
// description the server sends; tests/browser/management-pages.browser.ts
// drives the rendered pages. These tests cover what the server sends.

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

interface PageDescription { page: string; navigation: Array<{ id: string; label: string; route: string; order: number }>; descriptions: Record<string, string> }
const describe = (html: string): PageDescription => {
  const match = /<script type="application\/json" id="appport-page">([^<]*)<\/script>/.exec(html);
  assert.ok(match, 'the page carries its description');
  return JSON.parse(match[1]) as PageDescription;
};

async function serve(app: express.Express): Promise<{ base: string; close(): Promise<void> }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('configuration UI serves a page for every service, each with the shared design system and its navigation', async () => {
  const app = express();
  app.use(createConfigurationUiRouter());
  const { base, close } = await serve(app);
  const all = createUiPages();
  try {
    assert.deepEqual(all.map((page) => page.route), [
      '/services', '/api-keys', '/webhooks', '/jobs', '/schedules', '/notifications', '/files', '/configuration', '/intelligence', '/secrets',
    ]);
    for (const page of all) {
      const response = await fetch(`${base}${page.route}`);
      assert.equal(response.status, 200, page.route);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html/);
      const html = await response.text();
      const description = describe(html);
      assert.equal(description.page, page.id);
      assert.deepEqual(description.navigation.map((item) => item.route), all.map((item) => item.route), `${page.route}: navigation lists every mounted page`);
      assert.ok(html.includes(read('vendor/stack-ui/stack-ui-core-stateless.js')), `${page.route}: the vendored design system is inlined unmodified`);
      assert.ok(html.includes(read('vendor/stack-ui/core.css')) && html.includes(read('vendor/stack-ui/tokens.css')), `${page.route}: its styles too`);
      assert.ok(html.includes(read('ui/management.js')), `${page.route}: and the page script`);
      assert.match(html, /<html lang="en">/);
      assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    }
    const overview = describe(await (await fetch(`${base}/services`)).text());
    for (const page of all.filter((entry) => entry.id !== 'overview')) {
      assert.ok(overview.descriptions[page.id], `the overview describes ${page.id}`);
    }
  } finally {
    await close();
  }
});

test('the navigation lists only the pages a host mounts, and unmounted pages are not served', async () => {
  const pages = createUiPages({ apiKeys: true, jobs: true });
  assert.deepEqual(pages.map((page) => page.route), ['/api-keys', '/jobs'], 'two pages need no overview');
  const app = express();
  app.use(createConfigurationUiRouter({ pages }));
  const { base, close } = await serve(app);
  try {
    assert.deepEqual(describe(await (await fetch(`${base}/jobs`)).text()).navigation.map((item) => item.route), ['/api-keys', '/jobs']);
    assert.equal((await fetch(`${base}/webhooks`)).status, 404);
    assert.equal((await fetch(`${base}/services`)).status, 404);
  } finally {
    await close();
  }
  const withoutConfiguration = createUiPages(undefined, { includeConfiguration: false }).map((page) => page.id);
  for (const id of ['configuration', 'intelligence', 'secrets']) assert.ok(!withoutConfiguration.includes(id), `${id} is not listed without configuration`);
});

test('the page description cannot end its script element', () => {
  const hostile = { id: 'x', title: '</script><script>window.owned = 1</script>', route: '/x', order: 1 };
  const html = renderManagementPage(hostile, [hostile]);
  assert.equal(html.split('</script>').length - 1, 3, 'exactly the three script elements the page has');
  assert.equal(describe(html).navigation[0].label, hostile.title, 'the text survives intact as data');
  assert.match(html, /<title>AppPort Services · &lt;\/script&gt;/);
});

test('the page scripts never parse markup, evaluate code, or use blocking browser dialogs', () => {
  const page = read('ui/management.js');
  const designSystem = read('vendor/stack-ui/stack-ui-core-stateless.js');
  for (const [name, source] of [['ui/management.js', page], ['stack-ui-core-stateless.js', designSystem]] as const) {
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|DOMParser|createContextualFragment/, `${name} parses or evaluates nothing`);
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${name} stores nothing`);
  }
  assert.doesNotMatch(page, /\b(?:window\.)?(?:confirm|prompt|alert)\(/, 'ConfirmAction and form dialogs replace the browser\'s confirm, prompt and alert');
  assert.doesNotThrow(() => new vm.Script(page, { filename: 'ui/management.js' }), 'the page script is valid script code');
});

test('the vendored design system matches its SHA256SUMS', () => {
  const sums = read('vendor/stack-ui/SHA256SUMS').trim().split('\n');
  assert.ok(sums.length >= 4);
  for (const line of sums) {
    const [digest, file] = line.split(/\s+/);
    const actual = createHash('sha256').update(readFileSync(new URL(`vendor/stack-ui/${file}`, root))).digest('hex');
    assert.equal(actual, digest, `vendor/stack-ui/${file}`);
  }
  assert.equal(read('vendor/stack-ui/VERSION').trim(), '0.3.0');
});
