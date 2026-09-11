# Invoice Application - AppPort Services Dogfood

A minimal invoice application demonstrating real AppPort Services usage:
- **API Keys**: Machine-to-machine authentication
- **Webhooks**: Durable outbound notifications
- **Jobs**: Durable background processing
- **Atomic Composition**: Invoice creation, webhook delivery intent, and job enqueue in one FeltDB transaction

## Quick Start (5 minutes)

### 1. Install Dependencies
```bash
cd examples/invoice-app
npm install
```

### 2. Build
```bash
npm run build
```

### 3. Start the Application
```bash
npm start
```

Application runs on `http://localhost:3000`.

### 4. Create an API Key (in another terminal)

```bash
curl -X POST http://localhost:3000/customers \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Corp","email":"admin@acme.com"}'
```

Wait—you need an API key first. Let me show you the proper flow.

### Proper Setup Flow

#### 1. Initialize with appport.toml

The application declares its AppPort capabilities:
```toml
use api
use webhooks
use jobs

[webhooks]
events = ["invoice.created"]

[jobs]
max_attempts = 3
```

#### 2. Create API Key

```bash
node scripts/create-key.js --tenant acme-corp --name prod-key
# Returns: sk_live_xxxxx (save this)
```

#### 3. Create Customer

```bash
TENANT=acme-corp
API_KEY=sk_live_xxxxx

curl -X POST http://localhost:3000/customers \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Widget Inc","email":"billing@widget.com"}'
```

Response:
```json
{
  "id": "uuid",
  "name": "Widget Inc",
  "email": "billing@widget.com"
}
```

#### 4. Create Invoice (Atomic Composition)

```bash
curl -X POST http://localhost:3000/invoices \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "customer_id": "uuid-from-step-3",
    "items": [
      {"description": "Widgets", "quantity": 10, "unit_price": 50.00},
      {"description": "Shipping", "quantity": 1, "unit_price": 10.00}
    ]
  }'
```

This triggers ONE atomic FeltDB transaction:
1. **Create invoice** (application state)
2. **Queue webhook delivery** for `invoice.created` event
3. **Enqueue job** for invoice processing

All three persist together or all roll back.

#### 5. List Invoices

```bash
curl http://localhost:3000/invoices \
  -H "Authorization: Bearer $API_KEY"
```

#### 6. Process Invoices with Worker

In another terminal:
```bash
npm run worker
```

The worker will:
- Claim pending `invoice.process` jobs
- Process each invoice
- Mark completed
- Demonstrate retry on failure

#### 7. Webhook Delivery (Optional)

Setup a webhook endpoint to receive `invoice.created` events:

```bash
node scripts/setup-webhook.js \
  --tenant acme-corp \
  --url http://localhost:4000/webhook-receiver
```

Start a local webhook receiver:
```bash
npm run webhook-receiver
# Listens on http://localhost:4000
```

When you create an invoice, the webhook will:
- Generate delivery record
- Attempt delivery
- Retry with exponential backoff on failure
- Mark delivered on 2xx

#### 8. Restart Durability

Stop the application (Ctrl+C).

Verify data persisted:
```bash
ls -la .feltdb/invoice-app/
```

Restart:
```bash
npm start
```

Invoices, pending webhooks, and pending jobs are intact.
- Worker can resume processing
- Webhooks retry from where they left off
- No duplicate infrastructure needed

## Architecture

```
Invoice Application
    │
    ├── Domain State (Customers, Invoices, InvoiceItems)
    │   └── Stored in FeltDB collections
    │
    └── AppPort Services
        ├── API Keys
        │   └── Tenant-scoped authentication
        ├── Webhooks
        │   └── Durable invoice.created notifications
        └── Jobs
            └── Durable invoice processing
```

All services share one FeltDB runtime (no separate databases).

## Application State

**Customers**
```json
{
  "id": "uuid",
  "tenant_id": "acme-corp",
  "name": "Widget Inc",
  "email": "billing@widget.com",
  "created_at": "2026-09-11T...",
  "created_by": "api_key_user"
}
```

**Invoices**
```json
{
  "id": "uuid",
  "tenant_id": "acme-corp",
  "customer_id": "uuid",
  "total_amount": 510.00,
  "status": "pending|processing|completed|failed",
  "items": [...],
  "created_at": "2026-09-11T...",
  "created_by": "api_key_user"
}
```

## Atomic Composition Proof

The critical flow in `POST /invoices`:

```typescript
await services.transaction(async (tx) => {
  // 1. Create invoice (application state)
  await tx.collection<Invoice>('invoices').insert(invoice, invoiceId);
  
  // 2. Queue webhook delivery for invoice.created
  tx.queueWebhookDeliveries([endpointId], {
    tenantId, type: 'invoice.created', payload: {...}
  });
  
  // 3. Enqueue job for processing
  tx.queueJob({
    tenantId, type: 'invoice.process', payload: {...}
  });
});
// All three operations commit atomically or all roll back
```

If the application crashes between steps 1 and 3, NONE of them persist.
If step 2 fails after the transaction starts, the entire transaction rolls back—no partial invoices.

## Consumer Boundary (No FeltDB Leakage)

The application imports:
```typescript
import { createServices, apiKeyAuth } from '@appport/services';
```

It does NOT import:
- `@feltdb/core`
- `FeltDbApiKeyStore`, `FeltDbWebhookEndpointStore`, etc.
- `createFeltDbRuntime`
- Internal AppPort implementations

The application consumes AppPort through the public API:
- `createServices(options)`
- `services.apiKeys.createApiKey()`
- `services.webhooks.createWebhookEndpoint()`
- `services.jobs.enqueue()`
- `services.transaction(callback)`

## DSL Configuration

The application declares capabilities in `appport.toml`:

```toml
# Capability declarations
use api
use webhooks
use jobs

# Optional configuration
[webhooks]
events = ["invoice.created"]

[jobs]
max_attempts = 3
```

No boolean toggles, no configuration magic. Just semantic declarations.

## Running Tests

```bash
# Unit and integration tests
npm test

# Restart/durability test
npm run test:restart

# Atomic rollback test
npm run test:atomic

# Packed npm package test
npm run test:package
```

## Dogfooding Results

Does AppPort Services make this application simpler?

### ✓ Yes:
1. **Unified Runtime**: One FeltDB, all services share it. No setup complexity.
2. **Atomic Composition**: Genuine all-or-nothing across invoice + webhook + job.
3. **Authentication Built-in**: API key auth is a middleware, tenant isolation automatic.
4. **Durable Webhooks**: Retry, timeout handling, signed delivery included.
5. **Durable Jobs**: Retry, backoff, lease-based concurrency built in.
6. **DSL Configuration**: Simple `use` declarations, no generic framework overhead.
7. **Restart Durability**: FeltDB persistence handles recovery automatically.

### ⚠ Potential Issues:

1. **Application State**: Must use internal `_getDb` accessor for reads. A real consumer would want a public read API or delegation to application logic.

## Next Steps

1. Add customer endpoints (read, update, delete)
2. Add invoice item queries
3. Add webhook replay endpoint
4. Add job retry/manual requeue endpoints
5. Add metrics/observability

## Questions?

- See `appport.toml` for capability declarations
- See `src/app.ts` for the atomic invoice flow
- See `src/worker.ts` for job processing
- See root repository README for AppPort architecture
