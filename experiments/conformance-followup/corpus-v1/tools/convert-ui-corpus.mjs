// One-time conversion of the assessment corpus (rust-interop/fixtures/ui-contract-corpus.json)
// into the v1 layout: stable ids, a class, requirements and rationale. Inputs are
// copied byte for byte; expectations are NOT copied (bless.mjs regenerates them
// from the reference and must reproduce the assessment's results).
import { readFileSync, writeFileSync } from 'node:fs';

const old = JSON.parse(readFileSync(new URL('../../../rust-interop/fixtures/ui-contract-corpus.json', import.meta.url), 'utf8')).cases;
const ROUTE_WORDS = [[/^route "\/"$/, 'route-root'], [/\\u0000/, '-nul'], [/\\\\/, '-backslash'], [/\?/, '-query'], [/#/, '-fragment'], [/ b"/, '-space'], [/\.\./, '-dot-segments'], [/caf/, '-non-ascii']];
const ROUTE_IDS = { 'route "/"': 'route-root', 'route "//evil.example/x"': 'route-scheme-relative', 'route "/a://b"': 'route-embedded-scheme', 'route "https://evil.example/"': 'route-absolute-url', 'route "javascript:alert(1)"': 'route-javascript-url' };
const routeSlug = (name) => { if (!name.startsWith('route ')) return null; if (ROUTE_IDS[name]) return ROUTE_IDS[name]; let out = ''; for (const [re, w] of ROUTE_WORDS.slice(1)) if (re.test(name)) out += w; return out ? `route${out}` : null; };
const slug = (s) => routeSlug(s) ?? s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const security = {
  'route "/ok/../../escape"': 'Dot segments can leave the product path once a host joins the route to a base URL; the protocol accepts it, hosts must not resolve it outside the product origin/path.',
  'route "/a b"': 'Whitespace in a route; accepted by the protocol, refused by Compute. Hosts building URLs must encode, not concatenate.',
  'route "/a\\\\b"': 'Backslash is treated as a path separator by WHATWG URL parsing in browsers; accepted by the protocol.',
  'route "/a?x=1"': 'A query in a route lets a product steer parameters of the host-built link; accepted by the protocol.',
  'route "/a#frag"': 'A fragment in a route; accepted by the protocol.',
  'route "/a\\u0000"': 'A control character in a route; accepted by the protocol.',
  'route "//evil.example/x"': 'Scheme-relative URL would navigate to another origin; must be rejected.',
  'route "https://evil.example/"': 'Absolute URL to another origin; must be rejected.',
  'route "javascript:alert(1)"': 'Script URL; must be rejected (does not start with "/").',
  'route "/a://b"': 'Embedded scheme separator; must be rejected.',
  'markup in text is data': 'Text fields are data; consumers must render as text, never markup.',
  'protocol object with own toString (JS TypeError)': 'Hostile protocol field makes the reference throw a non-protocol TypeError (reported as INTERNAL_ERROR by servers). Known defect: see versioned case plan in SPEC.md.',
  'protocol array holding such an object (JS TypeError)': 'Same defect through Array.prototype.toString.',
  'capability: reserved segment http rejected': 'Transport words must never appear in capability names (spec §8).',
};
// Known reference defects: the reference's current output stays the blessed
// expectation (nothing is silently relaxed), and the intended outcome is recorded
// so consumers may implement it now and the reference fix is a reviewed re-bless.
const defects = {
  'protocol object with own toString (JS TypeError)': { finding: 'F-05', summary: 'String(value.protocol) throws TypeError for an object with an own non-callable toString; servers report INTERNAL_ERROR.', intended: { verdict: 'reject', code: 'INVALID_PROTOCOL', field: null } },
  'protocol array holding such an object (JS TypeError)': { finding: 'F-05', summary: 'Same, through Array.prototype.toString.', intended: { verdict: 'reject', code: 'INVALID_PROTOCOL', field: null } },
};
const classOf = (c) => {
  if (security[c.name]) return 'security';
  if (['real', 'valid'].includes(c.category)) return 'valid';
  if (['boundary', 'unicode', 'raw-number', 'raw', 'scale'].includes(c.category)) return 'boundary';
  if (c.category === 'filter') return c.expectedOk ? 'valid' : 'invalid';
  return 'invalid';
};
const requirements = (c) => [
  ...(/astral|UTF-16|512|513|surrogate|two-byte|128-char|129-char/.test(c.name) ? ['length-utf16-code-units'] : []),
  ...(/NFC|NFD/.test(c.name) ? ['no-unicode-normalization'] : []),
  ...(c.category === 'raw-number' || /1e21|2\^53/.test(c.name) ? ['order-is-ecmascript-integer'] : []),
  ...(/surrogate/.test(c.name) ? ['lone-surrogate-not-representable-in-utf8'] : []),
  ...(c.category === 'ordering' ? ['first-error-wins-check-order'] : []),
  ...(c.category === 'raw' ? ['raw-json-wire-quirk'] : []),
];
const used = new Set();
const cases = old.map((c) => {
  const cls = classOf(c);
  let id = `ui1.${slug(c.name)}`;
  for (let i = 2; used.has(id); i++) id = `ui1.${slug(c.name)}-${i}`;
  used.add(id);
  return {
    id, class: cls, title: c.name, op: c.op, ...(c.available ? { available: c.available } : {}),
    input: { json: c.raw },
    ...(requirements(c).length ? { requirements: requirements(c) } : {}),
    ...(security[c.name] ? { security: { rationale: security[c.name] } } : {}),
    ...(defects[c.name] ? { referenceDefect: defects[c.name] } : {}),
  };
});
writeFileSync(new URL('../appport-ui-1/cases.json', import.meta.url), JSON.stringify({
  contract: 'AppPort/ui/1', corpus: 'appport-ui-1', corpusVersion: '1.0.0',
  operations: { validate: 'validateUiContribution(JSON.parse(input.json))', filter: 'filterUiContribution(validateUiContribution(JSON.parse(input.json)), available)' },
  resultEnvelope: '{ok:true,value} | {ok:false,error:{code,message,details?}} | {ok:false,internal:<JS error name>}',
  cases,
}, null, 1) + '\n');
const counts = {}; for (const c of cases) counts[c.class] = (counts[c.class] ?? 0) + 1;
console.log(cases.length, counts);
