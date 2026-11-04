// Management extensions: another package's pages, routes and capabilities in this host, with the
// host's FeltDB instance, identity, authorization and UI shell, and no change without them.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import express from 'express';
import { createFeltDB } from '@feltdb/core';
import {
  APPPORT_UI_CONTRIBUTIONS,
  SERVICE_CAPABILITY_MANIFEST,
  ServicesExtensionError,
  createManagementRouter,
  createServices,
  createUiContribution,
  createUiPages,
  defineServicesExtension,
  type PrincipalClaims,
} from '../src/index.js';
import { TestAuthority } from './support/authority.js';
import { NOTES_COLLECTION, notesExtension } from './support/notes-extension.js';

const principals: Record<string, PrincipalClaims> = {
  alice: { principalId: 'alice', principalType: 'host_session', tenantId: 'tenant-a' },
  reader: { principalId: 'reader', principalType: 'host_session', tenantId: 'tenant-a' },
  nobody: { principalId: 'nobody', principalType: 'host_session', tenantId: 'tenant-a' },
  bob: { principalId: 'bob', principalType: 'host_session', tenantId: 'tenant-b' },
};

function authority(permissions: Record<string, readonly string[]>): TestAuthority {
  const authorizer = new TestAuthority();
  for (const [subject, capabilities] of Object.entries(permissions)) for (const capability of capabilities) void authorizer.grant({ subject, capability });
  return authorizer;
}

async function host(options: { extensions?: boolean } = {}) {
  const db = createFeltDB({ namespace: `extensions-${crypto.randomUUID()}`, memory: true } as never);
  const services = createServices({
    db,
    authorizer: authority({ alice: ['notes.read', 'notes.write', 'apikeys.read', 'apikeys.create', 'apikeys.revoke'], reader: ['notes.read'], bob: ['notes.read', 'notes.write'] }),
    ...(options.extensions === false ? {} : { extensions: [notesExtension] }),
  });
  const app = express();
  app.use(createManagementRouter({
    services,
    authority: services.gateway,
    extensions: services.extensions,
    authenticate: (request) => principals[String(request.headers['x-test-principal'])] ?? null,
    includeConfiguration: false,
  }));
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const call = (path: string, as: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { 'x-test-principal': as, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  return {
    db, services, base, call,
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await services.apiKeys.close();
    },
  };
}

const pageConfig = (html: string) => JSON.parse(/<script type="application\/json" id="appport-page">(.*?)<\/script>/s.exec(html)![1]!);

test('1-2: the extension registers a page, served in the host shell, and the host lists it in its navigation and UI contribution', async () => {
  const h = await host();
  try {
    const page = await h.call('/notes', 'alice');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /window\.AppPortServicesPages\['notes'\]/, 'the extension renderer is included');
    assert.ok(html.indexOf("AppPortServicesPages['notes']") < html.indexOf('const PAGES = {'), 'the renderer registers before the shared page script draws the shell');
    const config = pageConfig(html);
    assert.equal(config.page, 'notes');
    assert.ok(config.navigation.some((n: { id: string; route: string }) => n.id === 'notes' && n.route === '/notes'));
    assert.ok(config.navigation.some((n: { id: string }) => n.id === 'api-keys'), 'built-in pages stay in the same navigation');
    assert.equal(config.descriptions.notes, 'Notes for this tenant (an example extension).');
    const contribution = createUiContribution({ apiKeys: true }, { includeConfiguration: false, extensions: [notesExtension] })!;
    assert.deepEqual(contribution.surfaces.find((s) => s.id === 'notes'), { id: 'notes', title: 'Notes', route: '/notes', capabilities: ['notes.read', 'notes.write'] });
    assert.ok(contribution.navigation.some((n) => n.surface === 'notes'));
    // The built-in pages do not carry the extension's script.
    const builtIn = await (await h.call('/api-keys', 'alice')).text();
    assert.doesNotMatch(builtIn, /AppPortServicesPages\['notes'\]/);
    assert.ok(pageConfig(builtIn).navigation.some((n: { id: string }) => n.id === 'notes'));
  } finally {
    await h.close();
  }
});

test('3: the host enforces the declared capabilities: page needs all of them, each route its own, refusals are recorded evidence', async () => {
  const h = await host();
  try {
    assert.equal((await h.call('/notes', 'nobody')).status, 403, 'no notes capability: the page is refused');
    assert.equal((await h.call('/notes', 'reader')).status, 403, 'the page drives read and write: read alone is not enough');
    assert.equal((await h.call('/notes', 'someone-unknown')).status, 401, 'no host identity');
    assert.equal((await h.call('/v1/extensions/notes', 'reader')).status, 200, 'read is allowed for the read route');
    const denied = await h.call('/v1/extensions/notes', 'reader', { method: 'POST', body: JSON.stringify({ text: 'x' }) });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'DENIED');
    assert.equal((await h.call('/v1/extensions/notes', 'nobody')).status, 403);
    const evidence = await h.db.collection<{ capability: string; decision: string; principalId: string }>('service_effect_evidence').find({ capability: 'notes.write' });
    assert.ok(evidence.some((e) => e.principalId === 'reader' && e.decision === 'deny'), 'the refusal is in the host evidence store');
  } finally {
    await h.close();
  }
});

