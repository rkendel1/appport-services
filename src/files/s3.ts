import { isCredentialRef } from '../authority/credentials.js';
import { ServiceAuthorityError } from '../authority/errors.js';
import type { OutboundHttpResponse } from '../authority/outbound.js';
import type { FileObjectStore, ObjectPart, ObjectStoreContext, PresignedRequest } from './objects.js';
import { presignUrl, sha256Hex, signRequest, uriEncode, type SigV4Credentials } from './sigv4.js';

export interface S3ObjectStoreOptions {
  readonly bucket: string;
  /** AWS region; `auto` for Cloudflare R2. */
  readonly region: string;
  /**
   * Service endpoint. Default `https://s3.<region>.amazonaws.com`. For R2:
   * `https://<account>.r2.cloudflarestorage.com`; for MinIO, its URL.
   */
  readonly endpoint?: string;
  /** Path-style URLs (`<endpoint>/<bucket>/<key>`). Default true with a custom endpoint, false for AWS. */
  readonly forcePathStyle?: boolean;
  /** Not secret: the access key id. */
  readonly accessKeyId: string;
  /**
   * Credential reference (`credential-ref:<id>`) to the secret access key in
   * custody: a string, or `{ secretAccessKey, sessionToken? }`. Never the key itself.
   */
  readonly credentialRef: string;
  /** Prefix for every object key (for example the application name). */
  readonly prefix?: string;
  /** Store id recorded on files and in evidence. Default `s3`. */
  readonly id?: string;
  /** Smallest non-final part. Default 5 MiB (the S3 minimum). */
  readonly minPartSize?: number;
}

/**
 * S3 and S3-compatible object storage (AWS S3, Cloudflare R2, MinIO) over
 * plain HTTPS with SigV4: single-request put/get/head/delete, multipart
 * upload for resumable uploads, and presigned upload, part and download URLs
 * so clients move large objects without passing through the host. Every call
 * goes through the gateway's outbound client inside an authorized effect.
 */
export class S3ObjectStore implements FileObjectStore {
  readonly id: string;
  readonly credentialRef: string;
  readonly minPartSize: number;
  readonly maxPartSize = 5 * 1024 * 1024 * 1024;
  private readonly endpoint: URL;
  private readonly pathStyle: boolean;
  private readonly prefix: string;

  constructor(private readonly options: S3ObjectStoreOptions) {
    if (!options.bucket || !/^[a-z0-9][a-z0-9.-]{1,62}$/.test(options.bucket)) throw new TypeError('S3ObjectStore: bucket is invalid');
    if (!options.region || !/^[a-z0-9-]{1,32}$/.test(options.region)) throw new TypeError('S3ObjectStore: region is invalid');
    if (!options.accessKeyId) throw new TypeError('S3ObjectStore: accessKeyId is required');
    if (!isCredentialRef(options.credentialRef)) throw new TypeError('S3ObjectStore: credentialRef must be a credential-ref:<id>, never the secret key');
    this.id = options.id ?? 's3';
    this.credentialRef = options.credentialRef;
    this.minPartSize = options.minPartSize ?? 5 * 1024 * 1024;
    this.endpoint = new URL(options.endpoint ?? `https://s3.${options.region}.amazonaws.com`);
    this.pathStyle = options.forcePathStyle ?? Boolean(options.endpoint);
    this.prefix = (options.prefix ?? '').replace(/^\/+|\/+$/g, '');
  }

  /** The object URL for a key (without query). */
  objectUrl(key: string): URL {
    const objectKey = this.prefix ? `${this.prefix}/${key}` : key;
    const encodedKey = objectKey.split('/').map((segment) => uriEncode(segment)).join('/');
    const base = this.endpoint.toString().replace(/\/+$/, '');
    if (this.pathStyle) return new URL(`${base}/${this.options.bucket}/${encodedKey}`);
    const url = new URL(base);
    url.hostname = `${this.options.bucket}.${url.hostname}`;
    url.pathname = `/${encodedKey}`;
    return url;
  }

  async put(key: string, bytes: Uint8Array, options: { readonly contentType?: string }, context: ObjectStoreContext): Promise<{ readonly size: number }> {
    await this.call(context, 'PUT', this.objectUrl(key), { body: bytes, ...(options.contentType ? { headers: { 'content-type': options.contentType } } : {}) }, [200]);
    return { size: bytes.byteLength };
  }

  async get(key: string, context: ObjectStoreContext): Promise<Uint8Array> {
    const response = await this.call(context, 'GET', this.objectUrl(key), {}, [200], true);
    if (response.status === 404) throw new ServiceAuthorityError('NOT_FOUND', 'Stored object not found', { reason: 'object_missing' });
    return new Uint8Array(response.body.buffer, response.body.byteOffset, response.body.byteLength);
  }

  async head(key: string, context: ObjectStoreContext): Promise<{ readonly size: number } | null> {
    const response = await this.call(context, 'HEAD', this.objectUrl(key), {}, [200], true);
    if (response.status === 404) return null;
    const size = Number(response.headers['content-length']);
    if (!Number.isInteger(size) || size < 0) throw providerError('HEAD returned no content length');
    return { size };
  }

  async delete(key: string, context: ObjectStoreContext): Promise<void> {
    await this.call(context, 'DELETE', this.objectUrl(key), {}, [200, 204], true);
  }

  async createMultipart(key: string, options: { readonly contentType?: string }, context: ObjectStoreContext): Promise<string> {
    const url = this.objectUrl(key);
    url.search = 'uploads=';
    const response = await this.call(context, 'POST', url, { ...(options.contentType ? { headers: { 'content-type': options.contentType } } : {}) }, [200]);
    const uploadId = xmlValue(response.body.toString('utf8'), 'UploadId');
    if (!uploadId) throw providerError('CreateMultipartUpload returned no UploadId');
    return uploadId;
  }

