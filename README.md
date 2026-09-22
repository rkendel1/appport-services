# AppPort Services

AppPort Services provides durable operational application capabilities that sit beside AuthPort.

The service set includes API Keys, Jobs, Schedules, Secrets, Webhooks, Files, and Notifications.
Notifications are stored and delivered by AppPort Services; they are not an attention-management
layer. Attn may consume them to derive attention separately.

## Create and run an application

For a new application:

```sh
npx create-appport my-app
cd my-app
npm run dev
```

The generated source contains business handlers only. It does not create an HTTP server, configure persistence, implement CORS/SSE, run job workers, deliver webhooks, or install signal handlers.

For an existing application:

Install the package in your application:

```sh
npm install @appport/runtime
```

Initialize AppPort with every capability, or select only what the application uses:

```sh
npx @appport/runtime init
npx @appport/runtime init --use api,webhooks,jobs
```

With no flags, `init` asks which capabilities to enable and defaults each one to yes. The `--use` form is available for scripts and CI.

This creates two files that should be committed:

- `appport.toml` declares the AppPort capabilities your application uses.
- `feltdb.flow` is your application's authoritative FeltDB contract. AppPort's internal template remains inside the npm package; application developers do not edit or import AppPort storage internals.

Bootstrap AppPort from the contract:

```javascript
import { appport } from '@appport/runtime';

const app = await appport();

// Only capabilities declared in appport.toml are initialized.
await app.api.keys.createApiKey(/* ... */);
```

`appport()` reads `./appport.toml` by default and owns service construction, persistence, audit infrastructure, and lifecycle. Call `await app.close()` during graceful shutdown. Accessing an undeclared capability throws a `CapabilityNotDeclaredError` with the declaration needed to enable it.

`appport.toml` is the authoritative application contract. It is parsed, validated, normalized, and frozen once at startup. It declares application identity, deployment and state authority, tenancy, HTTP/CORS, API scopes, webhook delivery, job types, events, authorization, observability, lifecycle, and development defaults. The sibling `feltdb.flow` is deployed into FeltDB as the authoritative state contract.

Legacy files containing only `use api`, `use webhooks`, and `use jobs` remain supported. Expand one to the canonical contract with a recoverable backup using:

```sh
npx @appport/runtime config migrate
```

Application code supplies behavior:

```javascript
import { appport } from '@appport/runtime';

const application = await appport({
  routes: {
    'POST /invoices': async ({ body, tenantId }) => createInvoice(body, tenantId),
  },
  jobs: {
    'invoice.process': async (job) => processInvoice(job.payload),
  },
});

await application.publish('invoice.created', { id: 'inv-123' });
```

The public `application.state` and `application.events` APIs provide provider-neutral state and subscriptions. Application code never reaches through a capability to access its private database.

The runtime owns the stable management contract:

```text
/_appport/health
/_appport/overview
/_appport/events
/_appport/api/keys
/_appport/webhooks
/_appport/jobs
```

Health is public. Other endpoints follow the contract's authorization and tenant rules. Events uses SSE for `GET` and publishes domain events with `POST`; API keys, webhooks, and jobs support runtime-owned create/list operations.

`@appport/services` supplies the CLI and capability implementation, but application source imports only `@appport/runtime`. Existing applications may continue using `createServices()` from `@appport/services` as a compatibility API.

Run your application with its usual command, such as `npm run dev`. Operational CLI commands are available through the installed binary:

```sh
npx @appport/runtime api-key list --tenant acme
npx @appport/runtime webhook list --tenant acme
npx @appport/runtime job list --tenant acme
```

AppPort manages its FeltDB runtime dependency; consumers do not import `@feltdb/core` or AppPort's internal stores.

The repository defines four AppPort capabilities: **tenant-scoped API keys**, **durable webhooks**, **durable job execution**, and provider-neutral **Secrets** metadata/lifecycle and scoped-resolution contracts. Legacy runtime state uses **`@feltdb/core@0.11.6`**. Secret material remains with an authorized provider and is never durable AppPort state.

```text
            Application
                 │
     ┌───────────┴───────────┐
     │                       │
  AuthPort             AppPort Services
     │                       │
identity/authz        API Keys, Webhooks, Jobs, Secrets
     │                       │
     └───────────┬───────────┘
                 │
              FeltDB
```

## Consumer API

Existing authenticated Express applications can mount the supported management runtime against their existing service instance:

```javascript
import { createManagementRouter, createServices } from '@appport/services';

const services = createServices({ path: '.appport' });
app.use(createManagementRouter({
  services,
  authenticate: (request) => hostAuthentication(request),
  authorize: (capability, context) => hostAuthorization(capability, context),
}));
```

The host owns authentication and authorization; AppPort Services owns service behavior and durable state. API-key management requires `apikeys.read`, `apikeys.create`, and `apikeys.revoke`, always uses the authenticated tenant, and returns a plaintext credential only in the creation response. See [Composable management runtime](docs/management.md) for the full contract and standalone/embedded behavior.

Outbound credentials use a server-only scoped protocol. AppPort defines the reference, context, lifecycle, audit, errors, and callback contract; AuthBoundry authorizes and AppBoundry resolves provider-held material. AppPort ships no resolver, secret store, provider adapter, or policy engine, and exposes no browser-facing credential-value route.

