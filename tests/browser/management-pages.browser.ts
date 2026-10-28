// The packaged management pages in a real browser, against the standalone
// management host with a real durable deployment: the shared Stack shell with
// navigation built from the mounted surfaces, labelled fields, tables with one
// cell per header, ConfirmAction for destructive operations, a failed read
// shown as an error rather than an empty list, and axe in light and dark.
//
// Needs Chromium (CHROMIUM_PATH, or Playwright's). Run: npm run test:browser.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';

import { chromium, type Browser, type Page } from 'playwright-core';

import { runCli } from '../../src/cli.js';
import { startManagementHost, type ManagementHostRuntime } from '../../src/index.js';
import { TestAuthority } from '../support/authority.js';
import { MemoryCustody } from '../support/custody.js';

const chromiumPath = process.env.CHROMIUM_PATH ?? [chromium.executablePath()].find((path) => path && existsSync(path));
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const quiet = () => new Writable({ write(_chunk, _encoding, callback) { callback(); } });

async function deployment(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'appport-pages-'));
  assert.equal(await runCli(['init'], { stdout: quiet(), stderr: quiet() }, undefined, cwd), 0, 'init must succeed');
  const path = join(cwd, 'appport.toml');
  await writeFile(path, (await readFile(path, 'utf8'))
    .replace('port = 4100', 'port = 0')
    .replace('[lifecycle]\nmanaged = true', '[lifecycle]\nmanaged = false'));
  return cwd;
}

async function axe(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async () => (window as unknown as { axe: { run(context: Document, options: object): Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: string[]; any: Array<{ data?: { fgColor?: string; bgColor?: string; contrastRatio?: number } }> }> }> }> } }).axe.run(document, { resultTypes: ['violations'] }));
  return result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id} (${violation.impact}): ${violation.nodes.map((node) => {
      const data = node.any?.[0]?.data;
      return `${node.target.join(' ')}${data?.fgColor ? ` [${data.fgColor} on ${data.bgColor} = ${data.contrastRatio}]` : ''}`;
    }).join(', ')}`);
}

/** Waits until every list on the page has finished its first read. */
async function settled(page: Page): Promise<void> {
  await page.waitForSelector('.stack-shell__main');
  await page.waitForFunction(() => !document.querySelector('.stack-shell__main .stack-loading')
    && !document.querySelector('.stack-shell__main [aria-busy="true"]')
    && !/^Loading/.test(document.querySelector('.appport-summary')?.textContent ?? ''));
}

const operator = () => ({ principalId: 'operator@example.com', principalType: 'operator', tenantId: 'development' });

let browser: Browser;
let host: ManagementHostRuntime;
let authority: TestAuthority;

test.before(async () => {
  assert.ok(chromiumPath, 'Chromium is required; set CHROMIUM_PATH');
  browser = await chromium.launch({ executablePath: chromiumPath });
});
test.after(async () => {
  await browser?.close();
});
// A fresh host and deployment per test: the management router rate-limits each
// client (120 requests a minute), and a page load makes several requests.
test.beforeEach(async () => {
  authority = new TestAuthority({ allowAll: true });
  host = await startManagementHost({ cwd: await deployment(), port: 0, env: {}, authorizer: authority, identify: operator, installSignalHandlers: false, logger: () => {} });
});
test.afterEach(async () => {
  await host?.close();
});

async function open(path: string, options: { width?: number; colorScheme?: 'light' | 'dark' } = {}): Promise<{ page: Page; errors: string[]; close(): Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: options.width ?? 1280, height: 900 }, colorScheme: options.colorScheme ?? 'light' });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${host.url}${path}`);
  await settled(page);
  return { page, errors, close: () => context.close() };
}

