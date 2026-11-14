import { randomUUID } from 'node:crypto';

import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { FileAuditSink, FileStore } from '../storage/files.js';
import type { CreateFileInput, File, FileReferenceOptions, FileReferences, UpdateFileInput } from './models.js';
import { FILE_REFERENCE_EXAMINATION_LIMIT } from '../storage/files.js';
import type { ServiceResource } from '../authority/context.js';
import { ServiceAuthorityError } from '../authority/errors.js';
import type { ServiceGateway } from '../authority/gateway.js';
import { requireVerifiedPrincipal, resolveTenant } from '../authority/principal.js';

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

export interface FileServiceOptions {
  readonly store: FileStore;
  readonly auditSink: FileAuditSink;
  /** Policy Enforcement Point. Without it every file operation fails closed. */
  readonly authority?: ServiceGateway;
  readonly now?: () => Date;
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
    return this.gateway().execute('files.write', principal, { type: 'file', tenantId, attributes: { owner } }, { service: 'files' }, async () => {
      const now = this.now().toISOString();
      const item: File = { ...mutableFields(input), name: input.name, size: input.size, storageKey: input.storageKey, tenantId, applicationId: this.gateway().application, owner, id: randomUUID(), createdAt: now, updatedAt: now, __version: 1 };
      await this.options.store.create(item);
      await this.audit('file.created', item, principal);
      return item;
    });
  }

  async get(tenantId: string, id: string, caller: AuthenticatedPrincipal): Promise<File> {
    const principal = requireVerifiedPrincipal(caller);
    const item = await this.options.store.get(resolveTenant({ tenantId }, principal), id);
    if (!item || item.deletedAt || !this.owned(item)) throw new FileNotFoundError();
    return this.gateway().execute('files.read', principal, fileResource(item), { service: 'files' }, async () => item);
  }

  /** Lists files. Without an owner filter the request is for all owners; AuthBoundry decides whether that is allowed. */
  async list(tenantId: string, caller: AuthenticatedPrincipal, options: FileListOptions = {}): Promise<readonly File[]> {
    const principal = requireVerifiedPrincipal(caller);
    const tenant = resolveTenant({ tenantId }, principal);
    return this.gateway().execute('files.read', principal, { type: 'file', tenantId: tenant, attributes: { owner: options.owner ?? '*' } }, { service: 'files' }, async () =>
      (await this.options.store.list(tenant))
        .filter((item) => !item.deletedAt && this.owned(item) && (!options.owner || item.owner === options.owner))
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
    if (!current || current.deletedAt || !this.owned(current)) throw new FileNotFoundError();
    return this.gateway().execute('files.write', principal, fileResource(current), { service: 'files' }, async () => {
      // Only the mutable metadata fields; owner, tenant, application, and lifecycle fields are not caller-writable.
      const updated = await this.options.store.update(current.id, current.__version, { ...mutableFields(input), updatedAt: this.now().toISOString() });
      if (!updated) throw new FileValidationError('File was modified concurrently');
      await this.audit('file.updated', updated, principal);
      return updated;
    });
  }

  async delete(tenantId: string, id: string, caller: AuthenticatedPrincipal): Promise<void> {
    const principal = requireVerifiedPrincipal(caller);
    const current = await this.options.store.get(resolveTenant({ tenantId }, principal), id);
    if (!current || current.deletedAt || !this.owned(current)) return;
    await this.gateway().execute('files.delete', principal, fileResource(current), { service: 'files' }, async () => {
      const updated = await this.options.store.update(current.id, current.__version, { deletedAt: this.now().toISOString(), updatedAt: this.now().toISOString() });
      if (!updated) throw new FileValidationError('File was modified concurrently');
      await this.audit('file.deleted', updated, principal);
    });
  }

  private owned(item: File): boolean {
    return item.applicationId === this.gateway().application;
  }

  private gateway(): ServiceGateway {
    if (!this.options.authority) throw new ServiceAuthorityError('AUTHORITY_UNAVAILABLE', 'Files have no AuthBoundry authority configured');
    return this.options.authority;
  }

  private async audit(type: 'file.created' | 'file.updated' | 'file.deleted', item: File, principal: AuthenticatedPrincipal): Promise<void> {
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
  const provided = ['name', 'contentType', 'size', 'checksum', 'storageKey', 'metadata'].some((key) => key in input);
  if (!provided) throw new FileValidationError('At least one file property must be updated');
  if (input.name !== undefined && !input.name.trim()) throw new FileValidationError('name must be a non-empty string');
  if (input.storageKey !== undefined && !input.storageKey.trim()) throw new FileValidationError('storageKey must be a non-empty string');
  if (input.size !== undefined && (!Number.isInteger(input.size) || input.size < 0)) throw new FileValidationError('size must be a non-negative integer');
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) throw new FileValidationError('metadata must be an object');
}
