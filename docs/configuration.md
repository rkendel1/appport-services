# Configuration

AppPort Services stores application configuration in FeltDB, scoped by tenant,
application, and environment (`development`, `staging`, or `production`).

`.flow` declares the collections and the application contract remains
authoritative. AppPort Services stores the values; AuthBoundry determines who
may manage them; FeltDB provides durable state and evidence; the web UI is only
the human management surface.

Variables are returned in configuration list responses and may be edited.
Secrets are write-only: create and rotate accept a value, but list, audit,
error, and UI responses contain metadata only. Secret deletion and every other
mutation is durable and audited without recording secret material.

The API is available through `createConfigurationRouter`:

* `GET /v1/configuration`
* `POST /v1/configuration/variables`
* `PATCH /v1/configuration/variables/:name`
* `POST /v1/configuration/secrets`
* `PUT /v1/configuration/secrets/:name`
* `DELETE /v1/configuration/{variables|secrets}/:name`

Requests must carry an authenticated AppPort principal with the corresponding
`configuration.read`, `configuration.write`, `configuration.delete`, or
`secret.rotate` scope. The optional management UI is served by
`createConfigurationUiRouter()` at `/configuration`; it uses the API and does
not use browser storage.
