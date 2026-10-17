# API Keys

An API key **identifies** a caller and its application. What the caller may do
is decided by AuthBoundry for every operation (see [AUTHORITY.md](./AUTHORITY.md)).
A key can additionally carry **restrictions**, which narrow what that key can be
used for but never grant anything. The legacy `scopes` field is still rejected
with a migration error, and so is `api.keys.scopes` in `appport.toml`.

```
effective permission = AuthBoundry allows  AND  key restrictions permit  AND  key is live
```

## Installation and initialization

```bash
npm install @appport/services
```

```ts
import { createServices } from '@appport/services';

const services = createServices({
  mode: 'local',                  // or a managed FeltDB deployment (server: {...})
  namespace: 'billing',
  path: './.feltdb/billing',
  application: 'billing',
  authorizer,                     // your AuthBoundry client (ServiceAuthorizer); without it key management fails closed
  apiKeyVerifierKey: process.env.APPPORT_API_KEY_VERIFIER_KEY, // optional, >= 32 bytes, see "Verifiers"
});

const keys = services.apiKeys;    // ApiKeyService
```

`appport({ ..., apiKeyVerifierKey })` accepts the same option. All state lives in
the application's FeltDB deployment: `api_keys`, `api_key_prefixes`, and
`api_key_audit_events`. There is no other store.

## Operations

| Method | Capability (AuthBoundry) | Notes |
| --- | --- | --- |
| `createApiKey({ name, restrictions?, expiresAt? }, caller)` | `apikeys.create` | Returns the secret once. |
| `listApiKeys(tenantId, options?)` / `getApiKey(tenantId, id)` | `apikeys.read` via `invoke` or the management routes | Tenant-keyed reads; never return secrets or verifiers. |
| `updateApiKey({ id, name?, restrictions?, expiresAt? }, caller)` | `apikeys.update` | `null` clears restrictions or expiry. The secret does not change. |
| `rotateApiKey({ id, overlapSeconds? }, caller)` | `apikeys.rotate` | Returns the new secret once. |
| `revokeApiKey({ id }, caller)` | `apikeys.revoke` | Idempotent. |
| `revokeAllApiKeys({ createdBy? }, caller)` | `apikeys.revoke` on the collection, attribute `createdBy` (`*` for all) | One authorization for the bulk operation. |
| `listApiKeyAuditEvents({ credentialId?, limit?, after? }, caller)` | `apikeys.audit` | Lifecycle and usage events, no secrets. |
| `authenticateApiKey(secret)` | none (it is authentication) | Returns a verified principal or `null`. |
| `services.authorize(...)` / `services.invoke(...)` | the capability requested | The only authorization path: the gateway applies key liveness and restrictions, then asks AuthBoundry. |

`caller` is always a verified principal (from `authenticateApiKey`,
`services.identify`, or a management `authenticate` adapter). The tenant comes
from the caller; a different `tenantId` in the input is denied, not replaced.
Mutations authorize **before** looking the key up, so an unauthorized caller
learns nothing about whether a key exists. A key of another tenant or
application reads as not found (`null`).

Through `invoke`: `apikeys.read` takes `{ id }` or list options
`{ status, createdBy, limit, after }`; `apikeys.revoke` takes `{ id }` or
`{ all: true, createdBy? }`.

### Listing and pagination

Without options, `listApiKeys(tenantId)` returns every record of the tenant
exactly as before. With options it returns only this application's keys,
filtered by `status` (`active`, `expired`, `revoked`, `all`) and `createdBy`,
sorted by creation time, `limit` 1–500, continuing `after` the last id of the
previous page. Pagination is evaluated over the tenant's records in memory; it
bounds the response, not the read.

## Creating a key and handling the secret

```ts
const created = await services.apiKeys.createApiKey({
  name: 'reporting-worker',
  restrictions: {
    capabilities: ['files.read', 'jobs.create'],
    resources: [{ type: 'file', attributes: { owner: 'reporting' } }, { type: 'job' }],
  },
  expiresAt: new Date(Date.now() + 90 * 24 * 3600 * 1000),
}, operator);

// created.secret is shown here and nowhere else. Store it in the caller's secret manager.
```

Secrets look like `app_live_<6 hex prefix>_<43 base64url chars>` (256 bits from
`crypto.randomBytes`). Only the prefix and a verifier are persisted. `get`,
`list`, audit reads, errors, and the management routes never return the secret
or its verifier; `create` and `rotate` are the only responses that contain one.

## Restrictions

Restrictions are a ceiling on one key:

- `capabilities` — manifest capability names (`files.read`, `jobs.create`, ...).
  Anything not listed is denied. An empty list denies everything. Unknown names,
  wildcards, and runtime-internal capabilities are rejected when the key is
  created or updated, so a typo cannot silently read as "narrower".
