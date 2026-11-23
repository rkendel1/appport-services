import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { verifySignature, type SigV4Credentials } from '../../src/files/sigv4.js';

/**
 * A local S3-compatible server (path style, `/<bucket>/<key>`): PUT/GET/HEAD/
 * DELETE objects and multipart uploads. Every request must carry a valid SigV4
 * signature (header or presigned query) for `credentials`; a bad one is 403.
 */
export interface MockS3 {
  readonly endpoint: string;
  readonly objects: Map<string, Buffer>;
  readonly requests: { method: string; path: string; presigned: boolean; status: number }[];
  readonly multipart: Map<string, Map<number, Buffer>>;
  close(): Promise<void>;
}

export async function mockS3(options: { readonly bucket: string; readonly region: string; readonly credentials: SigV4Credentials }): Promise<MockS3> {
  const objects = new Map<string, Buffer>();
  const multipart = new Map<string, Map<number, Buffer>>();
  const requests: MockS3['requests'] = [];
  let endpoint = '';
  const server: Server = createServer(async (req, res) => {
    const body = await read(req);
    const url = new URL(req.url ?? '/', endpoint);
    const presigned = url.searchParams.has('X-Amz-Signature');
    const reply = (status: number, payload = '', headers: Record<string, string> = {}) => {
      requests.push({ method: req.method ?? '', path: url.pathname, presigned, status });
      res.writeHead(status, headers);
      res.end(req.method === 'HEAD' ? undefined : payload);
    };
    const signed = verifySignature({ method: req.method ?? 'GET', url: url.toString(), headers: req.headers as Record<string, string>, credentials: options.credentials, scope: { region: options.region, service: 's3' } });
    if (!signed) return reply(403, '<Error><Code>SignatureDoesNotMatch</Code></Error>', { 'content-type': 'application/xml' });
    if (!presigned && req.headers['x-amz-content-sha256'] !== createHash('sha256').update(body).digest('hex')) {
      return reply(400, '<Error><Code>XAmzContentSHA256Mismatch</Code></Error>', { 'content-type': 'application/xml' });
    }
    const prefix = `/${options.bucket}/`;
    if (!url.pathname.startsWith(prefix)) return reply(404, '<Error><Code>NoSuchBucket</Code></Error>', { 'content-type': 'application/xml' });
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const uploadId = url.searchParams.get('uploadId');
    if (req.method === 'POST' && url.searchParams.has('uploads')) {
      const id = randomUUID();
      multipart.set(id, new Map());
      return reply(200, `<InitiateMultipartUploadResult><Bucket>${options.bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`, { 'content-type': 'application/xml' });
    }
    if (req.method === 'PUT' && uploadId) {
      const parts = multipart.get(uploadId);
      if (!parts) return reply(404, '<Error><Code>NoSuchUpload</Code></Error>', { 'content-type': 'application/xml' });
      parts.set(Number(url.searchParams.get('partNumber')), body);
      return reply(200, '', { etag: `"${createHash('md5').update(body).digest('hex')}"` });
    }
    if (req.method === 'POST' && uploadId) {
      const parts = multipart.get(uploadId);
      if (!parts) return reply(404, '<Error><Code>NoSuchUpload</Code></Error>', { 'content-type': 'application/xml' });
      const listed = [...body.toString('utf8').matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag>/g)];
      const chunks: Buffer[] = [];
      for (const [, number, etag] of listed) {
        const part = parts.get(Number(number));
        if (!part || etag!.replace(/&quot;/g, '"') !== `"${createHash('md5').update(part).digest('hex')}"`) {
          return reply(200, '<Error><Code>InvalidPart</Code></Error>', { 'content-type': 'application/xml' });
        }
        chunks.push(part);
      }
      objects.set(key, Buffer.concat(chunks));
      multipart.delete(uploadId);
      return reply(200, `<CompleteMultipartUploadResult><Key>${key}</Key></CompleteMultipartUploadResult>`, { 'content-type': 'application/xml' });
    }
    if (req.method === 'DELETE' && uploadId) {
      multipart.delete(uploadId);
      return reply(204);
    }
    if (req.method === 'PUT') {
      objects.set(key, body);
      return reply(200, '', { etag: `"${createHash('md5').update(body).digest('hex')}"` });
    }
    const object = objects.get(key);
    if (req.method === 'DELETE') { objects.delete(key); return reply(204); }
    if (!object) return reply(404, '<Error><Code>NoSuchKey</Code></Error>', { 'content-type': 'application/xml' });
    if (req.method === 'HEAD') return reply(200, '', { 'content-length': String(object.length) });
    if (req.method === 'GET') return reply(200, object as unknown as string, { 'content-type': 'application/octet-stream', ...(url.searchParams.get('response-content-disposition') ? { 'content-disposition': url.searchParams.get('response-content-disposition')! } : {}) });
    reply(405);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { endpoint, objects, requests, multipart, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function read(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
