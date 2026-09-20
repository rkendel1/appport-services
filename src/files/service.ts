import { randomUUID } from 'node:crypto';

import type { AuthenticatedPrincipal } from '../contract/principals.js';
import type { FileAuditSink, FileStore } from '../storage/files.js';
import type { CreateFileInput, File, UpdateFileInput } from './models.js';

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
  readonly now?: () => Date;
}

export class FileService {
  private readonly now: () => Date;

  constructor(private readonly options: FileServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async create(input: CreateFileInput, principal: AuthenticatedPrincipal): Promise<File> {
    this.authorizeTenant(principal, input.tenantId, 'files.create');
    validateCreate(input);
    const now = this.now().toISOString();
    const item: File = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, __version: 1 };
    await this.options.store.create(item);
    await this.audit('file.created', item, principal);
    return item;
  }

  async get(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<File> {
    const item = await this.options.store.get(tenantId, id);
    if (!item || item.deletedAt) throw new FileNotFoundError();
    this.authorizeItem(principal, item, 'files.read');
    return item;
  }

  async list(tenantId: string, principal: AuthenticatedPrincipal, options: FileListOptions = {}): Promise<readonly File[]> {
    this.authorizeTenant(principal, tenantId, 'files.read');
    let items = (await this.options.store.list(tenantId))
      .filter((item) => !item.deletedAt && (!options.owner || item.owner === options.owner))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    if (!principal.scopes.includes('files.read:any') && !principal.scopes.includes('files.admin')) {
      items = items.filter((item) => item.owner === principal.principalId);
    }
    return items;
  }

  async update(input: UpdateFileInput, principal: AuthenticatedPrincipal): Promise<File> {
    validateUpdate(input);
    const current = await this.options.store.get(input.tenantId, input.id);
    if (!current || current.deletedAt) throw new FileNotFoundError();
    this.authorizeItem(principal, current, 'files.write');
    const updated = await this.options.store.update(current.id, current.__version, { ...input, updatedAt: this.now().toISOString() });
    if (!updated) throw new FileValidationError('File was modified concurrently');
    await this.audit('file.updated', updated, principal);
    return updated;
  }

  async delete(tenantId: string, id: string, principal: AuthenticatedPrincipal): Promise<void> {
    const current = await this.options.store.get(tenantId, id);
    if (!current || current.deletedAt) return;
    this.authorizeItem(principal, current, 'files.delete');
    const updated = await this.options.store.update(current.id, current.__version, { deletedAt: this.now().toISOString(), updatedAt: this.now().toISOString() });
    if (!updated) throw new FileValidationError('File was modified concurrently');
    await this.audit('file.deleted', updated, principal);
  }

  private authorizeTenant(principal: AuthenticatedPrincipal, tenantId: string, scope: string): void {
    if (principal.tenantId !== tenantId || (!principal.scopes.includes(scope) && !principal.scopes.includes('files.admin'))) {
      throw new FileAuthorizationError();
    }
  }

  private authorizeItem(principal: AuthenticatedPrincipal, item: File, scope: string): void {
    this.authorizeTenant(principal, item.tenantId, scope);
    const anyScope = `${scope}:any`;
    if (item.owner !== principal.principalId && !principal.scopes.includes(anyScope) && !principal.scopes.includes('files.admin')) {
      throw new FileAuthorizationError();
    }
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

function validateCreate(input: CreateFileInput): void {
  if (!input.tenantId.trim()) throw new FileValidationError('tenantId is required');
  if (!input.owner.trim()) throw new FileValidationError('owner is required');
  if (!input.name.trim()) throw new FileValidationError('name is required');
  if (!input.storageKey.trim()) throw new FileValidationError('storageKey is required');
  if (!Number.isInteger(input.size) || input.size < 0) throw new FileValidationError('size must be a non-negative integer');
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) throw new FileValidationError('metadata must be an object');
}

function validateUpdate(input: UpdateFileInput): void {
  if (!input.tenantId.trim()) throw new FileValidationError('tenantId is required');
  if (!input.id.trim()) throw new FileValidationError('id is required');
  const provided = ['name', 'contentType', 'size', 'checksum', 'storageKey', 'metadata'].some((key) => key in input);
  if (!provided) throw new FileValidationError('At least one file property must be updated');
  if (input.name !== undefined && !input.name.trim()) throw new FileValidationError('name must be a non-empty string');
  if (input.storageKey !== undefined && !input.storageKey.trim()) throw new FileValidationError('storageKey must be a non-empty string');
  if (input.size !== undefined && (!Number.isInteger(input.size) || input.size < 0)) throw new FileValidationError('size must be a non-negative integer');
  if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) throw new FileValidationError('metadata must be an object');
}
