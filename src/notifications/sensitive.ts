/**
 * Credential boundary for notification content.
 *
 * Notifications are durable, fan out to channels, and are shown to people, so
 * infrastructure credentials must never enter them. Content is rejected rather
 * than silently scrubbed: a producer that tries to send a credential has a bug
 * that should surface, and rejecting keeps the stored record exactly what was
 * accepted.
 */

/** Normalized (lowercase, alphanumeric only) key names that always carry credentials. */
const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'pwd', 'passphrase',
  'cookie', 'cookies', 'setcookie', 'sessioncookie', 'sessionid', 'sid',
  'authorization', 'proxyauthorization', 'auth', 'bearer',
  'refreshtoken', 'accesstoken', 'idtoken', 'sessiontoken', 'authtoken', 'csrftoken', 'xsrftoken', 'token',
  'apikey', 'xapikey', 'apisecret', 'clientsecret', 'secret', 'secretkey',
  'privatekey', 'signingkey', 'signingsecret', 'credential', 'credentials',
]);

/** Key suffixes that indicate credentials (e.g. `githubToken`, `dbPassword`). */
const SENSITIVE_KEY_SUFFIXES = ['password', 'passwd', 'token', 'secret', 'apikey', 'cookie', 'cookies', 'privatekey', 'signingkey', 'authorization', 'credential', 'credentials'];

/** Value shapes that are credentials regardless of the key they appear under. */
const SENSITIVE_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9\-._~+/]{8,}=*/i,
  /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9])/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /\bapp_live_[0-9a-f]{6}_[A-Za-z0-9_-]{16,}/, // AppPort API key
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/, // Stripe-style secret keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\b(?:session|sessionid|sid|connect\.sid|__Secure-[\w-]+|__Host-[\w-]+)=[^;\s]{8,}/i, // cookie header fragments
];

export class NotificationSensitiveDataError extends Error {
  constructor(readonly path: string) {
    super(`Notification content at "${path}" looks like a credential; credentials cannot be sent in notifications`);
    this.name = 'NotificationSensitiveDataError';
  }
}

function normalizeKey(key: string): string { return key.toLowerCase().replace(/[^a-z0-9]/g, ''); }

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEYS.has(normalized) || SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Throws NotificationSensitiveDataError when `value` contains a credential-named
 * key or a credential-shaped string anywhere in its structure. The error names
 * the offending path but never echoes the value.
 */
export function assertNoCredentials(value: unknown, path: string, seen = new Set<unknown>()): void {
  if (typeof value === 'string') {
    if (isSensitiveValue(value)) throw new NotificationSensitiveDataError(path);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentials(entry, `${path}[${index}]`, seen));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (isSensitiveKey(key) && entry !== null && entry !== undefined && entry !== '' && entry !== false) throw new NotificationSensitiveDataError(entryPath);
    assertNoCredentials(entry, entryPath, seen);
  }
}
