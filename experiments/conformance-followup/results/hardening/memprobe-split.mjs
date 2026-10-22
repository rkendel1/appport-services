// Separate per-application retention from shared-state growth.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const root = '/home/user/authboundry-bridge';
async function run(limit, distinct, n) {
  const dir = await mkdtemp(path.join(tmpdir(), 'split-'));
  const probe = path.join(dir, 'heap');
  const child = spawn(process.execPath, ['--expose-gc', '--require', `${root}/test/fixtures/appport-bridge/heap-probe.cjs`, `${root}/bridge/appport-services.cjs`], {
    cwd: root, env: { ...process.env, AUTHBOUNDRY_FELTDB_PATH: path.join(dir, 'state.json'), FELTDB_URL: '', FELTDB_ENDPOINT: '', AUTHBOUNDRY_APPPORT_SERVICES_PROTOCOL: '2', AUTHBOUNDRY_APPPORT_SERVICES_MAX_APPLICATIONS: String(limit), HEAP_PROBE_FILE: probe }, stdio: ['pipe', 'pipe', 'ignore'] });
  const it = createInterface({ input: child.stdout })[Symbol.asyncIterator](); await it.next();
  let id = 0;
  const send = async (app) => { child.stdin.write(JSON.stringify({ id: ++id, operation: 'snapshot', request: { actor: 'a', authority: { verified_by: 'authboundry', actor: 'a' }, tenant_id: `t:${app}`, application_id: app } }) + '\n'); JSON.parse((await it.next()).value); };
  const heap = async () => { child.kill('SIGUSR2'); for (;;) { await new Promise(r => setTimeout(r, 50)); try { const b = Number(await readFile(probe, 'utf8')); if (b) { await rm(probe); return b; } } catch {} } };
  for (let i = 0; i < 40; i++) await send(distinct ? `w${i}` : 'one');
  const before = await heap();
  const samples = [];
  for (let i = 0; i < n; i++) { await send(distinct ? `c${i}` : 'one'); if ((i + 1) % 100 === 0) samples.push(+(((await heap()) - before) / 2 ** 20).toFixed(1)); }
  child.stdin.end(); await new Promise(r => child.once('exit', r)); await rm(dir, { recursive: true, force: true });
  console.log(JSON.stringify({ limit, distinct, requests: n, growthMB_every100: samples }));
}
await run(4, false, 400);
await run(4, true, 400);
await run(1, true, 400);
