// Builds fixtures/ui-contract-corpus.json: every case's raw document and the
// TypeScript oracle's result. The oracle defines "correct"; nothing here is
// derived from the Rust port.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { oracle } from './oracle.mjs';
import { APPPORT_UI_CONTRIBUTIONS, createUiDiscoveryDocument } from '../../../dist/src/index.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const computeFixtures = '/home/user/compute/crates/compute-environment/tests/fixtures/appport-ui';

const base = () => ({
  protocol: 'AppPort/ui/1',
  product: { id: 'demo', version: '1.0.0' },
  surfaces: [
    { id: 'keys', title: 'Keys', route: '/api-keys', capabilities: ['apikeys.read'] },
    { id: 'jobs', title: 'Jobs', route: '/jobs', capabilities: [] },
  ],
  navigation: [
    { id: 'n.jobs', label: 'Jobs', group: 'Demo', order: 20, surface: 'jobs' },
    { id: 'n.keys', label: 'Keys', group: 'Demo', order: 10, surface: 'keys' },
  ],
  composition: { requires: [] },
});
const mut = (f) => { const d = base(); f(d); return d; };
const BASE_RAW = JSON.stringify(base());
/** Replace the first occurrence of `from` in the base document's JSON text. */
const rawEdit = (from, to) => { if (!BASE_RAW.includes(from)) throw new Error(from); return BASE_RAW.replace(from, to); };

const cases = [];
const add = (name, category, value, extra = {}) => cases.push({ name, category, op: 'validate', raw: JSON.stringify(value), ...extra });
const addRaw = (name, category, raw, extra = {}) => cases.push({ name, category, op: 'validate', raw, ...extra });

// --- real documents ---------------------------------------------------------
addRaw('compute fixture: anonymous /v1/ui (services 0.4.10)', 'real', readFileSync(`${computeFixtures}/appport-services.json`, 'utf8'));
addRaw('compute fixture: full contribution (services 0.4.10)', 'real', readFileSync(`${computeFixtures}/appport-services-full.json`, 'utf8'));
add('services 0.4.12 APPPORT_UI_CONTRIBUTIONS[0]', 'real', APPPORT_UI_CONTRIBUTIONS[0]);
add('services 0.4.12 anonymous discovery document', 'real', createUiDiscoveryDocument({ apiKeys: true, webhooks: true, jobs: true }));
add('base document', 'valid', base());
add('empty surfaces and navigation', 'valid', mut((d) => { d.surfaces = []; d.navigation = []; }));
add('all composition requirements', 'valid', mut((d) => { d.composition.requires = ['identity', 'tenant', 'application', 'environment']; }));
add('duplicate composition requirement is allowed', 'valid', mut((d) => { d.composition.requires = ['tenant', 'tenant']; }));
add('unknown keys are dropped', 'valid', mut((d) => { d.extra = 1; d.product.extra = 2; d.surfaces[0].extra = 3; d.navigation[0].extra = 4; d.composition.extra = 5; }));
add('entities and actions pass through untouched', 'valid', mut((d) => {
  d.surfaces[0].entities = ['api_key', { nested: [1, 0.1, -2.5e-7, 123456789012, null, true] }];
  d.surfaces[0].actions = [];
}));
add('entities that are not arrays are dropped', 'valid', mut((d) => { d.surfaces[0].entities = 'x'; d.surfaces[0].actions = { a: 1 }; }));
add('negative and zero order', 'valid', mut((d) => { d.navigation[0].order = -5; d.navigation[1].order = 0; }));
add('order 1e21 is an integer', 'boundary', mut((d) => { d.navigation[0].order = 1e21; }));
add('order 2^53 is an integer', 'boundary', mut((d) => { d.navigation[0].order = 2 ** 53; }));
add('order 1.5 rejected', 'invalid-type', mut((d) => { d.navigation[0].order = 1.5; }));
add('order string rejected', 'invalid-type', mut((d) => { d.navigation[0].order = '1'; }));
add('order null rejected', 'invalid-type', mut((d) => { d.navigation[0].order = null; }));
add('order missing rejected', 'missing', mut((d) => { delete d.navigation[0].order; }));
add('order boolean rejected', 'invalid-type', mut((d) => { d.navigation[0].order = true; }));
addRaw('raw order 20.0 (non-canonical number)', 'raw-number', rawEdit('"order":20', '"order":20.0'));
addRaw('raw order 2e1', 'raw-number', rawEdit('"order":20', '"order":2e1'));
addRaw('raw order 9007199254740993 (beyond 2^53)', 'raw-number', rawEdit('"order":20', '"order":9007199254740993'));
addRaw('raw order 1e400 (overflows to Infinity)', 'raw-number', rawEdit('"order":20', '"order":1e400'));
addRaw('raw order -0', 'raw-number', rawEdit('"order":20', '"order":-0'));
addRaw('raw numbers inside entities', 'raw-number', rawEdit('"capabilities":["apikeys.read"]', '"capabilities":["apikeys.read"],"entities":[1.0,-0,1e400,-1e400,1E2,0.000001,1e-7,123456789012345678901234567890,5e-324]'));

