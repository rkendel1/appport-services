import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, for S3 and S3-compatible stores (Cloudflare R2,
 * MinIO, ...): request signing (the `Authorization` header) and query-string
 * presigning. Implemented from the AWS SigV4 specification and verified
 * against AWS's published S3 examples (tests/sigv4.test.ts).
 */
export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface SigV4Scope {
  readonly region: string;
  /** `s3` for object storage. */
  readonly service: string;
}

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const EMPTY_PAYLOAD_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** RFC 3986 encoding as SigV4 requires: unreserved characters kept, everything else %XX (upper case). */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(char) || (!encodeSlash && char === '/')) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** `20130524T000000Z` */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
}

/** The canonical URI of a URL: each path segment decoded once and encoded once (S3 does not double-encode). */
export function canonicalUri(url: URL): string {
  const path = url.pathname || '/';
  return path.split('/').map((segment) => uriEncode(safeDecode(segment))).join('/') || '/';
}

/** Sorted, encoded query parameters (a parameter without a value signs as `name=`). */
export function canonicalQuery(params: Iterable<readonly [string, string]>): string {
  return [...params]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function canonicalHeaders(headers: Readonly<Record<string, string>>): { canonical: string; signed: string } {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value).trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(''), signed: entries.map(([name]) => name).join(';') };
}

export function signingKey(secretAccessKey: string, day: string, scope: SigV4Scope): Buffer {
  const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(day).digest();
  const kRegion = createHmac('sha256', kDate).update(scope.region).digest();
  const kService = createHmac('sha256', kRegion).update(scope.service).digest();
  return createHmac('sha256', kService).update('aws4_request').digest();
}

/** The pieces of one signature, for tests and diagnostics. */
export interface SigV4Signature {
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
  readonly signedHeaders: string;
  readonly credentialScope: string;
}

function sign(method: string, url: URL, query: Iterable<readonly [string, string]>, headers: Readonly<Record<string, string>>, payloadHash: string, credentials: SigV4Credentials, scope: SigV4Scope, date: Date): SigV4Signature {
  const timestamp = amzDate(date);
  const day = timestamp.slice(0, 8);
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const { canonical, signed } = canonicalHeaders(headers);
  const canonicalRequest = [method.toUpperCase(), canonicalUri(url), canonicalQuery(query), canonical, signed, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(credentials.secretAccessKey, day, scope)).update(stringToSign).digest('hex');
  return { canonicalRequest, stringToSign, signature, signedHeaders: signed, credentialScope };
}

export interface SignRequestInput {
  readonly method: string;
  readonly url: string | URL;
  /** Headers to send and sign. `host`, `x-amz-date` and `x-amz-content-sha256` are added. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or UNSIGNED_PAYLOAD. Default: the empty body's hash. */
  readonly payloadHash?: string;
  readonly credentials: SigV4Credentials;
  readonly scope: SigV4Scope;
  readonly date: Date;
}

