import type { CreateFeltDbRuntimeOptions } from './storage/api-keys.js';
import { createFeltDbRuntime, FeltDbApiKeyStore, FeltDbAuditSink } from './storage/api-keys.js';
import { ApiKeyService } from './api-keys/service.js';

export { ApiKeyService } from './api-keys/service.js';
export type {
  ApiKey,
  ApiKeyAuditEvent,
  ApiKeyView,
  CreateApiKeyInput,
  CreatedApiKey,
  RevokeApiKeyInput,
} from './api-keys/models.js';
export type { AuthenticatedPrincipal } from './contract/principals.js';
export type { ApiKeysConfig } from './runtime/config.js';
export { authenticateBearerToken } from './runtime/api-keys.js';
export {
  createFeltDbRuntime,
  FeltDbApiKeyStore,
  FeltDbAuditSink,
  auditCollectionName,
} from './storage/api-keys.js';
export type { AuditSink, ApiKeyStore, FeltDbServiceRuntime } from './storage/api-keys.js';

export function createApiKeyService(options: CreateFeltDbRuntimeOptions = {}): ApiKeyService {
  const runtime = createFeltDbRuntime(options);
  return new ApiKeyService({
    store: new FeltDbApiKeyStore(runtime.db),
    auditSink: new FeltDbAuditSink(runtime.db),
    runtime,
  });
}
