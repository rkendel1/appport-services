import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = 'scripts/release-versions.mjs';
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

// A copy of the four files the chain is made of, so tests can drift and bump it.
function chainCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'appport-release-versions-'));
  for (const file of [script, 'package.json', 'package-lock.json', 'packages/runtime/package.json', 'packages/create-appport/package.json']) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    cpSync(join(root, file), join(dir, file));
  }
  return dir;
}

const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

test('runtime and create-appport accept the versions released with them', () => {
  const services = readJson(join(root, 'package.json'));
  const runtime = readJson(join(root, 'packages/runtime/package.json'));
  const create = readJson(join(root, 'packages/create-appport/package.json'));
  assert.equal(runtime.dependencies['@appport/services'], `^${services.version}`);
  assert.equal(create.dependencies['@appport/runtime'], `^${runtime.version}`);
  assert.equal(run(root, 'check').status, 0);
});

test('check refuses a runtime range that no longer accepts this services version', () => {
  const dir = chainCopy();
  try {
    const file = join(dir, 'packages/runtime/package.json');
    const runtime = readJson(file);
    runtime.dependencies['@appport/services'] = '^0.4.9';
    writeFileSync(file, JSON.stringify(runtime));
    const result = run(dir, 'check');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dependencies\.@appport\/services is \^0\.4\.9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bump minor moves services and runtime by a minor, create-appport by a patch, and every range with them', () => {
  const dir = chainCopy();
  try {
    const before = {
      services: readJson(join(dir, 'package.json')).version as string,
      runtime: readJson(join(dir, 'packages/runtime/package.json')).version as string,
      create: readJson(join(dir, 'packages/create-appport/package.json')).version as string,
    };
    assert.equal(run(dir, 'bump', 'minor').status, 0);
    const services = readJson(join(dir, 'package.json'));
    const runtime = readJson(join(dir, 'packages/runtime/package.json'));
    const create = readJson(join(dir, 'packages/create-appport/package.json'));
    const minor = (v: string) => { const [a, b] = v.split('.').map(Number); return `${a}.${b + 1}.0`; };
    const patch = (v: string) => { const [a, b, c] = v.split('.').map(Number); return `${a}.${b}.${c + 1}`; };
    assert.equal(services.version, minor(before.services));
    assert.equal(runtime.version, minor(before.runtime));
    assert.equal(create.version, patch(before.create));
    assert.equal(runtime.dependencies['@appport/services'], `^${services.version}`);
    assert.equal(create.dependencies['@appport/runtime'], `^${runtime.version}`);
    assert.equal(readJson(join(dir, 'package-lock.json')).version, services.version);
    assert.equal(run(dir, 'check').status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create-appport scaffolds the runtime range from its own package.json, not a copy', () => {
  const source = readFileSync(join(root, 'packages/create-appport/cli.js'), 'utf8');
  assert.doesNotMatch(source, /'@appport\/runtime': '\^/);
  const dir = mkdtempSync(join(tmpdir(), 'create-appport-'));
  try {
    // The scaffold writes package.json before it runs the runtime's init, which
    // needs an installed runtime; only the written manifest is checked here.
    spawnSync(process.execPath, [join(root, 'packages/create-appport/cli.js'), 'demo', '--no-install'], { cwd: dir, encoding: 'utf8' });
    const generated = readJson(join(dir, 'demo/package.json'));
    const create = readJson(join(root, 'packages/create-appport/package.json'));
    assert.equal(generated.dependencies['@appport/runtime'], create.dependencies['@appport/runtime']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
