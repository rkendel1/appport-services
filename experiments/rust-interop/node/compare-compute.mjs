// TS oracle verdict vs Compute's own AppPort/ui/1 consumer verdict, per corpus document.
import { readFileSync, writeFileSync } from 'node:fs';
const corpus = JSON.parse(readFileSync(new URL('../fixtures/ui-contract-corpus.json', import.meta.url), 'utf8'));
const compute = new Map(readFileSync(new URL('../results/compute-observer.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.name, r]));
const rows = { both_accept: [], both_reject: [], compute_stricter: [], compute_more_lenient: [] };
for (const c of corpus.cases.filter((c) => c.op === 'validate')) {
  const r = compute.get(c.name);
  const computeAccepts = r.status === 'available' || r.status === 'empty';
  const key = c.expectedOk ? (computeAccepts ? 'both_accept' : 'compute_stricter') : (computeAccepts ? 'compute_more_lenient' : 'both_reject');
  rows[key].push({ name: c.name, compute: r.status, message: r.message });
}
writeFileSync(new URL('../results/compute-vs-oracle.json', import.meta.url), JSON.stringify(rows, null, 1));
for (const [k, v] of Object.entries(rows)) console.log(k, v.length);
for (const k of ['compute_stricter', 'compute_more_lenient']) for (const r of rows[k]) console.log(`  ${k}: ${r.name} -> ${r.compute}: ${r.message ?? ''}`);
