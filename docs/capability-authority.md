# Capability authority

AppPort Services is a Policy Enforcement Point. Every mounted consequential effect is executed through `ServiceGateway`, which binds:

1. the verified principal,
2. the tenant/application/resource scope,
3. the declared capability name, and
4. durable effect evidence in FeltDB.

Discovery is intentionally not an authorization decision. A capability may be discoverable and still return `UNAUTHENTICATED`, `DENIED`, or `AUTHORITY_UNAVAILABLE`.

## Authority summary by capability

| Capability | Authority path | Sensitive data rule |
| --- | --- | --- |
| API Keys | `apikeys.create`, `apikeys.read`, `apikeys.revoke` via `ServiceGateway` | Only create returns plaintext secret material; stored records and audits keep hashes/prefixes only. |
| Webhooks | `webhooks.*` via `ServiceGateway`, delivery credentials via `ScopedSecretsResolver` | Signing material is resolved only for an authorized delivery/receive path. |
| Jobs | `jobs.create`, `jobs.retry`, `jobs.execute` and `schedules.*` via `ServiceGateway` | Durable principals are re-authorized on every execution attempt. |
| Notifications | `notifications.*` via `ServiceGateway` | Notification data is validated to avoid credential/secret leakage. |
| Files | `files.read`, `files.write`, `files.delete` via `ServiceGateway` | Only file metadata is stored here; callers never receive provider credentials. |
| Configuration | `configuration.read`, `configuration.write`, `configuration.delete` via `ServiceGateway` | Variable reads never expand credential bindings into secret values. |
| Credentials | `credential.attach`, `credential.rotate`, `credential.detach` via `ServiceGateway` | Credential bindings remain opaque `credential-ref:<id>` references. |
| Secrets | Not mounted in this repository runtime | Secret values are never returned through discovery, listings, logs, or normal audits. |
| Runtime Events | In-process transport, not durable authority state | Event streaming is observational only and must not be used as an authority channel. |

## Runtime distinctions

- `createServices()` mounts the durable services runtime used by management APIs and tests.
- `appport()` mounts only the capabilities declared by `appport.toml`; its discovery output shows which capabilities are unavailable or not mounted in that application runtime.
- Secrets remain a provider-neutral contract in this repository: AppBoundry supplies execution, and AuthBoundry supplies the authorization decision that permits temporary secret resolution.
