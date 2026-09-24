# AppPort Services

AppPort Services provides durable operational application capabilities that sit beside AuthPort.

The service set includes API Keys, Jobs, Secrets, Webhooks, and Notifications. Notifications are
stored and delivered by AppPort Services; they are not an attention-management layer. Attn may
consume them to derive attention separately.

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

`appport.toml` is the authoritative application contract. It is parsed, validated, normalized, and frozen once at startup. It declares application identity, deployment and state authority, tenancy, HTTP/CORS, API keys, webhook delivery, job types, events, authorization, observability, lifecycle, and development defaults. The sibling `feltdb.flow` is deployed into FeltDB as the authoritative state contract.

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

The repository defines four AppPort capabilities: **tenant-scoped API keys**, **durable webhooks**, **durable job execution**, and provider-neutral **Secrets** metadata/lifecycle and scoped-resolution contracts. Legacy runtime state uses **`@feltdb/core@0.11.2`**. Secret material remains with an authorized provider and is never durable AppPort state.

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

const services = createServices({ path: '.appport', application: 'invoices', authorizer: authBoundry, credentials: authBoundryCustody });
app.use(createManagementRouter({
  services,
  authority: services.gateway,
  authenticate: (request) => hostAuthentication(request), // identity only
}));
```

The host owns authentication, AuthBoundry owns authorization, and AppPort Services enforces AuthBoundry's decisions before any effect. **@appport/services executes effects. It does not decide who is allowed to cause them.** See [the authority model](docs/AUTHORITY.md), [webhook security](docs/WEBHOOK-SECURITY.md), and [job security](docs/JOB-SECURITY.md). API-key management requires `apikeys.read`, `apikeys.create`, and `apikeys.revoke`, always uses the authenticated tenant, and returns a plaintext credential only in the creation response. See [Composable management runtime](docs/management.md) for the full contract and standalone/embedded behavior.

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

const app = await appport({ authorizer: authBoundry, credentials: authBoundryCustody });

// Identity comes from authentication; AuthBoundry authorizes each capability.
const principal = await app.authenticate(request);

// Machine identity (an API key identifies a caller; it carries no scopes)
await app.invoke('apikeys.create', { name: 'server-key' }, { principal });

// Durable outbound notifications, bound to a signing credential in AuthBoundry custody
await app.invoke('webhooks.register', {
  url: 'https://acme.example.com/webhooks',
  events: ['invoice.created'],
  signingCredentialRef: 'credential-ref:whsec_acme',
}, { principal });

// Durable deferred execution; the job runs as this principal and is re-authorized on every run
await app.invoke('jobs.create', {
  type: 'invoice.process',
  payload: { invoiceId: 'inv-123' },
  maxAttempts: 3,
}, { principal });
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
FeltDB (@feltdb/core@0.11.2)
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
    "@feltdb/core": "0.11.2"
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
// `operator` is a verified principal (host authentication or an existing API key).
const created = await service.createApiKey({ name: 'production' }, operator);

console.log(created.secret); // only returned once
```

