# AppPort capability inventory

`docs/capabilities.json` is the machine-readable capability catalog exported by the implementation-backed discovery helpers. It describes the repository's full `createServices()` surface; individual `appport()` applications return the same records with `runtimeMounted` adjusted to match the declared contract.

## Capability matrix

| Capability | Operations | Durable | Async | Runtime mounted in `createServices()` | Notes |
| --- | --- | --- | --- | --- | --- |
| API Keys | create, read, revoke, authenticate | yes | no | yes | Plaintext key material is returned only on create. |
| Webhooks | register, read, disable, deliver, retry, replay, receive, registerIntegration | yes | yes | yes | Signing secrets resolve through `ScopedSecretsResolver`. |
| Jobs | create, read, execute, retry | yes | yes | yes | Durable lease/retry state lives in FeltDB. |
| Schedules | create, read, cancel, materialize | yes | yes | yes | Built on the job store and durable principal model. |
| Notifications | create, read, deliver, retry, acknowledge, dismiss, delete | yes | yes | yes | Delivery retries use durable state and the job service. |
| Files | create, read, update, delete | yes | no | yes | Stores durable metadata and lifecycle state; no provider credentials are exposed. |
| Configuration | read, write, delete | yes | no | yes | Environment-scoped variable storage. |
| Credentials | attach, rotate, detach | yes | no | yes | Stores only `credential-ref:<id>` bindings. |
| Secrets | register, describe, list, rotate, revoke, retire, resolve | yes | no | no | Protocol and metadata contract only in this repository. |
| Runtime Events | publish, subscribe, stream | no | yes | no | `appport()` mounts this as the in-process `AppPortEvents` transport. |

## Runtime discovery

- `createServices().discovery` reports the full mounted service surface of the shared service runtime.
- `appport().discovery` reports the same catalog with contract-specific `runtimeMounted` values.
- `GET /_appport/capabilities` returns `appport().discovery` for autonomous agents and other runtime clients.

## Before / after gap matrix

| Capability area | Before | After |
| --- | --- | --- |
| Discovery surface | Runtime overview listed enabled sections, but not a machine-checkable capability catalog. | Discovery now exposes an implementation-backed catalog in code and at `/_appport/capabilities`. |
| Documentation | Capability docs were spread across feature-specific documents. | Added consolidated capability inventory plus machine-readable JSON. |
| Mounted-state reporting | Clients had to infer mounted status from contract sections. | Discovery now reports per-capability `runtimeMounted` explicitly. |
| Authority guidance | Feature docs described authority behavior separately. | Added capability authority summary aligned to the discovery catalog. |