- `resources` (optional) — rules of `{ type?, id?, attributes? }`. A request must
  match at least one rule: every field a rule sets must equal the requested
  resource (the `type`, the `id`, and the resource attributes the service sends
  AuthBoundry, such as `owner`, `recipient`, `jobType`). A rule with an `id` never
  matches a collection request such as a list, which has no id.
- No `restrictions` at all means no ceiling: AuthBoundry alone decides. This is
  the behaviour of every key created before 0.4.12.

Enforcement happens in `ServiceGateway`, before AuthBoundry is asked: a request
outside the ceiling is `DENIED` with reason `credential_restricted`, recorded as
denied effect evidence, and AuthBoundry is not consulted. A request inside the
ceiling is still sent to AuthBoundry, which can deny it. Restrictions are not a
second policy engine and cannot make AuthBoundry's answer more permissive.

**A key cannot exceed its creator key.** When the caller is itself an API key,
any key it creates, updates (restrictions or expiry), or rotates must be within
the caller's own restrictions and must not outlive it. Rotation is included
because it hands the caller a working secret for the target key.
(`DENIED`, reason `exceeds_credential_restrictions` or `exceeds_credential_lifetime`.)

Rate limits and usage quotas are **not** implemented per key. AppPort Services
has no authoritative, cross-process counter to enforce them with; the management
router's process-local rate limiter is not a per-key quota. Enforce quotas in
AuthBoundry or at the edge.

## Live validation and revocation

The principal returned by `authenticateApiKey` is identity only (no permissions
on the object). Internally it is bound to a check that, on **every** gateway
authorization, re-reads the key from FeltDB and refuses it if it was revoked
(`credential_revoked`), expired (`credential_expired`), deleted or moved
(`credential_unknown`), or narrowed so the request no longer fits
(`credential_restricted`). Revoking or narrowing a key in any process therefore
applies to principals other processes authenticated earlier, with no cache to
wait out. If the read fails, the operation fails closed with
`AUTHORITY_UNAVAILABLE`.

`authenticateApiKey` itself commits `lastUsedAt` with a version check against
the record it verified. A revoke, rotation, or update that lands between the read
and that write makes the write fail; the next attempt sees the change. If the
store cannot be read, authentication returns `null`.

An `api_key` principal that was not produced by `authenticateApiKey` is refused
(`credential_unbound`).

Process-local state is limited to lookup hints: a prefix→id map (bounded to
10,000 entries) and, in the embedded `local` mode only, copies of keys created
by this process, used only while FeltDB has not yet returned a just-committed
record and dropped as soon as it does. The stored record always wins.

## Rotation

`rotateApiKey({ id, overlapSeconds })` issues a replacement with the same name,
restrictions, and expiry, and in the **same atomic FeltDB transaction**, fenced on
the old key's version:

- `overlapSeconds: 0` (default): revokes the old key.
- `overlapSeconds: n` (up to 604,800 = 7 days): shortens the old key's expiry to
  `now + n`, never later than its existing expiry. Both secrets work until then.

The old key records `rotatedTo`, the new one `rotatedFrom`. A key is rotated at
most once: concurrent rotations of the same key (in one process or many) produce
exactly one replacement; the others fail with `INVALID_REQUEST`. A revoked,
expired, or already-rotated key cannot be rotated. Rotation never extends a
key's lifetime; extend it with `updateApiKey` (subject to `apikeys.update`).

## Revocation

`revokeApiKey` is immediate and permanent. `revokeAllApiKeys` asks AuthBoundry
once for `apikeys.revoke` on `appport://<app>/tenants/<tenant>/api_key/*` with
attribute `createdBy` (the filter, or `*`), then revokes each matching active key
with its own version check and returns the revoked ids. It is not one
transaction: a key created while it runs may survive and is not reported.

## Verifiers

Each key stores `scrypt$<salt>$<digest>` (salted scrypt, constant-time compare).
With `apiKeyVerifierKey` configured (at least 32 bytes, from your secret manager,
never from FeltDB), new keys store `hmac-scrypt$...`: scrypt over
HMAC-SHA256(verifierKey, secret), so a copy of the database alone cannot verify
anything. Consequences:

- keys created with a verifier key only authenticate on services configured with
  the same key; elsewhere they fail closed (audit result `verifier_unavailable`);
- keys created earlier keep working on keyed and unkeyed services;
- the key is held in a private class field: it is not part of the service's
  options, enumerable properties, `util.inspect` output, or logs;
- changing the verifier key is not supported in place; rotate keys onto a service
  configured with the new key.

The CLI does not read a verifier key; keys created with one cannot be used as
`APPPORT_API_KEY` for the CLI.

## Audit

Events are written to `api_key_audit_events`:

| Type | When | Extra fields |
| --- | --- | --- |
| `api_key.created` | create, and the replacement in a rotation | `relatedCredentialId` (rotation) |
| `api_key.updated` | update | `changes`: names of changed fields |
| `api_key.rotated` | rotation, on the replaced key | `relatedCredentialId` |
| `api_key.revoked` | revoke, revoke-all, rotation without overlap | |
| `api_key.authenticated` | every authentication attempt against a known prefix | `result`: `success`, `invalid_secret`, `revoked`, `expired`, `application_mismatch`, `verifier_unavailable` |

