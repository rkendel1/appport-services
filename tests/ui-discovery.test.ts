import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';

import express from 'express';
import { validateUiContribution } from '@appport/protocol';

import {
  APPPORT_UI_CONTRIBUTIONS,
  createManagementRouter,
  createServices,
  createUiContribution,
  createUiDiscoveryDocument,
} from '../src/index.js';
import { TestAuthority } from './support/authority.js';
import { SERVICE_CAPABILITY_MANIFEST } from '../src/authority/manifest.js';

async function host(options: { includeUi?: boolean; includeConfiguration?: boolean } = {}) {
  const services = createServices({ memory: true, namespace: `ui-${crypto.randomUUID()}`, authorizer: new TestAuthority() });
  const app = express();
  app.use(createManagementRouter({
    services,
    authority: services.gateway,
    // No identity: discovery must not require one.
    authenticate: () => null,
    ...options,
  }));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return { services, server, base };
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('GET /v1/ui returns a valid AppPort/ui/1 document for the mounted surfaces, anonymously', async () => {
  const { server, base } = await host();
  try {
    const response = await fetch(`${base}/v1/ui`);
    assert.equal(response.status, 200);
    const document = await response.json() as Record<string, unknown>;
    // The protocol's own validator accepts it: one schema, owned by @appport/protocol.
    const validated = validateUiContribution(document);
    assert.equal(validated.protocol, 'AppPort/ui/1');
    assert.equal(validated.product.id, 'appport-services');
    assert.match(validated.product.version, /^\d+\.\d+\.\d+/);
    assert.deepEqual(validated.composition.requires, []);
    for (const surface of validated.surfaces) {
      // Every route is one the packaged pages serve, and every navigation entry points at a surface.
      const page = await fetch(`${base}${surface.route}`);
      assert.notEqual(page.status, 404, surface.route);
    }
    assert.deepEqual(
      validated.navigation.map((item) => item.surface).sort(),
      validated.surfaces.map((surface) => surface.id).sort(),
    );
    assert.ok(Array.isArray(document.capabilities));
  } finally { await stop(server); }
});

test('every capability a surface names is a real service capability', () => {
  const known = new Set(SERVICE_CAPABILITY_MANIFEST.map((capability) => capability.name));
  for (const contribution of APPPORT_UI_CONTRIBUTIONS) {
    for (const surface of contribution.surfaces) {
      for (const capability of surface.capabilities) assert.ok(known.has(capability), `${surface.id}: ${capability}`);
    }
  }
});

test('the exported contribution is valid and an invalid one is rejected by the same validator', () => {
  for (const contribution of APPPORT_UI_CONTRIBUTIONS) assert.deepEqual(validateUiContribution(contribution), contribution);
  const [valid] = APPPORT_UI_CONTRIBUTIONS;
  assert.throws(() => validateUiContribution({ ...valid, protocol: 'AppPort/ui/2' }), /Unsupported UI contribution protocol/);
  assert.throws(() => validateUiContribution({ ...valid, surfaces: [{ ...valid!.surfaces[0], route: 'https://evil.example/' }] }), /malformed route/);
  assert.throws(() => validateUiContribution({ ...valid, navigation: [{ id: 'x', label: 'x', group: 'g', order: 1, surface: 'nope' }] }), /unknown surface/);
});

test('only mounted services are described, and nothing mounted means no contribution', async () => {
  assert.equal(createUiContribution({}), undefined);
  assert.equal(createUiDiscoveryDocument({}), undefined);
  const keysOnly = createUiContribution({ apiKeys: true })!;
  assert.deepEqual(keysOnly.surfaces.map((surface) => surface.id), ['api-keys']);
  // Configuration pages are described only when they are served.
  const withoutConfiguration = createUiContribution({ apiKeys: true, configuration: true }, { includeConfiguration: false })!;
  assert.deepEqual(withoutConfiguration.surfaces.map((surface) => surface.id), ['api-keys']);
});

test('a host that serves no UI advertises none: 404, as the protocol server does', async () => {
  const { server, base } = await host({ includeUi: false });
  try {
    const response = await fetch(`${base}/v1/ui`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: { code: 'NOT_FOUND', message: 'No composable UI is advertised' } });
  } finally { await stop(server); }
});

test('discovery carries no secrets or credentials', async () => {
  const { server, base } = await host();
  try {
    const text = await (await fetch(`${base}/v1/ui`)).text();
    assert.doesNotMatch(text, /secret_hash|apikey_|Bearer|password/i);
  } finally { await stop(server); }
});
