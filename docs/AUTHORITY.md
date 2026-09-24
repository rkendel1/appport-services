# Authority model

> **@appport/services executes effects. It does not decide who is allowed to cause them.**

`@appport/services` is a Policy Enforcement Point (PEP). AuthBoundry is the
only authority. FeltDB holds the durable authority state and the effect
evidence.

```
                AuthBoundry
                    │
             authorization
                    │
                    ▼
Application → AppPort → Services → Provider
                    │
                    ▼
                  FeltDB
```

Two invariants hold for every consequential service operation:

```
No AuthBoundry authorization  →  no service effect
No authorized credential      →  no provider credential
```

None of these can become authority on its own: API-key scopes, actor strings,
job metadata, the worker process, webhook payloads, service configuration,
or provider credentials.

## The safe API

Application code invokes capabilities with the principal that authentication
produced:

```ts
const services = createServices({
  application: 'invoices',
  authorizer,          // AuthBoundry client (ServiceAuthorizer)
  credentials,         // AuthBoundry credential custody (ScopedSecretsResolver)
});

const principal = await services.apiKeys.authenticateApiKey(bearerToken);
await services.invoke('notifications.send', { recipient: 'finance', type: 'invoice.paid', title: 'Paid' }, { principal });
```

With `appport()` the same call is `app.invoke(capability, input, { principal })`,
and `app.authenticate(request)` produces the principal from a bearer API key
or from the host's `identify` adapter.

Application code never handles provider credentials, signing secrets,
internal service principals, or admin scopes.

## Order of enforcement

Every protected operation goes through `ServiceGateway` in this fixed order:

1. validate the request
2. require a **verified principal** (see below)
3. enforce ownership: the tenant comes from the principal, and the
   application is the gateway's own. A different caller-supplied tenant or
   application is **denied**, not silently replaced.
4. resolve the declared capability from the manifest
5. ask AuthBoundry (`ServiceAuthorizer.authorize`) with a timeout
6. only if allowed: resolve credentials through AuthBoundry custody, passing
   the decision id as `authorizationRef`
7. perform the provider operation
8. record durable evidence

A credential is never resolved before authorization. `withCredential`
accepts only a live execution context that the gateway issued.

## Verified principals

A principal is an identity. It carries no scopes and grants nothing.
Principals are branded: a module-private registry records every principal
that an authentication path minted, and the services accept nothing else.
Object literals, spread copies, and strings are rejected.

Only these paths can produce a principal:

| Path | `verifiedBy` | Identity |
| --- | --- | --- |
| `apiKeys.authenticateApiKey(secret)` | `api_key` | key id, tenant, application |
| host `identify` adapter (`services.identify`, `appport({ identify })`, management `authenticate`) | `host` | whatever the host authenticated |
| durable job record | `job` | principal captured when the job was enqueued, plus its delegation and run id |
| durable webhook delivery record | `delivery` | principal that emitted the event |
| durable webhook integration | `integration` | `integration:<provider>` |

Durable principals (on jobs, schedules, and webhook deliveries) are
**attested**. Each record stores `authorizedBy`, the AuthBoundry decision id
of the effect that created it. Before a run or a delivery, the gateway
requires matching allow-evidence for that decision: same application,
tenant, principal, and a creating capability (`jobs.create` or
`schedules.create`, or `webhooks.emit` or `webhooks.replay`). A record
written any other way, or one that reuses a real decision id under a
different principal, is `DENIED`.

AppPort-owned collections (`jobs`, `webhook_deliveries`,
`service_effect_evidence`, `api_keys`, and so on) are reserved.
`tx.collection()`, `tx.addOperation()`, and `app.state.collection()` refuse
them, so application code cannot write records that would turn into
identity or evidence.

The host `identify` adapter is the application's authentication boundary.
Only pass it claims your authentication actually verified. Scopes on host
claims are dropped.

