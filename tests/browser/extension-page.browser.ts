// A management extension's page in a real browser: drawn by its own renderer inside the host's
// Stack shell, listed in the host navigation next to the built-in pages, driving its routes
// through the host's request helper, with no script errors and axe clean in light and dark.
//
// Needs Chromium (CHROMIUM_PATH, or Playwright's). Run: npm run test:browser.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import express from 'express';
import { createFeltDB } from '@feltdb/core';
import { chromium, type Browser } from 'playwright-core';

import { createManagementRouter, createServices, defineServicesExtension } from '../../src/index.js';
import { TestAuthority } from '../support/authority.js';
import { NOTES_COLLECTION, notesExtension } from '../support/notes-extension.js';

const chromiumPath = process.env.CHROMIUM_PATH ?? [chromium.executablePath()].find((path) => path && existsSync(path));
// An id that is also an Object.prototype property: the shell must still dispatch to the extension's renderer.
const constructorExtension = defineServicesExtension({
  id: 'constructor',
  capabilities: [{ name: 'constructor.read', operation: 'read', effect: 'observation', resource: 'constructor_item' }],
  pages: [{
    id: 'constructor', title: 'Constructor', route: '/constructor', order: 95, description: 'A page whose id is an Object.prototype name.', capabilities: ['constructor.read'],
    script: "window.AppPortServicesPages = window.AppPortServicesPages || {}; window.AppPortServicesPages['constructor'] = function (ui) { return ui.el('section', { 'data-extension-page': 'constructor' }, [ui.el('h1', {}, 'Constructor')]); };",
  }],
});
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

test('an extension page renders in the host shell, is in the navigation, writes through the host, and passes axe', async () => {
  assert.ok(chromiumPath, 'Chromium is required; set CHROMIUM_PATH');
  const db = createFeltDB({ namespace: `ext-browser-${crypto.randomUUID()}`, memory: true } as never);
  const services = createServices({ db, authorizer: new TestAuthority({ allowAll: true }), extensions: [notesExtension, constructorExtension] });
  const app = express();
  app.use(createManagementRouter({
    services,
    authority: services.gateway,
    extensions: services.extensions,
    authenticate: () => ({ principalId: 'operator@example.com', principalType: 'host_session', tenantId: 'tenant-a' }),
    includeConfiguration: false,
  }));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const browser: Browser = await chromium.launch({ executablePath: chromiumPath });
  try {
    for (const colorScheme of ['light', 'dark'] as const) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}/notes`);
      await page.waitForSelector('.stack-shell__main [data-extension-page="notes"]');

      const nav = page.getByRole('navigation', { name: 'AppPort Services navigation' });
      const links = await nav.locator('a:not(.stack-shell__switcher a)').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')));
      assert.ok(links.includes('/notes') && links.includes('/api-keys'), `extension and built-in pages share the navigation: ${links.join(', ')}`);
      assert.deepEqual(await nav.locator('[aria-current="page"]').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href'))), ['/notes']);
      assert.equal(await page.locator('h1').count(), 1);

      const text = `note in ${colorScheme}`;
      await page.getByLabel('Note').fill(text);
      await page.getByRole('button', { name: 'Add note' }).click();
      await page.locator('[data-notes] li', { hasText: text }).waitFor();
      const stored = await db.collection<{ text: string; tenantId: string; createdBy: string }>(NOTES_COLLECTION).find({ text });
      assert.deepEqual(stored.map((n) => [n.tenantId, n.createdBy]), [['tenant-a', 'operator@example.com']], 'written to the host FeltDB as the host identity');

      await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async () => {
        const result = await (window as unknown as { axe: { run(d: Document, o: object): Promise<{ violations: Array<{ id: string; impact: string }> }> } }).axe.run(document, { resultTypes: ['violations'] });
        return result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);
      });
      assert.deepEqual(violations, [], `axe (${colorScheme})`);
      assert.deepEqual(errors, [], 'no script errors');
      await context.close();
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/constructor`);
    await page.waitForSelector('.stack-shell__main [data-extension-page="constructor"]');
    assert.deepEqual(errors, [], 'an Object.prototype name as page id renders its own page');
    await context.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await services.apiKeys.close();
  }
});
