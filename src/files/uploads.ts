import { createHash } from 'node:crypto';

import type { StateFirstDB } from '@feltdb/core';

import { boundedFind } from '../storage/bounded.js';
import type { ObjectPart } from './objects.js';

const UPLOADS = 'file_uploads';
const USAGE = 'file_usage';

export type FileUploadStatus = 'open' | 'completed' | 'aborted';

/**
 * A resumable upload, persisted so it survives a restart: the file it
 * produces, the store's multipart upload id, the part size, and every part
 * received so far. A client resumes by asking `uploadStatus` for the missing
 * parts and sending only those.
 */
export interface FileUpload {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly fileId: string;
  readonly owner: string;
  readonly storageKey: string;
  readonly objectStore: string;
  /** The object store's multipart upload id. */
  readonly providerUploadId: string;
  /** Declared total size. */
  readonly size: number;
  readonly partSize: number;
  readonly partCount: number;
  readonly parts: readonly ObjectPart[];
  readonly status: FileUploadStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** An open upload past this time is aborted by `files.sweep`. */
  readonly expiresAt: string;
  readonly createdBy: string;
  readonly __version: number;
}

export interface FileUploadStore {
  create(upload: FileUpload): Promise<void>;
  get(tenantId: string, id: string): Promise<FileUpload | null>;
  update(upload: FileUpload, expectedVersion: number): Promise<FileUpload | null>;
  /** At most `limit` uploads of the tenant with this status. */
  listByStatus(tenantId: string, status: FileUploadStatus, limit: number): Promise<readonly FileUpload[]>;
}

export class FeltDbFileUploadStore implements FileUploadStore {
  private readonly collection;

  constructor(private readonly db: StateFirstDB) {
    this.collection = db.collection<FileUpload>(UPLOADS);
  }

  async create(upload: FileUpload): Promise<void> {
    await this.db.transaction({ operations: [{ collection: UPLOADS, id: upload.id, requireAbsent: true, value: { ...upload, parts: [...upload.parts] } }] });
  }

  async get(tenantId: string, id: string): Promise<FileUpload | null> {
    const upload = await this.collection.get(id);
    return upload?.tenantId === tenantId ? upload : null;
  }

  async update(upload: FileUpload, expectedVersion: number): Promise<FileUpload | null> {
    const result = await this.collection.updateIfVersion(upload.id, expectedVersion, { ...upload, parts: [...upload.parts] });
    return result.updated ? result.item ?? null : null;
  }

  listByStatus(tenantId: string, status: FileUploadStatus, limit: number): Promise<readonly FileUpload[]> {
    return boundedFind<FileUpload>(this.db, UPLOADS, { tenantId, status }, limit);
  }
}

/** Bytes and files a tenant holds (per application), including uploads in progress (reserved). */
export interface FileUsage {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly bytes: number;
  readonly files: number;
  readonly updatedAt: string;
  readonly __version: number;
}

/**
 * Per-tenant limits, enforced before anything is written. A limit that is
 * absent is not enforced.
 */
export interface FileQuota {
  /** Total bytes of the tenant's files, uploads in progress included. */
  readonly maxBytes?: number;
  /** Number of the tenant's files, uploads in progress included. */
  readonly maxFiles?: number;
  /** Largest single file. */
  readonly maxFileBytes?: number;
}

export interface FileUsageStore {
  get(tenantId: string, applicationId: string): Promise<FileUsage | null>;
  /**
   * Add `bytes` and `files` (negative to release). With `quota`, refuses
   * (returns `{ allowed: false }`) when the result would exceed it; releases
   * are always applied. Compare-and-set; counts never go below zero.
   */
  adjust(tenantId: string, applicationId: string, delta: { readonly bytes: number; readonly files: number }, quota: FileQuota | undefined, now: string): Promise<{ readonly allowed: boolean; readonly usage: FileUsage }>;
}

export class FeltDbFileUsageStore implements FileUsageStore {
  private readonly collection;

  constructor(private readonly db: StateFirstDB) {
    this.collection = db.collection<FileUsage>(USAGE);
  }

  async get(tenantId: string, applicationId: string): Promise<FileUsage | null> {
    const usage = await this.collection.get(usageId(tenantId, applicationId));
    return usage?.tenantId === tenantId ? usage : null;
  }

  async adjust(tenantId: string, applicationId: string, delta: { readonly bytes: number; readonly files: number }, quota: FileQuota | undefined, now: string): Promise<{ readonly allowed: boolean; readonly usage: FileUsage }> {
    const id = usageId(tenantId, applicationId);
    for (let attempt = 0; attempt < 20; attempt++) {
      const current = await this.collection.get(id);
      const bytes = Math.max(0, (current?.bytes ?? 0) + delta.bytes);
      const files = Math.max(0, (current?.files ?? 0) + delta.files);
      const growing = delta.bytes > 0 || delta.files > 0;
      if (growing && quota && ((quota.maxBytes !== undefined && delta.bytes > 0 && bytes > quota.maxBytes) || (quota.maxFiles !== undefined && delta.files > 0 && files > quota.maxFiles))) {
        return { allowed: false, usage: current ?? { id, tenantId, applicationId, bytes: 0, files: 0, updatedAt: now, __version: 0 } };
      }
      if (!current) {
        const usage: FileUsage = { id, tenantId, applicationId, bytes, files, updatedAt: now, __version: 1 };
        try {
          await this.db.transaction({ operations: [{ collection: USAGE, id, requireAbsent: true, value: { ...usage } }] });
          return { allowed: true, usage };
        } catch {
          continue;
        }
      }
      const result = await this.collection.updateIfVersion(id, current.__version, { ...current, bytes, files, updatedAt: now });
      if (result.updated && result.item) return { allowed: true, usage: result.item };
    }
    throw new Error('File usage changed concurrently; try again');
  }
}

function usageId(tenantId: string, applicationId: string): string {
  return `usage_${createHash('sha256').update(`${applicationId}\u0000${tenantId}`).digest('hex').slice(0, 40)}`;
}

export function fileUploadCollectionNames(): readonly string[] {
  return [UPLOADS, USAGE];
}
