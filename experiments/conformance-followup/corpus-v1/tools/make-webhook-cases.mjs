// webhook-signature-1: both documented @appport/services schemes.
//   outbound (README "Webhooks"): X-AppPort-Signature = hex(HMAC-SHA256(secret, body))
//   inbound (docs/WEBHOOK-SECURITY.md): x-appport-signature = hex(HMAC-SHA256(secret, `${x-appport-timestamp}.${rawBody}`))
// Secrets straddle the HMAC block size (64 bytes), where keys are hashed: an
// implementation that pre-hashes every key agrees only above it.
import { writeFileSync } from 'node:fs';
const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { amount: 4200, note: 'café ☕' } });
const timestamp = '2026-09-10T22:30:00.000Z';
const secrets = { 'len-1': 'k', 'len-32': 'k'.repeat(32), 'len-63': 'k'.repeat(63), 'len-64': 'k'.repeat(64), 'len-65': 'k'.repeat(65), 'len-200': 'k'.repeat(200), 'utf8-multibyte-40b': 'é'.repeat(20) };
const cases = [];
for (const scheme of ['outbound', 'inbound']) {
  for (const [name, secret] of Object.entries(secrets)) {
    const big = Buffer.byteLength(secret) > 64;
    cases.push({ id: `wh1.${scheme}.secret-${name}`, class: big ? 'valid' : 'security', scheme, title: `${scheme}, secret ${Buffer.byteLength(secret)} bytes`,
      input: { secret, body, timestamp }, requirements: ['hmac-sha256-rfc2104', 'hex-lowercase', 'secret-is-utf8-bytes-unhashed'],
      ...(big ? {} : { security: { rationale: 'Secrets of 64 bytes or less are used as the HMAC key directly (RFC 2104). An implementation that pre-hashes the key (sha256(secret)) disagrees here and rejects every genuine signature (assessment F-01).' } }) });
  }
  cases.push({ id: `wh1.${scheme}.empty-body`, class: 'boundary', scheme, title: `${scheme}, empty body`, input: { secret: secrets['len-32'], body: '', timestamp }, requirements: ['hmac-sha256-rfc2104'] });
  cases.push({ id: `wh1.${scheme}.body-bytes-not-reserialized`, class: 'boundary', scheme, title: `${scheme}, whitespace-significant body`, input: { secret: secrets['len-32'], body: '{ "a" : 1 }\n', timestamp }, requirements: ['sign-raw-body-bytes'] });
}
writeFileSync(new URL('../webhook-signature-1/cases.json', import.meta.url), JSON.stringify({ contract: '@appport/services webhook signatures', corpus: 'webhook-signature-1', corpusVersion: '1.0.0',
  operations: { outbound: 'signWebhookPayload(secret, body)', inbound: 'signWebhookPayload(secret, `${timestamp}.${body}`)' }, cases }, null, 1) + '\n');
console.log(cases.length, 'cases');
