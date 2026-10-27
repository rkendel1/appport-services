import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { VERSION, createUiContribution } from '../src/index.js';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
  exports: Record<string, unknown>;
  files: string[];
};

test('VERSION from the main entry is package.json version, so they cannot drift', () => {
  assert.equal(manifest.name, '@appport/services');
  assert.equal(typeof VERSION, 'string');
  assert.equal(VERSION, manifest.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
});

test('package.json exports ./package.json beside the main entry and the CLI', () => {
  assert.equal(manifest.exports['./package.json'], './package.json');
  assert.ok(manifest.exports['.'], 'the main entry is still exported');
  assert.ok(manifest.exports['./cli'], 'the CLI entry is still exported');
});

test('the UI contribution reports the same VERSION', () => {
  assert.equal(createUiContribution({ apiKeys: true })?.product.version, VERSION);
});

test('@appport/services/package.json resolves through the exports map (package self-reference)', async () => {
  const resolved = import.meta.resolve('@appport/services/package.json');
  assert.equal(resolved, new URL('../../package.json', import.meta.url).href);
  const specifier: string = '@appport/services/package.json';
  const { default: loaded } = await import(specifier, { with: { type: 'json' } }) as { default: { version: string } };
  assert.equal(loaded.version, VERSION);
});
