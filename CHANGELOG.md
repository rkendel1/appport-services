# Changelog

All notable changes to `@appport/services`. Releases before 0.6.0 are described in the git history.

## 0.10.0 — unreleased

Moves to `@feltdb/core` 0.16.1 (was 0.15.0). No AppPort API changed.

The services recognize FeltDB's errors by class (`ConditionalConflictError`), so they must run on
the same `@feltdb/core` copy as the host that opens the FeltDB instance and passes it to
`createServices({ db })`. Hosts that need FeltDB 0.16.1 (Managed FeltDB clients that stay correct
across contract promotions: `REVISION_NOT_ACTIVE`) could not use the services without loading a
second FeltDB copy, whose errors these checks never match. FeltKit worked around it with an npm
`overrides` entry; a library depending on the services cannot.

### Changed

- **`@feltdb/core` 0.16.1.** Includes FeltDB 0.16: state requests run only under an application
  environment's active contract, and a running remote client recovers from a promotion
  (`REVISION_NOT_ACTIVE`, nothing applied) instead of failing until restarted; bounded queries
  without `orderBy` and `collection.find()` behave the same against `feltdb-server` as embedded.

### Released with it

| Package | Was | Now | Dependency |
| --- | --- | --- | --- |
| `@appport/services` | 0.9.1 | 0.10.0 | `@feltdb/core` 0.15.0 → 0.16.1 |
| `@appport/runtime` | 0.8.1 | 0.9.0 | `@appport/services` `^0.9.1` → `^0.10.0` |
| `create-appport` | 0.1.17 | 0.1.18 | `@appport/runtime` `^0.8.1` → `^0.9.0` |

## 0.9.1

0.9.0's fragment declared every collection but no indexes, so on Managed FeltDB every
service's tenant-scoped read was refused (`INDEX_UNAVAILABLE`: an application-scoped
authority answers a query filtered on `tenantId` only through a schema-declared equality
index). Found running FeltKit's starter, with every service enabled, on Managed FeltDB.
Additive: a host republishes its contract with the new indexes.

### Fixed

- **`servicesContract(...)` carries an index per collection**: `<collection>_by_tenant` on
  `["tenantId"]`, in the same order as the collections. New exports `SERVICE_INDEXES` and
  `ServicesContractIndex`. A test encodes FeltDB's rule: every tenant-scoped collection has an
  equality index on its scope field, on declared fields only.

## 0.9.0 — 2026-10-29

The services declare what they store, so a host can run them on Managed FeltDB. An
application-scoped FeltDB authority stores only what its promoted contract declares, and the
services' collections and fields were internal: hosts could not declare them (FeltKit refused
to deploy an application with services to Managed FeltDB). Additive: nothing about how records
are stored changed.

### Added

- **`servicesContract(names | 'all')`**, `SERVICE_COLLECTIONS`, `SERVICE_REQUIREMENTS`,
  `SERVICE_NAMES`, `SERVICES_CONTRACT_VERSION` and the types `ServiceName`,
  `ServicesContractCollection`, `ServicesContractField`, `ServicesContractFragment`
  (`src/contract/services-contract.ts`, [docs/contract.md](docs/contract.md)): FeltDB
  application-contract entries for every collection the services store, each declared once,
  composed deterministically (name order, each collection once, dependencies included:
  `schedules` brings `jobs`; every service brings `service_effect_evidence`).
- `ApiKeyPrefixRecord` (the `api_key_prefixes` record) is exported.

### Tests

- `tests/services-contract.test.ts` drives every write path of each service on a fresh FeltDB
  instance and checks every committed record against the declarations (collection, field,
  and a value FeltDB accepts for the declared type), that every declared collection is
  written, and that each declaration is exactly the TypeScript type of the record its store
  writes (`tests/support/stored-records.ts`, read with the TypeScript compiler).

### Released with it

| Package | Was | Now | Dependency |
| --- | --- | --- | --- |
| `@appport/services` | 0.8.0 | 0.9.0 | |
| `@appport/runtime` | 0.7.0 | 0.8.0 | `@appport/services` ^0.9.0 |
| `create-appport` | 0.1.15 | 0.1.16 | `@appport/runtime` ^0.8.0 |

## 0.8.0 — published

The credential custody **write path**. A user had pasted a real API key into a "credential reference" field because no screen accepted a key. Services now owns how a key is collected (authorized, audited, versioned, never echoed or persisted), while the host keeps owning where the material lives. Everything is additive: a host that passes a `ScopedSecretsResolver` behaves exactly as in 0.7.0.

### Added

