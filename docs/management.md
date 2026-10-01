# Composable management runtime

AppPort Services owns service behavior, durable state, validation, API-key generation, and the management HTTP contract. The host application owns authentication. AuthBoundry is the authorization authority: the router is a thin adapter, and every operation is authorized by the services' `ServiceGateway` (see [AUTHORITY.md](./AUTHORITY.md)). AppPort Services does not authenticate an embedded browser, inspect host roles or claims, or require a second AppPort API key.

## Two ways to host the management runtime

AppPort Services can be **embedded by a host application** or run as **its own management host**:

- **Embedded** — an application calls `createManagementRouter(...)` and supplies its own `authenticate` adapter (see below).
- **Standalone** — `appport-services serve` starts the management host, which owns its state, `ServiceGateway`, authentication, router, and HTTP server. No application and no external control plane is required.

Both modes mount the **same** `createManagementRouter`, so the router is the single source of truth for which routes exist. The standalone host is an additional supported hosting option; it does not change or remove the embedded API.

## Standalone management host

```sh
appport-services init     # write appport.toml + feltdb.flow for this deployment
appport-services serve    # start the management host
```

`serve` hosts `createManagementRouter(...)` and therefore serves:

- `GET /v1/ui` — the `AppPort/ui/1` discovery document (public metadata, `Cache-Control: no-store`).
- `/services` and every other management page the mounted services advertise.
- The `/_appport/*` management API.

Which pages exist is **not** hard-coded. The host derives them from the same contribution the router serves, so a host that mounts fewer services advertises fewer surfaces.

| Concern | Behaviour |
| --- | --- |
| Default bind address | `127.0.0.1` (loopback). The host serves an operator UI, not the public internet. |
| Default port | `4100`. Overrides `--port 8787`; set `--host`/`--port` to change it. `--port 0` binds an ephemeral port. |
| Configuration | `appport.toml` (`[http] host` / `port`) and `--host` / `--port` flags, with the flags winning. |
| State | The same durable FeltDB deployment the `api-key`, `webhook`, and `job` commands use (`.appport/state`). Survives restart. |
| Authentication | AppPort Services' own. An AppPort API key as `Authorization: Bearer <secret>`, or an operator identity adapter. |
| Authorization | AuthBoundry, per operation, through the `ServiceGateway`. |
| Shutdown | `SIGINT`/`SIGTERM` close the listener, drain connections, and close the database. `close()` is idempotent. |

**Authentication setup.** A management request needs an AppPort API key. Mint one with the existing command and use it as a bearer credential:

```sh
appport-services api-key create --name operator --tenant-id <tenant>
```

Set `APPPORT_AUTHORITY` to a module exporting `{ authorizer, identify, credentials }` to supply an AuthBoundry authorizer and an operator identity adapter, exactly as the other CLI commands do. The standalone host never accepts an external control plane's credential and never requires one.

Discovery (`GET /v1/ui`) and the capability-free pages are public; the packaged API-key page and every `/_appport/*` operation require a valid identity. Without an AuthBoundry authorizer the host still serves discovery, but management operations fail closed with `503 AUTHORITY_UNAVAILABLE` — it never weakens the boundary to make discovery work.

## Embedded Express host

Mount the supported router against the same `AppPortServices` instance used by the application:

```ts
import express from 'express';
import { createManagementRouter, createServices } from '@appport/services';

const services = createServices({ path: '.appport', application: 'invoices', authorizer: authBoundry });
const app = express();

app.use(createManagementRouter({
  services,
  authority: services.gateway,
  // Identity only. Permissions come from AuthBoundry.
  authenticate: async (request) => {
    const session = await hostSessions.read(request);
    if (!session) return null;
    return { principalId: session.subject, principalType: 'host_session', tenantId: session.tenantId };
  },
}));
```

The router does not construct services, open another FeltDB connection, or make authorization decisions. The `authorize` adapter option was removed and is rejected with a migration error, because a second authorization layer next to AuthBoundry is not permitted. A missing principal receives `401 UNAUTHENTICATED`; an AuthBoundry denial receives `403 DENIED`; unavailable authority receives `503 AUTHORITY_UNAVAILABLE`.

The API-key page uses these stable endpoints:

