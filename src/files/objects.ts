import { createHash, randomUUID } from 'node:crypto';

import type { StateFirstDB } from '@feltdb/core';

import { ServiceAuthorityError } from '../authority/errors.js';
import type { OutboundHttpRequest, OutboundHttpResponse } from '../authority/outbound.js';

/**
 * What an object store gets for one operation: the tenant, the gateway's
 * outbound client (destination policy, pinned address, no redirects), and the
 * store's credential resolved from custody for this operation only. Every
 * object-store call runs inside an authorized gateway effect and is recorded as
 * effect evidence (`provider` = the store id).
 */
export interface ObjectStoreContext {
  readonly tenantId: string;
  send(request: OutboundHttpRequest): Promise<OutboundHttpResponse>;
  /** Resolve the store's credential (its `credentialRef`) for this operation. */
  withSecret<T>(use: (secret: unknown) => Promise<T>): Promise<T>;
  now(): Date;
}

/** A request a client makes directly against the store (a presigned URL). */
export interface PresignedRequest {
  readonly method: 'GET' | 'PUT';
  readonly url: string;
  /** Headers the client must send with the request (none for a plain presigned URL). */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}

export interface ObjectPart {
  readonly partNumber: number;
  readonly size: number;
  /** Store-defined part tag (S3: the ETag). */
  readonly etag: string;
}

/**
 * Where file bytes live. The default, `FeltDbObjectStore`, keeps them in the
 * application's FeltDB instance in bounded chunks; `S3ObjectStore` keeps them in
 * S3 or an S3-compatible store (Cloudflare R2, MinIO) and adds presigned URLs.
 * A host may supply its own.
 */
export interface FileObjectStore {
  /** Recorded on each file (`objectStore`) and in evidence as the provider. */
  readonly id: string;
  /** Credential reference the store needs (S3 secret access key); resolved per operation. */
  readonly credentialRef?: string;
  /** Smallest part (other than the last) a resumable upload may use. */
  readonly minPartSize: number;
  /** Largest part a resumable upload may use. */
  readonly maxPartSize: number;
  put(key: string, bytes: Uint8Array, options: { readonly contentType?: string }, context: ObjectStoreContext): Promise<{ readonly size: number }>;
  get(key: string, context: ObjectStoreContext): Promise<Uint8Array>;
  /** Size of a stored object, or null when absent. */
  head(key: string, context: ObjectStoreContext): Promise<{ readonly size: number } | null>;
  delete(key: string, context: ObjectStoreContext): Promise<void>;
  /** Start a multipart (resumable) upload; returns the store's upload id. */
  createMultipart(key: string, options: { readonly contentType?: string }, context: ObjectStoreContext): Promise<string>;
  putPart(key: string, uploadId: string, partNumber: number, bytes: Uint8Array, context: ObjectStoreContext): Promise<ObjectPart>;
  completeMultipart(key: string, uploadId: string, parts: readonly ObjectPart[], context: ObjectStoreContext): Promise<{ readonly size: number }>;
  abortMultipart(key: string, uploadId: string, parts: readonly ObjectPart[], context: ObjectStoreContext): Promise<void>;
  /** Presigned single-request upload. Absent: the store cannot presign (FeltDB). */
  presignPut?(key: string, options: { readonly expiresSeconds: number; readonly contentType?: string }, context: ObjectStoreContext): Promise<PresignedRequest>;
  presignGet?(key: string, options: { readonly expiresSeconds: number; readonly filename?: string; readonly contentType?: string }, context: ObjectStoreContext): Promise<PresignedRequest>;
  presignPart?(key: string, uploadId: string, partNumber: number, options: { readonly expiresSeconds: number }, context: ObjectStoreContext): Promise<PresignedRequest>;
}

const OBJECTS = 'file_objects';
const CHUNKS = 'file_object_chunks';

