import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// The conformance corpora for the contracts this package owns
// (conformance/contracts) are generated from this package. This test fails
// when a change alters any expected result without a reviewed re-bless.
const contracts = join(process.cwd(), 'conformance', 'contracts');
const reference = await import(pathToFileURL(join(contracts, 'tools', 'reference.mjs')).href);
const modules = await reference.load(pathToFileURL(join(process.cwd(), 'dist') + '/'));

for (const corpus of reference.CORPORA as string[]) {
  const casesText = readFileSync(join(contracts, corpus, 'cases.json'), 'utf8');
  const { cases } = JSON.parse(casesText) as { cases: Array<{ id: string }> };
  const expected = JSON.parse(readFileSync(join(contracts, corpus, 'expected.json'), 'utf8')) as {
    casesSha256: string;
    results: Record<string, { exact: string }>;
  };

  test(`conformance corpus ${corpus} is well-formed and pinned to its cases`, () => {
    assert.deepEqual(reference.lintCases(cases), []);
    assert.equal(createHash('sha256').update(casesText).digest('hex'), expected.casesSha256);
    assert.deepEqual(Object.keys(expected.results).sort(), cases.map((c) => c.id).sort());
  });

  test(`conformance corpus ${corpus} matches this package byte for byte`, () => {
    const diverged = cases.filter((c) => reference.run(corpus, modules, c).exact !== expected.results[c.id]!.exact).map((c) => c.id);
    assert.deepEqual(diverged, []);
  });
}