// --- strings: length and Unicode -----------------------------------------------
const s = (n, ch = 'x') => ch.repeat(n);
add('title 512 ASCII', 'boundary', mut((d) => { d.surfaces[0].title = s(512); }));
add('title 513 ASCII rejected', 'boundary', mut((d) => { d.surfaces[0].title = s(513); }));
add('title 256 astral chars (512 UTF-16 units)', 'unicode', mut((d) => { d.surfaces[0].title = s(256, '😀'); }));
add('title 257 astral chars (514 UTF-16 units) rejected', 'unicode', mut((d) => { d.surfaces[0].title = s(257, '😀'); }));
add('title 400 astral chars (800 units, 400 scalars) rejected', 'unicode', mut((d) => { d.surfaces[0].title = s(400, '😀'); }));
add('label 512 two-byte chars', 'unicode', mut((d) => { d.navigation[0].label = s(512, 'é'); }));
add('NFC and NFD labels are kept verbatim', 'unicode', mut((d) => { d.navigation[0].label = 'Caf\u00e9'; d.navigation[1].label = 'Cafe\u0301'; }));
add('NFC/NFD surface ids are distinct', 'unicode', mut((d) => {
  d.surfaces[0].id = 'caf\u00e9'; d.surfaces[1].id = 'cafe\u0301'; d.navigation[0].surface = 'cafe\u0301'; d.navigation[1].surface = 'caf\u00e9';
}));
add('whitespace-only title accepted', 'boundary', mut((d) => { d.surfaces[0].title = ' '; }));
add('empty title rejected', 'missing', mut((d) => { d.surfaces[0].title = ''; }));
add('markup in text is data', 'valid', mut((d) => { d.navigation[0].label = '<img src=x onerror=alert(1)>'; }));
add('control characters in label', 'unicode', mut((d) => { d.navigation[0].label = 'a\u0000b\u001f\u2028'; }));
addRaw('lone surrogate in title', 'unicode', rawEdit('"title":"Keys"', '"title":"\\ud800"'));
addRaw('escaped astral pair in title', 'unicode', rawEdit('"title":"Keys"', '"title":"\\ud83d\\ude00"'));

// --- capability names ----------------------------------------------------------
for (const [label, name, category] of [
  ['128-char name', `a.${s(126, 'b')}`, 'boundary'],
  ['129-char name rejected', `a.${s(127, 'b')}`, 'boundary'],
  ['uppercase rejected', 'Apikeys.read', 'invalid-type'],
  ['single segment rejected', 'apikeys', 'invalid-type'],
  ['trailing dot rejected', 'apikeys.', 'invalid-type'],
  ['empty segment rejected', 'a..b', 'invalid-type'],
  ['digit first rejected', '1a.b', 'invalid-type'],
  ['digits after first allowed', 'a1.b2c3', 'valid'],
  ['hyphen rejected', 'a.b-c', 'invalid-type'],
  ['underscore rejected', 'a.b_c', 'invalid-type'],
  ['non-ASCII rejected', 'caf\u00e9.read', 'unicode'],
  ['reserved segment http rejected', 'a.http', 'invalid-type'],
  ['reserved segment first rejected', 'grpc.call', 'invalid-type'],
  ['reserved word as substring allowed', 'a.https2', 'valid'],
]) add(`capability: ${label}`, category, mut((d) => { d.surfaces[0].capabilities = [name]; }));
add('capability: number rejected', 'invalid-type', mut((d) => { d.surfaces[0].capabilities = [5]; }));
add('capability: null rejected', 'invalid-type', mut((d) => { d.surfaces[0].capabilities = [null]; }));
add('capabilities missing rejected', 'missing', mut((d) => { delete d.surfaces[0].capabilities; }));
add('capabilities not an array rejected', 'invalid-type', mut((d) => { d.surfaces[0].capabilities = 'apikeys.read'; }));
add('duplicate capability in a surface kept', 'valid', mut((d) => { d.surfaces[0].capabilities = ['apikeys.read', 'apikeys.read']; }));

