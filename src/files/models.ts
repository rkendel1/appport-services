export interface File {
  readonly id: string;
  readonly tenantId: string;
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
  readonly tenantId: string;
  readonly owner: string;
  readonly name: string;
  readonly contentType?: string;
  readonly size: number;
  readonly checksum?: string;
  readonly storageKey: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface UpdateFileInput {
  readonly tenantId: string;
  readonly id: string;
  readonly name?: string;
  readonly contentType?: string;
  readonly size?: number;
  readonly checksum?: string;
  readonly storageKey?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