An API key identifies a caller and its application. It carries no scopes:
AuthBoundry decides what the caller may do. Passing `scopes` is rejected with
a migration error ([docs/AUTHORITY.md](docs/AUTHORITY.md#migration)).

CLI (the operator is identified through `APPPORT_AUTHORITY` or `APPPORT_API_KEY`):

```bash
APPPORT_AUTHORITY=./authority.mjs appport api-key create --tenant tenant-123 --name production
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
  applicationId: string;
  credentialId: string;
  verifiedBy: 'api_key';
}
```

Principals are branded: services accept only principals minted by an
authentication path, never object literals or actor strings.

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

Authentication returns an identity. Authorization belongs to AuthBoundry: every
service effect is authorized by the configured `ServiceAuthorizer` before it
runs, credentials are resolved only after that decision, and evidence is
written to FeltDB. See [docs/AUTHORITY.md](docs/AUTHORITY.md).

## How do I use webhooks?

Webhooks provide durable signed delivery to external HTTP endpoints.

### Setup

```ts
import { createServices } from '@appport/services';

const services = createServices({ path: './.appport', application: 'invoices', authorizer: authBoundry, credentials: authBoundryCustody });
const service = services.webhooks;
```

### Register endpoint

```ts
const endpoint = await service.createWebhookEndpoint({
  url: 'https://customer.example.com/webhooks',
  events: ['invoice.created', 'invoice.paid'],
  // The signing secret lives in AuthBoundry custody; the endpoint stores only the reference.
  signingCredentialRef: 'credential-ref:whsec_customer',
}, principal);

// Private, loopback, link-local, and metadata destinations are rejected; redirects are never followed.
// See docs/WEBHOOK-SECURITY.md.
```

### Emit event

```ts
await service.emitWebhookEvent({
  type: 'invoice.created',
  payload: { id: 'inv-456', amount: 100 }
}, principal);

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
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(payload).digest('hex'));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
```

### Retry policy

- **2xx** → delivered
- **408 / 429 / 5xx / network failure** → retry with bounded exponential backoff
- **3xx** → failed (terminal): redirects are never followed
- **other 4xx** → failed (terminal)
- **AuthBoundry denial** → failed; the provider is never called
- **AuthBoundry unavailable / timeout** → retried later; the provider is never called
- **Max attempts** → 5 (configurable)

Failed deliveries can be manually replayed:

```ts
await service.replayWebhookDelivery(tenantId, deliveryId, principal); // webhooks.replay
```

### Disable endpoint

```ts
await service.disableWebhookEndpoint({ id: endpoint.id }, principal); // webhooks.remove

// No new deliveries created; existing pending deliveries blocked
```

Webhooks are **at-least-once delivery**. Consumers should treat `eventId` / `deliveryId` as idempotency identifiers.

## How do I use durable jobs?

Jobs provide reliable background task execution with retry support, concurrency control via leases, and automatic recovery from worker failure.

### Setup

```ts
import { createServices } from '@appport/services';

const services = createServices({ path: './.appport', application: 'invoices', authorizer: authBoundry });
const service = services.jobs;
```

### Register handler

```ts
service.register('invoice.process', async (job, execution) => {
  const { invoiceId } = job.payload as { invoiceId: string };
  // The job runs as its durable principal; every effect is authorized again.
  await services.invoke('notifications.send', { recipient: 'finance', type: 'invoice.processed', title: invoiceId }, { principal: execution.principal });
});
```

### Enqueue job

```ts
const job = await service.enqueue({
  type: 'invoice.process',
  payload: { invoiceId: 'inv-456' },
  maxAttempts: 3,
  delegationId: 'del_quote_agent', // optional AuthBoundry delegation, checked on every run
}, principal);
```

A job without a durable principal is never executed, and a revoked delegation
stops the next run. See [docs/JOB-SECURITY.md](docs/JOB-SECURITY.md).

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
  type: 'invoice.reconcile',
  payload: { batchSize: 100 },
  interval: '1h',
}, principal);
```

### Retry policy

- **Success** → job marked completed
- **Failure** → retry with exponential backoff (2^attemptCount)
- **Max attempts exceeded** → job marked failed
- **Worker lease expired** → job eligible for recovery by another worker
- **Manual retry** → reset failed job to pending state

Jobs are **durable and idempotent**. Job state survives process restarts; workers claim jobs via version-based optimistic locking.

## Where does durable state live?

AppPort Services stores all state directly in FeltDB collections through `@feltdb/core@0.11.2`.

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
 @feltdb/core@0.11.2
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
- `/src/authority` — Policy Enforcement Point: capability manifest, verified principals, execution contexts, AuthBoundry protocol, destination policy, effect evidence
- `/src/webhooks` — Webhook models, service, and signing helpers
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
