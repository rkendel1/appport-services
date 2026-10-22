// Regenerate expected.json from the REFERENCE implementation only.
//   node tools/bless.mjs <contract> --check            CI: fail if committed expectations differ
//   node tools/bless.mjs <contract> --write --accept=ID[,ID...] --reason="..."
// --write refuses unless every changed case id is listed in --accept, and
// records the reason and reference version in expected.json's history.
// There is deliberately no mode that blesses an implementation under test.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { reference, views } from './references.mjs';

const [contract, ...flags] = process.argv.slice(2);
const dir = new URL(`../${contract}/`, import.meta.url);
const flag = (name) => flags.find((f) => f === `--${name}` || f.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const casesText = readFileSync(new URL('cases.json', dir), 'utf8');
const { cases } = JSON.parse(casesText);
const ids = new Set();
for (const c of cases) {
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(c.id) || ids.has(c.id)) throw new Error(`bad or duplicate id ${c.id}`);
  if (c.class === 'security' && !c.security?.rationale) throw new Error(`${c.id}: security cases need a rationale`);
  ids.add(c.id);
}
const ref = await reference(contract);
const results = {};
for (const c of cases) {
  const r = ref.run(c);
  results[c.id] = { exact: JSON.stringify(r), ...views(r) };
}
const expectedPath = new URL('expected.json', dir);
const previous = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, 'utf8')) : { results: {}, history: [] };
const changed = Object.keys(results).filter((id) => previous.results[id]?.exact !== results[id].exact);
const removed = Object.keys(previous.results).filter((id) => !(id in results));
const casesSha = createHash('sha256').update(casesText).digest('hex');

if (flags.includes('--check')) {
  const stale = previous.casesSha256 !== casesSha;
  if (changed.length || removed.length || stale) {
    console.error(`${contract}: expectations out of date. changed=${changed.join(',') || '-'} removed=${removed.join(',') || '-'} casesChanged=${stale}`);
    process.exit(1);
  }
  console.log(`${contract}: ${cases.length} cases match ${ref.id.package}@${ref.id.version}`);
  process.exit(0);
}
if (!flags.includes('--write')) throw new Error('pass --check or --write');
const accepted = new Set((flag('accept') ?? '').split(',').filter(Boolean));
const unreviewed = [...changed, ...removed].filter((id) => !accepted.has(id));
if (unreviewed.length) {
  console.error(`refusing: ${unreviewed.length} changed case(s) not listed in --accept: ${unreviewed.join(', ')}`);
  for (const id of unreviewed.slice(0, 5)) console.error(`  ${id}\n    was: ${previous.results[id]?.exact ?? '(new)'}\n    now: ${results[id]?.exact ?? '(removed)'}`.slice(0, 600));
  process.exit(2);
}
if (!flag('reason')) throw new Error('--reason is required');
const history = [...(previous.history ?? []), { at: new Date().toISOString(), reference: ref.id, reason: flag('reason'), changed, removed }];
writeFileSync(expectedPath, JSON.stringify({ contract, reference: ref.id, casesSha256: casesSha, results, history }, null, 1) + '\n');
console.log(`${contract}: wrote ${cases.length} expectations (${changed.length} changed, ${removed.length} removed)`);
