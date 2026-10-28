# Changelog

All notable changes to `@appport/services`. Releases before 0.6.0 are described in the git history.

## 0.6.0 — unreleased (prepared, not published)

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