- `GET /_appport/api/keys` requires `apikeys.read`.
- `POST /_appport/api/keys` requires `apikeys.create`.
- `DELETE /_appport/api/keys/:id` requires `apikeys.revoke`.

The authenticated principal's tenant and principal ID are authoritative. A different `tenantId` in a request body is denied (`403`), a different `createdBy` is rejected (`400`), and `scopes` are rejected (`400`): API keys carry no scopes. Creation returns the plaintext credential once. Lists contain metadata only, revoked keys are omitted, and revoke responses contain no credential material.

## UI discovery (`AppPort/ui/1`)

A host that serves the packaged pages (`includeUi`, the default for `createManagementRouter`) also serves `GET /v1/ui`, the discovery path defined by the AppPort protocol (`@appport/protocol`, `UI_DISCOVERY_PATH`). It returns an `AppPort/ui/1` document built from the services actually mounted: one surface per page (`id`, `title`, `route`, the capabilities the page drives), navigation entries pointing at those surfaces, `composition.requires: []`, and a `capabilities` list. The document is validated with the protocol's own `validateUiContribution`; this package defines no UI schema of its own. `APPPORT_UI_CONTRIBUTIONS` is the same document for a host that mounts everything.

Meaning (this is the protocol's, not this package's): `GET /v1/ui` is **caller-contextual**. The AppPort protocol server returns the contribution filtered by the capabilities the caller holds (`filterUiContribution`); there is no public mode, and a surface that needs no capability is visible to everyone.

What this package does with that:

- `@appport/services` cannot ask "may this caller?" without side effects (`ServiceGateway.authorize` throws on denial and records refusal evidence), so `GET /v1/ui` treats the caller as holding **no asserted capabilities**. The protocol's own filter therefore leaves only the capability-free surface: the **AppPort Services overview** (`/services`). The pages behind it each authenticate and authorize their own caller (an anonymous request to `/api-keys` is `401`).
- `APPPORT_UI_CONTRIBUTIONS` is the **full** contribution (overview plus one surface per page, with the capabilities the page drives). A host that knows its callers' capabilities can hand it to the AppPort protocol server's `ui` option, or call `createUiDiscoveryDocument(services, { callerCapabilities })`, and get per-caller filtering unchanged.
- Discovery is not authorization, and a consumer must not forward an identity it does not own (for example a control plane's operator token) to obtain more. A host that serves no pages (`includeUi: false`) answers `404 NOT_FOUND` ("No composable UI is advertised"), as the protocol server does.
- Routes are relative to the host that serves `/v1/ui`; they are never absolute URLs.

### `appport()` and the management router are different on purpose

`appport()` is an **application runtime**: it serves the application's routes and the `/_appport/*` JSON contract, and no pages and no `/v1/ui` (tested in `tests/runtime-boundaries.test.ts`). The packaged pages and the contribution exist only in a **host that mounts `createManagementRouter`**. Serving the pages from every runtime would turn every AppPort application into a management application, and Bearer-only standalone mode cannot authenticate the pages. A management UI therefore needs a host application that mounts the router.

(Before this change `APPPORT_UI_CONTRIBUTIONS` was `[{protocol, id, requiredCapabilities}]` for API keys only, which was not an `AppPort/ui/1` document.)

The packaged API-key page is mounted at `/api-keys` and requires AuthBoundry to allow all three API-key capabilities. When present on the supplied instance, the router also mounts the webhook, job, schedule, file, and notification handlers and their packaged pages. Each operation maps to one manifest capability (for example `webhooks.register`, `jobs.create`, `files.write`, `notifications.send`, `schedules.cancel`). Configuration composes `/v1/configuration` and its `/configuration` and `/secrets` pages with `configuration.read`, `configuration.write`, `configuration.delete`, `credential.attach`, `credential.rotate`, and `credential.detach`. UI pages are mounted only when their corresponding service handler is present.

## Standalone runtime

`appport()` and `application.start()` continue to start the standalone HTTP runtime. Its `/_appport/api/keys` routes are the same shared management implementation. Standalone Bearer authentication is retained for standalone deployments; embedded hosts use their own authentication adapter and do not need an AppPort credential bootstrap path.

In either mode, application and environment selection should be resolved by the host before it supplies the authoritative principal/context. Browser JSON cannot override tenancy.
