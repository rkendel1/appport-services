# Architecture

AppPort Services owns API-key semantics. It does not own identity, authorization policy, or database semantics.

```text
Application
   ↓
AppPort Services API
   ↓
ApiKey semantic contract
   ↓
ApiKeyStore
   ↓
real durable substrate
```

## Product boundary

- **AuthPort**: identity, authentication, authorization
- **AppPort Services**: operational application capabilities
- **FeltDB**: optional/default durable state substrate

## API Keys vertical slice

The API-key capability is split into four boundaries:

1. **contract** — machine-principal shape shared with AuthPort-facing authorization
2. **semantic service** — creation, lookup, authentication, revocation, and audit emission
3. **storage boundary** — `ApiKeyStore` and `AuditSink`
4. **runtime surface** — CLI and HTTP Bearer-token adapter

## Deliberate non-goals

This repository does **not** implement:

- a generic services platform
- a workflow engine
- webhooks
- jobs
- a duplicate authorization engine
- a custom durable database
- a JSON/file-based shadow store
- an in-memory production persistence fallback

## FeltDB integration status

This bootstrap defines the integration boundary only. A concrete FeltDB adapter is intentionally left as the next step because no repository-local FeltDB integration surface exists yet.

Until that adapter exists:

- unit tests verify the semantic contract with test doubles
- restart durability tests are marked blocked instead of being faked with non-durable storage
