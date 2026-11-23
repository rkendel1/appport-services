import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';

import {
  createServices, isServiceAuthorityError, presignAwsUrl, signAwsRequest, sha256Hex, verifyAwsSignature, S3ObjectStore, FeltDbObjectStore,
  type AppPortServices,
} from '../src/index.js';
import { TestAuthority } from './support/authority.js';
import { MemoryCustody } from './support/custody.js';
import { mockS3 } from './support/mock-s3.js';

const AWS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
const AWS_SCOPE = { region: 'us-east-1', service: 's3' };
const AWS_DATE = new Date('2013-05-24T00:00:00Z');

test('SigV4: the AWS published example presigned URL, byte for byte', () => {
  const { url } = presignAwsUrl({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', credentials: AWS, scope: AWS_SCOPE, date: AWS_DATE, expiresSeconds: 86400 });
  assert.equal(url, 'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

test('SigV4: the AWS published header-signing examples (GET object, PUT object, GET lifecycle, list objects)', () => {
  const sign = (method: string, url: string, headers: Record<string, string> = {}, payloadHash?: string) =>
    signAwsRequest({ method, url, headers, ...(payloadHash ? { payloadHash } : {}), credentials: AWS, scope: AWS_SCOPE, date: AWS_DATE });
  const get = sign('GET', 'https://examplebucket.s3.amazonaws.com/test.txt', { Range: 'bytes=0-9' });
  assert.equal(get.signature.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(get.headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(sign('PUT', 'https://examplebucket.s3.amazonaws.com/test$file.text', { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, sha256Hex('Welcome to Amazon S3.')).signature.signature,
    '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  assert.equal(sign('GET', 'https://examplebucket.s3.amazonaws.com/?lifecycle').signature.signature, 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  assert.equal(sign('GET', 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J').signature.signature, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

test('SigV4: verification accepts a valid presigned URL and refuses a tampered or expired one', () => {
  const { url } = presignAwsUrl({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/a/b c.txt', credentials: AWS, scope: AWS_SCOPE, date: AWS_DATE, expiresSeconds: 60 });
  const check = (candidate: string, now: Date) => verifyAwsSignature({ method: 'GET', url: candidate, headers: { host: 'examplebucket.s3.amazonaws.com' }, credentials: AWS, scope: AWS_SCOPE, now });
  assert.equal(check(url, new Date(AWS_DATE.getTime() + 30_000)), true);
  assert.equal(check(url.replace('b%20c.txt', 'other.txt'), new Date(AWS_DATE.getTime() + 30_000)), false);
  assert.equal(check(url, new Date(AWS_DATE.getTime() + 61_000)), false);
  assert.equal(verifyAwsSignature({ method: 'GET', url, headers: { host: 'examplebucket.s3.amazonaws.com' }, credentials: { ...AWS, secretAccessKey: 'wrong' }, scope: AWS_SCOPE, now: AWS_DATE }), false);
});

function open(options: { authority?: TestAuthority; quota?: { maxBytes?: number; maxFiles?: number; maxFileBytes?: number }; objectStore?: (db: AppPortServices['db']) => unknown; credentials?: MemoryCustody; db?: AppPortServices['db'] } = {}) {
  const authority = options.authority ?? new TestAuthority({ allowAll: true });
  const base = createServices({ memory: true, namespace: `files-${crypto.randomUUID()}`, application: 'meetings', authorizer: authority } as never);
  const db = options.db ?? base.db;
  const services = createServices({
    db, application: 'meetings', authorizer: authority,
    ...(options.credentials ? { credentials: options.credentials } : {}),
    outboundDestinationPolicy: { allowPrivateNetworks: true },
    files: { ...(options.quota ? { quota: options.quota } : {}), ...(options.objectStore ? { objectStore: options.objectStore(db) as never } : {}) },
  } as never);
  const host = services.identify({ principalId: 'host-1', principalType: 'user', tenantId: 'tenant-a' })!;
  return { services, host, authority, db };
}

test('S2: bytes larger than one FeltDB request are stored in chunks and read back intact (default store)', async () => {
  const { services, host, db } = open({ objectStore: (d) => new FeltDbObjectStore(d as never, { chunkBytes: 64 * 1024 }) });
  const bytes = randomBytes(3 * 1024 * 1024 + 123);
  const file = await services.files.upload({ name: 'recording.webm', contentType: 'video/webm', data: bytes }, host);
  assert.deepEqual([file.objectStore, file.status, file.size], ['feltdb', 'ready', bytes.length]);
  assert.equal(file.checksum, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  const chunks = await db.collection<{ id: string; data: string }>('file_object_chunks').list();
  assert.ok(chunks.length >= 49, 'split into chunk records');
  assert.ok(chunks.every((chunk) => chunk.data.length < 1024 * 1024), 'each chunk record is under 1 MiB');
  const { bytes: read } = await services.files.download('tenant-a', file.id, host);
  assert.ok(Buffer.from(read).equals(bytes));
  await assert.rejects(services.files.createUploadUrl({ name: 'x', size: 1 }, host), /cannot presign/);
  // Evidence names the store.
  const evidence = await db.collection<{ capability: string; provider?: string }>('service_effect_evidence').list();
  assert.ok(evidence.some((row) => row.capability === 'files.write' && row.provider === 'feltdb'));
});

test('S2: per-tenant quotas are enforced before anything is written (bytes, files, file size)', async () => {
  const { services, host, db } = open({ quota: { maxBytes: 1000, maxFiles: 2, maxFileBytes: 600 } });
  const other = services.identify({ principalId: 'host-2', principalType: 'user', tenantId: 'tenant-b' })!;
  await services.files.upload({ name: 'a', data: new Uint8Array(500) }, host);
  const before = (await db.collection('file_object_chunks').list()).length;
  await assert.rejects(services.files.upload({ name: 'b', data: new Uint8Array(501) }, host), (error: unknown) => isServiceAuthorityError(error) && error.code === 'QUOTA_EXCEEDED' && error.status === 413);
  await assert.rejects(services.files.upload({ name: 'big', data: new Uint8Array(601) }, host), /at most 600 bytes/);
  await assert.rejects(services.files.beginUpload({ name: 'big', size: 900 }, host), /at most 600 bytes/);
  assert.equal((await db.collection('file_object_chunks').list()).length, before, 'no bytes written for a refused upload');
  await services.files.upload({ name: 'b', data: new Uint8Array(400) }, host);
  await assert.rejects(services.files.create({ name: 'c', size: 0, storageKey: 'k' }, host), /quota exceeded/);
  assert.deepEqual(await services.files.usage('tenant-a', host), { tenantId: 'tenant-a', bytes: 900, files: 2, quota: { maxBytes: 1000, maxFiles: 2, maxFileBytes: 600 } });
  // Per tenant: tenant B is unaffected.
  await services.files.upload({ name: 'a', data: new Uint8Array(500) }, other);
  // Deleting releases quota.
  const [first] = await services.files.list('tenant-a', host);
  await services.files.delete('tenant-a', first!.id, host);
  assert.equal((await services.files.usage('tenant-a', host)).files, 1);
  await services.files.upload({ name: 'c', data: new Uint8Array(100) }, host);
});

test('S2: a resumable upload persists its parts and resumes after a restart', async () => {
  const first = open();
  const content = randomBytes(10_000);
  const session = await first.services.files.beginUpload({ name: 'recording.webm', contentType: 'video/webm', size: content.length, partSize: 4000 }, first.host);
  assert.deepEqual([session.partCount, session.missingParts], [3, [1, 2, 3]]);
  await first.services.files.uploadPart('tenant-a', session.uploadId, 1, content.subarray(0, 4000), first.host);
  await assert.rejects(first.services.files.uploadPart('tenant-a', session.uploadId, 2, content.subarray(0, 10), first.host), /must be 4000 bytes/);
  // The pending file is not served.
  await assert.rejects(first.services.files.get('tenant-a', session.fileId, first.host), /File not found/);
  await assert.rejects(first.services.files.completeUpload('tenant-a', session.uploadId, first.host), /Parts 2, 3 are missing/);

  // The process restarts: a new services instance on the same database.
  const second = open({ db: first.db });
  const status = await second.services.files.uploadStatus('tenant-a', session.uploadId, second.host);
  assert.deepEqual([status.receivedParts, status.missingParts, status.receivedBytes], [[1], [2, 3], 4000]);
  await second.services.files.uploadPart('tenant-a', session.uploadId, 3, content.subarray(8000), second.host);
  await second.services.files.uploadPart('tenant-a', session.uploadId, 2, content.subarray(4000, 8000), second.host);
  const file = await second.services.files.completeUpload('tenant-a', session.uploadId, second.host);
  assert.deepEqual([file.status, file.size], ['ready', content.length]);
  assert.ok(Buffer.from((await second.services.files.download('tenant-a', file.id, second.host)).bytes).equals(content));
  await assert.rejects(second.services.files.uploadPart('tenant-a', session.uploadId, 1, content.subarray(0, 4000), second.host), /The upload is completed/);
});

test('S2: retention blocks deletion; lifecycle sweep deletes expired files and aborts expired uploads, releasing bytes', async () => {
  const { services, host, db } = open();
  const future = new Date(Date.now() + 60_000).toISOString();
  const retained = await services.files.upload({ name: 'minutes.pdf', data: Buffer.from('minutes'), retainUntil: future }, host);
  await assert.rejects(services.files.delete('tenant-a', retained.id, host), (error: unknown) => isServiceAuthorityError(error) && error.code === 'DENIED' && error.details.reason === 'retention_active');
  await assert.rejects(services.files.update({ id: retained.id, retainUntil: new Date(Date.now() + 1000).toISOString() }, host), /extended, not shortened/);
  const soon = new Date(Date.now() + 500).toISOString();
  const expiring = await services.files.upload({ name: 'temp.webm', data: Buffer.from('temporary'), expiresAt: soon }, host);
  const held = await services.files.upload({ name: 'held.webm', data: Buffer.from('held'), expiresAt: soon, retainUntil: future }, host);
  const upload = await services.files.beginUpload({ name: 'abandoned', size: 10 }, host);
  await services.files.uploadPart('tenant-a', upload.uploadId, 1, Buffer.from('0123456789'), host);
  // Expire the upload session.
  const sessions = db.collection<Record<string, unknown>>('file_uploads');
  const record = await sessions.get(upload.uploadId);
  await sessions.update(upload.uploadId, { ...record, expiresAt: new Date(Date.now() - 1000).toISOString() });
  await new Promise((resolve) => setTimeout(resolve, 600));
  const usageBefore = await services.files.usage('tenant-a', host);
  const result = await services.files.sweep('tenant-a', host);
  assert.deepEqual(result, { deleted: [expiring.id], retained: [held.id], abortedUploads: [upload.uploadId], complete: true });
  await assert.rejects(services.files.download('tenant-a', expiring.id, host), /File not found/);
  const usageAfter = await services.files.usage('tenant-a', host);
  assert.equal(usageBefore.bytes - usageAfter.bytes, 'temporary'.length + 10);
  const objects = await db.collection<{ storageKey: string }>('file_objects').list();
  assert.ok(!objects.some((object) => object.storageKey === expiring.storageKey), 'the expired file\'s bytes were released');
});

test('S2: denial paths: no grant stores nothing; another tenant cannot read', async () => {
  const authority = new TestAuthority();
  const { services, host, db } = open({ authority });
  await assert.rejects(services.files.upload({ name: 'a', data: Buffer.from('x') }, host), /AuthBoundry denied files\.write/);
  assert.equal((await db.collection('file_object_chunks').list()).length, 0);
  await authority.grant({ subject: 'host-1', capability: 'files.write' });
  const file = await services.files.upload({ name: 'a', data: Buffer.from('x') }, host);
  await assert.rejects(services.files.download('tenant-a', file.id, host), /AuthBoundry denied files\.read/);
  const other = services.identify({ principalId: 'host-1', principalType: 'user', tenantId: 'tenant-b' })!;
  await assert.rejects(services.files.download('tenant-a', file.id, other), /Cross-tenant/);
});

test('S2: S3-compatible store: put/get through SigV4, presigned upload and download, multipart with presigned parts', async () => {
  const s3 = await mockS3({ bucket: 'recordings', region: 'auto', credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'test-secret-key' } });
  const custody = new MemoryCustody();
  await custody.store({ reference: { secretId: 'r2', tenantId: 'tenant-a' }, value: 'test-secret-key', context: { tenantId: 'tenant-a', principalId: 'host', purpose: 'test', authorizationRef: 'setup' } });
  try {
    const { services, host, db } = open({ credentials: custody, objectStore: () => new S3ObjectStore({ bucket: 'recordings', region: 'auto', endpoint: s3.endpoint, accessKeyId: 'AKIDTEST', credentialRef: 'credential-ref:r2', minPartSize: 1 }) });
    // Server-side put and get.
    const logo = await services.files.upload({ name: 'logo.png', contentType: 'image/png', data: Buffer.from('png bytes') }, host);
    assert.equal(logo.objectStore, 's3');
    assert.ok(s3.objects.get(`meetings/tenant-a/${logo.id}`)?.equals(Buffer.from('png bytes')));
    assert.ok(Buffer.from((await services.files.download('tenant-a', logo.id, host)).bytes).equals(Buffer.from('png bytes')));
    // Presigned upload, then confirm.
    const { file, upload } = await services.files.createUploadUrl({ name: 'big.webm', contentType: 'video/webm', size: 11 }, host);
    assert.equal(upload.method, 'PUT');
    assert.match(upload.url, /X-Amz-Signature=[0-9a-f]{64}/);
    assert.doesNotMatch(upload.url, /test-secret-key/);
    const put = await fetch(upload.url, { method: 'PUT', body: 'hello world' });
    assert.equal(put.status, 200);
    const tampered = await fetch(upload.url.replace(/X-Amz-Expires=\d+/, 'X-Amz-Expires=604800'), { method: 'PUT', body: 'evil' });
    assert.equal(tampered.status, 403, 'the mock store refuses a tampered presigned URL');
    const confirmed = await services.files.confirmUpload('tenant-a', file.id, host);
    assert.equal(confirmed.status, 'ready');
    // Presigned download.
    const download = await services.files.createDownloadUrl('tenant-a', file.id, host, { expiresInSeconds: 60 });
    const got = await fetch(download.url);
    assert.equal(await got.text(), 'hello world');
    assert.match(got.headers.get('content-disposition') ?? '', /big\.webm/);
    // Multipart: one part through the service, one through a presigned part URL.
    const session = await services.files.beginUpload({ name: 'meeting.webm', size: 7, partSize: 4 }, host);
    await services.files.uploadPart('tenant-a', session.uploadId, 1, Buffer.from('abcd'), host);
    const partUrl = await services.files.createPartUploadUrl('tenant-a', session.uploadId, 2, host);
    const partResponse = await fetch(partUrl.url, { method: 'PUT', body: 'efg' });
    const etag = partResponse.headers.get('etag')!;
    const done = await services.files.completeUpload('tenant-a', session.uploadId, host, { parts: [{ partNumber: 2, etag }] });
    assert.ok(s3.objects.get(`meetings/tenant-a/${done.id}`)?.equals(Buffer.from('abcdefg')));
    // Deleting releases the object.
    await services.files.delete('tenant-a', logo.id, host);
    assert.equal(s3.objects.has(`meetings/tenant-a/${logo.id}`), false);
    // Evidence: provider s3, the credential by reference only.
    const evidence = await db.collection<{ provider?: string; credentialRef?: string }>('service_effect_evidence').list();
    assert.ok(evidence.filter((row) => row.provider === 's3').every((row) => row.credentialRef === 'credential-ref:r2'));
    assert.ok(!JSON.stringify(evidence).includes('test-secret-key'));
    assert.ok(s3.requests.every((request) => request.status !== 403 || request.presigned));
  } finally {
    await s3.close();
  }
});

test('S2: S3 store with the wrong secret fails as a provider error, and private endpoints are refused by default', async () => {
  const s3 = await mockS3({ bucket: 'recordings', region: 'auto', credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'right' } });
  const custody = new MemoryCustody();
  await custody.store({ reference: { secretId: 'r2', tenantId: 'tenant-a' }, value: 'wrong', context: { tenantId: 'tenant-a', principalId: 'host', purpose: 'test', authorizationRef: 'setup' } });
  try {
    const { services, host } = open({ credentials: custody, objectStore: () => new S3ObjectStore({ bucket: 'recordings', region: 'auto', endpoint: s3.endpoint, accessKeyId: 'AKIDTEST', credentialRef: 'credential-ref:r2' }) });
    await assert.rejects(services.files.upload({ name: 'a', data: Buffer.from('x') }, host), (error: unknown) => isServiceAuthorityError(error) && error.code === 'PROVIDER_ERROR' && /SignatureDoesNotMatch/.test(error.message));
    assert.equal((await services.files.usage('tenant-a', host)).bytes, 0, 'the reservation was released');
    const strict = createServices({ memory: true, namespace: `strict-${crypto.randomUUID()}`, application: 'meetings', authorizer: new TestAuthority({ allowAll: true }), credentials: custody,
      files: { objectStore: new S3ObjectStore({ bucket: 'recordings', region: 'auto', endpoint: s3.endpoint, accessKeyId: 'AKIDTEST', credentialRef: 'credential-ref:r2' }) } } as never);
    const strictHost = strict.identify({ principalId: 'host-1', principalType: 'user', tenantId: 'tenant-a' })!;
    await assert.rejects(strict.files.upload({ name: 'a', data: Buffer.from('x') }, strictHost), /private, loopback/);
    assert.throws(() => new S3ObjectStore({ bucket: 'bucket', region: 'auto', accessKeyId: 'a', credentialRef: 'raw-secret-key' }), /credential-ref/);
  } finally {
    await s3.close();
  }
});
