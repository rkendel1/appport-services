export interface File {
  readonly id: string;
  readonly tenantId: string;
  /** Owning application. Records without one (created before application scoping) are not served. */
  readonly applicationId?: string;
  readonly owner: string;
  readonly name: string;
  readonly contentType?: string;
  readonly size: number;
  readonly checksum?: string;
  readonly storageKey: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly deletedAt?: string;
  /**
   * Set when AppPort Services holds the bytes (`upload`, presigned or resumable
   * uploads): the object store's id (`feltdb`, `s3`, ...). Absent for a
   * metadata-only record whose bytes the host keeps.
   */
  readonly objectStore?: string;
  /** `pending` while an upload is in progress (not served); `ready` once the bytes are stored. Absent: ready. */
  readonly status?: 'pending' | 'ready';
  /** The resumable upload producing this file, while pending. */
  readonly uploadId?: string;
  /** Retention: the file cannot be deleted before this time (it can only be extended). */
  readonly retainUntil?: string;
  /** Lifecycle: `files.sweep` deletes the file (and releases its bytes) after this time, once retention allows. */
  readonly expiresAt?: string;
  readonly __version: number;
}

export interface FileAuditEvent {
  readonly id: string;
  readonly type: 'file.created' | 'file.updated' | 'file.deleted' | 'file.uploaded' | 'file.upload.aborted' | 'file.expired';
  readonly fileId: string;
  readonly tenantId: string;
  readonly owner: string;
  readonly principalId: string;
  readonly timestamp: string;
  readonly result: 'success';
}

export interface CreateFileInput {
  /** Optional; must equal the caller's tenant. */
  readonly tenantId?: string;
  /** Defaults to the caller. Passed to AuthBoundry as a resource attribute; not trusted as identity. */
  readonly owner?: string;
  readonly name: string;
  readonly contentType?: string;
  readonly size: number;
  readonly checksum?: string;
  readonly storageKey: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly retainUntil?: string;
  readonly expiresAt?: string;
}

export interface UpdateFileInput {
  readonly tenantId?: string;
  readonly id: string;
  readonly name?: string;
  readonly contentType?: string;
  readonly size?: number;
  readonly checksum?: string;
  readonly storageKey?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Extend retention (never shorten). */
  readonly retainUntil?: string;
  /** Set (or clear with null) the lifecycle expiry. */
  readonly expiresAt?: string | null;
}

/** Shared by every way of storing bytes through the service. */
export interface FileBytesInput {
  readonly tenantId?: string;
  /** Defaults to the caller. */
  readonly owner?: string;
  readonly name: string;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly retainUntil?: string;
  readonly expiresAt?: string;
}

/** `files.upload`: bytes in one call (in process `data`, or `dataBase64` through invoke). */
export interface UploadFileInput extends FileBytesInput {
  readonly data?: Uint8Array;
  readonly dataBase64?: string;
}

/** `files.createUploadUrl`: a presigned single-request upload (object stores that presign). */
export interface CreateUploadUrlInput extends FileBytesInput {
  /** Exact size the client will upload. Reserved against the quota now. */
  readonly size: number;
  readonly expiresInSeconds?: number;
}

/** `files.beginUpload`: a resumable (multipart) upload. */
export interface BeginUploadInput extends FileBytesInput {
  readonly size: number;
  /** Bytes per part (the last may be smaller). Default 8 MiB, within the store's bounds. */
  readonly partSize?: number;
}

/** Where a resumable upload stands. */
export interface FileUploadView {
  readonly uploadId: string;
  readonly fileId: string;
  readonly status: 'open' | 'completed' | 'aborted';
  readonly size: number;
  readonly partSize: number;
  readonly partCount: number;
  /** Part numbers received, ascending. */
  readonly receivedParts: readonly number[];
  /** Part numbers still to send, ascending. */
  readonly missingParts: readonly number[];
  readonly receivedBytes: number;
  readonly expiresAt: string;
  readonly objectStore: string;
}

export interface FileUsageView {
  readonly tenantId: string;
  readonly bytes: number;
  readonly files: number;
  readonly quota?: { readonly maxBytes?: number; readonly maxFiles?: number; readonly maxFileBytes?: number };
}

export interface FileSweepResult {
  /** Expired files deleted (and their bytes released). */
  readonly deleted: readonly string[];
  /** Expired files kept because retention has not ended. */
  readonly retained: readonly string[];
  /** Expired open uploads aborted. */
  readonly abortedUploads: readonly string[];
  /** False when the sweep stopped at its limit: run it again. */
  readonly complete: boolean;
}

/**
 * Which live files of this application name a storage key (`FileService.references`). A file's
 * bytes may be released only when no live file names them, and only on a `complete` answer.
 */
export interface FileReferences {
  readonly storageKey: string;
  /** Ids of live (not deleted) files naming `storageKey`, at most the requested `limit`. */
  readonly live: readonly string[];
  /**
   * `true`: every record naming `storageKey` was examined, and `live` is all of the live ones.
   * `false`: more live files exist than `limit`, or the lookup stopped at its examination bound;
   * `live` is then a lower bound. A caller deciding to release bytes must treat `false` as "unknown".
   */
  readonly complete: boolean;
}

export interface FileReferenceOptions {
  /** The most live ids to return: 1–100, default 100. */
  readonly limit?: number;
}
