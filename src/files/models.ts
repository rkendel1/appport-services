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
  readonly __version: number;
}

export interface FileAuditEvent {
  readonly id: string;
  readonly type: 'file.created' | 'file.updated' | 'file.deleted';
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
