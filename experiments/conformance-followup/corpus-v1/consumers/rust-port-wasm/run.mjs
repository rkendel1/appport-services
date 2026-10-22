// Exact-level consumer: the assessment's Rust port via its WASM build.
import { readFileSync, writeFileSync } from 'node:fs';
import { loadWasm } from '../../../../rust-interop/node/bindings.mjs';
import { views } from '../../tools/references.mjs';
const handle = loadWasm();
const { cases } = JSON.parse(readFileSync(new URL('../../appport-ui-1/cases.json', import.meta.url), 'utf8'));
const out = cases.map((c) => {
  const exact = handle(`{"op":${JSON.stringify(c.op)},"value":${c.input.json}${c.available ? `,"available":${JSON.stringify(c.available)}` : ''}}`);
  return JSON.stringify({ id: c.id, exact, ...views(JSON.parse(exact)) });
});
writeFileSync(new URL('results.jsonl', import.meta.url), out.join('\n') + '\n');