// --- routes ----------------------------------------------------------------------
for (const [route, category] of [
  ['/', 'boundary'], ['//evil.example/x', 'invalid-type'], ['/a://b', 'invalid-type'], ['https://evil.example/', 'invalid-type'],
  ['relative', 'invalid-type'], ['javascript:alert(1)', 'invalid-type'], ['/ok/../../escape', 'security'], ['/a b', 'security'],
  ['/a\\b', 'security'], ['/a?x=1', 'security'], ['/a#frag', 'security'], ['/a\u0000', 'security'], ['/caf\u00e9', 'unicode'],
]) add(`route ${JSON.stringify(route)}`, category, mut((d) => { d.surfaces[0].route = route; }));

// --- structure, missing fields, invalid types -------------------------------------
for (const [label, value] of [['null', null], ['array', []], ['string', 'x'], ['number', 5], ['true', true]]) {
  add(`top-level ${label} rejected`, 'invalid-type', value);
}
for (const [label, protocol] of [
  ['missing', undefined], ['null', null], ['number', 1], ['1e21', 1e21], ['boolean', true], ['AppPort/ui/2', 'AppPort/ui/2'],
  ['lowercase', 'appport/ui/1'], ['nested array', ['a', ['b', null], 1.5]], ['object', {}],
]) add(`protocol ${label} rejected`, 'protocol', mut((d) => { if (protocol === undefined) delete d.protocol; else d.protocol = protocol; }));
add('protocol object with own toString (JS TypeError)', 'protocol', mut((d) => { d.protocol = { toString: 'x' }; }));
add('protocol array holding such an object (JS TypeError)', 'protocol', mut((d) => { d.protocol = [{ toString: 1 }]; }));
add('product missing', 'missing', mut((d) => { delete d.product; }));
add('product array', 'invalid-type', mut((d) => { d.product = ['demo']; }));
add('product.id missing', 'missing', mut((d) => { delete d.product.id; }));
add('product.version number', 'invalid-type', mut((d) => { d.product.version = 1; }));
add('product.id 513 chars', 'boundary', mut((d) => { d.product.id = s(513); }));
add('surfaces missing', 'missing', mut((d) => { delete d.surfaces; }));
add('navigation object', 'invalid-type', mut((d) => { d.navigation = {}; }));
add('surface null', 'invalid-type', mut((d) => { d.surfaces[1] = null; }));
add('surface array', 'invalid-type', mut((d) => { d.surfaces[1] = []; }));
add('surface id number', 'invalid-type', mut((d) => { d.surfaces[0].id = 1; }));
add('navigation entry string', 'invalid-type', mut((d) => { d.navigation[1] = 'n'; }));
add('navigation surface missing', 'missing', mut((d) => { delete d.navigation[0].surface; }));
add('navigation group missing', 'missing', mut((d) => { delete d.navigation[0].group; }));
add('duplicate surface id', 'duplicate', mut((d) => { d.surfaces[1].id = 'keys'; }));
add('duplicate navigation id', 'duplicate', mut((d) => { d.navigation[1].id = 'n.jobs'; }));
add('unknown navigation surface', 'duplicate', mut((d) => { d.navigation[0].surface = 'nope'; }));
add('composition missing', 'missing', mut((d) => { delete d.composition; }));
add('composition null', 'invalid-type', mut((d) => { d.composition = null; }));
add('composition.requires missing', 'missing', mut((d) => { d.composition = {}; }));
add('composition.requires unknown', 'invalid-type', mut((d) => { d.composition.requires = ['admin']; }));
add('composition.requires number', 'invalid-type', mut((d) => { d.composition.requires = [1]; }));
add('composition.requires string', 'invalid-type', mut((d) => { d.composition.requires = 'identity'; }));