test('4: the extension uses the host FeltDB instance and identity; tenants stay apart; effects are recorded evidence', async () => {
  const h = await host();
  try {
    assert.equal(h.services.extensions.length, 1);
    assert.equal(h.services.extensions[0]!.context.db, h.db, 'the host instance, not a new one');
    assert.equal(h.services.extensions[0]!.context.gateway, h.services.gateway);
    assert.ok(h.services.usesInstance(h.db) && !h.services.ownsDb);
    const created = await h.call('/v1/extensions/notes', 'alice', { method: 'POST', body: JSON.stringify({ text: 'first' }) });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).note.createdBy, 'alice', 'identity from the host authentication adapter');
    const stored = await h.db.collection<{ text: string; tenantId: string }>(NOTES_COLLECTION).find({});
    assert.deepEqual(stored.map((n) => [n.text, n.tenantId]), [['first', 'tenant-a']]);
    assert.deepEqual((await (await h.call('/v1/extensions/notes', 'alice')).json()).notes.map((n: { text: string }) => n.text), ['first']);
    assert.deepEqual((await (await h.call('/v1/extensions/notes', 'bob')).json()).notes, [], 'another tenant sees nothing');
    const evidence = await h.db.collection<{ capability: string; decision: string; principalId: string }>('service_effect_evidence').find({ capability: 'notes.write' });
    assert.ok(evidence.some((e) => e.principalId === 'alice' && e.decision === 'allow'));
  } finally {
    await h.close();
  }
});

test('5-6: without the extension the host is unchanged: no page, no route, no capability, the same manifest and UI', async () => {
  const h = await host({ extensions: false });
  try {
    assert.deepEqual(h.services.extensions, []);
    assert.equal(h.services.capabilities, SERVICE_CAPABILITY_MANIFEST, 'the same manifest object as before extensions existed');
    assert.equal((await h.call('/notes', 'alice')).status, 404);
    assert.equal((await h.call('/v1/extensions/notes', 'alice')).status, 404);
    await assert.rejects(h.services.gateway.authorize('notes.read', h.services.identify(principals.alice!), { type: 'note', tenantId: 'tenant-a' }), /not declared/);
    const page = await h.call('/api-keys', 'alice');
    assert.equal(page.status, 200);
    assert.ok(!pageConfig(await page.text()).navigation.some((n: { id: string }) => n.id === 'notes'));
    assert.deepEqual(createUiContribution({ apiKeys: true, webhooks: true, jobs: true, schedules: true, files: true, notifications: true, configuration: true, intelligence: true }), APPPORT_UI_CONTRIBUTIONS[0]);
    assert.deepEqual(createUiPages(), createUiPages(undefined, { extensions: [] }));
  } finally {
    await h.close();
  }
  // Installed, the built-in surfaces are exactly the same; the extension only adds its own.
  const all = { apiKeys: true, webhooks: true, jobs: true, schedules: true, files: true, notifications: true, configuration: true, intelligence: true };
  const without = createUiContribution(all)!;
  const withNotes = createUiContribution(all, { extensions: [notesExtension] })!;
  assert.deepEqual(withNotes.surfaces.filter((s) => s.id !== 'notes'), without.surfaces);
  const withServices = createServices({ memory: true, namespace: `ext-${crypto.randomUUID()}`, authorizer: authority({}), extensions: [notesExtension] });
  try {
    assert.deepEqual(withServices.capabilities.slice(0, SERVICE_CAPABILITY_MANIFEST.length), [...SERVICE_CAPABILITY_MANIFEST]);
    assert.deepEqual(withServices.capabilities.slice(SERVICE_CAPABILITY_MANIFEST.length).map((c) => c.name), ['notes.read', 'notes.write']);
  } finally {
    await withServices.apiKeys.close();
  }
});

test('declarations are checked: namespacing, no built-in names or ids, declared capabilities only, safe scripts', () => {
  const page = { id: 'demo', title: 'Demo', route: '/demo', order: 1, description: 'd', capabilities: ['demo.read'], script: 'void 0;' };
  const capability = { name: 'demo.read', operation: 'read', effect: 'observation' as const, resource: 'demo' };
  assert.ok(defineServicesExtension({ id: 'demo', capabilities: [capability], pages: [page] }));
  const bad: Array<[string, Parameters<typeof defineServicesExtension>[0]]> = [
    ['id', { id: 'Demo!' }],
    ['reserved id', { id: 'api-keys' }],
    ['unnamespaced capability', { id: 'demo', capabilities: [{ ...capability, name: 'read' }] }],
    ['built-in capability', { id: 'apikeys', capabilities: [{ ...capability, name: 'apikeys.read' }] }],
    ['undeclared page capability', { id: 'demo', capabilities: [capability], pages: [{ ...page, capabilities: ['demo.write'] }] }],
    ['page outside its namespace', { id: 'demo', capabilities: [capability], pages: [{ ...page, route: '/api-keys' }] }],
    ['page with no capability', { id: 'demo', capabilities: [capability], pages: [{ ...page, capabilities: [] }] }],
    ['script closing the element', { id: 'demo', capabilities: [capability], pages: [{ ...page, script: '</script><script>alert(1)' }] }],
  ];
  for (const [label, extension] of bad) assert.throws(() => defineServicesExtension(extension), ServicesExtensionError, label);
  assert.throws(() => createServices({ memory: true, namespace: `dup-${crypto.randomUUID()}`, extensions: [notesExtension, notesExtension] }), /registered twice/);
});

test('an extension bound to another Services instance is refused: one host, one gateway', async () => {
  const first = createServices({ memory: true, namespace: `a-${crypto.randomUUID()}`, authorizer: authority({}), extensions: [notesExtension] });
  const second = createServices({ memory: true, namespace: `b-${crypto.randomUUID()}`, authorizer: authority({}) });
  try {
    assert.throws(() => createManagementRouter({ services: second, authority: second.gateway, extensions: first.extensions, authenticate: () => null }), /another Services instance/);
  } finally {
    await first.apiKeys.close();
    await second.apiKeys.close();
  }
});