- **`SecretCustody`** (`src/secrets/protocol.ts`, exported): a `ScopedSecretsResolver` with `store({ reference, value, context }) → { version, storedAt }`, `status({ reference, context }) → { state: 'set' | 'missing' | 'revoked', version?, updatedAt?, location?, writable }` and optional `remove`. **`isSecretCustody(x)`** (has `withSecret`, `store`, `status`). Types `SecretAccessContext` (= `SecretResolutionContext`), `SecretCustodyWriteResult`, `SecretCustodyStatus`. `createServices({ credentials })` (and `appport()`, `startManagementHost()`) accept either.
- **`credential.store`** (consequential, resource `credential`): `{ ref, value, provider?, kind?, name?, environment? }` → `{ ref, version, storedAt, binding? }`. Validates first (a `credential-ref:` value, an empty value, a value over 64 KiB, a raw key in `ref` are refused without repeating them); authorizes through the gateway; authorizes the optional `name` binding (`credential.attach` / `credential.rotate`) before the value is stored; asks custody for `status` and refuses `writable: false`; calls `store` once with `authorizationRef` = the decision id; writes value-free `Secrets` / `SecretVersions` / `SecretAuditEvents` metadata (`FeltDbSecretMetadataStore`, in `src/storage/secrets.ts`); evidence records `credentialRef` and the new `credentialVersion` only.
- **`credential.status`** (observation, resource `credential`): `{ ref }` or `{ refs }` → `[{ ref, state, version?, updatedAt?, location?, writable }]`, one authorization per reference.
- Both are in `SERVICE_CAPABILITY_MANIFEST`, `invoke()`, the discovery catalog (`credentials` operations `store`, `status`; dependency `SecretCustody`), `docs/capabilities.json`, and the Secrets surface's capabilities. The `services-manifest-1` conformance corpus was re-blessed (digest changed).
- **Routes:** `POST /v1/configuration/credentials` (201) and `GET /v1/configuration/credentials/status?ref=…`, on `createConfigurationRouter` and therefore `createManagementRouter`.
- **Secrets page:** bindings now show their reference and value status (Set with version and location, Missing, Revoked, Unknown) and a masked **Set value** form (`type="password"`, `autocomplete="new-password"`) that posts to `credential.store`; the value is cleared after every submit and never rendered back. A row's **Set value** prefills its reference and name.
- **`ServiceFailureCode` `CUSTODY_READ_ONLY`** (HTTP 409) with an actionable message: no custody, a resolver-only custody, or a reference the custody reports as not writable (for example "This environment's credential comes from the host (environment variable FELTKIT_CREDENTIAL_X) and cannot be changed here; set it there.").
- **`health()` with a `SecretCustody`** asks `status` for every counted binding: `services.configuration.bindings` (name, environment, state; never a value or reference), `counts.missingMaterial`, `attention.missingCredentialMaterial`, reason `missing_material`. Without a `SecretCustody` the health shape is unchanged.

### Security

- Errors leaving `credential.store` are redacted defensively: a message, stack or detail that contains the value is replaced (the code is kept), and a host custody's own error text is never passed through on the write path.
- `createManagementRouter` and `configurationErrorHandler` no longer echo a JSON parse error message: Node's parser quotes the body, which could be a credential.
- `tests/credential-custody.test.ts` proves the value is in no FeltDB operation, row, audit log or state file, no evidence, no audit or version row, no error, no configuration export, no `health()` result, no log output, no AuthBoundry request, and no management page or JSON response.

### Released with it

| Package | Was | Now | Dependency |
| --- | --- | --- | --- |
| `@appport/services` | 0.7.0 | 0.8.0 | |
| `@appport/runtime` | 0.6.0 | 0.7.0 | `@appport/services` `^0.7.0` → `^0.8.0` |
| `create-appport` | 0.1.14 | 0.1.15 | `@appport/runtime` `^0.6.0` → `^0.7.0` |

## 0.7.0 — unreleased (prepared, not published)

Moves to `@feltdb/core` 0.15.0 (was 0.13.0). No AppPort API changed.

### Changed

- **A local state directory is now exclusive by default.** FeltDB 0.15 makes `createServices({ mode: 'local', path })` take `owner.lock` in the directory; a second *process* opening it is refused with `LocalStateLockedError` (`STATE_LOCKED`). Handles in one process share the lock. A host that runs an API server and a worker over one directory must pass `access: 'shared'` (it is part of `CreateServicesOptions` through `FeltDBOptions`; commits stay atomic and serialized). `examples/invoice-app` does this for both processes. A lock left by a dead process on this host is recovered automatically.
- Includes FeltDB 0.14–0.15 fixes: a committed transaction now notifies live subscribers on the local file and memory runtimes, and `collection.refresh({ strict })`.

### Available, not yet used by AppPort Services

