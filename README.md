# AppPort Services

AppPort Services provides operational application capabilities that sit beside AuthPort.

Today the repository implements one complete vertical slice: **tenant-scoped API keys** backed by **`@feltdb/core@0.10.0`**.

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

## What is AppPort Services?

AppPort Services answers:

> What operational capabilities does this application expose?

AuthPort still answers identity, authentication, and authorization questions.

## Why is API Keys separate from AuthPort?

API keys authenticate machine principals. They do **not** replace AuthPort authorization.

```text
API key
   ↓
machine principal
   ↓
AuthPort authorization
   ↓
resource/action decision
```

## Installation

```bash
npm install
npm run build
```

Dependencies are pinned, including:

```json
{
  "dependencies": {
    "@feltdb/core": "0.10.0"
  }
}
```

## How do I enable API keys?

Create the service with FeltDB’s real deployment model:

```ts
import { createApiKeyService } from '@appport/services';

const service = createApiKeyService({
  mode: 'local',
  namespace: 'appport-services',
  path: './.feltdb/appport-services'
});
```

Remote FeltDB deployments can use the same exported deployment fields that `resolveFeltDBDeployment()` understands.

## How do I create one?

```ts
const created = await service.createApiKey({
  tenantId: 'tenant-123',
  name: 'production',
  scopes: ['invoices.read'],
  createdBy: 'ops-user-1'
});

console.log(created.secret); // only returned once
```

CLI:

```bash
appport api-key create --tenant tenant-123 --name production --scope invoices.read --created-by ops-user-1
```

## How does an application authenticate?

```ts
import { authenticateBearerToken } from '@appport/services';

const principal = await authenticateBearerToken(
  'Bearer ' + created.secret,
  service,
);
```

That returns:

```ts
interface AuthenticatedPrincipal {
  principalId: string;
  principalType: 'api_key';
  tenantId: string;
  scopes: readonly string[];
  credentialId: string;
}
```

## How does authorization happen?

Authentication returns a machine principal plus scopes. Authorization still belongs to AuthPort.

## Where does durable state live?

AppPort Services stores API-key state directly in FeltDB collections through `@feltdb/core@0.10.0`.

```text
AppPort Services
      │
      ▼
 ApiKey semantic contract
      │
      ▼
 FeltDbApiKeyStore
      │
      ▼
 @feltdb/core@0.10.0
      │
      ▼
 real FeltDB
```

## What happens to the secret?

- generated with cryptographic randomness
- returned exactly once at creation time
- hashed with scrypt before persistence
- never stored in the durable API-key record
- excluded from audit records

## Repository layout

- `/src/api-keys` — API-key models and semantic service
- `/src/storage` — FeltDB-backed store and audit sink
- `/src/runtime` — Bearer-token runtime adapter
- `/src/contract` — AuthPort-facing principal contract
- `/tests` — Node/TypeScript tests, including real restart durability tests
- `/docs` — architecture and API-key notes
