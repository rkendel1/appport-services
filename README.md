# AppPort Services

AppPort Services provides operational application capabilities that sit beside AuthPort.

Today that means **tenant-scoped API keys** for machine-to-machine access.

AuthPort remains responsible for identity, authentication, and authorization policy. AppPort Services authenticates API-key credentials into a machine principal that AuthPort can authorize.

```text
                Application
                     │
         ┌───────────┴───────────┐
         │                       │
      AuthPort             AppPort Services
         │                       │
   identity/authz             API Keys
         │                       │
         └───────────┬───────────┘
                     │
                   FeltDB
```

## What is in this repository?

- `src/appport_services/api_keys/` — API-key contract and semantic service
- `src/appport_services/contract/` — AuthPort-facing principal contract
- `src/appport_services/storage/` — storage and audit boundaries
- `src/appport_services/runtime/` — CLI and Bearer-token runtime adapter
- `tests/` — focused unit tests for API-key semantics
- `docs/` — architecture and API-key documentation

## Why is API Keys separate from AuthPort?

AuthPort answers:

> Who is this principal, and what are they authorized to do?

AppPort Services answers:

> What operational capabilities does this application expose?

API keys authenticate a machine principal. They do **not** replace authorization and they do **not** introduce a second identity or policy system.

## How do I enable API keys?

Use the library surface with an injected durable store and audit sink:

```python
from appport_services.api_keys.service import ApiKeyService

service = ApiKeyService(store=real_feltdb_store, audit_sink=real_audit_sink)
```

Optional application-level contract:

```python
from appport_services.runtime.config import ApiKeysConfig

config = ApiKeysConfig(enabled=True, scopes=("invoices.read", "invoices.write"))
```

## How do I create one?

Library:

```python
created = service.create_api_key(
    tenant_id="tenant-123",
    name="production",
    scopes=("invoices.read",),
    expires_at=None,
    created_by="ops-user-1",
)
print(created.secret)  # display once and store safely
```

CLI (when an application injects a configured service):

```text
appport api-key create --tenant tenant-123 --name production --scope invoices.read --created-by ops-user-1
```

Creation warns that the secret is displayed exactly once.

## How does an application authenticate?

Use the runtime adapter:

```python
from appport_services.runtime.api_keys import authenticate_bearer_token

principal = authenticate_bearer_token(
    "Bearer " + created.secret,
    service,
)
```

That returns an `AuthenticatedPrincipal` with:

- `principal_id`
- `principal_type="api_key"`
- `tenant_id`
- `scopes`
- `credential_id`

## How does authorization happen?

Authentication produces a machine principal. Authorization remains a separate AuthPort decision:

```text
API key
   ↓
machine principal
   ↓
AuthPort authorization
   ↓
resource/action decision
```

No local policy engine is implemented in this repository.

## Where does durable state live?

Durable state belongs behind `ApiKeyStore`, with FeltDB intended as the first/reference durable adapter:

```text
AppPort Services
      │
      ▼
 ApiKeyStore
      │
      ▼
 FeltDB adapter
      │
      ▼
 real FeltDB
```

This repository intentionally does **not** provide a shadow JSON store, local database, or in-memory production fallback.

## What happens to the secret?

- raw API-key secrets are generated with cryptographic randomness
- the raw secret is returned **once**, at creation time
- only a salted hash is persisted
- `get` and `list` never return the raw secret
- audit metadata excludes the raw secret

See `/docs/architecture.md` and `/docs/api-keys.md` for more detail.