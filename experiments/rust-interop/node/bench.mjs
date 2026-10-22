// Driver: R fresh processes per variant, interleaved; reports medians across runs.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';

const R = Number(process.env.RUNS ?? 5);
const N = Number(process.env.ITERATIONS ?? 20000);
const variants = ['ts', 'wasm', 'napi'];
const worker = new URL('./bench-worker.mjs', import.meta.url).pathname;
const runs = Object.fromEntries(variants.map((v) => [v, []]));
const spawnMs = Object.fromEntries([...variants, 'bare-node'].map((v) => [v, []]));

for (let r = 0; r < R; r++) {
  for (const v of variants) {
    runs[v].push(JSON.parse(execFileSync(process.execPath, [worker, v, String(N)], { encoding: 'utf8' })));
  }
}
const fullDoc = JSON.parse(readFileSync(new URL('../fixtures/ui-contract-corpus.json', import.meta.url), 'utf8')).cases.find((c) => c.name.startsWith('services 0.4.12 APPPORT')).raw;
// Cold start: whole process, import + init + first caller-path call, vs bare node.
const coldScript = (v) => v === 'bare-node' ? 'process.exit(0)' : `
  const b = ${v === 'ts' ? "await import('@appport/protocol')" : "await import('./bindings.mjs')"};
  const f = ${v === 'ts' ? 'b' : `b.asProtocolFunctions(b.${v === 'wasm' ? 'loadWasm' : 'loadNapi'}())`};
  f.filterUiContribution(f.validateUiContribution(${fullDoc}), []);`;
for (let r = 0; r < R * 4; r++) {
  for (const v of Object.keys(spawnMs)) {
    const s = process.hrtime.bigint();
    execFileSync(process.execPath, ['--input-type=module', '-e', coldScript(v)], { cwd: new URL('.', import.meta.url).pathname });
    spawnMs[v].push(Number(process.hrtime.bigint() - s) / 1e6);
  }
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const summary = {};
for (const v of variants) {
  const keys = Object.keys(runs[v][0].results);
  summary[v] = {
    loadMs: median(runs[v].map((x) => x.loadMs)),
    firstCallMs: median(runs[v].map((x) => x.firstCallMs)),
    rssMB: median(runs[v].map((x) => x.rssMB)),
    coldProcessMs: median(spawnMs[v]),
    results: Object.fromEntries(keys.map((k) => [k, Object.fromEntries(['p50_us', 'p95_us', 'p99_us', 'ops_per_s'].map((m) => [m, median(runs[v].map((x) => x.results[k][m]))]))])),
  };
}
summary.bareNodeColdProcessMs = median(spawnMs['bare-node']);
const env = { node: process.version, cpu: os.cpus()[0].model, cores: os.cpus().length, memGB: Math.round(os.totalmem() / 2 ** 30), platform: `${os.platform()}-${os.arch()}`, runs: R, iterations: N, when: new Date().toISOString() };
const out = new URL('../results/bench.json', import.meta.url);
writeFileSync(out, JSON.stringify({ env, summary, raw: runs, coldProcessSamplesMs: spawnMs }, null, 1));
console.log(JSON.stringify(env));
console.log('cold process (ms, median):', Object.fromEntries(Object.entries(spawnMs).map(([k, v]) => [k, median(v).toFixed(1)])));
for (const v of variants) console.log(v, 'load', summary[v].loadMs.toFixed(2), 'ms; first call', summary[v].firstCallMs.toFixed(3), 'ms; rss', summary[v].rssMB.toFixed(1), 'MB');
const keys = Object.keys(summary.ts.results);
console.log('\n' + 'workload'.padEnd(52) + variants.map((v) => `${v} p50/p95 µs`.padStart(22)).join(''));
for (const k of keys) console.log(k.padEnd(52) + variants.map((v) => `${summary[v].results[k].p50_us.toFixed(2)}/${summary[v].results[k].p95_us.toFixed(2)}`.padStart(22)).join(''));
