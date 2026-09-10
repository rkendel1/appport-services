# AppPort Services Demo

A minimal example application demonstrating the complete AppPort Services developer experience: machine authentication, durable webhooks, and deferred job execution.

## Five-Minute Quickstart

```bash
# Install dependencies
npm install

# Create an API key for the demo tenant
npm run demo:create-key

# Create an invoice (triggers webhook delivery and job processing)
npm run demo:create-invoice

# In another terminal, start the worker
npm run demo:worker

# List invoices and their processing status
npm run demo:list-invoices
```

## What This Example Proves

### 1. API Key → Authenticated Tenant

```typescript
// API key establishes tenant identity without manual plumbing
const principal = await authenticate(apiKeySecret);
assert.equal(principal.tenantId, 'tenant-123');
```

**Application never:**
- Parses API keys
- Hashes API keys
- Manages revocation
- Handles expiration

**AppPort Services provides:**
- Secure secret storage
- Tenant binding
- Revocation capability
- Expiration tracking

### 2. Durable Invoice + Webhook + Job Intent

```typescript
// Single operation establishes application state AND downstream intents
await invoiceService.createInvoice(principal, customer, amount);

// This atomically creates:
// ✓ Invoice (application state)
// ✓ Webhook delivery intent (invoice.created event)
// ✓ Job intent (background invoice.process)
```

**Single transaction prevents:**
- Invoice created, webhook lost
- Invoice created, job lost
- Partial failures with silent recovery

### 3. Webhook Durability and Retry

```
invoice.created event
    ↓
WebhookDelivery record (pending)
    ↓
Worker attempts HTTP delivery
    ↓
If 5xx / timeout / network failure
    → Retry with exponential backoff
    → Status: retrying
    ↓
If success
    → Status: delivered
    ↓
If 4xx (terminal)
    → Status: failed
    → Inspectable for manual replay
```

### 4. Job Durability and Lease-Based Execution

```
enqueue job
    ↓
Job state in FeltDB (durable)
    ↓
Worker claims job with lease
    ↓
If worker dies
    → Lease expires
    → Another worker claims the job
    → Job executes exactly once more
    ↓
No duplicate execution
No lost jobs
```

### 5. Tenant Isolation (Enforced)

```typescript
// Tenant A cannot access Tenant B's data
const invoiceA = await invoiceService.createInvoice(principalA, 'A Corp', 100);
const fromB = await invoiceService.getInvoice(principalB, invoiceA.id);
assert.equal(fromB, null); // Tenant B is blocked
```

Every collection query includes `tenant_id` filter:
- API keys
- Webhooks
- Jobs
- Audit events
- Invoices (application example)

### 6. Restart Durability (No in-memory reconstruction)

Stop the process. Restart.

```bash
# After restart:
npm run demo:list-invoices
# All invoices and their state are still there
# Because FeltDB persists to disk
```

No magic. No eventual consistency. No reconstruction logic.

## Architecture

```
┌──────────────────────────────────────┐
│   Example Application (Node.js)      │
├──────────────────────────────────────┤
│  apiKeyAuth middleware               │
│    ↓                                 │
│  principal (tenant-scoped)           │
│    ↓                                 │
│  /invoices endpoint                  │
│    ↓                                 │
│  InvoiceService.createInvoice()      │
└──────────────────────────────────────┘
           │
    ┌──────┴──────┬──────────┐
    ↓             ↓          ↓
  Invoice    Webhook    Job
  (durable)   (durable) (durable)
    │             │         │
    └─────────────┴────┬────┘
                      │
                 FeltDB
              (Single durable
               substrate)
```

## Running the Example

### Start the application server

```bash
npm run dev
```

Server listens on `http://localhost:3000`

### Create an API key

```bash
npm run demo:create-key
```

Output:
```
✓ API Key created
  ID: <uuid>
  Name: default
  Secret: <secret>
  ⚠️  Save this secret—it is only returned once
```

### Create an invoice

