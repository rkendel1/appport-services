# Architecture

AppPort Services is a Node/TypeScript package that consumes FeltDB’s real deployment and persistence model through `@feltdb/core@0.10.0`.

```text
Application
   ↓
AppPort Services
   ↓
ApiKeyService
   ↓
FeltDbApiKeyStore
   ↓
@feltdb/core@0.10.0
   ↓
FeltDB
```

## Product boundaries

- **AuthPort** — identity, authentication, authorization policy
- **AppPort Services** — operational application capabilities
- **FeltDB** — durable state semantics, transactions, auditable persistence

## API-key boundaries

- `ApiKey` / `ApiKeyView` — credential state and safe read model
- `ApiKeyService` — create, list, get, revoke, authenticate
- `ApiKeyStore` — semantic persistence boundary, implemented by `FeltDbApiKeyStore`
- `AuditSink` — semantic audit boundary, implemented by `FeltDbAuditSink`
- `AuthenticatedPrincipal` — machine-principal contract for AuthPort authorization

## FeltDB integration

The repository uses the real 0.10.0 package surface:

- `resolveFeltDBDeployment(...)`
- `createFeltDB(...)`
- `db.collection(...)`
- `collection.get/find/updateIfVersion(...)`
- `db.transaction(...)`

API-key records live in FeltDB collections:

- `api_keys`
- `api_key_prefixes`
- `api_key_audit_events`

Creation persists the key record and prefix locator atomically. Revocation and last-used updates use FeltDB version-checked updates instead of app-local locking.

## Deliberate non-goals

This repository still does **not** implement:

- webhooks
- jobs
- a generic capability framework
- a policy engine
- a custom database
- JSON persistence
- SQLite persistence
- an in-memory production fallback
