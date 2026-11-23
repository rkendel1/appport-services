import { createHash, randomUUID } from 'node:crypto';

import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { FileAuditSink, FileStore } from '../storage/files.js';
import type {
  BeginUploadInput, CreateFileInput, CreateUploadUrlInput, File, FileBytesInput, FileReferenceOptions, FileReferences, FileSweepResult, FileUploadView,
  FileUsageView, UpdateFileInput, UploadFileInput,
} from './models.js';
import { FILE_REFERENCE_EXAMINATION_LIMIT } from '../storage/files.js';
import type { ServiceResource } from '../authority/context.js';
import type { CredentialRef } from '../authority/credentials.js';
import type { WebhookDestinationPolicy } from '../authority/destination.js';
import { ServiceAuthorityError } from '../authority/errors.js';
import type { EffectTools, ServiceGateway } from '../authority/gateway.js';
import { sendOutboundRequest } from '../authority/outbound.js';
import { requireVerifiedPrincipal, resolveTenant, type VerifiedPrincipal } from '../authority/principal.js';
import type { FileObjectStore, ObjectPart, ObjectStoreContext, PresignedRequest } from './objects.js';
import type { FileQuota, FileUpload, FileUploadStore, FileUsageStore } from './uploads.js';

/** @deprecated Denials are reported as ServiceAuthorityError with code DENIED. */
export class FileAuthorizationError extends Error {
  constructor() { super('File operation is not authorized'); this.name = 'FileAuthorizationError'; }
}
export class FileValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'FileValidationError'; }
}
export class FileNotFoundError extends Error {
  constructor() { super('File not found'); this.name = 'FileNotFoundError'; }
}

export interface FileListOptions {
  readonly owner?: string;
}

/** Per-tenant quota: fixed, or looked up per tenant (for example from the tenant's plan). */
export type FileQuotaPolicy = FileQuota | ((tenantId: string) => FileQuota | undefined | Promise<FileQuota | undefined>);

export interface FileServiceOptions {
  readonly store: FileStore;
  readonly auditSink: FileAuditSink;
  /** Policy Enforcement Point. Without it every file operation fails closed. */
  readonly authority?: ServiceGateway;
  readonly now?: () => Date;
  /** Where bytes live (`upload`, presigned and resumable uploads). Without it, only metadata records are kept. */
  readonly objectStore?: FileObjectStore;
  /** Resumable upload sessions. Required for `beginUpload` and presigned uploads. */
  readonly uploads?: FileUploadStore;
  /** Per-tenant usage counters. With a quota, every write checks them first. */
  readonly usage?: FileUsageStore;
  readonly quota?: FileQuotaPolicy;
  /** Destination policy for object-store calls (trusted host code only). */
  readonly destinationPolicy?: WebhookDestinationPolicy;
  /** Default lifetime of a presigned URL, seconds (default 900; at most 604800). */
  readonly presignExpiresSeconds?: number;
  /** How long a resumable upload stays open, seconds (default 86400). */
  readonly uploadExpiresSeconds?: number;
  /** Default resumable part size, bytes (default 8 MiB, raised to the store's minimum). */
  readonly partSize?: number;
}

/** Largest single-call `upload` (the bytes are held in memory): 64 MiB. Larger files use `beginUpload`. */
export const MAX_INLINE_UPLOAD_BYTES = 64 * 1024 * 1024;
/** Most parts in one resumable upload (the S3 limit). */
export const MAX_UPLOAD_PARTS = 10_000;
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
const DEFAULT_PRESIGN_SECONDS = 900;
const DEFAULT_UPLOAD_SECONDS = 86_400;
/** A presigned single upload is a session whose provider upload id is this marker. */
const PRESIGNED_SINGLE = 'presigned-single';

/** A write would exceed the tenant's quota. Nothing was written. */
export class FileQuotaExceededError extends ServiceAuthorityError {
  constructor(message: string) {
    super('QUOTA_EXCEEDED', message, { capability: 'files.write', reason: 'quota_exceeded' });
    this.name = 'FileQuotaExceededError';
  }
}

export class FileService {
  private readonly now: () => Date;

  constructor(private readonly options: FileServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateFileInput, caller: AuthenticatedPrincipal): Promise<File> {
    const principal = requireVerifiedPrincipal(caller);
    const tenantId = resolveTenant(input, principal);
    const owner = input.owner ?? principal.principalId;
    validateCreate({ ...input, tenantId, owner });
    const lifecycle = this.lifecycleOf(input);
    return this.gateway().execute('files.write', principal, { type: 'file', tenantId, attributes: { owner } }, { service: 'files' }, async () => {
      const now = this.now().toISOString();
      await this.reserve(tenantId, input.size, 1);
      const item: File = { ...mutableFields(input), ...lifecycle, name: input.name, size: input.size, storageKey: input.storageKey, tenantId, applicationId: this.gateway().application, owner, id: randomUUID(), createdAt: now, updatedAt: now, __version: 1 };
      try {
        await this.options.store.create(item);
      } catch (error) {
        await this.release(tenantId, input.size, 1);
        throw error;
      }
      await this.audit('file.created', item, principal);
      return item;
    });
  }

