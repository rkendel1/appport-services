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

### Option 1: Framework-neutral HTTP adapter

For applications using ordinary Node HTTP request/response semantics:

```ts
import { createApiKeyAuth } from '@appport/services';

const auth = createApiKeyAuth({ service });

// Optional authentication (returns null if missing/invalid)
const principal = await auth.authenticate(request);

// Required authentication (throws if missing/invalid)
const principal = await auth.require(request);
```

The adapter extracts the `Authorization: Bearer <api-key>` header and returns an `AuthenticatedPrincipal`:

```ts
interface AuthenticatedPrincipal {
  principalId: string;
  principalType: 'api_key';
  tenantId: string;
  scopes: readonly string[];
  credentialId: string;
}
```

### Option 2: Express middleware

For Express applications:

```ts
import { apiKeyAuth, requireApiKeyAuth } from '@appport/services';

const app = express();

// Optional authentication
app.use(apiKeyAuth(service));

app.get('/invoices', async (req, res) => {
  const principal = req.auth; // null if missing/invalid
  if (!principal) {
    return res.status(401).json({ error: 'Unauthenticated' });
  }
  // Handle request with principal
});

// Or, require authentication
app.use(requireApiKeyAuth(service));

app.get('/protected', async (req, res) => {
  const principal = req.auth; // guaranteed, or middleware rejects
  // Handle request with principal
});
```

The middleware attaches the principal to `req.auth` and provides request-scoped context via `req.authContext`.

### Tenant safety

If your application accepts tenant context independently, validate it against the principal:

```ts
import { assertTenant } from '@appport/services';

assertTenant(principal, tenantIdFromRequest); // throws if mismatch
```

### Low-level Bearer token extraction

For custom frameworks:

```ts
import { authenticateBearerToken } from '@appport/services';

const principal = await authenticateBearerToken(
  authorizationHeader,
  service,
);
```

## How does authorization happen?

Authentication returns a machine principal plus scopes. Authorization still belongs to AuthPort.

## How do I use webhooks?

Webhooks provide durable signed delivery to external HTTP endpoints.

### Setup

```ts
import { createFeltDbRuntime, FeltDbWebhookEndpointStore, FeltDbWebhookDeliveryStore, FeltDbWebhookAuditSink, WebhookService, EncryptedWebhookSecretStore } from '@appport/services';

const runtime = createFeltDbRuntime({ mode: 'local', namespace: 'webhooks', path: './.feltdb' });
const service = new WebhookService({
  endpointStore: new FeltDbWebhookEndpointStore(runtime.db),
  deliveryStore: new FeltDbWebhookDeliveryStore(runtime.db),
  auditSink: new FeltDbWebhookAuditSink(runtime.db),
  secretStore: new EncryptedWebhookSecretStore(),
});
```

### Register endpoint

```ts
const { endpoint, secret } = await service.createWebhookEndpoint({
  tenantId: 'tenant-123',
  url: 'https://customer.example.com/webhooks',
  events: ['invoice.created', 'invoice.paid'],
  createdBy: 'ops-user-1'
});

// Save secret securely; it is only returned once
```

### Emit event

```ts
await service.emitWebhookEvent({
  tenantId: 'tenant-123',
  type: 'invoice.created',
  payload: { id: 'inv-456', amount: 100 }
});

// Delivery records created automatically for matching endpoints
```

### Worker: deliver webhooks

```ts
const delivery = await service.getWebhookDelivery(tenantId, deliveryId);
const result = await service.deliverWebhook(tenantId, deliveryId);

if (result.success) {
  // Delivered
} else {
  // Failed or queued for retry
}
```

The delivery is signed with HMAC-SHA256. Each delivery includes:

```json
{
  "id": "delivery-uuid",
  "eventId": "event-uuid",
  "type": "invoice.created",
  "data": { "id": "inv-456", "amount": 100 },
  "timestamp": "2026-09-10T22:30:00Z"
}
```

Header: `X-AppPort-Signature: <hex-encoded-hmac-sha256>`

Consumer verification:

```ts
import crypto from 'node:crypto';

function verify(payload, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return expected === signature;
}
```

### Retry policy

- **2xx** → delivered
- **408 / 429 / 5xx / network failure** → retry with bounded exponential backoff
- **other 4xx** → failed (terminal)
- **Max attempts** → 5 (configurable)

Failed deliveries can be manually replayed:

```ts
await service.replayWebhookDelivery(tenantId, deliveryId, 'user-replay');
```

### Disable endpoint

```ts
await service.disableWebhookEndpoint({
  tenantId: 'tenant-123',
  id: endpoint.id,
  disabledBy: 'ops-user-1'
});

// No new deliveries created; existing pending deliveries blocked
```

Webhooks are **at-least-once delivery**. Consumers should treat `eventId` / `deliveryId` as idempotency identifiers.

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
- `/src/webhooks` — Webhook models, service, and secret handling
  - `models.ts` — Endpoint, delivery, event contracts
  - `service.ts` — Webhook lifecycle and delivery orchestration
  - `secrets.ts` — Secret generation, encryption, HMAC signing
- `/src/storage` — FeltDB-backed store and audit sink
  - `api-keys.ts` — API key storage
  - `webhooks.ts` — Webhook endpoint/delivery storage
- `/src/runtime` — HTTP/Express authentication adapters and Bearer-token extraction
  - `api-keys.ts` — Bearer token extraction
  - `http-adapter.ts` — Framework-neutral HTTP adapter
  - `express-middleware.ts` — Express middleware
- `/src/contract` — AuthPort-facing principal contract
- `/tests` — Node/TypeScript tests
  - `api-keys.test.ts` — Core service tests
  - `http-adapter.test.ts` — HTTP adapter tests (security, isolation, tenant safety)
  - `integration-app.test.ts` — Real HTTP application fixture
  - `express-integration.test.ts` — Express middleware integration tests
  - `webhooks.test.ts` — Webhook lifecycle and durability tests
  - `webhooks-delivery.test.ts` — HTTP delivery, signing, retry, and concurrency tests
- `/docs` — architecture notes
