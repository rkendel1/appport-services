# AppPort Service Boundary Audit

## Scope and ownership

This audit reviews the existing API Keys, Webhooks, and Jobs code against the
three-layer model:

| Layer | Owns |
| --- | --- |
| AppPort / `@appport/services` | Capability contracts, request/response types, `.flow`, lifecycle state, errors, discovery, and conformance tests |
| AppBoundry | Runtime execution, providers, persistence adapters, delivery, retries, workers, and external effects |
| AuthBoundry | Identity, principals, claims, authentication, authorization, and policy decisions |

The repository predates the protocol-only Secrets boundary and currently
contains implementation code for the three established services. Those
findings are recorded below rather than silently redesigned in this audit.

## Boundary matrix

| Capability | AppPort | AppBoundry | AuthBoundry | Outcome |
| --- | --- | --- | --- | --- |
| API Key contract and safe views | `src/api-keys/models.ts`, `appport.flow` |  |  | Clean |
| API Key generation, hashing, verification, and revocation execution |  | `src/api-keys/service.ts` |  | Follow-up required: pre-existing runtime implementation |
| API Key authentication and principal creation |  |  | `src/api-keys/service.ts`, `src/runtime/api-keys.ts`, `src/runtime/http-adapter.ts` | Follow-up required: pre-existing authentication implementation |
| API Key authorization |  |  |  | Clean: no policy engine or access decision found |
| API Key FeltDB storage and audit persistence |  | `src/storage/api-keys.ts` |  | Follow-up required: pre-existing storage implementation |
| Webhook endpoint/delivery/event contracts | `src/webhooks/models.ts`, `appport.flow` |  |  | Clean |
| Webhook signing, secret handling, HTTP delivery, retry, and backoff |  | `src/webhooks/service.ts`, `src/webhooks/secrets.ts` |  | Follow-up required: pre-existing runtime/provider behavior |
| Webhook authorization |  |  |  | Clean: no policy engine or access decision found |
| Webhook FeltDB storage and audit persistence |  | `src/storage/webhooks.ts` |  | Follow-up required: pre-existing storage implementation |
| Job/job-schedule contracts and lifecycle state | `src/jobs/models.ts`, `appport.flow` |  |  | Clean |
| Job claiming, leasing, execution, retry, and worker polling |  | `src/jobs/service.ts`, `src/jobs/worker.ts`, `src/jobs/store.ts` |  | Follow-up required: pre-existing runtime execution |
| Job authorization |  |  |  | Clean: no policy engine or access decision found |
| Job FeltDB storage and audit persistence |  | `src/jobs/store.ts` |  | Follow-up required: pre-existing storage implementation |
| Secrets contract and lifecycle metadata | `src/secrets/models.ts`, `src/secrets/protocol.ts`, `appport.flow` |  |  | Clean |
| Secret provider/runtime |  |  |  | Clean: intentionally absent |
| Secret authorization |  |  |  | Clean: intentionally absent; principal context is protocol data only |

## Findings

### API Keys

The API Key models and `.flow` fields are AppPort contract material. The
service generates credential material, hashes and verifies it, mutates
revocation/usage state, creates machine principals, and writes audit records.
`FeltDbApiKeyStore` and `FeltDbAuditSink` are concrete persistence adapters.
These are pre-existing AppBoundry/AuthBoundry concerns in this repository,
not changes introduced by Secrets. A separate migration could split the
protocol from runtime/authentication/storage; this PR does not change the
public API.

No roles, claims, policy evaluator, or authorization decision was found.
`assertTenant` is a tenant-consistency guard around an already supplied
principal, not an authorization policy engine.

### Webhooks

Endpoint, delivery, event, and audit record shapes are AppPort contract
material. `WebhookService` also performs secret generation/storage, signing,
HTTP delivery, retry, and backoff; `src/storage/webhooks.ts` persists those
records in FeltDB. Those are pre-existing AppBoundry/runtime concerns and are
documented for a separate migration.

No webhook authorization or policy engine was found. `createdBy`,
`disabledBy`, and the synthetic `system` audit principal are context fields,
not authorization decisions.

### Jobs

Job and schedule models, statuses, run times, retry metadata, and lease fields
are AppPort state-contract material. `JobService`, `JobWorker`, and
`src/jobs/store.ts` perform claiming, fencing, execution, retry scheduling,
worker polling, and FeltDB persistence. These are pre-existing AppBoundry
runtime/storage concerns and are not redesigned here.

No roles, claims, policy evaluator, or authorization decision was found.

### Secrets consistency

Secrets remains protocol-only. It has no provider adapter, storage engine,
cache, material handling, runtime resolver, authentication, or authorization
implementation. `principalId` and tenant context in the protocol describe
operation context; they do not authorize an operation.

## Dependency and storage conclusion

`@feltdb/core` is an existing runtime/storage dependency used by the three
legacy service implementations and by the authoritative Flow validation. No
provider SDK, AuthBoundry package, or AppBoundry package is present. This is a
documented pre-existing implementation exception, not a reason to add such
dependencies to Secrets.

## Follow-up recommendations

1. Split API Key authentication/credential execution and concrete FeltDB
   adapters from the AppPort protocol package.
2. Split Webhook signing, secret handling, HTTP delivery, retry execution, and
   concrete persistence.
3. Split Job workers, execution/retry machinery, scheduling, and concrete
   persistence.
4. Keep authorization decisions in AuthBoundry while passing actor/principal
   context through protocol calls.

These migrations should be separate PRs because they would change established
runtime APIs and are outside the Secrets boundary audit.
