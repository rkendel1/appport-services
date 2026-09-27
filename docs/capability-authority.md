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
| API Keys | Discovery ops `create/read/revoke/authenticate`; authorized mutations/reads use `apikeys.create`, `apikeys.read`, and `apikeys.revoke` through `ServiceGateway` | Only create returns plaintext secret material; stored records and audits keep hashes/prefixes only. |
| Webhooks | Discovery ops `register/read/disable/deliver/retry/replay/receive/registerIntegration`; authorized through `webhooks.*` capabilities and `ScopedSecretsResolver` for signing material | Signing material is resolved only for an authorized delivery/receive path. |
| Jobs | Discovery ops `create/read/execute/retry`; authorized through `jobs.create`, `jobs.retry`, `jobs.execute`, and `schedules.*` | Durable principals are re-authorized on every execution attempt. |
| Notifications | Discovery ops `create/read/deliver/retry/acknowledge/dismiss/delete`; authorized through `notifications.*` capabilities | Notification data is validated to avoid credential/secret leakage. |
| Files | Discovery ops `create/read/update/delete`; authorized through `files.read`, `files.write`, and `files.delete` | Only file metadata is stored here; callers never receive provider credentials. |
| Configuration | Discovery ops `read/write/delete`; authorized through `configuration.read`, `configuration.write`, and `configuration.delete` | Variable reads never expand credential bindings into secret values. |
| Credentials | Discovery ops `attach/rotate/detach`; authorized through `credential.attach`, `credential.rotate`, and `credential.detach` | Credential bindings remain opaque `credential-ref:<id>` references. |
| Secrets | Not mounted in this repository runtime | Secret values are never returned through discovery, listings, logs, or normal audits. |
| Runtime Events | Discovery ops `publish/subscribe/stream`; in-process transport, not durable authority state | Event streaming is observational only and must not be used as an authority channel. |

## Runtime distinctions

- `createServices()` mounts the durable services runtime used by management APIs and tests.
- `appport()` mounts only the capabilities declared by `appport.toml`; its discovery output shows which capabilities are unavailable or not mounted in that application runtime.
- Secrets remain a provider-neutral contract in this repository: AppBoundry supplies execution, and AuthBoundry supplies the authorization decision that permits temporary secret resolution.
