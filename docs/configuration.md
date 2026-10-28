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
* `POST /v1/configuration/credentials` (`credential.store`: `{ ref, value, provider?, kind?, name?, required? }`, 201 `{ ref, version, storedAt, binding? }`)
* `GET /v1/configuration/credentials/status?ref=…` (`credential.status`, repeat `ref` for several)

Requests must carry a verified principal. Each operation is authorized by
AuthBoundry as `configuration.read`, `configuration.write`,
`configuration.delete`, `credential.attach`, `credential.rotate`,
`credential.detach`, `credential.store`, or `credential.status` (see
[AUTHORITY.md](./AUTHORITY.md)). The two credential routes need a host
`SecretCustody`; otherwise they answer `CUSTODY_READ_ONLY` (409). The value is
sent to the host's custody and is never stored in configuration or returned
(see [credentials.md](./credentials.md#write-path-secretcustody-080)). The optional management UI is served by
`createConfigurationUiRouter()` at `/configuration`; it uses the API and does
not use browser storage.

## Export and import between environments

`services.configuration.export(options)` writes the non-secret configuration of
the caller's tenant in one environment as a versioned JSON document;
`services.configuration.import(document, options)` plans it against a target
and, unless it is a dry run, applies it.

```ts
const document = await source.configuration.export({ principal, environment: 'staging' });
// { format: 'appport.configuration-export', formatVersion: 1, exportedAt, source: { application, environment, servicesVersion },
//   variables: [{ name, value, required }],
//   secrets: [{ name, required, credentialRef }],            // references only
//   webhookEndpoints: [{ url, events, signingCredentialRef? }], // active endpoints; no signing secret
//   schedules: [{ type, interval, payload }] }                 // enabled schedules

const plan = await target.configuration.import(document, { principal, dryRun: true, environment: 'production' });
const report = await target.configuration.import(document, { principal, overwrite: false });
// report.items: [{ kind, key, action: 'create'|'update'|'unchanged'|'conflict'|'missing'|'skip', reason?, applied, error? }]
// report.summary: { create, update, unchanged, conflict, missing, skip, failed }
// report.missingSecrets: [{ name, required, sourceCredentialRef }]
```

**Secret values never leave.** The document is built field by field from the
authorized reads: variables (non-secret by contract), credential binding names
and their `credential-ref:` references, endpoint URLs and events with their
signing credential *reference*, and schedule type, interval and payload. No
signing secret, custody value, or legacy raw value stored on an old binding is
read into it, and the tenant and record internals are left out.

**Import rules.**

| Kind | Target lacks it | Target matches | Target differs |
| --- | --- | --- | --- |
| Variable | `create` | `unchanged` | `conflict`; `update` with `overwrite` |
| Credential binding | `missing`, listed in `missingSecrets`; **never created** | `unchanged` (even with a different reference) | — |
| Webhook endpoint (by URL) | `create` with the exported signing reference | `unchanged` (same events) | `conflict`; with `overwrite`, a new endpoint is registered and the old one disabled |
| Schedule (by `type@interval`) | `create` | `unchanged` (same payload) | `conflict`; with `overwrite`, created and the old one cancelled |

A name used as a variable on one side and a binding on the other is a
`conflict`. An import never attaches a credential: a credential lives in an
environment's own custody, so `missingSecrets` lists what to attach with
`credential.attach` (the source reference is given only as a hint). An
endpoint's exported signing reference must name a credential the target's
custody can resolve, or its deliveries will be denied.

**Authorization and atomicity.** Export reads as `configuration.read`,
`webhooks.read` and `schedules.read`; import reads the same way, then writes
each item through its own capability (`configuration.write`,
`webhooks.register`, `webhooks.remove`, `schedules.create`, `schedules.cancel`),
as the importing principal. An import is not one transaction: a failed write
is reported on its item (`error`, counted in `summary.failed`) and the next
item is tried. Re-running an import is safe: applied items report `unchanged`.

**Versioning.** `formatVersion` is `1` (`CONFIGURATION_EXPORT_FORMAT_VERSION`).
An import refuses any other version, any other `format`, a `value`/`secret`/
`plaintext` field on a binding, a `secret`/`signingSecret` field on an endpoint,
and any reference that is not `credential-ref:<id>`. The document may be passed
as an object or a JSON string.

## Default HTTP port

There are two defaults, and they differ on purpose (both are tested in `tests/runtime-boundaries.test.ts`):

- **Generated** applications (`appport init`, `create-appport`) write `[http] port = 4100`, so they never collide with the Compute control plane, whose default is `8787`.
- The **parser** default, used when an `appport.toml` enables HTTP but omits `port`, remains `8787`. Changing it would silently move every existing application that relies on it. If you write the file by hand and run next to Compute, set `port` explicitly.
