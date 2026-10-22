// The WASM build inside real Chromium (not inferred from Node): same corpus,
// same byte comparison, plus the main-thread synchronous-compile limit that
// decides whether a synchronous validateUiContribution can be kept in browsers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

const wasm = readFileSync(new URL('../build/ui-contract.wasm', import.meta.url));
const corpus = readFileSync(new URL('../fixtures/ui-contract-corpus.json', import.meta.url));
const page = `<!doctype html><script type="module">
const [bytes, corpus] = await Promise.all([fetch('/ui.wasm').then(r => r.arrayBuffer()), fetch('/corpus.json').then(r => r.json())]);
let syncCompile;
try { new WebAssembly.Module(bytes); syncCompile = 'allowed'; } catch (e) { syncCompile = e.name + ': ' + e.message; }
const { instance } = await WebAssembly.instantiate(bytes, {});
const x = instance.exports, enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
const handle = (s) => { const i = enc.encode(s); const p = x.ui_alloc(i.length); new Uint8Array(x.memory.buffer, p, i.length).set(i);
  const packed = x.ui_handle(p, i.length); x.ui_free(p, i.length); const op = Number(packed >> 32n), ol = Number(packed & 0xffffffffn);
  const out = dec.decode(new Uint8Array(x.memory.buffer, op, ol)); x.ui_free(op, ol); return out; };
const diverged = [];
for (const c of corpus.cases) {
  const req = '{"op":' + JSON.stringify(c.op) + ',"value":' + c.raw + (c.available ? ',"available":' + JSON.stringify(c.available) : '') + '}';
  if (handle(req) !== c.expectedJson) diverged.push(c.name);
}
window.__result = { syncCompile, cases: corpus.cases.length, diverged, ua: navigator.userAgent };
</script>`;

test('Chromium: WASM build matches the corpus; main-thread sync compile behaviour recorded', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/ui.wasm') { res.setHeader('content-type', 'application/wasm'); return res.end(wasm); }
    if (req.url === '/corpus.json') { res.setHeader('content-type', 'application/json'); return res.end(corpus); }
    res.setHeader('content-type', 'text/html'); res.end(page);
  }).listen(0);
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  try {
    const tab = await browser.newPage();
    await tab.goto(`http://127.0.0.1:${server.address().port}/`);
    const result = await tab.waitForFunction(() => window.__result, null, { timeout: 60000 }).then((h) => h.jsonValue());
    console.log(JSON.stringify(result));
    assert.deepEqual(result.diverged, ['lone surrogate in title']);
  } finally {
    await browser.close();
    server.close();
  }
});
