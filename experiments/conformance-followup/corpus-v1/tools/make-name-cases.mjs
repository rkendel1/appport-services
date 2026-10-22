// capability-name-1: AppPort names (spec §8, @appport/protocol names.ts) and name@version refs.
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
// Ids: a readable slug plus 6 hex of sha256(text), so near-identical strings stay distinct and ids stay stable.
const h = (t) => createHash('sha256').update(t).digest('hex').slice(0, 6);
const names = [
  ['valid', 'documents.save'], ['valid', 'crm.contacts.read'], ['valid', 'a1.b2c3'], ['valid', 'a.https2'], ['boundary', `a.${'b'.repeat(126)}`],
  ['boundary', `a.${'b'.repeat(127)}`], ['invalid', 'documents'], ['invalid', 'Documents.save'], ['invalid', 'documents.Save'], ['invalid', 'crm_x.read'],
  ['invalid', 'crm.read-all'], ['invalid', '1crm.read'], ['invalid', 'a..b'], ['invalid', '.a.b'], ['invalid', 'a.b.'], ['invalid', ''], ['invalid', ' a.b'],
  ['security', 'http.get'], ['security', 'a.grpc'], ['security', 'inprocess.call'], ['boundary', 'café.read'], ['boundary', 'a.b\u0000'],
  ['invalid', 'documents.save@1'], ['invalid', 'jobs@9.enqueue'], ['invalid', 'appport.jobs@0.4.5.enqueue'], ['invalid', 'api_keys.create'], ['invalid', 'webhooks.createWebhookEndpoint'],
];
const refs = [
  ['valid', 'documents.save@1'], ['valid', 'documents.save@12'], ['invalid', 'documents.save'], ['invalid', 'documents.save@0'], ['invalid', 'documents.save@-1'],
  ['boundary', 'documents.save@1.0'], ['boundary', 'documents.save@01'], ['boundary', 'documents.save@0x1'], ['boundary', 'documents.save@1e0'],
  ['boundary', 'documents.save@+1'], ['boundary', 'documents.save@ 1'], ['boundary', 'documents.save@1 '], ['invalid', 'documents.save@v1'], ['invalid', 'documents.save@'], ['boundary', 'a@b.c@1'],
  ['invalid', 'jobs@9.enqueue'], ['boundary', 'documents.save@9007199254740993'],
];
const slug = (s) => s.replace(/\u0000/g, 'nul').replace(/[A-Z]/g, (c) => `-uc-${c.toLowerCase()}`).replace(/ /g, '-sp-').replace(/_/g, '-us-').replace(/\.\./g, '-dotdot-').replace(/^\./, 'lead-dot-').replace(/\.$/, '-trail-dot').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 50) || 'empty';
const cases = [];
for (const [cls, text] of names) cases.push({ id: `name1.name.${slug(text).slice(0, 30)}-${h(text)}`, class: cls, op: 'name', title: JSON.stringify(text), input: { text },
  ...(cls === 'security' ? { security: { rationale: 'Names must not encode a transport (spec §8); an implementation that accepts these can bind authorization to transport-specific names.' } } : {}) });
const NONCANONICAL = /@(1\.0|01|0x1|1e0|\+1| 1|1 |9007199254740993)$/;
for (const [cls, text] of refs) cases.push({ id: `name1.ref.${slug(text).slice(0, 30)}-${h(text)}`, class: cls, op: 'ref', title: JSON.stringify(text), input: { text },
  ...(NONCANONICAL.test(text) ? { decisionRequired: { finding: 'F-04b', question: 'parseCapabilityRef parses the version with Number(): non-canonical spellings (and integers above 2^53, rounded) yield a valid ref. Should a reference be canonical (^[1-9][0-9]*$, safe integer)?' } } : {}) });
const ids = new Set(); for (const c of cases) { if (ids.has(c.id)) throw new Error(c.id); ids.add(c.id); }
writeFileSync(new URL('../capability-name-1/cases.json', import.meta.url), JSON.stringify({ contract: 'AppPort capability names and references (spec §8)', corpus: 'capability-name-1', corpusVersion: '1.0.0',
  operations: { name: 'validateName(text)', ref: 'parseCapabilityRef(text)' }, cases }, null, 1) + '\n');
console.log(cases.length, 'cases');