/** One stored object's manifest (FeltDB store). */
export interface FileObjectRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly storageKey: string;
  readonly size: number;
  /** `sha256:<hex>` of the whole object. */
  readonly checksum: string;
  readonly contentType?: string;
  /** Ids of the chunk records, in order. */
  readonly chunks: readonly string[];
  readonly createdAt: string;
}

/** One chunk of an object's bytes (FeltDB store), base64. */
export interface FileObjectChunk {
  readonly id: string;
  readonly tenantId: string;
  readonly objectId: string;
  readonly index: number;
  readonly size: number;
  readonly data: string;
}

/** Default raw bytes per chunk record: 512 KiB (about 683 KiB of base64, under FeltDB's 1 MiB request cap). */
export const DEFAULT_FELTDB_CHUNK_BYTES = 512 * 1024;

/**
 * The default object store: bytes in the application's FeltDB instance,
 * split into chunk records small enough for any FeltDB authority (a managed
 * authority caps a request at 1 MiB). Objects of any size are stored as many
 * chunks; resumable uploads store each part's chunks as they arrive. No
 * presigned URLs: clients upload through the service.
 */
export class FeltDbObjectStore implements FileObjectStore {
  readonly id = 'feltdb';
  readonly minPartSize = 1;
  readonly maxPartSize = 64 * 1024 * 1024;
  private readonly chunkBytes: number;

  constructor(private readonly db: StateFirstDB, options: { readonly chunkBytes?: number } = {}) {
    this.chunkBytes = options.chunkBytes ?? DEFAULT_FELTDB_CHUNK_BYTES;
    if (!Number.isInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > 700 * 1024) throw new RangeError('chunkBytes must be an integer from 1 to 716800');
  }

  async put(key: string, bytes: Uint8Array, options: { readonly contentType?: string }, context: ObjectStoreContext): Promise<{ readonly size: number }> {
    const objectId = objectIdOf(context.tenantId, key);
    const previous = await this.manifest(context.tenantId, key);
    const chunks = await this.writeChunks(context.tenantId, objectId, `${objectId}-${randomUUID()}`, bytes);
    await this.writeManifest({ id: objectId, tenantId: context.tenantId, storageKey: key, size: bytes.byteLength, checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, ...(options.contentType ? { contentType: options.contentType } : {}), chunks, createdAt: context.now().toISOString() });
    if (previous) await this.deleteChunks(previous.chunks.filter((id) => !chunks.includes(id)));
    return { size: bytes.byteLength };
  }

