# Server-side outbound credential resolution

AppPort owns the provider-neutral Secrets contract: logical identity, tenant and provider metadata, lifecycle/version state, audit shapes, error semantics, and the scoped resolution protocol. It does not own secret material or decide whether a principal may use it.

The boundary is deliberately split:

| Boundary | Responsibility |
| --- | --- |
| AppPort | `SecretReference`, metadata/lifecycle contracts, audit provenance, errors, and `ScopedSecretsResolver` |
| AuthBoundry | Authenticate the principal and authorize the requested tenant, provider, and purpose |
| AppBoundry | Implement `ScopedSecretsResolver`, access the configured provider, and invoke trusted server integration code |

AppPort contains no resolver implementation, provider adapter, secret store, encryption mechanism, environment lookup, or authorization policy engine. Secret values are not FeltDB fields.

## Integration contract

Trusted server integrations consume an AppBoundry implementation of the AppPort protocol:

```ts
import type { ScopedSecretsResolver } from '@appport/services';

async function lookupPerson(
  secrets: ScopedSecretsResolver<string>,
  secretId: string,
  authorizationRef: string,
) {
  return secrets.withSecret({
    reference: {
      secretId,
      tenantId: 'acme',
      provider: 'pipedrive',
      kind: 'api_token',
    },
    context: {
      tenantId: 'acme',
      principalId: 'integration:pipedrive',
      purpose: 'person.lookup',
      authorizationRef,
    },
  }, async ({ value }) => callProvider(value));
}
```

`authorizationRef` is opaque AppPort context. AuthBoundry defines and verifies its meaning; AppPort does not inspect it. AppBoundry must validate existence, tenant, lifecycle, provider/reference consistency, authorization, and material availability before invoking the callback.

The callback form narrows temporary access, but trusted execution must still avoid returning, logging, serializing, or persisting the resolved value.

## Durable contract

`Secrets`, `SecretVersions`, and `SecretAuditEvents` are authoritative metadata in the application Flow. They may contain logical IDs, opaque provider references, provider/account/kind classification, versions, status, timestamps, principal, purpose, result, and failure reason.

They must never contain plaintext, decrypted values, tokens, passwords, authorization headers, provider credentials, or any equivalent secret payload. Work, WorkAttempt, Evidence, events, telemetry, logs, browser responses, and LLM context carry only `SecretReference` and non-secret outcomes.

Lifecycle is `active` to `revoked` or `retired`, with rotation represented by a stable logical secret and a new `SecretVersion`. The protocol distinguishes not found, denied, tenant mismatch, inactive/revoked, provider mismatch, unavailable, and internal failures without exposing provider implementation details.

There is no `GET /secrets/:id/value`, `app.api.credentials`, or other browser-accessible resolution API in AppPort Services.