  /**
   * Store bytes and their file record in one call (`files.write`, operation
   * `upload`). The tenant's quota is checked before anything is written. The
   * bytes go to the object store (FeltDB by default) under a key the service
   * chooses; evidence records the store as the provider.
   */
  async upload(input: UploadFileInput, caller: AuthenticatedPrincipal): Promise<File> {
    const principal = requireVerifiedPrincipal(caller);
    const tenantId = resolveTenant(input, principal);
    const store = this.objectStore();
    const bytes = bytesOf(input);
    if (bytes.byteLength > MAX_INLINE_UPLOAD_BYTES) throw new FileValidationError(`upload accepts at most ${MAX_INLINE_UPLOAD_BYTES} bytes; use beginUpload for larger files`);
    const owner = input.owner ?? principal.principalId;
    validateBytesInput({ ...input, owner });
    const lifecycle = this.lifecycleOf(input);
    await this.checkFileSize(tenantId, bytes.byteLength);
    return this.gateway().execute('files.write', principal, this.bytesResource(tenantId, owner, 'upload', store, { size: String(bytes.byteLength) }), this.bytesOptions(store), async (_context, tools) => {
      const id = randomUUID();
      const storageKey = this.storageKey(tenantId, id);
      await this.reserve(tenantId, bytes.byteLength, 1);
      try {
        await store.put(storageKey, bytes, { ...(input.contentType ? { contentType: input.contentType } : {}) }, this.objectContext(tenantId, store, tools));
      } catch (error) {
        await this.release(tenantId, bytes.byteLength, 1);
        throw error;
      }
      const now = this.now().toISOString();
      const item: File = {
        id, tenantId, applicationId: this.gateway().application, owner, name: input.name, size: bytes.byteLength,
        checksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, storageKey, objectStore: store.id, status: 'ready',
        ...(input.contentType ? { contentType: input.contentType } : {}), ...(input.metadata ? { metadata: input.metadata } : {}), ...lifecycle,
        createdAt: now, updatedAt: now, __version: 1,
      };
      await this.options.store.create(item);
      await this.audit('file.uploaded', item, principal);
      return item;
    });
  }

  /** The file and its bytes (`files.read`, operation `download`). */
  async download(tenantId: string, id: string, caller: AuthenticatedPrincipal): Promise<{ readonly file: File; readonly bytes: Uint8Array }> {
    const principal = requireVerifiedPrincipal(caller);
    const item = await this.readable(resolveTenant({ tenantId }, principal), id);
    const store = this.storeOf(item);
    return this.gateway().execute('files.read', principal, this.bytesResource(item.tenantId, item.owner, 'download', store, {}, item.id), this.bytesOptions(store), async (_context, tools) => ({
      file: item,
      bytes: await store.get(item.storageKey, this.objectContext(item.tenantId, store, tools)),
    }));
  }

  /**
   * A presigned download URL (`files.read`, operation `presign-download`), for
   * stores that presign (S3, R2). The URL is a bearer grant until it expires.
   */
  async createDownloadUrl(tenantId: string, id: string, caller: AuthenticatedPrincipal, options: { readonly expiresInSeconds?: number; readonly filename?: string } = {}): Promise<PresignedRequest> {
    const principal = requireVerifiedPrincipal(caller);
    const item = await this.readable(resolveTenant({ tenantId }, principal), id);
    const store = this.storeOf(item);
    if (!store.presignGet) throw new FileValidationError(`The ${store.id} object store cannot presign URLs; use download`);
    const expiresSeconds = this.presignSeconds(options.expiresInSeconds);
    return this.gateway().execute('files.read', principal, this.bytesResource(item.tenantId, item.owner, 'presign-download', store, { expiresInSeconds: String(expiresSeconds) }, item.id), this.bytesOptions(store), (_context, tools) =>
      store.presignGet!(item.storageKey, { expiresSeconds, filename: options.filename ?? item.name, ...(item.contentType ? { contentType: item.contentType } : {}) }, this.objectContext(item.tenantId, store, tools)));
  }

