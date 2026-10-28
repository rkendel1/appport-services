import { SecretNotFoundError, SecretResolutionDeniedError, SecretRevokedError, SecretTenantMismatchError } from '../../src/secrets/errors.js';
import type { ResolvedSecret, ScopedResolveSecretInput, SecretReference } from '../../src/secrets/index.js';
import type { SecretAccessContext, SecretCustody, SecretCustodyStatus, SecretCustodyWriteResult } from '../../src/secrets/protocol.js';

interface Entry { value: string; version: number; updatedAt: string; revoked: boolean }

/** A custody call as recorded for assertions: never the value. */
export interface CustodyCall {
  readonly op: 'store' | 'status' | 'remove' | 'withSecret';
  readonly reference: SecretReference;
  readonly context: SecretAccessContext;
}

/**
 * Test-only in-memory host custody (a `SecretCustody`). Material lives in this
 * object's Map, never in FeltDB. Not part of the package.
 *
 * - `hostManaged` refs report `writable: false` with an environment-variable
 *   location, the way an env-var-only host custody would.
 * - `failStore` makes `store` throw (to prove failures do not leak the value).
 */
export class MemoryCustody implements SecretCustody<string> {
  readonly calls: CustodyCall[] = [];
  readonly hostManaged = new Set<string>();
  failStore?: (value: string) => Error;
  private readonly entries = new Map<string, Entry>();
  private clock = Date.parse('2026-10-01T00:00:00Z');

  constructor(readonly location = 'test memory custody') {}

  private key(reference: SecretReference): string {
    return `${reference.tenantId}\u0000${reference.secretId}`;
  }

  private check(context: SecretAccessContext, reference: SecretReference): void {
    if (context.tenantId !== reference.tenantId) throw new SecretTenantMismatchError(reference.secretId);
  }

  async store(input: { reference: SecretReference; value: string; context: SecretAccessContext }): Promise<SecretCustodyWriteResult> {
    this.calls.push({ op: 'store', reference: input.reference, context: input.context });
    // A host custody accepts a write only under an AuthBoundry decision.
    if (!input.context.authorizationRef) throw new SecretResolutionDeniedError(input.reference.secretId);
    this.check(input.context, input.reference);
    if (this.failStore) throw this.failStore(input.value);
    const key = this.key(input.reference);
    const previous = this.entries.get(key);
    const storedAt = new Date(this.clock += 1000).toISOString();
    const entry = { value: input.value, version: (previous?.version ?? 0) + 1, updatedAt: storedAt, revoked: false };
    this.entries.set(key, entry);
    return { version: entry.version, storedAt };
  }

  async status(input: { reference: SecretReference; context: SecretAccessContext }): Promise<SecretCustodyStatus> {
    this.calls.push({ op: 'status', reference: input.reference, context: input.context });
    this.check(input.context, input.reference);
    if (this.hostManaged.has(input.reference.secretId)) {
      return { state: 'missing', location: `environment variable FELTKIT_CREDENTIAL_${input.reference.secretId.toUpperCase()}`, writable: false };
    }
    const entry = this.entries.get(this.key(input.reference));
    if (!entry) return { state: 'missing', location: this.location, writable: true };
    return { state: entry.revoked ? 'revoked' : 'set', version: entry.version, updatedAt: entry.updatedAt, location: this.location, writable: true };
  }

  async remove(input: { reference: SecretReference; context: SecretAccessContext }): Promise<void> {
    this.calls.push({ op: 'remove', reference: input.reference, context: input.context });
    const entry = this.entries.get(this.key(input.reference));
    if (entry) entry.revoked = true;
  }

  async withSecret<TResult>(input: ScopedResolveSecretInput, use: (secret: ResolvedSecret<string>) => TResult | Promise<TResult>): Promise<TResult> {
    this.calls.push({ op: 'withSecret', reference: input.reference, context: input.context });
    if (!input.context.authorizationRef) throw new SecretResolutionDeniedError(input.reference.secretId);
    this.check(input.context, input.reference);
    const entry = this.entries.get(this.key(input.reference));
    if (!entry) throw new SecretNotFoundError(input.reference.secretId);
    if (entry.revoked) throw new SecretRevokedError(input.reference.secretId);
    return use({ value: entry.value, secretId: input.reference.secretId, version: entry.version });
  }

  /** The stored material, for assertions that it reached custody. */
  peek(tenantId: string, secretId: string): string | undefined {
    return this.entries.get(`${tenantId}\u0000${secretId}`)?.value;
  }

  get size(): number {
    return this.entries.size;
  }
}