test('every page: the shell lists exactly the mounted pages, marks this one, labels every field, and keeps one cell per header', async () => {
  for (const route of host.routes) {
    const { page, errors, close } = await open(route);
    try {
      const nav = page.getByRole('navigation', { name: 'AppPort Services navigation' });
      const links = await nav.locator('a').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href')));
      assert.deepEqual([...links].sort(), [...host.routes].sort(), `${route}: navigation is the mounted routes`);
      const current = await nav.locator('[aria-current="page"]').evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href')));
      assert.deepEqual(current, [route], `${route}: exactly this page is current`);
      assert.equal(await page.locator('h1').count(), 1, `${route}: one page heading`);
      const unlabelled = await page.locator('.stack-shell__main input, .stack-shell__main select, .stack-shell__main textarea').evaluateAll((controls) => controls
        .filter((control) => {
          const labels = (control as HTMLInputElement).labels;
          return !labels || labels.length !== 1 || !labels[0].textContent?.trim();
        })
        .map((control) => control.getAttribute('name')));
      assert.deepEqual(unlabelled, [], `${route}: every control has exactly one visible label of its own`);
      const duplicates = await page.evaluate(() => {
        const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
        return ids.filter((id, index) => ids.indexOf(id) !== index);
      });
      assert.deepEqual(duplicates, [], `${route}: ids are unique`);
      const shapes = await page.locator('.stack-table__table').evaluateAll((tables) => tables.map((table) => ({
        headers: table.querySelectorAll('thead th').length,
        rows: Array.from(table.querySelectorAll('tbody tr')).map((row) => row.children.length),
      })));
      for (const shape of shapes) for (const cells of shape.rows) assert.equal(cells, shape.headers, `${route}: one cell per header`);
      assert.deepEqual(errors, [], `${route}: no script errors`);
    } finally {
      await close();
    }
  }
});