Caller-supplied actor fields (`actor`, `createdBy`, `revokedBy`,
`disabledBy`, `replayedBy`, `principal`) are rejected unless they restate the
verified caller. An arbitrary string is never proof of identity.

## Execution context

When AuthBoundry allows an operation, the gateway mints a
`ServiceExecutionContext`:

```ts
type ServiceExecutionContext = {
  application: string
  tenantId: string
  principal: VerifiedPrincipal
  capability: string
  capabilityVersion: number
  requestId: string
  resource: ServiceResource
  resourceUri: string
  authorization: { decision: 'allow'; decisionId: string; decidedAt: string; policyVersion?: string }
  expiresAt: string
}
```

The context has these properties:

- **Frozen.** The principal cannot be replaced after authorization.
- **Bound to one capability and tenant.** Using it for anything else is denied.
- **Short-lived.** It expires 60 seconds after issue.
- **Single-use for transactions.** `tx.queueJob`, `tx.queueNotification`,
  and `tx.queueWebhookDeliveries` each consume one context issued by
  `services.authorize(...)`. Its evidence commits in the same FeltDB
  transaction as the effect.

## Capability manifest

`SERVICE_CAPABILITY_MANIFEST` is a static, sorted, frozen list. Services
never invent capability names. `serviceCapabilityManifestDigest()` gives
AuthBoundry a stable hash to pin.

| Service | Capabilities |
| --- | --- |
| API keys | `apikeys.read`, `apikeys.create`, `apikeys.revoke` |
| Webhooks | `webhooks.read`, `webhooks.register`, `webhooks.remove`, `webhooks.emit`, `webhooks.replay`, `webhooks.integrations.register`, `webhooks.deliver`*, `webhooks.receive`* |
| Jobs | `jobs.read`, `jobs.create`, `jobs.retry`, `jobs.execute`* |
| Schedules | `schedules.read`, `schedules.create`, `schedules.cancel` |
| Notifications | `notifications.read`, `notifications.send`, `notifications.update`, `notifications.delete` |
| Files | `files.read`, `files.write`, `files.delete` |
| Configuration | `configuration.read`, `configuration.write`, `configuration.delete`, `credential.attach`, `credential.rotate`, `credential.detach` |

\* Runtime-internal. These are authorized on every delivery, receipt, or
job run, but cannot be invoked by callers.

