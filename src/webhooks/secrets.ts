import { createHmac, timingSafeEqual } from 'node:crypto';

// Webhook signing secrets live in AuthBoundry credential custody and are
// referenced by credential-ref. This module only computes and checks HMACs
// with material resolved for one authorized effect.

export function signWebhookPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyWebhookSignature(secret: string, payload: string, signature: string): boolean {
  const expected = Buffer.from(signWebhookPayload(secret, payload), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Resolved credential values may be strings or objects carrying a signing secret. */
export function signingSecretValue(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value && typeof value === 'object') {
    const candidate = (value as Record<string, unknown>).signingSecret ?? (value as Record<string, unknown>).secret;
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  throw new Error('Resolved credential does not contain a signing secret');
}
