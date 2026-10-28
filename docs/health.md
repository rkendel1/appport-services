# Service health

`services.health(options?)` reports, per service, whether it is usable and what
needs an operator, from durable state. It replaces reading the services'
private collections (`files`, `notifications`, `ConfigurationVariables`,
`ConfigurationSecrets`, `webhook_deliveries`, `webhook_endpoints`, ...), whose
names and shapes are not a public contract.

```ts
import { createServices, type AppPortServicesHealth } from '@appport/services';

const services = createServices({ db, application: 'invoices', authorizer, credentials });
const health: AppPortServicesHealth = await services.health({ tenantId: 'acme' });

if (health.status !== 'ok') console.warn(health.attention);
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `tenantId` | every tenant | Count one tenant only. Required for the missing-required-declaration check. |
| `countLimit` | `1000` (max `10000`) | Upper bound of every count. A count equal to it means "at least"; its path is listed in `cappedCounts`. |

## Result

```ts
interface AppPortServicesHealth {
  status: 'ok' | 'degraded' | 'unconfigured';
  checkedAt: string;          // ISO time
  application: string;
  tenantId?: string;
  version: string;            // VERSION
  countLimit: number;
  cappedCounts: string[];     // e.g. ['webhooks.failedDeliveries']
  authority: { state, reasons, authorizer: boolean, credentials: boolean };
  services: { apiKeys, webhooks, jobs, schedules, notifications, files, configuration, intelligence };
  attention: {
    failedWebhookDeliveries, disabledWebhookEndpoints, failedJobs,
    failedNotifications, failedNotificationDeliveries, missingSecrets, legacySecretValues,
    missingCredentialMaterial?,   // only with a SecretCustody
  };
}
```

Each service is `{ state, reasons, counts }`, with
`state: 'ok' | 'degraded' | 'unconfigured' | 'disabled'`:

| Service | `unconfigured` | `degraded` | `disabled` | `counts` |
| --- | --- | --- | --- | --- |
| `apiKeys` | no keys | — | no authorizer | `keys`, `active`, `revoked`, `expired` |
| `webhooks` | no endpoints | failed deliveries; active endpoints but no credential custody (cannot sign) | every endpoint disabled; no authorizer | `endpoints`, `activeEndpoints`, `disabledEndpoints`, `pendingDeliveries`, `retryingDeliveries`, `failedDeliveries` |
| `jobs` | — | failed jobs | no authorizer | `pending`, `running`, `retrying`, `failed` |
| `schedules` | no schedules | — | every schedule disabled; no authorizer | `enabled`, `disabled` |
| `notifications` | — | failed notifications or deliveries | no authorizer | `failedNotifications`, `pendingDeliveries`, `retryingDeliveries`, `failedDeliveries` |
| `files` | — | — | no authorizer | `files` (not deleted) |
| `configuration` | no variables or bindings | a required declaration is missing; a binding still holds a raw value; custody reports a binding's material missing or revoked | no authorizer | `variables`, `secrets`, `missingRequired`, `legacySecretValues`, `missingMaterial` (only with a `SecretCustody`) |
| `intelligence` | not selected | the selected provider requires a credential and none is bound | no authorizer | `configured`, `missingCredentials` |

`reasons` are machine-readable: `authorizer_unconfigured`,
`credentials_unconfigured`, `no_keys`, `no_endpoints`, `all_endpoints_disabled`,
`failed_deliveries`, `failed_jobs`, `no_schedules`, `all_schedules_disabled`,
`failed_notifications`, `no_configuration`, `missing_required`,
`legacy_secret_values`, `missing_material`, `not_configured`, `missing_credential`.

With a `SecretCustody` (see [credentials.md](./credentials.md#write-path-secretcustody-080)),
`health()` asks `status()` about every counted binding (one call each, a custody
error counts as `unknown` and never fails health). `services.configuration.bindings`
lists `{ tenantId, environment, name, state, version?, location?, writable? }`
per binding, and `counts.missingMaterial` / `attention.missingCredentialMaterial`
count those `missing` or `revoked`. With a resolver-only custody these fields
are absent and the shape is unchanged.

The overall `status` is `unconfigured` without an AuthBoundry authorizer (every
effect fails closed), `degraded` when any service is degraded, and `ok`
otherwise. `unconfigured` and `disabled` services do not degrade the overall
status: a deployment with no webhooks is healthy. `authority.state` is
`degraded` without credential custody (`credentials`), which only matters to
effects that resolve credentials.

`attention.missingSecrets` is the number of required `secret` declarations
with no binding (pass `configurationDeclarations` to `createServices`, and a
`tenantId`) plus intelligence selections missing their credential.

## Guarantees

- **Bounded.** Every count is one equality query at the storage boundary that
  stops after `countLimit + 1` rows; `health()` never scans history beyond that.
- **Counts only.** No record, value, payload, or credential reference is
  returned. The one list, `configuration.bindings` (only with a
  `SecretCustody`), names bindings and their material state, never a value or
  a reference.
- **Scoping.** Records that carry an `applicationId` (keys, endpoints, jobs,
  schedules, notifications, files, configuration) are counted for this
  application only. Webhook and notification *deliveries* carry no application;
  they are counted for every application sharing the namespace (and the tenant,
  when given).
- **Trusted host API.** Like the services' observation methods, `health()` is
  in-process and not authorized per caller. It is not mounted over HTTP by
  `createManagementRouter`; a host that exposes it decides who may see it.
