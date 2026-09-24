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
