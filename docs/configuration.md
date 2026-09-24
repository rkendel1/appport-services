# Configuration

AppPort Services stores application configuration in FeltDB, scoped by tenant,
application, and environment (`development`, `staging`, or `production`).

`.flow` declares the collections and the application contract remains
authoritative. AppPort Services stores the values; AuthBoundry determines who
may manage them; FeltDB provides durable state and evidence; the web UI is only
the human management surface.

Variables are returned in configuration list responses and may be edited.
Secrets are **credential bindings**: they store only a `credential-ref:<id>`
into AuthBoundry credential custody. A raw `value` is rejected with a
migration error. Configuration is not authority: attaching a credential
reference does not allow anyone to use it. Every mutation is durable and
audited without recording secret material.

Ownership is resolved from context. The tenant comes from the verified
principal and the application is the deployment's own. A request naming
another tenant or application is denied.

The API is available through `createConfigurationRouter`:

* `GET /v1/configuration`
* `POST /v1/configuration/variables`
* `PATCH /v1/configuration/variables/:name`
* `POST /v1/configuration/secrets`
* `PUT /v1/configuration/secrets/:name`
* `DELETE /v1/configuration/{variables|secrets}/:name`

Requests must carry a verified principal. Each operation is authorized by
AuthBoundry as `configuration.read`, `configuration.write`,
`configuration.delete`, `credential.attach`, `credential.rotate`, or
`credential.detach` (see [AUTHORITY.md](./AUTHORITY.md)). The optional management UI is served by
`createConfigurationUiRouter()` at `/configuration`; it uses the API and does
not use browser storage.