  /**
   * A presigned single-request upload (`files.write`, operation
   * `presign-upload`). The file is `pending` (not served) until
   * `confirmUpload` checks the stored size. The declared size is reserved
   * against the quota now; an upload not confirmed before it expires is
   * released by `sweep`.
   */
  async createUploadUrl(input: CreateUploadUrlInput, caller: AuthenticatedPrincipal): Promise<{ readonly file: File; readonly upload: PresignedRequest }> {
    const principal = requireVerifiedPrincipal(caller);
    const tenantId = resolveTenant(input, principal);
    const store = this.objectStore();
    if (!store.presignPut) throw new FileValidationError(`The ${store.id} object store cannot presign URLs; use upload or beginUpload`);
    const uploads = this.uploadStore();
    const owner = input.owner ?? principal.principalId;
    validateBytesInput({ ...input, owner });
    validateSize(input.size, 0);
    const lifecycle = this.lifecycleOf(input);
    await this.checkFileSize(tenantId, input.size);
    const expiresSeconds = this.presignSeconds(input.expiresInSeconds);
    return this.gateway().execute('files.write', principal, this.bytesResource(tenantId, owner, 'presign-upload', store, { size: String(input.size) }), this.bytesOptions(store), async (_context, tools) => {
      const id = randomUUID();
      const storageKey = this.storageKey(tenantId, id);
      const now = this.now();
      await this.reserve(tenantId, input.size, 1);
      const upload = await store.presignPut!(storageKey, { expiresSeconds, ...(input.contentType ? { contentType: input.contentType } : {}) }, this.objectContext(tenantId, store, tools));
      const session: FileUpload = {
        id: randomUUID(), tenantId, applicationId: this.gateway().application, fileId: id, owner, storageKey, objectStore: store.id, providerUploadId: PRESIGNED_SINGLE,
        size: input.size, partSize: input.size, partCount: 1, parts: [], status: 'open', createdAt: now.toISOString(), updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + expiresSeconds * 1000 + 60_000).toISOString(), createdBy: principal.principalId, __version: 1,
      };
      const file: File = this.pendingFile(id, tenantId, owner, input, storageKey, store, session.id, lifecycle);
      await uploads.create(session);
      await this.options.store.create(file);
      return { file, upload };
    });
  }

  /** Confirm a presigned upload: the stored size must equal the declared one. The file becomes `ready`. */
  async confirmUpload(tenantId: string, fileId: string, caller: AuthenticatedPrincipal): Promise<File> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    const file = await this.options.store.get(tenant, fileId);
    if (!file || file.deletedAt || !this.owned(file) || file.status !== 'pending' || !file.uploadId) throw new FileNotFoundError();
    const session = await this.uploadStore().get(tenant, file.uploadId);
    if (!session || session.providerUploadId !== PRESIGNED_SINGLE || session.status !== 'open') throw new FileNotFoundError();
    const store = this.storeOf(file);
    return this.gateway().execute('files.write', principal, this.bytesResource(tenant, file.owner, 'confirm-upload', store, {}, file.id), this.bytesOptions(store), async (_context, tools) => {
      const context = this.objectContext(tenant, store, tools);
      const stored = await store.head(file.storageKey, context);
      if (!stored) throw new FileValidationError('Nothing was uploaded for this file yet');
      if (stored.size !== session.size) {
        await this.discardUpload(session, file, store, context, principal);
        throw new FileValidationError(`Uploaded ${stored.size} bytes, declared ${session.size}; the upload was discarded`);
      }
      return this.finishUpload(session, file, principal);
    });
  }

  /**
   * Start a resumable upload (`files.write`, operation `upload`). The declared
   * size is checked against the quota and reserved before anything is stored.
   * The session (parts received so far) is durable: a client resumes after a
   * failure or restart by asking `uploadStatus` and sending the missing parts.
   */
  async beginUpload(input: BeginUploadInput, caller: AuthenticatedPrincipal): Promise<FileUploadView> {
    const principal = requireVerifiedPrincipal(caller);
    const tenantId = resolveTenant(input, principal);
    const store = this.objectStore();
    const uploads = this.uploadStore();
    const owner = input.owner ?? principal.principalId;
    validateBytesInput({ ...input, owner });
    validateSize(input.size, 1);
    const lifecycle = this.lifecycleOf(input);
    await this.checkFileSize(tenantId, input.size);
    const partSize = this.partSizeFor(input.size, input.partSize, store);
    const partCount = Math.max(1, Math.ceil(input.size / partSize));
    if (partCount > MAX_UPLOAD_PARTS) throw new FileValidationError(`An upload has at most ${MAX_UPLOAD_PARTS} parts; use a larger partSize`);
    return this.gateway().execute('files.write', principal, this.bytesResource(tenantId, owner, 'upload', store, { size: String(input.size) }), this.bytesOptions(store), async (_context, tools) => {
      const id = randomUUID();
      const storageKey = this.storageKey(tenantId, id);
      const now = this.now();
      await this.reserve(tenantId, input.size, 1);
      let providerUploadId: string;
      try {
        providerUploadId = await store.createMultipart(storageKey, { ...(input.contentType ? { contentType: input.contentType } : {}) }, this.objectContext(tenantId, store, tools));
      } catch (error) {
        await this.release(tenantId, input.size, 1);
        throw error;
      }
      const session: FileUpload = {
        id: randomUUID(), tenantId, applicationId: this.gateway().application, fileId: id, owner, storageKey, objectStore: store.id, providerUploadId,
        size: input.size, partSize, partCount, parts: [], status: 'open', createdAt: now.toISOString(), updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + (this.options.uploadExpiresSeconds ?? DEFAULT_UPLOAD_SECONDS) * 1000).toISOString(), createdBy: principal.principalId, __version: 1,
      };
      await uploads.create(session);
      await this.options.store.create(this.pendingFile(id, tenantId, owner, input, storageKey, store, session.id, lifecycle));
      return uploadView(session);
    });
  }

  /** Send one part of a resumable upload (`files.write`, operation `upload-part`). Re-sending a part replaces it. */
  async uploadPart(tenantId: string, uploadId: string, partNumber: number, data: Uint8Array | string, caller: AuthenticatedPrincipal): Promise<FileUploadView> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    const session = await this.openSession(tenant, uploadId);
    const bytes = typeof data === 'string' ? decodeBase64(data, 'data') : data instanceof Uint8Array ? data : (() => { throw new FileValidationError('data must be bytes'); })();
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.partCount) throw new FileValidationError(`partNumber must be an integer from 1 to ${session.partCount}`);
    const expected = partNumber < session.partCount ? session.partSize : session.size - session.partSize * (session.partCount - 1);
    if (bytes.byteLength !== expected) throw new FileValidationError(`Part ${partNumber} must be ${expected} bytes, received ${bytes.byteLength}`);
    const store = this.storeById(session.objectStore);
    return this.gateway().execute('files.write', principal, this.bytesResource(tenant, session.owner, 'upload-part', store, { uploadId: session.id, partNumber: String(partNumber) }, session.fileId), this.bytesOptions(store), async (_context, tools) => {
      const part = await store.putPart(session.storageKey, session.providerUploadId, partNumber, bytes, this.objectContext(tenant, store, tools));
      return uploadView(await this.recordParts(session, [part]));
    });
  }

  /** A presigned URL for one part (stores that presign); the client reports the part's ETag to `completeUpload`. */
  async createPartUploadUrl(tenantId: string, uploadId: string, partNumber: number, caller: AuthenticatedPrincipal, options: { readonly expiresInSeconds?: number } = {}): Promise<PresignedRequest> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    const session = await this.openSession(tenant, uploadId);
    const store = this.storeById(session.objectStore);
    if (!store.presignPart) throw new FileValidationError(`The ${store.id} object store cannot presign URLs; use uploadPart`);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > session.partCount) throw new FileValidationError(`partNumber must be an integer from 1 to ${session.partCount}`);
    const expiresSeconds = this.presignSeconds(options.expiresInSeconds);
    return this.gateway().execute('files.write', principal, this.bytesResource(tenant, session.owner, 'presign-part', store, { uploadId: session.id, partNumber: String(partNumber) }, session.fileId), this.bytesOptions(store), (_context, tools) =>
      store.presignPart!(session.storageKey, session.providerUploadId, partNumber, { expiresSeconds }, this.objectContext(tenant, store, tools)));
  }

  /** Where a resumable upload stands: the parts received and the parts still missing (`files.read`). */
  async uploadStatus(tenantId: string, uploadId: string, caller: AuthenticatedPrincipal): Promise<FileUploadView> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    const session = await this.uploadStore().get(tenant, uploadId);
    if (!session || session.applicationId !== this.gateway().application || session.providerUploadId === PRESIGNED_SINGLE) throw new FileNotFoundError();
    return this.gateway().execute('files.read', principal, { type: 'file', tenantId: tenant, id: session.fileId, attributes: { owner: session.owner, operation: 'upload-status' } }, { service: 'files' }, async () => uploadView(session));
  }

  /**
   * Finish a resumable upload once every part is stored. `parts` adds ETags of
   * parts the client sent to presigned part URLs. The stored size must equal
   * the declared one; the file becomes `ready`.
   */
  async completeUpload(tenantId: string, uploadId: string, caller: AuthenticatedPrincipal, options: { readonly parts?: readonly { readonly partNumber: number; readonly etag: string }[] } = {}): Promise<File> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    let session = await this.openSession(tenant, uploadId);
    const store = this.storeById(session.objectStore);
    const file = await this.options.store.get(tenant, session.fileId);
    if (!file || file.deletedAt || file.status !== 'pending') throw new FileNotFoundError();
    const reported = (options.parts ?? []).map((part) => {
      if (!part || !Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > session.partCount || typeof part.etag !== 'string' || !part.etag || part.etag.length > 256) throw new FileValidationError('parts must be { partNumber, etag } of this upload');
      return { partNumber: part.partNumber, etag: part.etag, size: part.partNumber < session.partCount ? session.partSize : session.size - session.partSize * (session.partCount - 1) };
    });
    return this.gateway().execute('files.write', principal, this.bytesResource(tenant, session.owner, 'complete-upload', store, { uploadId: session.id }, session.fileId), this.bytesOptions(store), async (_context, tools) => {
      if (reported.length) session = await this.recordParts(session, reported);
      const missing = missingParts(session);
      if (missing.length) throw new FileValidationError(`Parts ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', ...' : ''} are missing`);
      const context = this.objectContext(tenant, store, tools);
      await store.completeMultipart(session.storageKey, session.providerUploadId, session.parts, context);
      const stored = await store.head(session.storageKey, context);
      if (!stored || stored.size !== session.size) {
        await this.discardUpload(session, file, store, context, principal);
        throw new FileValidationError(`Stored ${stored?.size ?? 0} bytes, declared ${session.size}; the upload was discarded`);
      }
      return this.finishUpload(session, file, principal);
    });
  }

  /** Abandon a resumable or presigned upload: stored parts are deleted and the reserved quota released. */
  async abortUpload(tenantId: string, uploadId: string, caller: AuthenticatedPrincipal): Promise<FileUploadView> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    const session = await this.openSession(tenant, uploadId);
    const store = this.storeById(session.objectStore);
    const file = await this.options.store.get(tenant, session.fileId);
    return this.gateway().execute('files.write', principal, this.bytesResource(tenant, session.owner, 'abort-upload', store, { uploadId: session.id }, session.fileId), this.bytesOptions(store), async (_context, tools) =>
      uploadView(await this.discardUpload(session, file, store, this.objectContext(tenant, store, tools), principal)));
  }

  /** Bytes and files the tenant holds (uploads in progress included), with its quota (`files.read`). */
  async usage(tenantId: string, caller: AuthenticatedPrincipal): Promise<FileUsageView> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    return this.gateway().execute('files.read', principal, { type: 'file', tenantId: tenant, attributes: { owner: '*', operation: 'usage' } }, { service: 'files' }, async () => {
      const usage = await this.options.usage?.get(tenant, this.gateway().application);
      const quota = await this.quotaFor(tenant);
      return { tenantId: tenant, bytes: usage?.bytes ?? 0, files: usage?.files ?? 0, ...(quota ? { quota: { ...quota } } : {}) };
    });
  }

  /**
   * Lifecycle (`files.delete`, owner `*`, operation `lifecycle`): delete files
   * whose `expiresAt` has passed (unless retention still holds them) and
   * release their bytes, and abort uploads left open past their expiry. Run it
   * from a schedule. Bounded by `limit` (default 100, at most 1000) per call.
   */
  async sweep(tenantId: string, caller: AuthenticatedPrincipal, options: { readonly limit?: number } = {}): Promise<FileSweepResult> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new FileValidationError('limit must be an integer from 1 to 1000');
    const store = this.options.objectStore;
    return this.gateway().execute('files.delete', principal, { type: 'file', tenantId: tenant, attributes: { owner: '*', operation: 'lifecycle', ...(store?.credentialRef ? { credentialRef: store.credentialRef } : {}) } }, { service: 'files', ...(store ? { provider: store.id } : {}), ...(store?.credentialRef ? { credentialRef: store.credentialRef as CredentialRef } : {}) }, async (_context, tools) => {
      const now = this.now().toISOString();
      const deleted: string[] = [];
      const retained: string[] = [];
      const abortedUploads: string[] = [];
      let budget = limit;
      if (this.options.uploads) {
        const open = await this.options.uploads.listByStatus(tenant, 'open', limit + 1);
        for (const session of open.filter((item) => item.applicationId === this.gateway().application && item.expiresAt <= now)) {
          if (budget <= 0) break;
          budget -= 1;
          const sessionStore = this.storeById(session.objectStore);
          const file = await this.options.store.get(tenant, session.fileId);
          await this.discardUpload(session, file, sessionStore, this.objectContext(tenant, sessionStore, tools), principal);
          abortedUploads.push(session.id);
        }
      }
      const expired = (await this.options.store.list(tenant))
        .filter((item) => this.owned(item) && !item.deletedAt && item.status !== 'pending' && item.expiresAt !== undefined && item.expiresAt <= now)
        .sort((a, b) => (a.expiresAt ?? '').localeCompare(b.expiresAt ?? '') || a.id.localeCompare(b.id));
      let complete = true;
      for (const item of expired) {
        if (item.retainUntil && item.retainUntil > now) { retained.push(item.id); continue; }
        if (budget <= 0) { complete = false; break; }
        budget -= 1;
        await this.deleteRecord(item, principal, tools, 'file.expired');
        deleted.push(item.id);
      }
      return { deleted, retained, abortedUploads, complete };
    });
  }

  async get(tenantId: string, id: string, caller: AuthenticatedPrincipal): Promise<File> {
    const principal = requireVerifiedPrincipal(caller);
    const item = await this.options.store.get(resolveTenant({ tenantId }, principal), id);
    if (!item || item.deletedAt || item.status === 'pending' || !this.owned(item)) throw new FileNotFoundError();
    return this.gateway().execute('files.read', principal, fileResource(item), { service: 'files' }, async () => item);
  }

  /** Lists files. Without an owner filter the request is for all owners; AuthBoundry decides whether that is allowed. */
  async list(tenantId: string, caller: AuthenticatedPrincipal, options: FileListOptions = {}): Promise<readonly File[]> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    return this.gateway().execute('files.read', principal, { type: 'file', tenantId: tenant, attributes: { owner: options.owner ?? '*' } }, { service: 'files' }, async () =>
      (await this.options.store.list(tenant))
        .filter((item) => !item.deletedAt && item.status !== 'pending' && this.owned(item) && (!options.owner || item.owner === options.owner))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)));
  }

  /**
   * Which live files of this application name `storageKey`: the question to answer before a file's
   * bytes are released (several records may name the same bytes; a deleted record keeps its key).
   * A bounded lookup on the `storageKey` index, never a scan of the tenant's files. Authorized as
   * `files.read` on the tenant's files (`owner: "*"`): it reveals which files exist.
   *
   * `complete: false` means the answer is a lower bound (more live files than `limit`, or more than
   * FILE_REFERENCE_EXAMINATION_LIMIT records naming the key): treat it as "not known".
   */
  async references(tenantId: string, storageKey: string, caller: AuthenticatedPrincipal, options: FileReferenceOptions = {}): Promise<FileReferences> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    if (typeof storageKey !== 'string' || !storageKey.trim() || storageKey.length > 1024) throw new FileValidationError('storageKey is required');
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FileValidationError('limit must be an integer from 1 to 100');
    const find = this.options.store.findByStorageKey?.bind(this.options.store);
    if (!find) throw new FileValidationError('This file store cannot look up references by storage key');
    return this.gateway().execute('files.read', principal, { type: 'file', tenantId: tenant, attributes: { owner: '*', storageKey } }, { service: 'files' }, async () => {
      const { records, exhausted } = await find(tenant, storageKey, FILE_REFERENCE_EXAMINATION_LIMIT);
      const live = records.filter((item) => !item.deletedAt && this.owned(item)).map((item) => item.id);
      return { storageKey, live: live.slice(0, limit), complete: exhausted && live.length <= limit };
    });
  }

  async update(input: UpdateFileInput, caller: AuthenticatedPrincipal): Promise<File> {
    const principal = requireVerifiedPrincipal(caller);
    const tenantId = resolveTenant(input, principal);
    validateUpdate({ ...input, tenantId });
    const current = await this.options.store.get(tenantId, input.id);
    if (!current || current.deletedAt || current.status === 'pending' || !this.owned(current)) throw new FileNotFoundError();
    if (current.objectStore && (input.storageKey !== undefined || input.size !== undefined || input.checksum !== undefined)) {
      throw new FileValidationError('The bytes of a stored file are fixed: storageKey, size and checksum cannot change');
    }
    const lifecycle = this.lifecycleUpdate(current, input);
    return this.gateway().execute('files.write', principal, fileResource(current), { service: 'files' }, async () => {
      // Only the mutable metadata fields; owner, tenant, application, and lifecycle fields are not caller-writable.
      const sizeDelta = input.size !== undefined ? input.size - current.size : 0;
      if (sizeDelta > 0) await this.reserve(current.tenantId, sizeDelta, 0);
      else if (sizeDelta < 0) await this.release(current.tenantId, -sizeDelta, 0);
      const updated = await this.options.store.update(current.id, current.__version, { ...mutableFields(input), ...lifecycle, updatedAt: this.now().toISOString() });
      if (!updated) throw new FileValidationError('File was modified concurrently');
      await this.audit('file.updated', updated, principal);
      return updated;
    });
  }

  /**
   * Delete a file. Refused (DENIED, reason `retention_active`) while its
   * retention holds. A file whose bytes the service stores has them released
   * once no other live file names the same storage key.
   */
  async delete(tenantId: string, id: string, caller: AuthenticatedPrincipal): Promise<void> {
    const principal = requireVerifiedPrincipal(caller);
    const current = await this.options.store.get(resolveTenant({ tenantId }, principal), id);
    if (!current || current.deletedAt || current.status === 'pending' || !this.owned(current)) return;
    const store = current.objectStore ? this.storeOf(current) : undefined;
    const resource = store ? { ...fileResource(current), attributes: { owner: current.owner, objectStore: store.id, ...(store.credentialRef ? { credentialRef: store.credentialRef } : {}) } } : fileResource(current);
    await this.gateway().execute('files.delete', principal, resource, store ? this.bytesOptions(store) : { service: 'files' }, async (_context, tools) => {
      if (current.retainUntil && current.retainUntil > this.now().toISOString()) {
        throw new ServiceAuthorityError('DENIED', `File is retained until ${current.retainUntil}`, { capability: 'files.delete', reason: 'retention_active' });
      }
      await this.deleteRecord(current, principal, tools, 'file.deleted');
    });
  }

  private async deleteRecord(current: File, principal: VerifiedPrincipal, tools: EffectTools, type: 'file.deleted' | 'file.expired'): Promise<void> {
    const now = this.now().toISOString();
    const updated = await this.options.store.update(current.id, current.__version, { deletedAt: now, updatedAt: now });
    if (!updated) throw new FileValidationError('File was modified concurrently');
    await this.release(current.tenantId, current.size, 1);
    if (current.objectStore) await this.releaseBytes(current, tools);
    await this.audit(type, updated, principal);
  }

  /** Delete stored bytes no live file names any more. An uncertain answer keeps them. */
  private async releaseBytes(file: File, tools: EffectTools): Promise<void> {
    const find = this.options.store.findByStorageKey?.bind(this.options.store);
    if (!find) return;
    const { records, exhausted } = await find(file.tenantId, file.storageKey, FILE_REFERENCE_EXAMINATION_LIMIT);
    if (!exhausted || records.some((item) => item.id !== file.id && !item.deletedAt)) return;
    const store = this.storeOf(file);
    await store.delete(file.storageKey, this.objectContext(file.tenantId, store, tools));
  }

  private async finishUpload(session: FileUpload, file: File, principal: VerifiedPrincipal): Promise<File> {
    const now = this.now().toISOString();
    const closed = await this.uploadStore().update({ ...session, status: 'completed', updatedAt: now }, session.__version);
    if (!closed) throw new FileValidationError('The upload changed concurrently; ask uploadStatus and try again');
    const ready = await this.options.store.update(file.id, file.__version, { status: 'ready', size: session.size, uploadId: undefined, updatedAt: now });
    if (!ready) throw new FileValidationError('File was modified concurrently');
    await this.audit('file.uploaded', ready, principal);
    return ready;
  }

  private async discardUpload(session: FileUpload, file: File | null, store: FileObjectStore, context: ObjectStoreContext, principal: VerifiedPrincipal): Promise<FileUpload> {
    const now = this.now().toISOString();
    const aborted = await this.uploadStore().update({ ...session, status: 'aborted', updatedAt: now }, session.__version);
    if (!aborted) throw new FileValidationError('The upload changed concurrently; ask uploadStatus and try again');
    if (session.providerUploadId === PRESIGNED_SINGLE) await store.delete(session.storageKey, context).catch(() => undefined);
    else await store.abortMultipart(session.storageKey, session.providerUploadId, session.parts, context).catch(() => undefined);
    await this.release(session.tenantId, session.size, 1);
    if (file && !file.deletedAt) {
      const removed = await this.options.store.update(file.id, file.__version, { deletedAt: now, updatedAt: now });
      if (removed) await this.audit('file.upload.aborted', removed, principal);
    }
    return aborted;
  }

  private async recordParts(session: FileUpload, parts: readonly ObjectPart[]): Promise<FileUpload> {
    let current = session;
    for (let attempt = 0; attempt < 20; attempt++) {
      const merged = new Map(current.parts.map((part) => [part.partNumber, part]));
      for (const part of parts) merged.set(part.partNumber, { partNumber: part.partNumber, size: part.size, etag: part.etag });
      const next: FileUpload = { ...current, parts: [...merged.values()].sort((a, b) => a.partNumber - b.partNumber), updatedAt: this.now().toISOString() };
      const updated = await this.uploadStore().update(next, current.__version);
      if (updated) return updated;
      const reread = await this.uploadStore().get(current.tenantId, current.id);
      if (!reread || reread.status !== 'open') throw new FileValidationError('The upload is no longer open');
      current = reread;
    }
    throw new FileValidationError('The upload changed concurrently; try again');
  }

  private async openSession(tenantId: string, uploadId: string): Promise<FileUpload> {
    if (typeof uploadId !== 'string' || !uploadId) throw new FileValidationError('uploadId is required');
    const session = await this.uploadStore().get(tenantId, uploadId);
    if (!session || session.applicationId !== this.gateway().application) throw new FileNotFoundError();
    if (session.status !== 'open') throw new FileValidationError(`The upload is ${session.status}`);
    if (session.expiresAt <= this.now().toISOString()) throw new FileValidationError('The upload has expired');
    return session;
  }

  private async readable(tenantId: string, id: string): Promise<File> {
    const item = await this.options.store.get(tenantId, id);
    if (!item || item.deletedAt || item.status === 'pending' || !this.owned(item)) throw new FileNotFoundError();
    if (!item.objectStore) throw new FileValidationError('This file\'s bytes are kept by the host, not by AppPort Services');
    return item;
  }

  private pendingFile(id: string, tenantId: string, owner: string, input: FileBytesInput & { readonly size: number }, storageKey: string, store: FileObjectStore, uploadId: string, lifecycle: Partial<File>): File {
    const now = this.now().toISOString();
    return {
      id, tenantId, applicationId: this.gateway().application, owner, name: input.name, size: input.size, storageKey, objectStore: store.id, status: 'pending', uploadId,
      ...(input.contentType ? { contentType: input.contentType } : {}), ...(input.metadata ? { metadata: input.metadata } : {}), ...lifecycle,
      createdAt: now, updatedAt: now, __version: 1,
    };
  }

  private objectContext(tenantId: string, store: FileObjectStore, tools: EffectTools): ObjectStoreContext {
    return {
      tenantId,
      now: () => this.now(),
      send: (request) => sendOutboundRequest(request, this.options.destinationPolicy),
      withSecret: (use) => store.credentialRef
        ? tools.withCredential(store.credentialRef as CredentialRef, `files.object:${store.id}`, (secret) => use(secret.value))
        : use(undefined),
    };
  }

  private bytesResource(tenantId: string, owner: string, operation: string, store: FileObjectStore, extra: Record<string, string>, id?: string): ServiceResource {
    return { type: 'file', tenantId, ...(id ? { id } : {}), attributes: { owner, operation, objectStore: store.id, ...extra, ...(store.credentialRef ? { credentialRef: store.credentialRef } : {}) } };
  }

  private bytesOptions(store: FileObjectStore) {
    return { service: 'files', provider: store.id, ...(store.credentialRef ? { credentialRef: store.credentialRef as CredentialRef } : {}) };
  }

  private storageKey(tenantId: string, fileId: string): string {
    return `${this.gateway().application}/${tenantId}/${fileId}`;
  }

  private objectStore(): FileObjectStore {
    if (!this.options.objectStore) throw new FileValidationError('No object store is configured; files keeps metadata only on this host');
    return this.options.objectStore;
  }

  private storeById(id: string): FileObjectStore {
    const store = this.objectStore();
    if (store.id !== id) throw new FileValidationError(`The file's bytes are in the "${id}" object store, which this host does not configure`);
    return store;
  }

  private storeOf(file: File): FileObjectStore {
    return this.storeById(file.objectStore ?? '');
  }

  private uploadStore(): FileUploadStore {
    if (!this.options.uploads) throw new FileValidationError('Resumable uploads are not configured on this host');
    return this.options.uploads;
  }

  private async quotaFor(tenantId: string): Promise<FileQuota | undefined> {
    const policy = this.options.quota;
    return typeof policy === 'function' ? await policy(tenantId) : policy;
  }

  private async checkFileSize(tenantId: string, size: number): Promise<void> {
    const quota = await this.quotaFor(tenantId);
    if (quota?.maxFileBytes !== undefined && size > quota.maxFileBytes) throw new FileQuotaExceededError(`A file may be at most ${quota.maxFileBytes} bytes`);
  }

  /** Count bytes and files against the tenant's quota before writing. Refuses with QUOTA_EXCEEDED. */
  private async reserve(tenantId: string, bytes: number, files: number): Promise<void> {
    if (!this.options.usage) return;
    const quota = await this.quotaFor(tenantId);
    if (quota?.maxFileBytes !== undefined && files > 0 && bytes > quota.maxFileBytes) throw new FileQuotaExceededError(`A file may be at most ${quota.maxFileBytes} bytes`);
    const result = await this.options.usage.adjust(tenantId, this.gateway().application, { bytes, files }, quota, this.now().toISOString());
    if (!result.allowed) {
      throw new FileQuotaExceededError(`Tenant quota exceeded (${result.usage.bytes} of ${quota?.maxBytes ?? 'unlimited'} bytes, ${result.usage.files} of ${quota?.maxFiles ?? 'unlimited'} files used)`);
    }
  }

  private async release(tenantId: string, bytes: number, files: number): Promise<void> {
    if (!this.options.usage) return;
    await this.options.usage.adjust(tenantId, this.gateway().application, { bytes: -bytes, files: -files }, undefined, this.now().toISOString());
  }

  private presignSeconds(requested: number | undefined): number {
    const seconds = requested ?? this.options.presignExpiresSeconds ?? DEFAULT_PRESIGN_SECONDS;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 604_800) throw new FileValidationError('expiresInSeconds must be an integer from 1 to 604800');
    return seconds;
  }

  private partSizeFor(size: number, requested: number | undefined, store: FileObjectStore): number {
    const partSize = requested ?? Math.max(this.options.partSize ?? DEFAULT_PART_SIZE, store.minPartSize);
    if (!Number.isInteger(partSize) || partSize < 1) throw new FileValidationError('partSize must be a positive integer');
    if (partSize > store.maxPartSize) throw new FileValidationError(`partSize may be at most ${store.maxPartSize} bytes for the ${store.id} store`);
    if (partSize < store.minPartSize && size > partSize) throw new FileValidationError(`partSize must be at least ${store.minPartSize} bytes for the ${store.id} store`);
    return Math.min(partSize, size);
  }

  private lifecycleOf(input: { readonly retainUntil?: unknown; readonly expiresAt?: unknown }): Partial<File> {
    const retainUntil = optionalTime(input.retainUntil, 'retainUntil');
    const expiresAt = optionalTime(input.expiresAt, 'expiresAt');
    const now = this.now().toISOString();
    if (expiresAt && expiresAt <= now) throw new FileValidationError('expiresAt must be in the future');
    return { ...(retainUntil ? { retainUntil } : {}), ...(expiresAt ? { expiresAt } : {}) };
  }

  private lifecycleUpdate(current: File, input: UpdateFileInput): Partial<File> {
    const changes: Record<string, unknown> = {};
    if (input.retainUntil !== undefined) {
      const retainUntil = optionalTime(input.retainUntil, 'retainUntil')!;
      if (current.retainUntil && retainUntil < current.retainUntil) throw new FileValidationError('Retention can be extended, not shortened');
      changes.retainUntil = retainUntil;
    }
    if (input.expiresAt === null) changes.expiresAt = undefined;
    else if (input.expiresAt !== undefined) {
      const expiresAt = optionalTime(input.expiresAt, 'expiresAt')!;
      if (expiresAt <= this.now().toISOString()) throw new FileValidationError('expiresAt must be in the future');
      changes.expiresAt = expiresAt;
    }
    return changes as Partial<File>;
  }

  private owned(item: File): boolean {
    return item.applicationId === this.gateway().application;
  }

  private gateway(): ServiceGateway {
    if (!this.options.authority) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Files have no AuthBoundry authority configured');
    return this.options.authority;
  }

  private async audit(type: FileAuditEventType, item: File, principal: AuthenticatedPrincipal): Promise<void> {
    await this.options.auditSink.record({
      id: randomUUID(),
      type,
      fileId: item.id,
      tenantId: item.tenantId,
      owner: item.owner,
      principalId: principal.principalId,
      timestamp: this.now().toISOString(),
      result: 'success',
    });
  }
}