  async putPart(key: string, uploadId: string, partNumber: number, bytes: Uint8Array, context: ObjectStoreContext): Promise<ObjectPart> {
    const url = this.partUrl(key, uploadId, partNumber);
    const response = await this.call(context, 'PUT', url, { body: bytes }, [200]);
    const etag = response.headers.etag;
    if (!etag) throw providerError('UploadPart returned no ETag');
    return { partNumber, size: bytes.byteLength, etag };
  }

  async completeMultipart(key: string, uploadId: string, parts: readonly ObjectPart[], context: ObjectStoreContext): Promise<{ readonly size: number }> {
    const url = this.objectUrl(key);
    url.searchParams.set('uploadId', uploadId);
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const body = `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${ordered.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
    const response = await this.call(context, 'POST', url, { body: Buffer.from(body, 'utf8'), headers: { 'content-type': 'application/xml' } }, [200]);
    // S3 can answer 200 with an error document.
    const text = response.body.toString('utf8');
    if (/<Error>/.test(text)) throw providerError(`CompleteMultipartUpload failed (${xmlValue(text, 'Code') ?? 'error'})`);
    return { size: ordered.reduce((sum, part) => sum + part.size, 0) };
  }

  async abortMultipart(key: string, uploadId: string, _parts: readonly ObjectPart[], context: ObjectStoreContext): Promise<void> {
    const url = this.objectUrl(key);
    url.searchParams.set('uploadId', uploadId);
    await this.call(context, 'DELETE', url, {}, [200, 204], true);
  }

  presignPut(key: string, options: { readonly expiresSeconds: number }, context: ObjectStoreContext): Promise<PresignedRequest> {
    return this.presign(context, 'PUT', this.objectUrl(key), options.expiresSeconds);
  }

  presignGet(key: string, options: { readonly expiresSeconds: number; readonly filename?: string; readonly contentType?: string }, context: ObjectStoreContext): Promise<PresignedRequest> {
    const url = this.objectUrl(key);
    if (options.filename) url.searchParams.set('response-content-disposition', `attachment; filename="${options.filename.replace(/["\\\r\n]/g, '_')}"`);
    if (options.contentType) url.searchParams.set('response-content-type', options.contentType);
    return this.presign(context, 'GET', url, options.expiresSeconds);
  }

  presignPart(key: string, uploadId: string, partNumber: number, options: { readonly expiresSeconds: number }, context: ObjectStoreContext): Promise<PresignedRequest> {
    return this.presign(context, 'PUT', this.partUrl(key, uploadId, partNumber), options.expiresSeconds);
  }

  private partUrl(key: string, uploadId: string, partNumber: number): URL {
    const url = this.objectUrl(key);
    url.searchParams.set('partNumber', String(partNumber));
    url.searchParams.set('uploadId', uploadId);
    return url;
  }

  private presign(context: ObjectStoreContext, method: 'GET' | 'PUT', url: URL, expiresSeconds: number): Promise<PresignedRequest> {
    return context.withSecret(async (secret) => {
      const date = context.now();
      const signed = presignUrl({ method, url, credentials: this.credentials(secret), scope: { region: this.options.region, service: 's3' }, date, expiresSeconds });
      return { method, url: signed.url, headers: {}, expiresAt: new Date(date.getTime() + expiresSeconds * 1000).toISOString() };
    });
  }

  private call(context: ObjectStoreContext, method: string, url: URL, request: { readonly body?: Uint8Array; readonly headers?: Record<string, string> }, ok: readonly number[], allow404 = false): Promise<OutboundHttpResponse> {
    return context.withSecret(async (secret) => {
      const { headers } = signRequest({
        method, url, headers: request.headers ?? {},
        payloadHash: request.body ? sha256Hex(request.body) : undefined,
        credentials: this.credentials(secret), scope: { region: this.options.region, service: 's3' }, date: context.now(),
      });
      delete headers.host;
      const response = await context.send({ url: url.toString(), method, headers, ...(request.body ? { body: request.body } : {}), timeoutMs: 300_000, maxResponseBytes: 6 * 1024 * 1024 * 1024 });
      if (ok.includes(response.status) || (allow404 && response.status === 404)) return response;
      const code = response.headers['content-type']?.includes('xml') ? xmlValue(response.body.toString('utf8'), 'Code') : undefined;
      throw providerError(`${method} returned HTTP ${response.status}${code ? ` (${code})` : ''}`);
    });
  }

  private credentials(secret: unknown): SigV4Credentials {
    if (typeof secret === 'string' && secret) return { accessKeyId: this.options.accessKeyId, secretAccessKey: secret };
    if (secret && typeof secret === 'object' && typeof (secret as { secretAccessKey?: unknown }).secretAccessKey === 'string') {
      const value = secret as { secretAccessKey: string; sessionToken?: unknown };
      return { accessKeyId: this.options.accessKeyId, secretAccessKey: value.secretAccessKey, ...(typeof value.sessionToken === 'string' ? { sessionToken: value.sessionToken } : {}) };
    }
    throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'The S3 credential is not a secret access key', { reason: 'credential_shape' });
  }
}

function xmlValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match ? match[1]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : undefined;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function providerError(message: string): ServiceAuthorityError {
  return new ServiceAuthorityError('PROVIDER_ERROR', `Object store: ${message}`, { reason: 'object_store_failed' });
}
