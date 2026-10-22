// Signature vectors produced by @appport/services' own signer (the TS contract).
import { writeFileSync } from 'node:fs';
import { signWebhookPayload, verifyWebhookSignature } from '../../../dist/src/webhooks/secrets.js';

const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { amount: 4200, note: 'café ☕' }, timestamp: '2026-09-10T22:30:00Z' });
const timestamp = '2026-09-10T22:30:00.000Z';
const vectors = [];
for (const length of [1, 16, 32, 63, 64, 65, 100]) {
  const secret = 'k'.repeat(length - 1) + 'é'.slice(0, length > 1 ? 1 : 0) || 'k';
  vectors.push({
    secretLength: Buffer.byteLength(secret), secret, body, timestamp,
    // Outbound delivery (README §webhooks): X-AppPort-Signature = HMAC-SHA256(secret, body).
    outbound: signWebhookPayload(secret, body),
    // Inbound receive (docs/WEBHOOK-SECURITY.md): HMAC-SHA256(secret, `${timestamp}.${rawBody}`).
    inbound: signWebhookPayload(secret, `${timestamp}.${body}`),
  });
  if (!verifyWebhookSignature(secret, `${timestamp}.${body}`, vectors.at(-1).inbound)) throw new Error('self-check');
}
writeFileSync(new URL('../fixtures/webhook-signature-vectors.json', import.meta.url), JSON.stringify({ source: '@appport/services 0.4.12 src/webhooks/secrets.ts', vectors }, null, 1) + '\n');
console.log(vectors.map((v) => v.secretLength).join(','));
