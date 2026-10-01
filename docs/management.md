# Composable management runtime

AppPort Services owns service behavior, durable state, validation, API-key generation, and the management HTTP contract. The host application owns authentication. AuthBoundry is the authorization authority: the router is a thin adapter, and every operation is authorized by the services' `ServiceGateway` (see [AUTHORITY.md](./AUTHORITY.md)). AppPort Services does not authenticate an embedded browser, inspect host roles or claims, or require a second AppPort API key.

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
