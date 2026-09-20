import type { StateFirstDB } from '@feltdb/core';

import type { File, FileAuditEvent } from '../files/models.js';

const FILES = 'files';
const AUDIT = 'file_audit_events';

export interface FileStore {
  create(item: File): Promise<void>;
  get(tenantId: string, id: string): Promise<File | null>;
  list(tenantId: string): Promise<readonly File[]>;
  update(id: string, expectedVersion: number, updates: Partial<File>): Promise<File | null>;
}

export interface FileAuditSink {
  record(event: FileAuditEvent): Promise<void>;
}

export class FeltDbFileStore implements FileStore {
  private readonly collection;

  constructor(private readonly db: StateFirstDB) {
    this.collection = db.collection<File>(FILES);
  }

  async create(item: File): Promise<void> {
    await this.db.transaction({
      operations: [{ collection: FILES, id: item.id, requireAbsent: true, value: { ...item } }],
    });
  }

  async get(tenantId: string, id: string): Promise<File | null> {
    const item = await this.collection.get(id);
    return item?.tenantId === tenantId ? item : null;
  }

  async list(tenantId: string): Promise<readonly File[]> {
    return this.collection.find({ tenantId });
  }

  async update(id: string, expectedVersion: number, updates: Partial<File>): Promise<File | null> {
    const current = await this.collection.get(id);
    if (!current) return null;
    const result = await this.collection.updateIfVersion(id, expectedVersion, { ...current, ...updates });
    return result.updated ? result.item ?? null : null;
  }
}

export class FeltDbFileAuditSink implements FileAuditSink {
  private readonly collection;

  constructor(private readonly db: StateFirstDB) {
    this.collection = db.collection<FileAuditEvent>(AUDIT);
  }

  async record(event: FileAuditEvent): Promise<void> {
    await this.collection.insert({ ...event }, event.id);
  }
}

export function fileCollectionNames(): readonly string[] {
  return [FILES, AUDIT];
}