```bash
npm run demo:create-invoice \
  --tenant demo-tenant \
  --customer "ACME Corp" \
  --amount 1000
```

This atomically:
1. Creates invoice in FeltDB
2. Establishes webhook delivery intent for `invoice.created` event
3. Enqueues background job `invoice.process`

### List invoices

```bash
npm run demo:list-invoices
```

Shows all invoices for the demo tenant with their processing status.

### Start the worker

In a separate terminal:

```bash
npm run demo:worker
```

The worker:
- Polls for pending jobs every 5 seconds
- Processes invoice.process jobs (marks invoice completed)
- Retries jobs with exponential backoff
- Claims jobs with leases (preventing duplicate execution)
- Delivers webhooks with retry

### Kill the worker

```bash
# Press Ctrl+C while worker is running
```

Jobs in progress will:
- Have their lease expire
- Become re-executable by the next worker
- NOT execute twice

### Restart the worker

```bash
npm run demo:worker
```

The worker resumes processing:
- Existing invoices are still there
- Pending jobs still exist
- Failed webhooks are still retryable

## Operational Commands

All commands use the CLI for operational visibility:

```bash
# Create API key
appport api-key create \
  --tenant <tenant-id> \
  --name <name> \
  --scope <scope> \
  --created-by <operator>

# Create invoice
appport invoice create \
  --tenant <tenant-id> \
  --customer <name> \
  --amount <number>

# List invoices
appport invoice list --tenant <tenant-id>

# List pending/retrying jobs
appport job list --tenant <tenant-id>

# List webhook deliveries
appport webhook list-deliveries --tenant <tenant-id>
```

## Test Coverage

Run integration tests:

```bash
npm test
```

Tests verify:
- ✓ API key → tenant → invoice → webhook → job composition
- ✓ Tenant isolation (cross-tenant access rejected)
- ✓ Webhook retry with exponential backoff
- ✓ Job execution marks invoice as processed
- ✓ Process restart preserves all durable state
- ✓ No cross-tenant job execution leakage

## Key Invariants

### Durability
If the process dies after the transaction commits, durable state survives. Proven by process restart test.

### At-Least-Once Delivery
Webhooks and jobs are retried if the worker dies. Consumers must treat event IDs as idempotency keys.

### Tenant Isolation
Every query includes tenant_id filter. Cross-tenant access is impossible, not just prevented by convention.

### Fencing
Stale workers cannot overwrite newer workers' results. Proven by lease expiration and version-based updates.

### No Silent Partial Failure
Invoice creation atomically establishes invoice + webhook intent + job intent. No sequence of "maybe succeed".

### No Hidden Persistence
Only FeltDB persists state.
- No in-memory reconstruction
- No event sourcing reconstruction
- No sneaky secondary storage
- One durable substrate

### No Secret Leakage
- API key secrets never stored raw (scrypt hash only)
- Webhook signing secrets never in deliveries
- Job payloads are application data, not infrastructure data
- Audit events never contain secrets

## What This Example Does NOT Do

✗ No Redis / RabbitMQ / Kafka / SQS  
✗ No custom queue implementation  
✗ No custom retry logic  
✗ No custom lease management  
✗ No cron jobs (use recurring schedules)  
✗ No distributed tracing (use FeltDB audit events)  
✗ No feature flags  
✗ No rate limiting  
✗ No payments integration  
✗ No workflow DAGs  
✗ No "job graph" orchestration  

The infrastructure is in AppPort Services. The example contains only business logic.

## Friction Discovered and Fixed

### Original API gaps
The initial implementation lacked atomic composition of invoice + webhook + job.

**Fixed:** JobService and WebhookService now support single-transaction intent establishment. No partial failures.

## Further Reading

- See `/src/invoice-service.ts` for the minimal application logic
- See `/src/worker.ts` for the polling-based job/webhook execution
- See `/tests/integration.test.ts` for proof tests

The complete setup is <300 lines of production-ready code.
