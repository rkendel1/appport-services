// Same properties as test/appport-services-bridge-limits.test.js, in protocol 1,
// so they can be checked against a bridge without the ready line.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const bridge = process.argv[2];
const ctx = { actor: 'a', authority: { verified_by: 'authboundry', actor: 'a' }, tenant_id: 't:app', application_id: 'app' };
async function run(preload, body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'orig-'));
  const child = spawn(process.execPath, [...preload.flatMap((p) => ['--require', path.resolve(p)]), bridge], { env: { ...process.env, AUTHBOUNDRY_FELTDB_PATH: path.join(dir, 's.json'), FELTDB_URL: '', FELTDB_ENDPOINT: '' }, stdio: ['pipe', 'pipe', 'ignore'] });
  const it = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  try { return await body(child, it, exited); } finally { child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }); }
}
const out = {};
out.revoke_unknown = await run([], async (child, it) => { child.stdin.write(JSON.stringify({ operation: 'api_keys.revoke', request: { ...ctx, input: { id: 'no-such-key' } } }) + '\n'); return (await it.next()).value; });
out.noise_lines_before_response = await run(['test/fixtures/appport-bridge/noisy-dependency.cjs'], async (child, it) => {
  child.stdin.write(JSON.stringify({ operation: 'snapshot', request: ctx }) + '\n');
  let stray = 0; for (;;) { const line = (await it.next()).value; try { JSON.parse(line); return stray; } catch { stray++; } }
});
out.exits_on_eof_with_open_handle = await run(['test/fixtures/appport-bridge/open-handle.cjs'], async (child, it, exited) => {
  child.stdin.write(JSON.stringify({ operation: 'snapshot', request: ctx }) + '\n'); await it.next(); child.stdin.end();
  return await Promise.race([exited.then((c) => `exited ${c}`), new Promise((r) => setTimeout(() => r('still running after 5 s'), 5000))]);
});
console.log(JSON.stringify({ bridge: path.basename(path.dirname(bridge)) + '/' + path.basename(bridge), ...out }));
