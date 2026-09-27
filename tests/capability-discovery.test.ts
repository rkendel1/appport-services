import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { createServices } from '../src/index.js';

test('createServices exposes implementation-backed capability discovery', async () => {
  const services = createServices({ memory: true, namespace: `capabilities-${Math.random()}` });
  try {
    assert.equal(services.discovery.find((capability) => capability.id === 'apikeys')?.runtimeMounted, true);
    assert.equal(services.discovery.find((capability) => capability.id === 'configuration')?.runtimeMounted, true);
    assert.equal(services.discovery.find((capability) => capability.id === 'credentials')?.runtimeMounted, true);
    assert.equal(services.discovery.find((capability) => capability.id === 'secrets')?.runtimeMounted, false);
    assert.equal(services.discovery.find((capability) => capability.id === 'runtime-events')?.runtimeMounted, false);
  } finally {
    await services.apiKeys.close();
  }
});

test('docs/capabilities.json matches the exported discovery catalog', async () => {
  const services = createServices({ memory: true, namespace: `capabilities-docs-${Math.random()}` });
  try {
    const documented = JSON.parse(readFileSync(join(process.cwd(), 'docs/capabilities.json'), 'utf8')) as unknown;
    assert.deepEqual(documented, services.discovery);
  } finally {
    await services.apiKeys.close();
  }
});
