// Differential: TS oracle (live) vs corpus vs WASM vs Node-API, byte for byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { oracle, requestJson } from './oracle.mjs';
import { loadNapi, loadWasm } from './bindings.mjs';

const corpus = JSON.parse(readFileSync(new URL('../fixtures/ui-contract-corpus.json', import.meta.url), 'utf8'));
const KNOWN = new Set(['lone surrogate in title']);
const variants = { wasm: loadWasm(), napi: loadNapi() };

test('the recorded corpus still matches the live TypeScript oracle (regression lock on the TS contract)', () => {
  for (const c of corpus.cases) {
    assert.equal(JSON.stringify(oracle({ op: c.op, value: JSON.parse(c.raw), available: c.available })), c.expectedJson, c.name);
  }
});

for (const [name, handle] of Object.entries(variants)) {
  test(`${name}: byte-identical to the oracle except documented limits`, () => {
    const diverged = [];
    for (const c of corpus.cases) {
      const actual = handle(requestJson(c));
      if (actual !== c.expectedJson) diverged.push(c.name);
      // Repeated calls are deterministic and leave no state behind.
      assert.equal(handle(requestJson(c)), actual, `${c.name} repeat`);
    }
    assert.deepEqual(new Set(diverged), KNOWN);
  });
}

test('wasm: malformed request bytes are an error envelope, not a trap', () => {
  const handle = variants.wasm;
  for (const bad of ['', '{', 'nul', '\u0000', '{"op":"validate","value":}']) {
    assert.deepEqual(JSON.parse(handle(bad)), { ok: false, internal: 'SyntaxError' });
  }
});

test('wasm: repeated calls on one instance do not grow linear memory past the first call', () => {
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL('../build/ui-contract.wasm', import.meta.url))), {});
  const input = new TextEncoder().encode(requestJson(corpus.cases.find((c) => c.name === '1000 surfaces')));
  const call = () => {
    const p = exports.ui_alloc(input.length);
    new Uint8Array(exports.memory.buffer, p, input.length).set(input);
    const packed = exports.ui_handle(p, input.length);
    exports.ui_free(p, input.length);
    exports.ui_free(Number(packed >> 32n), Number(packed & 0xffffffffn));
  };
  call();
  const first = exports.memory.buffer.byteLength;
  for (let i = 0; i < 500; i++) call();
  assert.equal(exports.memory.buffer.byteLength, first);
});