```javascript
await secrets.withSecret({
  reference: { secretId, tenantId: 'acme', provider: 'pipedrive' },
  context: { tenantId: 'acme', principalId: 'integration:pipedrive', purpose: 'person.lookup', authorizationRef },
}, async ({ value }) => callProvider(value));
```

See [the outbound credential guide](docs/credentials.md) for ownership, authorization handoff, lifecycle, and failure semantics.

The contract determines which runtime APIs are available:

```javascript
import { appport } from '@appport/runtime';

const app = await appport();

// Machine identity & tenant scoping
await app.api.keys.createApiKey({
  tenantId: 'acme-corp',
  name: 'server-key',
  scopes: ['invoices.write'],
  createdBy: 'operator',
});

// Durable outbound notifications
await app.webhooks.createWebhookEndpoint({
  tenantId: 'acme-corp',
  url: 'https://acme.example.com/webhooks',
  events: ['invoice.created'],
  createdBy: 'operator',
});

// Durable deferred execution
await app.jobs.enqueue({
  tenantId: 'acme-corp',
  type: 'invoice.process',
  payload: { invoiceId: 'inv-123' },
  maxAttempts: 3,
});
```

The consumer does not need to know that FeltDB exists underneath. Only declared capabilities are constructed, and they share one durable runtime.

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

AppPort Services uses Flow (the `@feltdb/core` contract language) as the authoritative durable schema. The package's internal `appport.flow` is the template from which `appport init` generates the application's authoritative `feltdb.flow`:

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

**Secrets vertical:**
- `Secrets` — Tenant-scoped logical secret identity and lifecycle metadata
- `SecretVersions` — Provider references and explicit rotation versions
- `SecretAuditEvents` — Creation, resolution, rotation, revocation, retirement, and failure audit records

Secrets operations distinguish `describeSecret` (metadata only) from `resolveSecret` (authorized provider resolution). Secret values, plaintext, decrypted material, and provider credentials are not fields in `appport.flow` or audit events.

All collections are tenant-scoped via `tenant_id` field with `tenant_idx` for efficient queries.

### Dependency direction

```
feltdb.flow (generated authoritative application contract)
       ↓
TypeScript implementation
       ↓
FeltDB (@feltdb/core@0.11.6)
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
    "@feltdb/core": "0.11.6"
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

## How do I send notifications?

Notifications are durable application events routed through one or more delivery channels.
Applications decide what happened. AppPort Services decides how a durable notification is delivered.

```
Application       = meaning
AppPort Services  = delivery infrastructure
FeltDB            = durable state and evidence
Attn              = attention and judgment
```

```ts
const { notification, deliveries } = await app.notifications.notify({
  tenantId: 'tenant-a',
  recipient: 'user-1',
  type: 'monitor.triggered',
  title: 'Status changed',
  source: { type: 'monitor', id: 'monitor-7', eventId: 'observation-123' },
  channels: ['browser', 'in-app'],
}, principal);

await app.notifications.markRead('tenant-a', notification.id, recipientPrincipal);
await app.notifications.acknowledge('tenant-a', notification.id, recipientPrincipal);
```

- Each channel has its own durable delivery record (`pending`, `delivered`, `failed`, `retrying`).
- Repeating the same source event returns the same notification.
- Retries run on the existing job infrastructure.
- `expiresAt` stops obsolete deliveries but keeps the record as evidence.
- Credentials (passwords, cookies, authorization headers, tokens, API keys, private keys) are rejected.
- Closing a browser does not destroy notifications. The browser is one delivery channel, and a new
  session catches up from `GET /notifications?unread=true`.

Email, mobile push, SMS, and webhook channels are adapters registered with `registerChannel()`.
See [docs/notifications.md](docs/notifications.md) for the resource model, lifecycle, HTTP API,
authorization, and the sensitive-data boundary.

## Where does durable state live?

AppPort Services stores all state directly in FeltDB collections through `@feltdb/core@0.11.6`.

```text
feltdb.flow (generated Flow contract)
      │
      ▼
AppPort Services
      │
      ├─→ FeltDbApiKeyStore (ApiKeys, ApiKeyPrefixes, ApiKeyAuditEvents)
      ├─→ FeltDbWebhookEndpointStore (WebhookEndpoints, WebhookAuditEvents)
      ├─→ FeltDbWebhookDeliveryStore (WebhookDeliveries)
      ├─→ FeltDbJobStore (Jobs, JobSchedules, JobAuditEvents)
      └─→ Secrets protocol (Secrets, SecretVersions, SecretAuditEvents)
      │
      ▼
 @feltdb/core@0.11.6
      │
      ▼
 real FeltDB
```

## What happens to the secret?

For AppPort Secrets, the boundary is:

```text
application .flow → capability contract → AuthBoundry authorization → secret provider
```

Applications declare the `secrets` capability, but never put secret values in `.flow`. AppPort publishes identity, lifecycle, tenant, audit, and provider-reference metadata only; AppBoundry supplies provider execution after AuthBoundry authorization.

AppPort is declarative: it defines what the Secrets capability means. AppBoundry decides how it runs, and AuthBoundry decides who may use it. The Secrets contract contains no provider, storage, caching, injection, or authorization implementation.

- generated with cryptographic randomness
- returned exactly once at creation time
- hashed with scrypt before persistence
- never stored in the durable API-key record
- excluded from audit records

## Repository layout

- `appport.flow` — Internal package template used to generate consumer `feltdb.flow` contracts
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
