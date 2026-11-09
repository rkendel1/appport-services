# Durable agent feedback storage

`FeltDbFeedbackStore` is the production `FeedbackStore` for the AppPort Agent Feedback Protocol (`appport.feedback/1`).
`@appport/sdk` (>= 1.7.0) implements the protocol and the provider (`createFeedbackProvider`); this store keeps what the
provider accepts in FeltDB, so feedback survives restarts and deployments, and several provider instances can share it.

Ownership: AppPort owns the protocol and its rules, AppPort Services owns this integration, and FeltDB owns persistence.
FeltDB is used through its generic primitives only (transactions, preconditions, versions, equality indexes); it holds no
feedback-specific code.

## Configure

```js
import { createFeltDB } from '@feltdb/core';
import { createFeedbackProvider, createApplication, permissionAuthorizer } from '@appport/sdk';
import { FeltDbFeedbackStore } from '@appport/services';

const db = createFeltDB({ mode: 'local', namespace: 'feedback', path: '/var/lib/myapp/feltdb', access: 'shared' });
// or a managed FeltDB authority: createFeltDB({ server: { url, token, applicationId } })

const feedback = createFeedbackProvider({
  product: { id: 'com.example.invoicing' },
  store: new FeltDbFeedbackStore(db, { tenantId }),
  actor: { kind: 'agent', id: 'invoicing-maintainer' },
});

const application = createApplication({
  application: { id: 'com.example.invoicing', name: 'Invoicing', version: '3.2.0' },
  capabilities: [...myCapabilities, ...feedback.capabilities],
  extensions: [...feedback.extensions],
  attributes: { ...feedback.attributes },
  authorizer: permissionAuthorizer(), // or your AuthBoundry-backed Authorizer
});
```

A runnable version, including a provider restart, is [`examples/feedback-store/example.mjs`](../examples/feedback-store/example.mjs)
(`npm run build && node examples/feedback-store/example.mjs`).

| Option | Meaning |
|---|---|
| `tenantId` (required) | Every record is written and read within this tenant. A store never returns another tenant's records, and the same `submissionId` in two tenants is two submissions. Create one store per tenant. |
| `now` | Clock for `createdAt`/`updatedAt` (tests). |

### FeltDB contract

On an application-scoped FeltDB authority (Managed FeltDB, FeltKit) compose the store's declarations with your own, as
for `servicesContract(...)`:

```js
import { feedbackStoreContract } from '@appport/services';
const feedbackDeclarations = feedbackStoreContract(); // { collections, indexes }
```

It declares three collections, each with a tenant equality index: `feedback_records`, `feedback_submissions`,
`feedback_updates`. The test suite runs every write path against a FeltDB that enforces exactly this fragment.

## Required FeltDB capabilities

| Capability | Used for |
|---|---|
| Atomic multi-operation transactions | a record and its idempotency key commit together; a head and its new update rows commit together |
| `requireAbsent` preconditions | one record per (tenant, principal, submissionId); one row per (record, sequence) |
| `expectedVersion` preconditions | compare-and-set on the record head |
| Equality indexes on `tenantId` (and `tenantId, feedbackId`) | tenant-scoped reads on an application-scoped authority |
| Durable commits | a receipt is answered only after the commit returns |

The local file runtime (`mode: 'local'`) and managed authorities provide all of them. The in-memory runtime does too,
but is not durable: do not use it in production. Several processes may share one local directory only with
`access: 'shared'`.

## Data model

| Collection | One per | Written |
|---|---|---|
| `feedback_records` | report | once with the report, its digest, the receipt, the authenticated owner and the claimed agent (all immutable); the head (`state`, `sequence`, `updatedAt`) is rewritten only under compare-and-set |
| `feedback_submissions` | (tenant, principal, submissionId) | once, with the record, `requireAbsent` |
| `feedback_updates` | lifecycle update | once, `requireAbsent`, never rewritten |

The status the SDK serves is rebuilt from the update rows on every read; the head is a checked projection, not a second
source of truth. Product, protocol, correlation id, category and severity are copied from the report for the provider's
queue (`list()`); the report remains authoritative.

## Guarantees

* **Durable before acknowledgement.** `create()` returns only after FeltDB committed the record; the SDK answers the
  receipt after `create()`.
* **Idempotent submissions.** The idempotency key and the record commit in one transaction with `requireAbsent`, so two
  instances racing on one submission produce one record; the loser gets the existing record and the SDK replays its
  receipt (or answers `CONFLICT` for a different report).
* **Atomic, append-only lifecycle.** `replace()` accepts only a status whose stored history is an unchanged prefix and
  whose new updates are valid next transitions (Core's `applyFeedbackUpdate`), and commits the head (compare-and-set on
  its FeltDB version) with the new rows (`requireAbsent`) in one transaction. A concurrent writer makes it return `false`,
  which the SDK reports as `CONFLICT`. History can neither fork nor be rewritten through the store.
* **Verified reads.** Every read re-checks the report against its digest, the receipt against the report, and the
  history's coherence; a record altered outside the store raises `FeedbackStoreIntegrityError` and is not served (the
  SDK answers `INTERNAL_ERROR`).
* **Crash safety.** FeltDB commits are atomic across crashes: a process killed mid-write leaves whole records and whole
  transitions only (tested with `SIGKILL` against a live writer).

## Identity and authorization

* The record's owner is the principal the SDK's submit handler authenticated (`context.principal`), never anything in the
  report; `reporter.agent`, `reporter.principal` and `context` are stored as the reporter's claims. Provenance is never
  upgraded by the store.
* Reporter access is enforced by the SDK: `appport.feedback.status` serves a record only to its owner and answers
  `NOT_FOUND` otherwise. Tenant isolation is enforced by the store.
* `list()` is the provider's own view and has no caller: authorize who may reach it in your host (for a management
  route, with your existing management authorization). It returns heads only, never report content, and leaves
  `security_concern` records out unless `includeSecurityConcerns: true`.
* Authentication itself is the host's (AuthBoundry, sessions, API keys); this store adds none.

## Recovery and operations

| Situation | What happens | What to do |
|---|---|---|
| Restart or redeploy | Everything committed is there; lifecycles continue | nothing |
| Commit refused (authority error, rollback) | Nothing is written; the SDK answers `INTERNAL_ERROR` | the reporter resubmits; it is a new acceptance |
| Commit outcome unknown (`COMMIT_OUTCOME_UNKNOWN`) | The record may or may not exist; no receipt was sent | the reporter resubmits the same report; if it was committed, the original receipt is replayed |
| Concurrent lifecycle update | One writer wins; the other gets `CONFLICT` | re-read and retry the transition if it still applies |
| `FeedbackStoreIntegrityError` | A stored record no longer matches its digests or history | investigate the change made outside the store; the record is not served |

## Limitations

* Requires `@appport/protocol` >= 1.5.0 (a dependency) and `@appport/sdk` >= 1.7.0 for `createFeedbackProvider`.
* `list()` reads at most 10 000 heads of a tenant per call and sorts them in memory; there is no cursor yet.
* A record holds at most 1 000 updates (the protocol's status bound).
* Submission ids are kept for the life of the record; retention and deletion are not implemented, so `retention` in the
  provider's discovery document is a declaration only.
* Rate limiting is not enforced here.
* Events (`appport.feedback.updated`) are not emitted; reporters read status.
* Evidence is stored inline as submitted (bounded by the protocol); `uri` evidence is not fetched or copied.
