import type { StateFirstDB } from '@feltdb/core';

import type { File, FileAuditEvent } from '../files/models.js';
import { FELTDB_QUERY_PAGE_LIMIT } from './bounded.js';

const FILES = 'files';
const AUDIT = 'file_audit_events';

/** The most records naming one storage key a reference lookup examines before it answers "incomplete". */
export const FILE_REFERENCE_EXAMINATION_LIMIT = 10_000;

export interface FileStore {
  create(item: File): Promise<void>;
  get(tenantId: string, id: string): Promise<File | null>;
  list(tenantId: string): Promise<readonly File[]>;
  update(id: string, expectedVersion: number, updates: Partial<File>): Promise<File | null>;
  /**
   * The records of `tenantId` naming `storageKey`, deleted or not, by a bounded, indexed query:
   * at most `limit` of them, and whether that was all. Optional for compatibility with
   * stores written before it: `FileService.references` refuses without it.
   */
  findByStorageKey?(tenantId: string, storageKey: string, limit: number): Promise<{ readonly records: readonly File[]; readonly exhausted: boolean }>;
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

  /** Every file record of the tenant, read in bounded pages (an unbounded find is refused above 1,000). */
  async list(tenantId: string): Promise<readonly File[]> {
    const items: File[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.db.query<File>({ collection: FILES, where: [{ field: 'tenantId', eq: tenantId }], limit: FELTDB_QUERY_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
      items.push(...page.records.filter((item) => item.tenantId === tenantId));
      if (page.exhausted || !page.nextCursor || page.records.length === 0) return items;
      cursor = page.nextCursor;
    }
  }

  async findByStorageKey(tenantId: string, storageKey: string, limit: number): Promise<{ readonly records: readonly File[]; readonly exhausted: boolean }> {
    this.ensureStorageKeyIndex();
    const records: File[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.db.query<File>({
        collection: FILES,
        where: [{ field: 'storageKey', eq: storageKey }, { field: 'tenantId', eq: tenantId }],
        limit: Math.min(FELTDB_QUERY_PAGE_LIMIT, limit - records.length + 1),
        ...(cursor ? { cursor } : {}),
      });
      records.push(...page.records.filter((item) => item.tenantId === tenantId && item.storageKey === storageKey));
      if (page.exhausted || !page.nextCursor || page.records.length === 0) return { records: records.slice(0, limit), exhausted: records.length <= limit };
      if (records.length > limit) return { records: records.slice(0, limit), exhausted: false };
      cursor = page.nextCursor;
    }
  }

  private storageKeyIndexed = false;

  /**
   * The hash index on `storageKey`, declared the first time it is needed (a managed authority
   * declares it from the contract, `files_by_storage_key`); a runtime that refuses the declaration
   * still answers the bounded query.
   */
  private ensureStorageKeyIndex(): void {
    if (this.storageKeyIndexed) return;
    this.storageKeyIndexed = true;
    try {
      if (!this.collection.listIndexes().some((index) => index.field === 'storageKey')) {
        this.collection.createIndex({ name: 'files_by_storage_key', type: 'hash', field: 'storageKey' });
      }
    } catch { /* the bounded query is still correct without the index */ }
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