const MUTABLE_FILE_FIELDS = ['name', 'contentType', 'size', 'checksum', 'storageKey', 'metadata'] as const;

function mutableFields(input: Partial<Record<(typeof MUTABLE_FILE_FIELDS)[number], unknown>>): Partial<File> {
  const changes: Record<string, unknown> = {};
  for (const field of MUTABLE_FILE_FIELDS) if (input[field] !== undefined) changes[field] = input[field];
  return changes as Partial<File>;
}

type FileAuditEventType = 'file.created' | 'file.updated' | 'file.deleted' | 'file.uploaded' | 'file.upload.aborted' | 'file.expired';

function uploadView(session: FileUpload): FileUploadView {
  const received = session.parts.map((part) => part.partNumber).sort((a, b) => a - b);
  return {
    uploadId: session.id, fileId: session.fileId, status: session.status, size: session.size, partSize: session.partSize, partCount: session.partCount,
    receivedParts: received, missingParts: missingParts(session), receivedBytes: session.parts.reduce((sum, part) => sum + part.size, 0),
    expiresAt: session.expiresAt, objectStore: session.objectStore,
  };
}

function missingParts(session: FileUpload): number[] {
  const received = new Set(session.parts.map((part) => part.partNumber));
  const missing: number[] = [];
  for (let part = 1; part <= session.partCount; part++) if (!received.has(part)) missing.push(part);
  return missing;
}