test('API keys: create shows the secret once; revoking needs the typed key name, then the key leaves the list', async () => {
  const { page, errors, close } = await open('/api-keys');
  try {
    const form = page.getByRole('form', { name: 'Create API key' });
    await form.getByLabel('Key name').fill('ci-deployer');
    await form.getByRole('button', { name: 'Create API key' }).click();
    const created = page.locator('.appport-create .appport-outcome__ok');
    await page.waitForFunction(() => /Copy this secret now/.test(document.querySelector('.appport-create .appport-outcome__ok')?.textContent ?? ''));
    assert.match(await created.innerText(), /Copy this secret now/);
    assert.ok((await created.locator('code').innerText()).length > 10, 'the secret is shown');
    const row = page.locator('tr[data-key="ci-deployer"]');
    await row.waitFor();
    assert.equal(await row.locator('.stack-status').getAttribute('data-field'), 'appport.api_key.revoked');
    assert.equal((await row.locator('.stack-status__label').innerText()).trim(), 'Active');

    await row.getByRole('button', { name: 'Revoke ci-deployer' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Revoke API key ci-deployer?' });
    await dialog.waitFor();
    assert.equal(await dialog.evaluate((element) => (element as HTMLDialogElement).matches(':modal')), true);
    const confirm = dialog.getByRole('button', { name: 'Revoke API key' });
    assert.equal(await confirm.isDisabled(), true, 'the name must be typed first');
    await dialog.getByLabel('Type ci-deployer to confirm').fill('ci-deployer');
    await confirm.click();
    await dialog.waitFor({ state: 'detached' });
    // The product's list holds active keys only: the revoked key is gone, and
    // focus moves to the outcome rather than being lost with the row.
    await row.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('appport-outcome__ok')), true);
    assert.match(await page.locator('.appport-outcome__ok').last().innerText(), /Revoked ci-deployer/);
    await page.getByRole('heading', { name: 'No API keys yet' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test('API keys: restricted create, edit, rotate with a one-time secret, audit, and revoke all', async () => {
  const { page, errors, close } = await open('/api-keys');
  try {
    const form = page.getByRole('form', { name: 'Create API key' });
    await form.getByLabel('Key name').fill('reporting');
    await form.getByLabel('Permissions').selectOption('restricted');
    await form.getByLabel('Allowed capabilities').fill('files.read, jobs.create');
    await form.getByRole('button', { name: 'Create API key' }).click();
    await page.waitForFunction(() => /Copy this secret now/.test(document.querySelector('.appport-create .appport-outcome__ok')?.textContent ?? ''));
    const firstSecret = await page.locator('.appport-create .appport-outcome__ok code').innerText();
    const row = page.locator('tr[data-key="reporting"]');
    await row.waitFor();
    assert.match(await row.innerText(), /files\.read, jobs\.create/);

    // Edit in a dialog: rename and lift the ceiling.
    await row.getByRole('button', { name: 'Edit reporting' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit API key reporting' });
    await edit.waitFor();
    await edit.getByLabel('Key name').fill('reporting-2');
    await edit.getByLabel('Permissions').selectOption('unrestricted');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await edit.waitFor({ state: 'detached' });
    const renamed = page.locator('tr[data-key="reporting-2"]');
    await renamed.waitFor();
    assert.match(await renamed.innerText(), /No ceiling/);

    // Rotate: the new secret is shown once, and differs from the first.
    await renamed.getByRole('button', { name: 'Rotate reporting-2' }).click();
    const rotate = page.getByRole('dialog', { name: 'Rotate API key reporting-2' });
    await rotate.waitFor();
    await rotate.getByRole('button', { name: 'Rotate API key' }).click();
    await rotate.waitFor({ state: 'detached' });
    const outcome = page.locator('.appport-outcome__ok').filter({ hasText: 'Rotated reporting-2' });
    await outcome.waitFor();
    const rotatedSecret = await outcome.locator('code').innerText();
    assert.ok(rotatedSecret.startsWith('app_live_') && rotatedSecret !== firstSecret);
    // The replaced key is revoked (no overlap) and leaves the list; its replacement is listed.
    await page.waitForFunction(() => document.querySelectorAll('tr[data-key="reporting-2"]').length === 1);
    const replacement = page.locator('tr[data-key="reporting-2"]');
    assert.equal(await replacement.getByRole('button', { name: 'Rotate reporting-2' }).count(), 1);

    // Audit for the replacement, without any secret on the page outside the one outcome line.
    await replacement.getByRole('button', { name: 'Audit reporting-2' }).click();
    await page.getByRole('heading', { name: 'Audit for reporting-2' }).waitFor();
    await page.locator('table').filter({ hasText: 'api_key.created' }).waitFor();
    const pageText = await page.locator('.stack-shell__main').innerText();
    assert.equal(pageText.split(rotatedSecret).length - 1, 1, 'the secret appears once, in the outcome');
    assert.equal(pageText.includes(firstSecret), false, 'the replaced secret is no longer shown');

    // Revoke all, with typed confirmation.
    await page.getByRole('button', { name: 'Revoke all API keys' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Revoke every API key of this tenant?' });
    await dialog.waitFor();
    await dialog.getByLabel('Type revoke all to confirm').fill('revoke all');
    await dialog.getByRole('button', { name: 'Revoke all API keys' }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: 'No API keys yet' }).waitFor();
    assert.deepEqual(await axe(page), []);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test('configuration: add, edit in a dialog, and delete with typed confirmation', async () => {
  const { page, errors, close } = await open('/configuration');
  try {
    const form = page.getByRole('form', { name: 'Add variable' });
    await form.getByLabel('Name').fill('DATABASE_URL');
    await form.getByLabel('Value').fill('postgres://one');
    await form.getByRole('button', { name: 'Add variable' }).click();
    const row = page.locator('tr[data-variable="DATABASE_URL"]');
    await row.waitFor();
    assert.match(await row.innerText(), /postgres:\/\/one/);

    await row.getByRole('button', { name: 'Edit DATABASE_URL' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit DATABASE_URL' });
    await edit.waitFor();
    await edit.getByLabel('Value').fill('postgres://two');
    await edit.getByLabel('Value').press('Enter');
    await edit.waitFor({ state: 'detached' });
    await page.waitForFunction(() => /postgres:\/\/two/.test(document.querySelector('tr[data-variable="DATABASE_URL"]')?.textContent ?? ''));

    await row.getByRole('button', { name: 'Delete DATABASE_URL' }).click();
    const remove = page.getByRole('alertdialog', { name: 'Delete DATABASE_URL?' });
    await remove.waitFor();
    await remove.getByLabel('Type DATABASE_URL to confirm').fill('DATABASE_URL');
    await remove.getByRole('button', { name: 'Delete variable' }).click();
    await remove.waitFor({ state: 'detached' });
    await row.waitFor({ state: 'detached' });
    await page.getByRole('heading', { name: 'No variables yet' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test('secrets: the masked Set value form stores through the host custody, is cleared, and never shows the value', async () => {
  // This test needs a host whose custody can store: replace the default one.
  await host.close();
  const custody = new MemoryCustody('local encrypted vault');
  host = await startManagementHost({ cwd: await deployment(), port: 0, env: {}, authorizer: authority, identify: operator, credentials: custody, installSignalHandlers: false, logger: () => {} });
  const value = 'Xq9Zk2LeakCanary-browser-sk-test-0123456789abcdef';
  const { page, errors, close } = await open('/secrets');
  try {
    const form = page.getByRole('form', { name: 'Set value' });
    const valueField = form.locator('input[name="value"]');
    assert.equal(await form.getByLabel('Value', { exact: false }).count(), 1, 'the value field is labelled');
    assert.equal(await valueField.getAttribute('type'), 'password');
    assert.equal(await valueField.getAttribute('autocomplete'), 'new-password');
    await form.getByLabel('Credential reference').fill('credential-ref:anthropic');
    await valueField.fill(value);
    await form.getByLabel('Binding name (optional)').fill('ANTHROPIC_API_KEY');
    await form.getByRole('button', { name: 'Set value' }).click();
    const row = page.locator('tr[data-secret="ANTHROPIC_API_KEY"]');
    await row.waitFor();
    await page.waitForFunction(() => /Set/.test(document.querySelector('tr[data-secret="ANTHROPIC_API_KEY"]')?.textContent ?? ''));
    assert.match(await row.innerText(), /credential-ref:anthropic/);
    assert.match(await row.innerText(), /version 1/);
    assert.match(await row.innerText(), /local encrypted vault/);
    assert.match(await page.locator('.appport-outcome__ok').allInnerTexts().then((texts) => texts.join(' ')), /Stored a new value for credential-ref:anthropic \(version 1\) and bound it as ANTHROPIC_API_KEY/);
    assert.equal(custody.peek('development', 'anthropic'), value, 'the host custody holds the value');

    // The value is gone from the page: the field, the markup, and every control.
    assert.equal(await valueField.inputValue(), '');
    const everything = await page.evaluate(() => document.documentElement.outerHTML + Array.from(document.querySelectorAll('input, textarea')).map((control) => (control as HTMLInputElement).value).join('\n'));
    assert.equal(everything.includes(value), false);
    assert.equal(everything.includes(value.slice(0, 10)), false);

    // "Set value" on a row prefills the reference and binding and focuses the value.
    await row.getByRole('button', { name: 'Set value ANTHROPIC_API_KEY' }).click();
    assert.equal(await form.getByLabel('Credential reference').inputValue(), 'credential-ref:anthropic');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name), 'value');

    // A refused value (a reference) is reported, and the field is cleared anyway.
    await valueField.fill('credential-ref:not-a-value');
    await form.getByRole('button', { name: 'Set value' }).click();
    await page.getByText('credential reference, not credential material', { exact: false }).waitFor();
    assert.equal(await valueField.inputValue(), '');
    assert.deepEqual(await axe(page), []);
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test('jobs: invalid JSON is caught before sending; a queued job shows its mapped status', async () => {
  const { page, errors, close } = await open('/jobs');
  try {
    const form = page.getByRole('form', { name: 'Queue job' });
    await form.getByLabel('Job type').fill('invoice.process');
    await form.getByLabel('Payload JSON').fill('{not json');
    await form.getByRole('button', { name: 'Queue job' }).click();
    const problem = page.getByRole('alert');
    await problem.waitFor();
    assert.match(await problem.innerText(), /not valid JSON/);
    assert.equal(await page.locator('tr[data-job]').count(), 0, 'nothing was queued');

    await form.getByLabel('Payload JSON').fill('[1, 2]');
    await form.getByRole('button', { name: 'Queue job' }).click();
    await page.waitForFunction(() => /must be a JSON object/.test(document.querySelector('[role="alert"]')?.textContent ?? ''));
    assert.equal(await page.locator('tr[data-job]').count(), 0, 'an array is refused too');

    await form.getByLabel('Payload JSON').fill('{"invoice": 7}');
    await form.getByRole('button', { name: 'Queue job' }).click();
    const row = page.locator('tr[data-job="invoice.process"]');
    await row.waitFor();
    assert.equal(await row.locator('.stack-status').getAttribute('data-field'), 'appport.job.status');
    assert.notEqual(await row.locator('.stack-status').getAttribute('data-tone'), 'unknown', 'the job status is a mapped value');
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test('intelligence: the endpoint field appears only for a custom endpoint, and a save shows what the product stored', async () => {
  const { page, errors, close } = await open('/intelligence');
  try {
    await page.waitForFunction(() => /Not configured/.test(document.querySelector('.appport-summary')?.textContent ?? ''));
    const form = page.getByRole('form', { name: 'Intelligence configuration' });
    await form.getByLabel('Provider').selectOption('ollama');
    const endpoint = form.getByLabel('Custom endpoint URL');
    assert.equal(await endpoint.isVisible(), false, 'the default endpoint needs no URL');
    await form.getByLabel('Endpoint', { exact: true }).selectOption('custom');
    assert.equal(await endpoint.isVisible(), true);
    assert.equal(await endpoint.evaluate((input) => (input as HTMLInputElement).required), true);
    await form.getByLabel('Endpoint', { exact: true }).selectOption('default');
    await form.getByRole('combobox', { name: 'Model', exact: true }).fill('llama3');
    await form.getByRole('button', { name: 'Save' }).click();
    await page.waitForFunction(() => /Configured: ollama \/ llama3/.test(document.querySelector('.appport-summary')?.textContent ?? ''));
    assert.deepEqual(errors, []);
  } finally {
    await close();
  }
});

test('a failed read is an error with Retry, never an empty list', async () => {
  authority.mode = 'unavailable';
  const { page, errors, close } = await open('/webhooks');
  try {
    const failure = page.getByRole('alert');
    await failure.waitFor();
    assert.match(await failure.innerText(), /Webhook endpoints could not be read/);
    assert.equal(await page.getByText('No webhooks yet').count(), 0, 'a failure is not shown as "none"');
    authority.mode = 'allow-all';
    await failure.getByRole('button', { name: 'Retry' }).click();
    await page.getByRole('heading', { name: 'No webhooks yet' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    authority.mode = 'allow-all';
    await close();
  }
});

test('the pages follow the operating system\'s colour scheme and keep nothing in browser storage', async () => {
  const light = await open('/services', { colorScheme: 'light' });
  const dark = await open('/services', { colorScheme: 'dark' });
  try {
    const background = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(await background(dark.page), await background(light.page), 'a dark system gives a dark page');
    assert.equal(await light.page.locator('select[id$="-theme"]').count(), 0, 'no theme control: there is no stored preference to set');
    const stored = await light.page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }));
    assert.deepEqual(stored, { local: 0, session: 0 });
  } finally {
    await light.close();
    await dark.close();
  }
});

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [1280, 640]) {
    test(`axe on every page (${colorScheme}, ${width}px), with no page-level horizontal scroll`, async () => {
      for (const route of host.routes) {
        const { page, close } = await open(route, { width, colorScheme });
        try {
          assert.deepEqual(await axe(page), [], `axe on ${route}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(overflow <= 0, `${route} at ${width}px scrolls sideways by ${overflow}px`);
        } finally {
          await close();
        }
      }
    });
  }
}

test('a confirm dialog and a form dialog pass axe', async () => {
  const { page, close } = await open('/files');
  try {
    const form = page.getByRole('form', { name: 'Create file record' });
    await form.getByLabel('File name').fill('report.pdf');
    await form.getByLabel('Storage key').fill('s3://bucket/report.pdf');
    await form.getByLabel('Size in bytes').fill('2048');
    await form.getByRole('button', { name: 'Create file record' }).click();
    const row = page.locator('tr[data-file="report.pdf"]');
    await row.waitFor();
    for (const [button, role, name] of [['Rename report.pdf', 'dialog', 'Rename report.pdf'], ['Delete report.pdf', 'alertdialog', 'Delete the file record report.pdf?']] as const) {
      await row.getByRole('button', { name: button }).click();
      const dialog = page.getByRole(role, { name });
      await dialog.waitFor();
      await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
      assert.deepEqual(await axe(page), [], `${name} dialog`);
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
    }
  } finally {
    await close();
  }
});
