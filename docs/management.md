# Composable management runtime

AppPort Services owns service behavior, durable state, validation, API-key generation, and the management HTTP contract. The host application owns authentication and is the authorization authority. AppPort Services does not authenticate an embedded browser, inspect host roles or claims, or require a second AppPort API key.

## Embedded Express host

Mount the supported router against the same `AppPortServices` instance used by the application:

```ts
import express from 'express';
import { createManagementRouter, createServices } from '@appport/services';

const services = createServices({ path: '.appport' });
const app = express();

app.use(createManagementRouter({
  services,
  authenticate: async (request) => {
    const session = await hostSessions.read(request);
    if (!session) return null;
    return {
      principalId: session.subject,
      principalType: 'host_session',
      tenantId: session.tenantId,
      scopes: [],
    };
  },
  authorize: (capability, { principal, request }) =>
    hostAuthorization.isAllowed(principal.principalId, capability, request),
}));
```

The router does not construct services, open another FeltDB connection, or use `principalType` and `scopes` as host authorization decisions. A missing principal receives `401 UNAUTHENTICATED`; a denied authorization decision receives `403 FORBIDDEN`.

The API-key page uses these stable endpoints:

- `GET /_appport/api/keys` requires `apikeys.read`.
- `POST /_appport/api/keys` requires `apikeys.create`.
- `DELETE /_appport/api/keys/:id` requires `apikeys.revoke`.

The authenticated principal's tenant and principal ID are authoritative. Tenant or creator fields in request bodies are ignored. Creation returns the plaintext credential once. Lists contain metadata only, revoked keys are omitted, and revoke responses contain no credential material.

`APPPORT_UI_CONTRIBUTIONS` describes the `AppPort/ui/1` API-key contribution and declares all three capabilities because the packaged page supports list, create, and revoke as one management experience.

The packaged API-key page is mounted at `/api-keys` and is guarded by all three API-key capabilities. When present on the supplied instance, the router also mounts the existing webhook, job, schedule, file, and notification handlers and their packaged pages. Those services retain their existing authorization rules. Configuration similarly composes the existing `/v1/configuration` contract plus its `/configuration` and `/secrets` pages with the existing `configuration.read`, `configuration.write`, `configuration.delete`, and `secret.rotate` checks. UI pages are mounted only when their corresponding service handler is present.

## Standalone runtime

`appport()` and `application.start()` continue to start the standalone HTTP runtime. Its `/_appport/api/keys` routes are the same shared management implementation. Standalone Bearer authentication is retained for standalone deployments; embedded hosts use their own authentication adapter and do not need an AppPort credential bootstrap path.

In either mode, application and environment selection should be resolved by the host before it supplies the authoritative principal/context. Browser JSON cannot override tenancy.
