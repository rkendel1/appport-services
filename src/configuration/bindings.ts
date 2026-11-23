import type { StateFirstDB } from '@feltdb/core';

import { isCredentialRef, type CredentialRef } from '../authority/credentials.js';
import { boundedFind } from '../storage/bounded.js';
import { CONFIGURATION_ENVIRONMENTS, type ConfigurationEnvironment } from './models.js';
import { configurationCollectionNames } from './storage.js';

/** One credential binding: its name and the reference it points at. Never material. */
export interface CredentialBindingReference {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environment: ConfigurationEnvironment;
  readonly name: string;
  readonly credentialRef: CredentialRef;
  readonly required: boolean;
  readonly updatedAt: string;
}

export interface CredentialBindingsOptions {
  /** One tenant only. Without it, every tenant of this application in the namespace. */
  readonly tenantId?: string;
  readonly environment?: ConfigurationEnvironment;
  /** Most bindings returned: 1–1000, default 500. */
  readonly limit?: number;
}

export interface CredentialBindingsResult {
  /** Sorted by tenant, environment, then name. */
  readonly bindings: readonly CredentialBindingReference[];
  /** True when more bindings matched than `limit`. */
  readonly truncated: boolean;
}

export const DEFAULT_CREDENTIAL_BINDINGS_LIMIT = 500;
export const MAX_CREDENTIAL_BINDINGS_LIMIT = 1000;

/**
 * The trusted host read of credential bindings (`services.credentialBindings`):
 * names and references, for a host that checks them against its own custody.
 * Like `health()` it is an in-process host API, not a capability: it is not
 * authorized per caller, writes no evidence, and returns references only (a
 * binding whose stored row holds a pre-reference raw value is skipped, never
 * returned). One bounded query.
 */
export async function readCredentialBindings(db: StateFirstDB, application: string, options: CredentialBindingsOptions = {}): Promise<CredentialBindingsResult> {
  const limit = options.limit ?? DEFAULT_CREDENTIAL_BINDINGS_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CREDENTIAL_BINDINGS_LIMIT) throw new RangeError(`limit must be an integer from 1 to ${MAX_CREDENTIAL_BINDINGS_LIMIT}`);
  if (options.tenantId !== undefined && (typeof options.tenantId !== 'string' || !options.tenantId)) throw new TypeError('tenantId must be a non-empty string');
  if (options.environment !== undefined && !CONFIGURATION_ENVIRONMENTS.includes(options.environment)) throw new TypeError('environment is invalid');
  const where = {
    applicationId: application,
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
  };
  const rows = await boundedFind<Record<string, unknown>>(db, configurationCollectionNames.secrets, where, limit + 1);
  const bindings = rows.slice(0, limit)
    .filter((row) => isCredentialRef(row.credentialRef))
    .map((row): CredentialBindingReference => ({
      tenantId: String(row.tenantId),
      applicationId: String(row.applicationId),
      environment: row.environment as ConfigurationEnvironment,
      name: String(row.name),
      credentialRef: row.credentialRef as CredentialRef,
      required: row.required === true,
      updatedAt: String(row.updatedAt ?? row.createdAt ?? ''),
    }))
    .sort((a, b) => a.tenantId.localeCompare(b.tenantId) || a.environment.localeCompare(b.environment) || a.name.localeCompare(b.name));
  return { bindings, truncated: rows.length > limit };
}
