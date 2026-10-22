// One variant, one fresh process. Prints a JSON line of measurements.
// Usage: node bench-worker.mjs <ts|wasm|napi> <iterations>
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const variant = process.argv[2];
const iterations = Number(process.argv[3] ?? 20000);
const t0 = performance.now();
let fns;
if (variant === 'ts') {
  const protocol = await import('@appport/protocol');
  fns = { validateUiContribution: protocol.validateUiContribution, filterUiContribution: protocol.filterUiContribution };
} else {
  const b = await import('./bindings.mjs');
  fns = b.asProtocolFunctions(variant === 'wasm' ? b.loadWasm() : b.loadNapi());
}
const loadMs = performance.now() - t0;

const corpus = JSON.parse(readFileSync(new URL('../fixtures/ui-contract-corpus.json', import.meta.url), 'utf8'));
const doc = (name) => JSON.parse(corpus.cases.find((c) => c.name === name).raw);
const workloads = {
  'anonymous /v1/ui (1 surface)': doc('compute fixture: anonymous /v1/ui (services 0.4.10)'),
  'services full (10 surfaces)': doc('services 0.4.12 APPPORT_UI_CONTRIBUTIONS[0]'),
  '64 surfaces': doc('64 surfaces (Compute MAX_LINKS)'),
  '1000 surfaces': doc('1000 surfaces'),
  'rejected: bad capability': doc('capability: uppercase rejected'),
};
// The real caller path: createUiDiscoveryDocument = validate, then filter for the caller.
const callerPath = (value) => fns.filterUiContribution(fns.validateUiContribution(value), ['apikeys.read', 'apikeys.create', 'apikeys.revoke']);

const t1 = performance.now();
try { callerPath(workloads['services full (10 surfaces)']); } catch { /* measured either way */ }
const firstCallMs = performance.now() - t1;

function measure(fn, value, n) {
  const run = () => { try { fn(value); } catch { /* rejections are part of the workload */ } };
  for (let i = 0; i < Math.min(2000, n); i++) run(); // warm-up / JIT tier-up
  const samples = new Float64Array(n);
  const start = performance.now();
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    run();
    samples[i] = performance.now() - s;
  }
  const total = performance.now() - start;
  samples.sort();
  const q = (p) => samples[Math.min(n - 1, Math.floor(p * n))] * 1000;
  return { n, p50_us: q(0.5), p95_us: q(0.95), p99_us: q(0.99), mean_us: (total / n) * 1000, ops_per_s: n / (total / 1000) };
}

const results = {};
for (const [name, value] of Object.entries(workloads)) {
  const n = name === '1000 surfaces' ? Math.max(200, iterations / 50) : iterations;
  results[`validate: ${name}`] = measure(fns.validateUiContribution, value, n);
  if (!name.startsWith('rejected')) results[`validate+filter: ${name}`] = measure(callerPath, value, n);
}
// The JS-side marshalling a JSON-string boundary adds, without any Rust call:
// stringify the input, parse an output of the same size.
for (const [name, value] of Object.entries(workloads)) {
  if (name.startsWith('rejected')) continue;
  const n = name === '1000 surfaces' ? Math.max(200, iterations / 50) : iterations;
  const out = JSON.stringify({ ok: true, value: fns.validateUiContribution(value) });
  results[`marshalling only: ${name}`] = measure((v) => JSON.parse(JSON.stringify(v) && out), value, n);
}
const mem = process.memoryUsage();
console.log(JSON.stringify({ variant, loadMs, firstCallMs, rssMB: mem.rss / 2 ** 20, heapUsedMB: mem.heapUsed / 2 ** 20, externalMB: mem.external / 2 ** 20, arrayBuffersMB: mem.arrayBuffers / 2 ** 20, results }));
