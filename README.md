# AppPort Services

AppPort Services provides operational application capabilities that sit beside AuthPort.

The repository implements three complete vertical slices: **tenant-scoped API keys**, **durable webhooks**, and **durable job execution** backed by **`@feltdb/core@0.10.0`**.

```text
            Application
                 │
     ┌───────────┴───────────┐
     │                       │
  AuthPort             AppPort Services
     │                       │
identity/authz        API Keys, Webhooks, Jobs
     │                       │
     └───────────┬───────────┘
                 │
              FeltDB
```

## What is AppPort Services?

AppPort Services answers:

> What operational capabilities does this application expose?

AuthPort still answers identity, authentication, and authorization questions.

## See It In Action

A complete example application is available under `examples/services-demo/`. It demonstrates:

- API key authentication with tenant-scoped principals
- Durable invoice creation with automatic webhook and job intent
- Webhook delivery with retry and replay
- Background job processing with lease-based concurrency control
- Tenant isolation and durability across process restart

See [`examples/services-demo/README.md`](./examples/services-demo/README.md) for a five-minute quickstart.

## Architecture

AppPort Services uses Flow (the `@feltdb/core` contract language) as the authoritative durable schema. `appport.flow` describes all collections:

**API Keys vertical:**
- `ApiKeys` — API key credentials (secret stored as scrypt hash only)
- `ApiKeyPrefixes` — Prefix lookup for efficient secret validation
- `ApiKeyAuditEvents` — Access audit trail

**Webhooks vertical:**
- `WebhookEndpoints` — Registered webhook receivers
- `WebhookDeliveries` — Outbound delivery records with retry state
- `WebhookAuditEvents` — Webhook lifecycle audit trail

**Jobs vertical:**
- `Jobs` — Individual jobs with execution status and lease tracking
- `JobSchedules` — Recurring job definitions
- `JobAuditEvents` — Job execution audit trail

All collections are tenant-scoped via `tenant_id` field with `tenant_idx` for efficient queries.

### Dependency direction

```
appport.flow (authoritative contract)
       ↓
TypeScript implementation
       ↓
FeltDB (@feltdb/core@0.10.0)
```

The Flow contract is parsed and validated at test time. The TypeScript stores (FeltDbApiKeyStore, FeltDbWebhookEndpointStore, etc.) implement the contract semantics directly against FeltDB collections.

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

## How do I use durable jobs?

Jobs provide reliable background task execution with retry support, concurrency control via leases, and automatic recovery from worker failure.

### Setup

```ts
import { createFeltDbRuntime, FeltDbJobStore, FeltDbJobScheduleStore, FeltDbJobAuditSink, JobService } from '@appport/services';

const runtime = createFeltDbRuntime({ mode: 'local', namespace: 'jobs', path: './.feltdb' });
const service = new JobService({
  jobStore: new FeltDbJobStore(runtime.db),
  scheduleStore: new FeltDbJobScheduleStore(runtime.db),
  auditSink: new FeltDbJobAuditSink(runtime.db),
});
```

### Register handler

```ts
service.register('invoice.process', async (job) => {
  const { invoiceId } = job.payload as { invoiceId: string };
  // Process the invoice
});
```

### Enqueue job

```ts
const job = await service.enqueue({
  tenantId: 'tenant-123',
  type: 'invoice.process',
  payload: { invoiceId: 'inv-456' },
  maxAttempts: 3
});
```

### Execute job (worker)

```ts
const result = await service.executeJob(tenantId, jobId, 'worker-1');
if (result) {
  // Job completed successfully
}
```

### Schedule recurring job

```ts
const schedule = await service.scheduleRecurring({
  tenantId: 'tenant-123',
  type: 'invoice.reconcile',
  payload: { batchSize: 100 },
  interval: '1h',
  createdBy: 'ops-user-1'
});
```

### Retry policy

- **Success** → job marked completed
- **Failure** → retry with exponential backoff (2^attemptCount)
- **Max attempts exceeded** → job marked failed
- **Worker lease expired** → job eligible for recovery by another worker
- **Manual retry** → reset failed job to pending state

Jobs are **durable and idempotent**. Job state survives process restarts; workers claim jobs via version-based optimistic locking.

## Where does durable state live?

AppPort Services stores all state directly in FeltDB collections through `@feltdb/core@0.10.0`.

```text
appport.flow (Flow contract)
      │
      ▼
AppPort Services
      │
      ├─→ FeltDbApiKeyStore (ApiKeys, ApiKeyPrefixes, ApiKeyAuditEvents)
      ├─→ FeltDbWebhookEndpointStore (WebhookEndpoints, WebhookAuditEvents)
      ├─→ FeltDbWebhookDeliveryStore (WebhookDeliveries)
      └─→ FeltDbJobStore (Jobs, JobSchedules, JobAuditEvents)
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

- `appport.flow` — Authoritative Flow DSL contract describing all collections
- `/src/api-keys` — API-key models and semantic service
- `/src/webhooks` — Webhook models, service, and secret handling
  - `models.ts` — Endpoint, delivery, event contracts
  - `service.ts` — Webhook lifecycle and delivery orchestration
  - `secrets.ts` — Secret generation, encryption, HMAC signing
- `/src/jobs` — Job models, service, and execution
  - `models.ts` — Job and schedule contracts
  - `service.ts` — Job lifecycle, retry, and scheduling
  - `store.ts` — FeltDB-backed storage with optimistic locking
  - `worker.ts` — Concurrent job execution with polling
- `/src/storage` — FeltDB-backed store and audit sink
  - `api-keys.ts` — API key storage
  - `webhooks.ts` — Webhook endpoint/delivery storage
- `/src/runtime` — HTTP/Express authentication adapters and Bearer-token extraction
  - `api-keys.ts` — Bearer token extraction
  - `http-adapter.ts` — Framework-neutral HTTP adapter
  - `express-middleware.ts` — Express middleware
- `/src/contract` — AuthPort-facing principal contract
- `/tests` — Node/TypeScript tests
  - `contract.test.ts` — Flow DSL validation and collection verification
  - `api-keys.test.ts` — Core service tests
  - `http-adapter.test.ts` — HTTP adapter tests (security, isolation, tenant safety)
  - `integration-app.test.ts` — Real HTTP application fixture
  - `express-integration.test.ts` — Express middleware integration tests
  - `webhooks.test.ts` — Webhook lifecycle and durability tests
  - `webhooks-delivery.test.ts` — HTTP delivery, signing, retry, and concurrency tests
  - `jobs.test.ts` — Job lifecycle, scheduling, and durability tests
  - `jobs-execution.test.ts` — Concurrent execution, leasing, and recovery tests
- `/docs` — architecture notes
