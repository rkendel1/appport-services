# AppPort Services Packaging & Consumer Testing

## Overview

AppPort Services is published as a standalone npm package: `@appport/services`

The package contains everything needed for application developers to use AppPort Services without understanding or depending on FeltDB internals.

## Public API Boundary

### Exports (Consumer-facing)

```typescript
// Primary factory
export { createServices } from './runtime/unified-services.js';
export type { AppPortServices, CreateServicesOptions } from './runtime/unified-services.js';

// Atomic transaction API
export type { AppPortTransactionContext, AppPortTransactionCollection } from './runtime/transaction.js';

// DSL Configuration
export { parseAppPortConfig } from './runtime/dsl.js';
export type { AppPortConfig } from './runtime/dsl.js';

// Service classes
export { ApiKeyService, WebhookService, JobService, JobWorker } from './...';

// Domain types (Customer, Invoice, etc are application-owned)
export type {
  ApiKey, WebhookEndpoint, WebhookDelivery, Job,
  // ...
} from './...';

// HTTP integration
export { apiKeyAuth, authenticateBearerToken, createApiKeyAuth } from './runtime/...';
```

### Non-Exports (Hidden from consumers)

- `@feltdb/core` internals
- `FeltDbApiKeyStore`, `FeltDbWebhookEndpointStore`, etc.
- `createFeltDbRuntime`
- Collection constants and internal store implementations
- Storage layer implementation details

## Building the Package

```bash
npm install                 # Install dependencies
npm run build              # Compile TypeScript → dist/
npm pack                   # Create appport-services-0.1.0.tgz
```

## Verifying Consumer Boundary

The consumer boundary test in `examples/invoice-app/tests/consumer-boundary.test.ts` proves:

1. ✓ Tarball can be installed as a dependency
2. ✓ `createServices()` is importable and works
3. ✓ All service classes are available
4. ✓ Transaction API functions correctly
5. ✓ No workspace imports required
6. ✓ No @feltdb/core imports needed
7. ✓ Application code is isolated from infrastructure

### Running Consumer Test

```bash
# 1. Build and pack the main package
cd /home/user/appport-services
npm run build
npm pack

# 2. Create consumer test environment
mkdir consumer-test
cp appport-services-0.1.0.tgz consumer-test/
cd consumer-test/invoice-app

# 3. Install from tarball
npm install

# 4. Run test
npm test
```

Expected output:
```
✓ Consumer boundary: packed tarball can be imported and used
✓ All required services available from packed npm package
```

## Invoice Application Example

The `examples/invoice-app/` demonstrates the complete pattern:

1. **API Key Authentication**: Request validation via middleware
2. **Atomic Composition**: Invoice + webhook + job in one transaction
3. **Restart Durability**: Process crash → restart → data intact
4. **Tenant Isolation**: Multi-tenant data scoping
5. **Consumer Boundary**: Imports only @appport/services

### Key Pattern

```typescript
// Application initialization
const services = createServices({
  mode: 'local',
  namespace: 'invoice-app',
  path: './.feltdb/invoice-app',
  config: './appport.toml'
});

// Atomic transaction
await services.transaction(async (tx) => {
  // 1. Create invoice (application state)
  await tx.collection('invoices').insert(invoice, invoiceId);
  
  // 2. Queue webhook
  tx.queueWebhookDeliveries([endpointId], {...});
  
  // 3. Enqueue job
  tx.queueJob({...});
});
// All three commit/rollback atomically with FeltDB transaction semantics
```

## Package Contents

After `npm pack`, the tarball includes:

- `dist/src/**/*.js` - Compiled consumer-facing code
- `dist/src/**/*.d.ts` - TypeScript declarations
- `package.json` - Package metadata and exports
- `node_modules/@feltdb/core/` - Runtime dependency (fetched by npm)
- `examples/invoice-app/` - Working example (optional, for reference)
- `DOGFOOD_REPORT.md` - Findings and benefits analysis

## Version and Compatibility

- **Package Name**: @appport/services
- **Current Version**: 0.1.0
- **Module Format**: ESM (type: "module")
- **Node.js Target**: ES2022 (suitable for Node 16+)
- **TypeScript**: Full .d.ts declarations included

## Publishing to npm Registry

When ready to publish to the npm public registry:

```bash
npm run publish:packages
```

The release command runs the full test suite, loads `NPM_TOKEN` from
`.env.local` when present, and publishes the scoped package publicly. The token
file is excluded from both git and the npm package.

Consumers would then install with:
```bash
npm install @appport/services
```

## Acceptance Criteria

A developer can:

1. ✓ Create empty directory
2. ✓ `npm install @appport/services`
3. ✓ Create `appport.toml` with DSL configuration
4. ✓ Import createServices and use it
5. ✓ Build and run application
6. ✗ Never know FeltDB exists
7. ✗ Never import from @feltdb/core
8. ✗ Never use workspace paths or file: dependencies

All criteria met and tested.