There are no `*.admin` or `:any` capabilities. Ownership questions ("may
this principal read files owned by someone else?") are AuthBoundry policy
over resource attributes. The service sends attributes such as `owner`,
`recipient`, `createdBy`, `jobType`, `eventType`, `destination`, and
`credentialRef`. A request for "all owners" is sent as the attribute value
`*`.

## AuthBoundry protocol

```ts
interface ServiceAuthorizer {
  authorize(request: ServiceAuthorizationRequest, options: { signal: AbortSignal }): Promise<ServiceAuthorizationDecision>
}
```

The request and decision follow AuthBoundry's `AuthorizationRequest` and
`AuthorizationDecision` shapes: `subject`, `tenant_id`, `application_id`,
`capability`, `resource.uri`, `resource.attributes`, and `context` with
`delegation_id`, `run_id`, and `credential_id`. The gateway accepts a
decision only if its capability, tenant, application, subject, and resource
URI match the request.

## Failure semantics

| Code | Meaning | Provider called? |
| --- | --- | --- |
| `DENIED` | AuthBoundry said no, ownership failed, or the credential was refused or revoked | never |
| `AUTHORITY_UNAVAILABLE` | no authorizer, the authorizer failed, or its decision was malformed | never |
| `AUTHORIZATION_TIMEOUT` | no decision in time; a late answer is discarded | never |
| `INVALID_REQUEST` | bad input, undeclared capability, forbidden destination, or a migration error | never |
| `PROVIDER_ERROR` | authorized, but the provider failed | yes, once |
| `UNAUTHENTICATED` | no verified principal or execution context | never |

Provider failures are never reported as authorization failures.

## Credentials

Provider credentials stay in AuthBoundry custody. Service state stores only
`credential-ref:<id>`:

```
Provider credential
       ↓
AuthBoundry custody
       ↓
authorized effect
       ↓
short-lived scoped grant  (ScopedSecretsResolver.withSecret, authorizationRef = decisionId)
       ↓
service/provider call
```

- Configuration credentials (`credential.attach` and `credential.rotate`)
  take `credentialRef`. A raw `value` is rejected with a migration error.
- Webhook endpoints and integrations take `signingCredentialRef`. The
  service no longer generates, encrypts, or holds signing secrets.
- Configuration is not authority. Attaching `credential-ref:cred_123` means
  the credential is configured. It does not let anyone use it.

## Evidence

Every consequential operation writes an `EffectEvidence` row to FeltDB
(`service_effect_evidence`) with these fields:

- application, tenant, principal, delegation/run
- capability and version, resource URI
- decision and decision id
- credential reference, service, provider
- request id, start and completion times, outcome, failure code

A `started` row is written before the provider is called, so a crash still
leaves evidence behind. Denials are recorded with outcome `denied`.
Evidence never contains raw credentials, decrypted secrets, tokens, API keys,
webhook secrets, or payloads. `assertEvidenceHasNoSecrets` enforces this on
every write.

## No local authorization cache

The services hold no maps of principals to scopes and cache no grants,
decisions, delegation status, or credential validity. AuthBoundry is asked
again for every operation, every job run, and every delivery attempt.

## Observation APIs

Tenant-keyed read methods on the service classes (`listWebhookEndpoints`,
`listJobs`, `getApiKey`, and so on) remain for trusted operator code and the
CLI, which already have direct state access. Application code reads through
`invoke('<service>.read', ...)`, which is authorized like any other
capability.

## Migration

```
Old:  API key + scopes      → service authority
New:  API key               → identity
      AuthBoundry           → authorization
```

| Before | After |
| --- | --- |
| `createApiKey({ tenantId, name, scopes, createdBy })` | `createApiKey({ name }, principal)`. Scopes are rejected; grant capabilities in AuthBoundry. |
| `[api.keys] scopes = [...]` in `appport.toml` | rejected with a migration error |
| `principal.scopes` | removed; principals are identity only |
| `files.admin`, `notifications.admin`, `schedules.admin`, `configuration.admin`, `*:any` | no replacement; express the policy in AuthBoundry over resource attributes |
| `notifications.create` / `notifications.write` | `notifications.send` / `notifications.update` |
| `files.create` | `files.write` |
| `schedules.write` | `schedules.cancel` |
| `secret.rotate` | `credential.rotate` |
| `createSecret({ value })` | `createSecret({ credentialRef: 'credential-ref:<id>' })` |
| `createWebhookEndpoint({ url, events, createdBy })` returning `{ endpoint, secret }` | `createWebhookEndpoint({ url, events, signingCredentialRef }, principal)` returning the endpoint |
| `new WebhookService({ secretStore })` | rejected; signing secrets are held by AuthBoundry |
| `enqueue(input)` | `enqueue(input, principal)`. The job durably records its principal and delegation. |
| `replayWebhookDelivery(tenant, id, 'actor')` | `replayWebhookDelivery(tenant, id, principal)` |
| `createManagementRouter({ authorize })` | rejected; pass `authority: services.gateway` |
| `tx.queueJob(input)` | `tx.queueJob(input, await services.authorize('jobs.create', principal, resource))` |
| `app.publish(type, data, tenantId)` with matching webhooks | pass `{ principal }`; webhook fan-out is an authorized effect |
| CLI `--created-by`, `--revoked-by`, `--scope` | rejected; the operator is identified through `APPPORT_AUTHORITY` or `APPPORT_API_KEY` |

API keys created before this change have no `applicationId`. They no longer
authenticate: re-issue them.

See also [WEBHOOK-SECURITY.md](./WEBHOOK-SECURITY.md) and
[JOB-SECURITY.md](./JOB-SECURITY.md).
