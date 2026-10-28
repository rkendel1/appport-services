import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createServices } from '../src/index.js';

// @feltdb/core 0.15 makes a local state directory exclusive by default. A host that
// runs an API server and a worker over one directory must opt in with access: 'shared'.
function open(path: string, access?: 'shared' | 'exclusive') {
  return createServices({ mode: 'local', namespace: 'access-test', path, ...(access ? { access } : {}) });
}

test('a second process opening a local directory is refused by default', () => {
  const path = mkdtempSync(join(tmpdir(), 'appport-access-'));
  const first = open(path);
  try {
    const entry = new URL('../src/index.js', import.meta.url).href;
    const script = `import(${JSON.stringify(entry)}).then(({ createServices }) => { try { createServices({ mode: 'local', namespace: 'access-test', path: ${JSON.stringify(path)} }); console.log('OPENED'); process.exit(0); } catch (e) { console.log(e.code); process.exit(0); } })`;
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    assert.equal(result.stdout.trim(), 'STATE_LOCKED');
  } finally {
    first.db.close?.();
    rmSync(path, { recursive: true, force: true });
  }
});

test('access: shared lets several openers use one local directory', () => {
  const path = mkdtempSync(join(tmpdir(), 'appport-access-'));
  const first = open(path, 'shared');
  try {
    const second = open(path, 'shared');
    second.db.close?.();
  } finally {
    first.db.close?.();
    rmSync(path, { recursive: true, force: true });
  }
});
