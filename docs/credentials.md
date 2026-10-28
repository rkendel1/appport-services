# Server-side outbound credential resolution

AppPort owns the provider-neutral Secrets contract: logical identity, tenant and provider metadata, lifecycle/version state, audit shapes, error semantics, and the scoped resolution protocol. It does not own secret material or decide whether a principal may use it.

The boundary is deliberately split:

| Boundary | Responsibility |
| --- | --- |
| AppPort | `SecretReference`, metadata/lifecycle contracts, audit provenance, errors, and `ScopedSecretsResolver` |
| AuthBoundry | Authenticate the principal and authorize the requested tenant, provider, and purpose |
| AppBoundry | Implement `ScopedSecretsResolver`, access the configured provider, and invoke trusted server integration code |

AppPort contains no resolver implementation, provider adapter, secret store, encryption mechanism, environment lookup, or authorization policy engine. Secret values are not FeltDB fields.

Since 0.8.0 the host's custody may also accept values (a `SecretCustody`, below). That does not move the boundary: AppPort Services owns how a value is **collected** (authorized, audited, versioned, validated, never echoed); the **host** owns where the material **lives**.

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

## Write path: `SecretCustody` (0.8.0)

A user has to enter a key somewhere. Without a write path they paste it into a field meant for a `credential-ref:`; with one, the key goes straight to the host's custody and every other surface carries only the reference.

```ts
import { isSecretCustody, type SecretCustody } from '@appport/services';

interface SecretCustody<TSecret = string> extends ScopedSecretsResolver<TSecret> {
  /** Store a new version of the material. Never returns the value. */
  store(input: { reference: SecretReference; value: TSecret; context: SecretAccessContext }): Promise<{ version: number; storedAt: string }>;
  /** Whether material exists, without revealing it. */
  status(input: { reference: SecretReference; context: SecretAccessContext }): Promise<{
    state: 'set' | 'missing' | 'revoked';
    version?: number;
    updatedAt?: string;
    location?: string;   // display only: "local encrypted vault", "environment variable FELTKIT_CREDENTIAL_X"
    writable: boolean;   // false when store cannot change it (env-var-only custody)
  }>;
  /** Optional: remove (revoke) material. */
  remove?(input: { reference: SecretReference; context: SecretAccessContext }): Promise<void>;
}

const services = createServices({ authorizer, credentials: hostCustody }); // a resolver or a SecretCustody
```

`SecretAccessContext` is the context `withSecret` already takes (`tenantId`, `principalId`, `purpose`, `authorizationRef`); `reference.secretId` is the `credential-ref:` id. `isSecretCustody(x)` is true when `x` has `withSecret`, `store` and `status`. A host that passes only a `ScopedSecretsResolver` keeps working exactly as before.

### Who owns what

| | Owns |
| --- | --- |
| AppPort Services | The `credential.store` / `credential.status` capabilities, their authorization through the gateway, input validation, the `SecretVersions` / `SecretAuditEvents` metadata, effect evidence, redaction, the Secrets page form |
| The host (`SecretCustody`) | Where and how the material is kept (an encrypted vault outside FeltDB, a secret manager, environment variables), its versions, and whether a reference is writable here |
| AuthBoundry | Whether this principal may store or observe this reference |

### `credential.store` (consequential)

`invoke('credential.store', { ref, value, provider?, kind?, name?, environment? }, { principal })`, or `POST /v1/configuration/credentials` (JSON body, `?environment=`), returns `{ ref, version, storedAt, binding? }`. Never the value.

1. Input is validated before anything else, and no message repeats it: `ref` must be a `credential-ref:<id>`; `value` must be a non-empty string of at most 64 KiB and must not itself be a `credential-ref:` (a reference is not material: bind it with `credential.attach`).
2. AuthBoundry authorizes `credential.store` on resource `credential` with attribute `credentialRef`. A denial records denial evidence and custody is never called.
3. If `name` is given, the binding change is authorized next (`credential.attach` for a new binding, `credential.rotate` to point an existing one at `ref`; nothing when it already points there). A denial here also stores nothing. A name taken by a variable is refused.
4. The custody is asked for `status`. A resolver-only custody, no custody, or `writable: false` is `CUSTODY_READ_ONLY` (HTTP 409) with an actionable message, for example *"This environment's credential comes from the host (environment variable FELTKIT_CREDENTIAL_ANTHROPIC) and cannot be changed here; set it there."*
5. `store` is called once with `authorizationRef` = the AuthBoundry decision id. The value is not kept, logged, or returned.
6. Value-free metadata is written: `Secrets` (logical id, `providerRef` = the reference, `currentVersion`), a `SecretVersions` row (the version the host assigned; the previous active version becomes `retired`), and a `SecretAuditEvents` row (`secret.created` or `secret.rotated`; `secret.failed` with a reason code when the store fails). The effect evidence records `credentialRef` and `credentialVersion` only.
7. The binding is created or re-pointed under its own authorization, with its own configuration audit event.

Any error that would contain the value is replaced with a fixed message (the code is kept); a host's own error text never reaches the caller on this path. The management router never echoes an unparseable JSON body, because the parser's message quotes it.

### `credential.status` (observation)

`invoke('credential.status', { ref } | { refs: [...] }, { principal })`, or `GET /v1/configuration/credentials/status?ref=…&ref=…`, returns `[{ ref, state, version?, updatedAt?, location?, writable }]`. Each reference is authorized separately. A resolver-only custody answers `CUSTODY_READ_ONLY`.

`services.health()` also asks `status` for every binding when the custody is a `SecretCustody`: `configuration.bindings` lists each binding's `state` (`set`, `missing`, `revoked`, or `unknown` when custody could not answer), `configuration.counts.missingMaterial` and `attention.missingCredentialMaterial` count the missing or revoked ones, and the reason `missing_material` degrades configuration. Health still returns no value and no credential reference.

### The Secrets page

The packaged `/secrets` page lists bindings with their reference and value status (Set, with version and location; Missing; Revoked; Unknown), and has a **Set value** form: reference, value (`type="password"`, `autocomplete="new-password"`), optional binding name and provider. The value field is cleared on every submit, success or failure, and nothing the page renders comes from it; the outcome line says only "Stored a new value for `credential-ref:…` (version N)".

### What never contains the value

FeltDB (any collection, any operation, its audit log, its files), effect evidence, `Secrets`/`SecretVersions`/`SecretAuditEvents`, configuration audit events, configuration export, error messages and details, log output, the AuthBoundry request, `health()`, and every management page and JSON response. `tests/credential-custody.test.ts` scans each of these after exercising success, rotation, binding, refusal, and failure paths.

## Durable contract

`Secrets`, `SecretVersions`, and `SecretAuditEvents` are authoritative metadata in the application Flow. They may contain logical IDs, opaque provider references, provider/account/kind classification, versions, status, timestamps, principal, purpose, result, and failure reason.

They must never contain plaintext, decrypted values, tokens, passwords, authorization headers, provider credentials, or any equivalent secret payload. Work, WorkAttempt, Evidence, events, telemetry, logs, browser responses, and LLM context carry only `SecretReference` and non-secret outcomes.

Lifecycle is `active` to `revoked` or `retired`, with rotation represented by a stable logical secret and a new `SecretVersion`. The protocol distinguishes not found, denied, tenant mismatch, inactive/revoked, provider mismatch, unavailable, and internal failures without exposing provider implementation details.

There is no `GET /secrets/:id/value`, `app.api.credentials`, or other browser-accessible resolution API in AppPort Services. The write path is one-way: a value can be handed to custody, and only its status comes back.