- `db.storeContent` / `db.acquireContent` (SHA-256 content-addressed bytes, local file and server runtimes). `FileService` stays metadata-only (`storageKey`); content storage is a candidate for a later release.
- Durable agent executions (`findAgentExecution`, `cancelAgentExecution`) and paged `listTasks` / `listHandoffs` in agent state: not relevant to these services.

### Released with it

| Package | Was | Now | Dependency |
| --- | --- | --- | --- |
| `@appport/services` | 0.6.0 | 0.7.0 | `@feltdb/core` 0.13.0 → 0.15.0 |
| `@appport/runtime` | 0.5.0 | 0.6.0 | `@appport/services` `^0.6.0` → `^0.7.0` |
| `create-appport` | 0.1.13 | 0.1.14 | `@appport/runtime` `^0.5.0` → `^0.6.0` |

## 0.6.0

Consumer APIs requested by FeltKit. Everything is additive; no existing API changed behaviour. `@appport/runtime` and `create-appport` are released with it.

### Added

- **`services.db`, `services.usesInstance(db)`, `services.ownsDb`.** A public, read-only way to see which FeltDB instance `createServices()` runs on, including a host-supplied local, memory, or remote instance (`createServices({ db })`). `usesInstance` compares identity. The test-only `_getDb` is kept and deprecated.
- **`services.evidence.findByRunId(runId, { limit?, tenantId? })`.** Bounded lookup (default 100, max 1000; `truncated` flag) of the effect evidence recorded under a run id, served by a hash index on `runId` (`run_idx`, added to `appport.flow`'s `ServiceEffectEvidence`). Returns typed records with `state: 'started' | 'completed' | 'failed'` and an aggregate state (`'none'` when nothing was recorded). Types: `EffectEvidenceReader`, `EffectEvidenceLookup`, `EffectEvidenceRecord`, `EffectEvidenceState`, `EffectEvidenceLookupOptions`.
- **`services.health({ tenantId?, countLimit? })`.** Per-service `ok | degraded | unconfigured | disabled` with reasons and counts (failed/retrying/pending webhook deliveries, disabled endpoints, failed jobs, failed notifications and deliveries, missing required secrets, legacy raw secret values, intelligence selections missing a credential), plus a flat `attention` summary. Every count is a bounded, paged query (default limit 1000, max 10000; capped counts are listed). Type: `AppPortServicesHealth` and per-service types. New option `createServices({ configurationDeclarations })` feeds the missing-required check.
- **`webhooks.deliveries.read` capability** (observation, resource `webhook_delivery`, attributes `endpointId`, `status`). `WebhookService.readWebhookDeliveries(query, principal)` (bounded: default 50, max 200; filter by endpoint and status) and `readWebhookDelivery({ id }, principal)`; `invoke('webhooks.deliveries.read', ...)`; management routes `GET /_appport/webhooks/deliveries` and `GET /_appport/webhooks/deliveries/:id`. `webhooks.read` is unchanged and still covers endpoints only. The `services-manifest-1` conformance corpus was re-blessed for the new manifest entry (digest changed).
- **`services.configuration.export({ principal, environment? })` / `import(document, { principal, dryRun?, overwrite?, environment? })`.** A versioned JSON document (`format: 'appport.configuration-export'`, `formatVersion: 1`) of variables, credential binding names and references, active webhook endpoints (signing credential reference only) and enabled schedules. Import returns a plan/report of create/update/unchanged/conflict/missing/skip items and the credential bindings the target must attach; it never creates credential bindings and refuses any secret value. Every read and write goes through its existing capability.
- **`createManagementRouter({ basePath })`.** Prefixes every request and navigation link the packaged pages make (a path or an http(s) origin). Default `''` keeps the previous behaviour.
- **`VERSION`** exported from the main entry, read from the package's own `package.json` so it cannot drift, and **`@appport/services/package.json`** in the `exports` map.

### Released with it

| Package | Was | Now | Dependency |
| --- | --- | --- | --- |
| `@appport/services` | 0.5.0 | 0.6.0 | |
| `@appport/runtime` | 0.4.9 | 0.5.0 | `@appport/services` `^0.4.9` → `^0.6.0` |
| `create-appport` | 0.1.12 | 0.1.13 | `@appport/runtime` `^0.4.9` → `^0.5.0` |

### Fixed

- **`npx create-appport` installed services 0.4.x.** The published `@appport/runtime` 0.4.9 declared `@appport/services@^0.4.9`, which on 0.x accepts no 0.5.x, so 0.5.0 never reached a scaffolded project. The runtime and the scaffolder now move with every services release: `npm run release:bump -- <patch|minor|major>` bumps all three and their ranges (runtime by the same increment as services, create-appport by a patch), and `npm run check:versions`, run first by `npm test` and by `scripts/publish-packages.sh`, refuses a range that does not accept the version in this repository. The scaffolder writes the runtime range from its own `package.json` instead of a hard-coded copy.
