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

Which pages exist is **not** hard-coded. The host derives them from the same contribution the router serves, so a host that mounts fewer services advertises fewer surfaces. The pages' navigation is built from the same list, so it never links to a page the host does not serve.

### How the pages are built

The packaged pages use the shared Stack design system (`rkendel1/stack-ui`), vendored in `vendor/stack-ui` and checked against its `SHA256SUMS`. Each page is one HTML document that inlines the design system's styles and its stateless classic script, this package's `ui/management.css` and `ui/management.js`, and a JSON description of the page and its navigation; no extra route is served. The browser renders the shell, forms and tables with the design system's DOM helpers and never parses markup.

- Every field has a visible label; tables keep one cell per header; statuses use the design system's mappings for these services' own fields (job status, notification status, and so on).
- Revoking, deleting and disabling go through the design system's `ConfirmAction`, which states the consequences and, for named resources, asks for the name to be typed. Edits that used `prompt()` open a labelled form dialog. Nothing uses `confirm()`, `prompt()` or `alert()`.
- A list that cannot be read shows the product's error and code with Retry, never an empty list. A change the product answers with `null` (the record was not found or changed meanwhile) is reported as not done.
- The Configuration page edits the production environment: its requests name no environment, and `/v1/configuration` reads the environment from the query string. The old forms' Environment select, which the server ignored, is gone.
- The pages keep nothing in browser storage. There is no theme control; the colour scheme follows the operating system.
- `npm run test:browser` drives every page in Chromium against the standalone host, with axe in light and dark at 1280 and 640 pixels.

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
- `POST /_appport/api/keys` requires `apikeys.create` (`{ name, restrictions?, expiresAt? }`).
- `PATCH /_appport/api/keys/:id` requires `apikeys.update` (`{ name?, restrictions?, expiresAt? }`; `null` clears).
- `POST /_appport/api/keys/:id/rotate` requires `apikeys.rotate` (`{ overlapSeconds? }`); the response carries the new secret once.
- `DELETE /_appport/api/keys/:id` requires `apikeys.revoke`.
- `POST /_appport/api/keys/revoke-all` requires `apikeys.revoke` on the collection with attribute `createdBy` (`{ createdBy? }`, `*` when omitted).
- `GET /_appport/api/keys/:id/audit` requires `apikeys.audit`.

Webhook deliveries are read under their own capability, `webhooks.deliveries.read` (endpoint routes keep `webhooks.read`):

- `GET /_appport/webhooks/deliveries?endpointId=&status=&limit=` returns at most `limit` deliveries (default 50, at most 200; `400` outside that), filtered by endpoint and/or status (`pending`, `delivering`, `delivered`, `retrying`, `failed`).
- `GET /_appport/webhooks/deliveries/:id` returns one delivery, or `404`.

The update, rotate, revoke-all, and audit routes are mounted when the supplied `apiKeys` service provides those methods. The page edits, rotates, audits, and bulk-revokes keys through them; see [api-keys.md](api-keys.md).

The authenticated principal's tenant and principal ID are authoritative. A different `tenantId` in a request body is denied (`403`), a different `createdBy` is rejected (`400`), and `scopes` are rejected (`400`): API keys carry no scopes. Creation and rotation return the plaintext credential once. Lists contain metadata only, revoked keys are omitted, and revoke responses contain no credential material.

### Pages on a sub-path or another origin (`basePath`)

By default the packaged pages request root-relative paths (`/_appport/...`, `/v1/...`) and link to root-relative page routes. When the router is mounted under a path, or the pages are shown by a console on another origin, pass `basePath`:

```ts
app.use('/services-admin', createManagementRouter({ services, authority: services.gateway, authenticate, basePath: '/services-admin' }));
// or, for a console on another origin that calls this host:
createManagementRouter({ services, authority: services.gateway, authenticate, basePath: 'https://services.example.com' });
```

`basePath` is a path (`/services-admin`) or an `http(s)` origin with an optional path; a trailing slash is removed, and credentials, a query or a fragment are refused. Every request and navigation link the pages make is prefixed with it. It changes nothing on the server: the routes stay where the router is mounted, and `GET /v1/ui` still describes host-relative routes. A cross-origin `basePath` needs the host to allow that origin (CORS, and how the console's requests are authenticated); the router does not set CORS headers. The default (`''`) is unchanged behaviour.

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

The packaged API-key page is mounted at `/api-keys` and requires AuthBoundry to allow all three API-key capabilities. When present on the supplied instance, the router also mounts the webhook, job, schedule, file, and notification handlers and their packaged pages. Each operation maps to one manifest capability (for example `webhooks.register`, `jobs.create`, `files.write`, `notifications.send`, `schedules.cancel`). Configuration composes `/v1/configuration` and its `/configuration` and `/secrets` pages with `configuration.read`, `configuration.write`, `configuration.delete`, `credential.attach`, `credential.rotate`, `credential.detach`, `credential.store`, and `credential.status`. The `/secrets` page's masked **Set value** form posts to `POST /v1/configuration/credentials` (`credential.store`) and shows each binding's value status from `GET /v1/configuration/credentials/status`; the value goes to the host's `SecretCustody` and is cleared from the form after every submit (see [credentials.md](./credentials.md#the-secrets-page)). UI pages are mounted only when their corresponding service handler is present.

## Standalone runtime

`appport()` and `application.start()` continue to start the standalone HTTP runtime. Its `/_appport/api/keys` routes are the same shared management implementation. Standalone Bearer authentication is retained for standalone deployments; embedded hosts use their own authentication adapter and do not need an AppPort credential bootstrap path.

In either mode, application and environment selection should be resolved by the host before it supplies the authoritative principal/context. Browser JSON cannot override tenancy.
