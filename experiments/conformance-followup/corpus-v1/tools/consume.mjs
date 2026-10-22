// Consumer-side check. Compares an implementation's results with the blessed
// expectations at the consumer's declared comparison level, allowing only the
// divergences the consumer has declared (with a rationale) in its narrowings
// file. Fails on: an undeclared divergence, a declared divergence that no
// longer diverges (stale), a declared id that does not exist, or a corpus
// checksum the consumer did not pin. Never writes expectations.
//   node tools/consume.mjs <contract> <results.jsonl> <narrowings.json>
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const [contract, resultsPath, narrowingsPath] = process.argv.slice(2);
const dir = new URL(`../${contract}/`, import.meta.url);
const casesText = readFileSync(new URL('cases.json', dir), 'utf8');
const expectedText = readFileSync(new URL('expected.json', dir), 'utf8');
const expected = JSON.parse(expectedText).results;
const pin = JSON.parse(readFileSync(narrowingsPath, 'utf8'));
const sha = (t) => createHash('sha256').update(t).digest('hex');
const problems = [];
if (pin.corpus.casesSha256 !== sha(casesText) || pin.corpus.expectedSha256 !== sha(expectedText)) {
  problems.push(`corpus checksum differs from the pinned one (consumer must re-pin deliberately)`);
}
const level = pin.comparison; // exact | error | verdict
const actual = new Map(readFileSync(resultsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.id, r]));
const cases = new Map(JSON.parse(casesText).cases.map((c) => [c.id, c]));
const declared = new Map(pin.narrowings.map((n) => [n.id, n]));
const tally = { equal: 0, matchesIntended: 0, declared: 0, undeclared: 0, stale: 0, notRun: 0 };
for (const [id, want] of Object.entries(expected)) {
  if (pin.scope && !pin.scope.includes(id.split('.')[1]) && !declared.has(id)) continue;
  const got = actual.get(id);
  if (!got) { tally.notRun++; if (!pin.notApplicable?.includes(id)) problems.push(`${id}: no result`); continue; }
  const same = level === 'exact' ? got.exact === want.exact
    : level === 'error' ? got.verdict === want.verdict && got.code === want.code && got.field === want.field
    : got.verdict === want.verdict;
  const d = declared.get(id);
  const intended = cases.get(id)?.referenceDefect?.intended;
  if (!same && intended && got.verdict === intended.verdict && (level === 'verdict' || (got.code === intended.code && got.field === intended.field))) { tally.matchesIntended++; continue; }
  if (same && d) { tally.stale++; problems.push(`${id}: declared narrowing no longer diverges (remove it)`); }
  else if (same) tally.equal++;
  else if (d && d.consumerVerdict === got.verdict) tally.declared++;
  else { tally.undeclared++; problems.push(`${id}: reference ${want.verdict}${want.code ? `/${want.code}` : ''}, consumer ${got.verdict}${got.detail ? ` (${got.detail})` : ''}`); }
}
for (const id of declared.keys()) if (!(id in expected)) problems.push(`${id}: declared but not in corpus`);
console.log(`${pin.consumer} vs ${contract} @ ${level}:`, JSON.stringify(tally));
for (const p of problems) console.log(`  FAIL ${p}`);
process.exit(problems.length ? 1 : 0);
