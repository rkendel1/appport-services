import { ServiceAuthorityError, ServiceMigrationError } from './errors.js';
import type { SecretReference } from '../secrets/models.js';

const PREFIX = 'credential-ref:';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

/** A pointer into AuthBoundry credential custody. It is the only credential form services store. */
export type CredentialRef = `credential-ref:${string}`;

export function isCredentialRef(value: unknown): value is CredentialRef {
  return typeof value === 'string' && value.startsWith(PREFIX) && ID.test(value.slice(PREFIX.length));
}

export function formatCredentialRef(secretId: string): CredentialRef {
  const ref = `${PREFIX}${secretId}`;
  if (!isCredentialRef(ref)) throw new ServiceAuthorityError('INVALID_REQUEST', 'Invalid credential identifier');
  return ref as CredentialRef;
}

/** Validate a caller-supplied credential reference, refusing raw material with a migration error. */
export function requireCredentialRef(value: unknown, field = 'credentialRef'): CredentialRef {
  if (isCredentialRef(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    throw new ServiceMigrationError(`"${field}" must be a credential-ref:<id> into AuthBoundry custody; raw credentials are never stored in service configuration.`);
  }
  throw new ServiceAuthorityError('INVALID_REQUEST', `${field} is required and must be a credential-ref:<id>`);
}

export function credentialReference(ref: CredentialRef, tenantId: string, provider?: string): SecretReference {
  return { secretId: ref.slice(PREFIX.length), tenantId, ...(provider ? { provider } : {}) };
}

const RAW_CREDENTIAL_FIELDS = ['value', 'secret', 'password', 'token', 'apiKey', 'signingSecret', 'credential'] as const;

/** Reject inputs that try to put credential material into ordinary service configuration. */
export function rejectRawCredentialFields(input: unknown): void {
  if (!input || typeof input !== 'object') return;
  for (const field of RAW_CREDENTIAL_FIELDS) {
    if ((input as Record<string, unknown>)[field] !== undefined) {
      throw new ServiceMigrationError(`"${field}" looks like raw credential material. Register it with AuthBoundry and pass credentialRef instead.`);
    }
  }
}