function bytesOf(input: UploadFileInput): Uint8Array {
  if ((input.data === undefined) === (input.dataBase64 === undefined)) throw new FileValidationError('Pass data or dataBase64');
  if (input.dataBase64 !== undefined) return decodeBase64(input.dataBase64, 'dataBase64');
  if (!(input.data instanceof Uint8Array)) throw new FileValidationError('data must be bytes');
  return input.data;
}

function decodeBase64(value: unknown, field: string): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new FileValidationError(`${field} must be base64`);
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function validateSize(size: unknown, min: number): void {
  if (!Number.isInteger(size) || (size as number) < min) throw new FileValidationError(`size must be an integer of at least ${min}`);
}

function validateBytesInput(input: FileBytesInput & { owner: string }): void {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 1024) throw new FileValidationError('name is required');
  if (typeof input.owner !== 'string' || !input.owner.trim()) throw new FileValidationError('owner is required');
  if (input.contentType !== undefined && (typeof input.contentType !== 'string' || input.contentType.length > 255 || /[\r\n]/.test(input.contentType))) throw new FileValidationError('contentType is invalid');
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) throw new FileValidationError('metadata must be an object');
}

function optionalTime(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) throw new FileValidationError(`${field} must be an ISO-8601 time`);
  return parsed.toISOString();
}

