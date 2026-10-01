import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// dist/tests/package-artifact.test.js -> repository root.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function npm(args: readonly string[], cwd: string): string {
  return execFileSync('npm', [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false' },
  });
}

/**
 * Runs inside the clean consumer directory (outside the workspace) against the
 * installed tarball. It proves the artifact itself — never the workspace copy —
 * serves a valid AppPort/ui/1 document and every route that document's
 * contribution describes.
 */
const VERIFIER = `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { APPPORT_UI_CONTRIBUTIONS, createManagementRouter, createServices, createUiContribution } from '@appport/services';
import { validateUiContribution } from '@appport/protocol';

// The install must be self-contained: never resolve the workspace package.
const here = new URL('./node_modules/', import.meta.url).href;
const resolved = import.meta.resolve('@appport/services');
assert.ok(resolved.startsWith(here), 'resolved outside the clean install: ' + resolved);

const services = createServices({ memory: true, namespace: 'pack-' + Date.now() });
const app = express();
app.use(createManagementRouter({
  services,
  authority: services.gateway,
  // Anonymous discovery: no identity, exactly what a control plane sends.
  authenticate: () => null,
}));
const server = createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;

const response = await fetch(base + '/v1/ui');
const document = await response.json();
// The protocol's own validator, from the installed @appport/protocol.
const validated = validateUiContribution(document);

// Every route the host's contribution describes must actually be served.
const contribution = createUiContribution(services);
assert.ok(contribution, 'the host mounts pages, so it must contribute a document');
const pages = {};
for (const surface of contribution.surfaces) {
  pages[surface.route] = (await fetch(base + surface.route)).status;
}
// The full exported contribution names routes that exist too.
for (const surface of APPPORT_UI_CONTRIBUTIONS[0].surfaces) {
  if (!(surface.route in pages)) pages[surface.route] = (await fetch(base + surface.route)).status;
}

server.close();
console.log(JSON.stringify({
  resolved,
  status: response.status,
  document,
  validatedProtocol: validated.protocol,
  product: validated.product,
  contributionSurfaceCount: contribution.surfaces.length,
  pages,
}));
process.exit(0);
`;


test('the packed npm artifact serves a valid AppPort/ui/1 document at GET /v1/ui', { timeout: 300_000 }, async () => {
  const staging = await mkdtemp(join(tmpdir(), 'appport-pack-'));
  const packDir = join(staging, 'tarball');
  const consumer = join(staging, 'consumer');
  await mkdir(packDir);
  await mkdir(consumer);

  // 1. Pack exactly what npm would publish (dist is built by `npm test` first).
  const packed = JSON.parse(npm(['pack', '--pack-destination', packDir, '--json'], repoRoot)) as Array<{ version: string; filename: string }>;
  assert.equal(packed.length, 1);
  const version = packed[0]!.version;
  const tarball = join(packDir, packed[0]!.filename);

  // 2. Clean install outside the workspace: no workspace paths, no linked copies.
  await writeFile(join(consumer, 'package.json'), `${JSON.stringify({ name: 'appport-services-consumer', private: true, type: 'module' }, null, 2)}\n`);
  npm(['install', tarball, '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=error'], consumer);

  // 3. The artifact declares the published protocol it needs, and a published
  //    protocol satisfying that declaration is what got installed.
  const installed = JSON.parse(await readFile(join(consumer, 'node_modules/@appport/services/package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };
  assert.equal(installed.version, version, 'the installed package must be the packed version');
  const declaredProtocol = installed.dependencies['@appport/protocol'];
  assert.ok(declaredProtocol, 'the packed package must declare @appport/protocol');
  const protocol = JSON.parse(await readFile(join(consumer, 'node_modules/@appport/protocol/package.json'), 'utf8')) as { version: string };
  assert.match(protocol.version, /^1\.0\.\d+$/, `published protocol ${protocol.version} must satisfy ${declaredProtocol}`);

  // 4. Start the management host from the installed copy and probe it.
  await writeFile(join(consumer, 'verify.mjs'), VERIFIER);
  const stdout = execFileSync(process.execPath, ['verify.mjs'], { cwd: consumer, encoding: 'utf8', timeout: 120_000 });
  const lines = stdout.trim().split('\n');
  const result = JSON.parse(lines.at(-1)!) as {
    resolved: string;
    status: number;
    document: { protocol: string; product: { id: string; version: string }; capabilities: string[]; surfaces: Array<{ route: string; capabilities: string[] }> };
    validatedProtocol: string;
    product: { id: string; version: string };
    contributionSurfaceCount: number;
    pages: Record<string, number>;
  };

  // Discovery works from the artifact and is a valid AppPort/ui/1 document.
  assert.equal(result.status, 200, 'GET /v1/ui must answer 200 from the packed artifact');
  assert.equal(result.document.protocol, 'AppPort/ui/1');
  assert.equal(result.validatedProtocol, 'AppPort/ui/1', 'the protocol validator of the installed @appport/protocol accepted it');
  assert.equal(result.product.id, 'appport-services');
  assert.equal(result.product.version, version, 'the document reports the published package version');
  // Caller-contextual discovery: a caller with no capabilities sees only
  // capability-free surfaces (the protocol's own filterUiContribution output).
  assert.ok(result.document.surfaces.every((surface) => surface.capabilities.length === 0), 'anonymous discovery must not advertise capability-gated pages');
  assert.ok(result.document.surfaces.some((surface) => surface.route === '/services'), 'the capability-free overview is the anonymous view');

  // It resolved from the clean install, not the workspace.
  assert.ok(result.resolved.startsWith('file://'), result.resolved);
  assert.ok(!result.resolved.includes('appport-services/dist'), `must not resolve the workspace package: ${result.resolved}`);
  assert.ok(result.resolved.includes('/node_modules/'), `must resolve the installed package: ${result.resolved}`);

  // Every advertised/described page is served by the artifact (never 404);
  // /api-keys answers 401 for an anonymous caller, which is auth, not absence.
  assert.ok(result.contributionSurfaceCount > 0, 'the host contributes its mounted pages');
  for (const [route, status] of Object.entries(result.pages)) {
    assert.notEqual(status, 404, `${route} must be served by the packed artifact`);
  }
  assert.equal(result.pages['/services'], 200, 'the overview page is served');
});