Events hold ids, the acting principal id, timestamps, and results. They never
contain secrets, presented credential values, verifiers, or Authorization
headers. Denied operations also appear in the gateway's effect evidence
(`service_effect_evidence`) with their failure code.

`listApiKeyAuditEvents` returns only events about this application's keys in the
caller's tenant, sorted by time, `limit` 1–500 (default 100), continuing `after`
an event id. A custom `AuditSink` without `list` cannot be read
(`INVALID_REQUEST`).

## Management routes and UI

`createManagementRouter` (and `appport-services serve`) mount:

| Route | Capability |
| --- | --- |
| `GET /_appport/api/keys` | `apikeys.read` (unrevoked keys) |
| `POST /_appport/api/keys` | `apikeys.create`; body `{ name, restrictions?, expiresAt? }` |
| `PATCH /_appport/api/keys/:id` | `apikeys.update`; body `{ name?, restrictions?, expiresAt? }` (`null` clears) |
| `POST /_appport/api/keys/:id/rotate` | `apikeys.rotate`; body `{ overlapSeconds? }` |
| `DELETE /_appport/api/keys/:id` | `apikeys.revoke` |
| `POST /_appport/api/keys/revoke-all` | `apikeys.revoke`; body `{ createdBy? }` |
| `GET /_appport/api/keys/:id/audit` | `apikeys.audit`; `?limit=&after=` |

The packaged **API Keys** page (`/api-keys`) creates keys with an optional
permission ceiling, resource rules, and expiry; edits name, ceiling, and expiry
in a dialog; rotates with a chosen overlap and shows the new secret once;
shows a key's audit trail; and revokes one key or all keys with typed
confirmation. The page is shown to callers AuthBoundry allows `apikeys.read`,
`apikeys.create`, and `apikeys.revoke`; edit, rotate, and audit are each still
authorized individually, and a refusal is shown in place.

## Errors

All failures are `ServiceAuthorityError` with a `code` and HTTP `status`:

| Code | Status | Typical cause |
| --- | --- | --- |
| `INVALID_REQUEST` | 400 | bad restrictions or dates, nothing to update, rotating a revoked/expired/rotated key, legacy `scopes` |
| `UNAUTHENTICATED` | 401 | no verified principal |
| `DENIED` | 403 | AuthBoundry denial, cross-tenant request, key revoked/expired/restricted, exceeding the caller key's ceiling |
| `AUTHORITY_UNAVAILABLE` | 503 | no authorizer configured, AuthBoundry failed, or the key store could not be read |
| `AUTHORIZATION_TIMEOUT` | 504 | AuthBoundry did not answer in time |

Messages never include secret material. `details.reason` carries the
machine-readable cause (`credential_revoked`, `credential_restricted`, ...).

## Operational security

- Treat `create` and `rotate` responses as secrets: do not log them.
- Prefer restricted, expiring keys; rotate with a short overlap.
- Give `apikeys.update`, `apikeys.rotate`, and `apikeys.revoke` (with
  `createdBy=*`) only to administrators in AuthBoundry.
- Keep the verifier key out of FeltDB and out of the application's config files.
- Revocation is effective on the next gateway authorization or authentication;
  effects already authorized (a context lives at most 60 seconds) complete.
- Work a key enqueued before it was revoked (jobs, schedules, webhook deliveries)
  runs as its attested durable principal under AuthBoundry policy; key
  restrictions and revocation do not follow it. Revoke the delegation or cancel
  the work in AuthBoundry/AppPort as well.

## Compatibility and migration

0.4.12 is additive:

- Existing keys (no `restrictions`) behave as before: no ceiling, AuthBoundry decides.
- New manifest capabilities `apikeys.update`, `apikeys.rotate`, `apikeys.audit`
  change `serviceCapabilityManifestDigest()`. AuthBoundry policies pinned to the
  old digest must be re-pinned; grant the new capabilities to whoever needs them.
- `ApiKeyView` gains `status` and optional `restrictions`, `revokedBy`,
  `updatedAt`, `updatedBy`, `rotatedFrom`, `rotatedTo`, `rotatedAt`.
- Every gateway authorization by an API-key principal now reads that key's record
  once. A principal object kept after its key is revoked stops working.
- Custom `ApiKeyStore` implementations must add `replace` and `rotate` (used only
  by update and rotation); `revoke` gains an optional `revokedBy` argument.
  Custom `AuditSink`s may add `list` to support audit reads.
- `revokeApiKey` no longer revokes a key bound to a *different* application in a
  shared namespace (it reads as not found); legacy keys bound to no application
  can still be revoked.
- `ManagementServices.apiKeys` still only requires create/list/revoke; the new
  routes mount when the service provides the corresponding methods.