function fileResource(item: File): ServiceResource {
  return { type: 'file', tenantId: item.tenantId, id: item.id, attributes: { owner: item.owner } };
}

function validateCreate(input: CreateFileInput & { tenantId: string; owner: string }): void {
  if (!input.tenantId.trim()) throw new FileValidationError('tenantId is required');
  if (!input.owner.trim()) throw new FileValidationError('owner is required');
  if (!input.name.trim()) throw new FileValidationError('name is required');
  if (!input.storageKey.trim()) throw new FileValidationError('storageKey is required');
  if (!Number.isInteger(input.size) || input.size < 0) throw new FileValidationError('size must be a non-negative integer');
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) throw new FileValidationError('metadata must be an object');
}

function validateUpdate(input: UpdateFileInput & { tenantId: string }): void {
  if (typeof input.id !== 'string') throw new FileValidationError('id is required');
  if (!input.tenantId.trim()) throw new FileValidationError('tenantId is required');
  if (!input.id.trim()) throw new FileValidationError('id is required');
  const provided = ['name', 'contentType', 'size', 'checksum', 'storageKey', 'metadata', 'retainUntil', 'expiresAt'].some((key) => key in input);
  if (!provided) throw new FileValidationError('At least one file property must be updated');
  if (input.name !== undefined && !input.name.trim()) throw new FileValidationError('name must be a non-empty string');
  if (input.storageKey !== undefined && !input.storageKey.trim()) throw new FileValidationError('storageKey must be a non-empty string');
  if (input.size !== undefined && (!Number.isInteger(input.size) || input.size < 0)) throw new FileValidationError('size must be a non-negative integer');
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) throw new FileValidationError('metadata must be an object');
}