/** Sign a request with the `Authorization` header. Returns every header to send (host included). */
export function signRequest(input: SignRequestInput): { readonly headers: Record<string, string>; readonly signature: SigV4Signature } {
  const url = typeof input.url === 'string' ? new URL(input.url) : input.url;
  const payloadHash = input.payloadHash ?? EMPTY_PAYLOAD_SHA256;
  const headers: Record<string, string> = {
    ...lowerCaseKeys(input.headers ?? {}),
    host: url.host,
    'x-amz-date': amzDate(input.date),
    ...(input.scope.service === 's3' ? { 'x-amz-content-sha256': payloadHash } : {}),
    ...(input.credentials.sessionToken ? { 'x-amz-security-token': input.credentials.sessionToken } : {}),
  };
  const signature = sign(input.method, url, url.searchParams, headers, payloadHash, input.credentials, input.scope, input.date);
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${signature.credentialScope}, SignedHeaders=${signature.signedHeaders}, Signature=${signature.signature}`;
  return { headers, signature };
}

export interface PresignInput {
  readonly method: string;
  readonly url: string | URL;
  readonly credentials: SigV4Credentials;
  readonly scope: SigV4Scope;
  readonly date: Date;
  /** 1 to 604800 (7 days). */
  readonly expiresSeconds: number;
  /** Extra headers the client must send exactly (signed). `host` is always signed. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A presigned URL (query-string authentication, unsigned payload). */
export function presignUrl(input: PresignInput): { readonly url: string; readonly signature: SigV4Signature } {
  if (!Number.isInteger(input.expiresSeconds) || input.expiresSeconds < 1 || input.expiresSeconds > 604_800) throw new RangeError('expiresSeconds must be an integer from 1 to 604800');
  const url = new URL(typeof input.url === 'string' ? input.url : input.url.toString());
  const timestamp = amzDate(input.date);
  const day = timestamp.slice(0, 8);
  const headers = { ...lowerCaseKeys(input.headers ?? {}), host: url.host };
  const signedHeaders = Object.keys(headers).map((name) => name.toLowerCase()).sort().join(';');
  url.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256');
  url.searchParams.set('X-Amz-Credential', `${input.credentials.accessKeyId}/${day}/${input.scope.region}/${input.scope.service}/aws4_request`);
  url.searchParams.set('X-Amz-Date', timestamp);
  url.searchParams.set('X-Amz-Expires', String(input.expiresSeconds));
  if (input.credentials.sessionToken) url.searchParams.set('X-Amz-Security-Token', input.credentials.sessionToken);
  url.searchParams.set('X-Amz-SignedHeaders', signedHeaders);
  const signature = sign(input.method, url, url.searchParams, headers, UNSIGNED_PAYLOAD, input.credentials, input.scope, input.date);
  // The query with SigV4 encoding (exactly the signed string), then the signature, as AWS's own presigned URLs.
  const query = canonicalQuery(url.searchParams);
  return { url: `${url.origin}${canonicalUri(url)}?${query}&X-Amz-Signature=${signature.signature}`, signature };
}

/**
 * Verify a presigned URL or a header-signed request (used by test servers and
 * by hosts that proxy uploads). Returns true when the signature matches and,
 * for a presigned URL, it has not expired at `now`.
 */
export function verifySignature(input: { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string | string[] | undefined>>; readonly credentials: SigV4Credentials; readonly scope: SigV4Scope; readonly now?: Date }): boolean {
  const url = new URL(input.url);
  const lower = Object.fromEntries(Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value.join(',') : value ?? '']));
  const presigned = url.searchParams.get('X-Amz-Signature');
  if (presigned) {
    const timestamp = url.searchParams.get('X-Amz-Date') ?? '';
    const expires = Number(url.searchParams.get('X-Amz-Expires'));
    const date = parseAmzDate(timestamp);
    if (!date || !Number.isInteger(expires)) return false;
    if ((input.now ?? new Date()).getTime() > date.getTime() + expires * 1000) return false;
    const signed = (url.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';').filter(Boolean);
    const headers = Object.fromEntries(signed.map((name) => [name, lower[name] ?? '']));
    const query = [...url.searchParams].filter(([name]) => name !== 'X-Amz-Signature');
    const expected = sign(input.method, url, query, headers, UNSIGNED_PAYLOAD, input.credentials, input.scope, date).signature;
    return timingSafeEqualHex(expected, presigned);
  }
  const authorization = lower.authorization ?? '';
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/[^,]+, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(authorization);
  if (!match || match[1] !== input.credentials.accessKeyId) return false;
  const date = parseAmzDate(lower['x-amz-date'] ?? '');
  if (!date) return false;
  const headers = Object.fromEntries(match[2]!.split(';').map((name) => [name, lower[name] ?? '']));
  const expected = sign(input.method, url, url.searchParams, headers, lower['x-amz-content-sha256'] || EMPTY_PAYLOAD_SHA256, input.credentials, input.scope, date).signature;
  return timingSafeEqualHex(expected, match[3]!);
}

function parseAmzDate(value: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  return match ? new Date(Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +match[6]!)) : null;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function lowerCaseKeys(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function safeDecode(segment: string): string {
  try { return decodeURIComponent(segment); } catch { return segment; }
}