  async get(key: string, context: ObjectStoreContext): Promise<Uint8Array> {
    const manifest = await this.manifest(context.tenantId, key);
    if (!manifest) throw new ServiceAuthorityError('NOT_FOUND', 'Stored object not found', { reason: 'object_missing' });
    const collection = this.db.collection<FileObjectChunk>(CHUNKS);
    const parts: Buffer[] = [];
    for (const id of manifest.chunks) {
      const chunk = await collection.get(id);
      if (!chunk || chunk.tenantId !== context.tenantId) throw new ServiceAuthorityError('PROVIDER_ERROR', 'A chunk of the stored object is missing', { reason: 'object_chunk_missing' });
      parts.push(Buffer.from(chunk.data, 'base64'));
    }
    const bytes = Buffer.concat(parts);
    if (bytes.byteLength !== manifest.size) throw new ServiceAuthorityError('PROVIDER_ERROR', 'The stored object is incomplete', { reason: 'object_size_mismatch' });
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async head(key: string, context: ObjectStoreContext): Promise<{ readonly size: number } | null> {
    const manifest = await this.manifest(context.tenantId, key);
    return manifest ? { size: manifest.size } : null;
  }

  async delete(key: string, context: ObjectStoreContext): Promise<void> {
    const manifest = await this.manifest(context.tenantId, key);
    if (!manifest) return;
    await this.db.collection(OBJECTS).delete(manifest.id);
    await this.deleteChunks(manifest.chunks);
  }

  async createMultipart(): Promise<string> {
    return randomUUID();
  }

  async putPart(_key: string, uploadId: string, partNumber: number, bytes: Uint8Array, context: ObjectStoreContext): Promise<ObjectPart> {
    // Re-sending a part overwrites the same chunk ids: resuming is idempotent.
    await this.writeChunks(context.tenantId, partObjectId(uploadId), `${partObjectId(uploadId)}-p${partNumber}`, bytes);
    return { partNumber, size: bytes.byteLength, etag: createHash('sha256').update(bytes).digest('hex') };
  }

  async completeMultipart(key: string, uploadId: string, parts: readonly ObjectPart[], context: ObjectStoreContext): Promise<{ readonly size: number }> {
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const chunks = ordered.flatMap((part) => this.chunkIds(`${partObjectId(uploadId)}-p${part.partNumber}`, part.size));
    const collection = this.db.collection<FileObjectChunk>(CHUNKS);
    const hash = createHash('sha256');
    let size = 0;
    for (const id of chunks) {
      const chunk = await collection.get(id);
      if (!chunk || chunk.tenantId !== context.tenantId) throw new ServiceAuthorityError('INVALID_REQUEST', 'A part of the upload is missing; upload it again', { reason: 'part_missing' });
      const data = Buffer.from(chunk.data, 'base64');
      hash.update(data);
      size += data.byteLength;
    }
    const previous = await this.manifest(context.tenantId, key);
    await this.writeManifest({ id: objectIdOf(context.tenantId, key), tenantId: context.tenantId, storageKey: key, size, checksum: `sha256:${hash.digest('hex')}`, chunks, createdAt: context.now().toISOString() });
    if (previous) await this.deleteChunks(previous.chunks.filter((id) => !chunks.includes(id)));
    return { size };
  }

  async abortMultipart(_key: string, uploadId: string, parts: readonly ObjectPart[]): Promise<void> {
    await this.deleteChunks(parts.flatMap((part) => this.chunkIds(`${partObjectId(uploadId)}-p${part.partNumber}`, part.size)));
  }

  private chunkIds(prefix: string, size: number): string[] {
    const count = Math.max(1, Math.ceil(size / this.chunkBytes));
    return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
  }

  private async writeChunks(tenantId: string, objectId: string, prefix: string, bytes: Uint8Array): Promise<string[]> {
    const ids = this.chunkIds(prefix, bytes.byteLength);
    for (const [index, id] of ids.entries()) {
      const slice = bytes.subarray(index * this.chunkBytes, Math.min(bytes.byteLength, (index + 1) * this.chunkBytes));
      const chunk: FileObjectChunk = { id, tenantId, objectId, index, size: slice.byteLength, data: Buffer.from(slice).toString('base64') };
      // One chunk per transaction keeps every request under the authority's size cap.
      await this.db.transaction({ operations: [{ collection: CHUNKS, id, value: { ...chunk } }] });
    }
    return ids;
  }

  private async writeManifest(record: FileObjectRecord): Promise<void> {
    await this.db.transaction({ operations: [{ collection: OBJECTS, id: record.id, value: { ...record, chunks: [...record.chunks] } }] });
  }

  private async manifest(tenantId: string, key: string): Promise<FileObjectRecord | null> {
    const record = await this.db.collection<FileObjectRecord>(OBJECTS).get(objectIdOf(tenantId, key));
    return record && record.tenantId === tenantId && record.storageKey === key ? record : null;
  }

  private async deleteChunks(ids: readonly string[]): Promise<void> {
    const collection = this.db.collection(CHUNKS);
    for (const id of ids) await collection.delete(id).catch(() => undefined);
  }
}

function objectIdOf(tenantId: string, key: string): string {
  return `obj_${createHash('sha256').update(`${tenantId}\u0000${key}`).digest('hex')}`;
}

function partObjectId(uploadId: string): string {
  return `upl_${createHash('sha256').update(uploadId).digest('hex').slice(0, 32)}`;
}

export function fileObjectCollectionNames(): readonly string[] {
  return [OBJECTS, CHUNKS];
}