// --- error ordering: several defects, the first reported must match -----------------
add('order: bad product and bad surfaces', 'ordering', mut((d) => { d.product.id = ''; d.surfaces = 1; }));
add('order: bad route then bad capabilities', 'ordering', mut((d) => { d.surfaces[0].route = 'x'; d.surfaces[0].capabilities = ['X']; }));
add('order: duplicate surface and bad nav', 'ordering', mut((d) => { d.surfaces[1].id = 'keys'; d.navigation[0] = null; }));
add('order: nav order before label', 'ordering', mut((d) => { d.navigation[0].order = 'x'; d.navigation[0].label = ''; }));
add('order: unknown surface vs bad composition', 'ordering', mut((d) => { d.navigation[0].surface = 'nope'; d.composition = null; }));
add('order: second surface invalid and duplicate nav', 'ordering', mut((d) => { d.surfaces[1].title = ''; d.navigation[1].id = 'n.jobs'; }));

// --- raw JSON wire quirks -------------------------------------------------------------
addRaw('duplicate key: last protocol wins', 'raw', BASE_RAW.replace('{"protocol":"AppPort/ui/1"', '{"protocol":"AppPort/ui/9","protocol":"AppPort/ui/1"'));
addRaw('__proto__ key is plain data', 'raw', BASE_RAW.replace('{"protocol"', '{"__proto__":{"protocol":"x"},"protocol"'));
addRaw('whitespace and escapes', 'raw', ` \n${BASE_RAW.replace('"Keys"', '"K\\u0065ys"')}\t`);

// --- scale ---------------------------------------------------------------------------
const many = (n) => ({
  protocol: 'AppPort/ui/1',
  product: { id: 'large', version: '1.0.0' },
  surfaces: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `Surface ${i}`, route: `/s/${i}`, capabilities: [`svc${i % 7}.read`, `svc${i % 7}.write`] })),
  navigation: Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `Surface ${i}`, group: `G${i % 4}`, order: i, surface: `s${i}` })),
  composition: { requires: [] },
});
add('64 surfaces (Compute MAX_LINKS)', 'scale', many(64));
add('65 surfaces (over Compute MAX_LINKS)', 'scale', many(65));
add('1000 surfaces', 'scale', many(1000));

// --- filter (createUiDiscoveryDocument path) ------------------------------------------
const full = JSON.stringify(APPPORT_UI_CONTRIBUTIONS[0]);
for (const [label, available] of [
  ['no capabilities', []],
  ['api keys only', ['apikeys.read', 'apikeys.create', 'apikeys.revoke']],
  ['partial api keys hides the surface', ['apikeys.read']],
  ['everything', APPPORT_UI_CONTRIBUTIONS[0].surfaces.flatMap((x) => x.capabilities)],
  ['unknown extra names', ['zz.top', 'apikeys.read', 'apikeys.create', 'apikeys.revoke', 'a.a']],
]) addRaw(`filter: ${label}`, 'filter', full, { op: 'filter', available });
addRaw('filter: invalid document is rejected before filtering', 'filter', JSON.stringify(mut((d) => { d.protocol = 'x'; })), { op: 'filter', available: [] });

for (const c of cases) {
  const expected = oracle({ op: c.op, value: JSON.parse(c.raw), available: c.available });
  // Only the serialized form is stored: a result can hold a lone surrogate,
  // which JSON.stringify escapes but a UTF-8 string type cannot hold.
  c.expectedOk = expected.ok;
  c.expectedJson = JSON.stringify(expected);
}
const names = new Set();
for (const c of cases) { if (names.has(c.name)) throw new Error(`duplicate case ${c.name}`); names.add(c.name); }
writeFileSync(here('../fixtures/ui-contract-corpus.json'), JSON.stringify({
  oracle: '@appport/protocol@1.0.3 validateUiContribution/filterUiContribution (as resolved by @appport/services 0.4.12)',
  cases,
}, null, 1) + '\n');
const accepted = cases.filter((c) => c.expectedOk).length;
console.log(`${cases.length} cases (${accepted} accepted, ${cases.length - accepted} rejected)`);
