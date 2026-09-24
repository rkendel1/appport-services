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

`APPPORT_UI_CONTRIBUTIONS` describes the `AppPort/ui/1` API-key contribution and declares all three capabilities because the packaged page supports list, create, and revoke as one management experience.

The packaged API-key page is mounted at `/api-keys` and requires AuthBoundry to allow all three API-key capabilities. When present on the supplied instance, the router also mounts the webhook, job, schedule, file, and notification handlers and their packaged pages. Each operation maps to one manifest capability (for example `webhooks.register`, `jobs.create`, `files.write`, `notifications.send`, `schedules.cancel`). Configuration composes `/v1/configuration` and its `/configuration` and `/secrets` pages with `configuration.read`, `configuration.write`, `configuration.delete`, `credential.attach`, `credential.rotate`, and `credential.detach`. UI pages are mounted only when their corresponding service handler is present.

## Standalone runtime

`appport()` and `application.start()` continue to start the standalone HTTP runtime. Its `/_appport/api/keys` routes are the same shared management implementation. Standalone Bearer authentication is retained for standalone deployments; embedded hosts use their own authentication adapter and do not need an AppPort credential bootstrap path.

In either mode, application and environment selection should be resolved by the host before it supplies the authoritative principal/context. Browser JSON cannot override tenancy.
