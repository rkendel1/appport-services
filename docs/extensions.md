# Management extensions

A management extension lets another AppPort package add pages, navigation entries, JSON routes, and
the capabilities they need to an AppPort Services management host. The extension uses the host's
existing pieces and adds none of its own:

| The extension uses | Not |
|---|---|
| the host's `createServices` instance | a second Services instance |
| the host's FeltDB instance (`context.db`) | a database it opens |
| the host's authentication adapter (`authenticate`, `req.auth`) | its own sign-in or sessions |
| the host's `ServiceGateway`, so the host's AuthBoundry `ServiceAuthorizer` decides and `service_effect_evidence` records | a permission system of its own |
| the packaged Stack shell, navigation and `AppPort/ui/1` contribution | a separate UI shell |
| the host's process and lifecycle | hooks, sidecars, or a lifecycle of its own |

The mechanism is generic. Nothing in core Services names a particular extension.

## Registering

A host lists the extensions it trusts in code, the same way it lists its other dependencies:

```ts
import { createServices, createManagementRouter } from '@appport/services';
import { notesExtension } from 'some-package';

const services = createServices({ db, authorizer, extensions: [notesExtension] });
app.use(createManagementRouter({
  services,
  authority: services.gateway,
  extensions: services.extensions,
  authenticate,
}));
```

`createServices` validates every extension before anything opens and binds each one to this host's
`db` and `gateway`. The router mounts only the registrations `createServices` returned
(`services.extensions`), and only those bound to the gateway it is given. A hand-built
`{ extension, context }`, a copy of a registration, an extension that was never registered, or one
registered with another Services instance is refused.

There is no discovery, loading, or evaluation of code from configuration, the network, or the
database. This is not a plugin marketplace.

## Declaring an extension

```ts
import { defineServicesExtension } from '@appport/services';

export const notesExtension = defineServicesExtension({
  id: 'notes',
  capabilities: [
    { name: 'notes.read',  operation: 'listNotes',  effect: 'observation',   resource: 'note' },
    { name: 'notes.write', operation: 'createNote', effect: 'consequential', resource: 'note' },
  ],
  pages: [{
    id: 'notes', title: 'Notes', route: '/notes', order: 90,
    description: 'Notes for this tenant.',
    capabilities: ['notes.read', 'notes.write'],
    script: RENDERER, // the extension's own code, shipped in its package
  }],
  routes(router, { db, gateway, application }) {
    router.get('/', async (req, res, next) => { /* gateway.execute('notes.read', req.auth, …, () => db.collection(…).find(…)) */ });
  },
});
```

| Part | Contract |
|---|---|
| `id` | `[a-z][a-z0-9-]{1,30}`. It is the namespace of everything below. It may not be a built-in page or route name (`overview`, `services`, `api-keys`, `webhooks`, `jobs`, `schedules`, `notifications`, `files`, `configuration`, `intelligence`, `secrets`, `extensions`, `v1`, `_appport`), nor a built-in capability namespace (the first segment of any `SERVICE_CAPABILITY_MANIFEST` name, such as `apikeys` or `credential`). |
| `capabilities` | Each is named `<id>.<segment>[.<segment>…]` (for example `notes.read` or `notes.items.archive`), may not be a built-in capability name, and declares an `effect` (`observation` or `consequential`), an `operation`, and a `resource` type that no built-in capability uses (not `api_key`, `credential`, …), so a policy written for a built-in resource never covers an extension's. They join the gateway's manifest as `service: extension:<id>`, `invocable: false`. Extensions call `gateway.execute` / `gateway.authorize` from their own routes; they are not reachable through `invoke()`. |
| `routes(router, context)` | Mounted at `/v1/extensions/<id>` on the management router, after the host's authentication adapter and behind a guard: a request without a host identity is `401 UNAUTHENTICATED` and never reaches the extension's handlers, so `req.auth` is always the host's verified principal there. The routes share the router's body parser, rate limit and error mapping. `context` holds the host's `db`, `gateway`, and `application`. |
| `pages[]` | `id` is `<id>` or `<id>-<name>`, and not a built-in page id. `route` is `/<id>` or under it, and no other page (of this or another extension) uses it. Each page has a title, an `order` (built-in pages use 0–80), a non-empty description shown on the overview, and the **non-empty** list of declared capabilities it drives. |
| `pages[].script` | The renderer. It registers `window.AppPortServicesPages[<page id>] = (ui) => node`. `ui` holds the helpers the built-in pages use: `S` (Stack UI), `el`, `request`, `at`, `failureOf`, `config`. The script is included in a `<script>` element before the shared page script, and only on that page. It must be under 256 KiB and may not contain `</script`, `<script` or `<!--` (any case): the first ends its element, the others can stop its closing tag from ending it. |

`defineServicesExtension` reads each declared field once, checks that copy, and returns it frozen,
so a getter cannot pass the checks and hand over something else. It throws `ServicesExtensionError`
on the first violation. `createServices` also refuses two extensions with the same id, page id or page
route. `ServiceGateway` accepts extension capabilities only in the shape `extensionCapabilities()`
produces (`extension:<id>`, `<id>.<name>`, not invocable, authorization required).

## What the host enforces

- **Pages.** `GET <page.route>` authenticates the caller with the host adapter (no identity: `401`).
  It then authorizes **every** capability the page declares, through the gateway, for the caller's
  tenant. Any refusal is `403`. A page that only reads but has a form that writes therefore declares
  both, and a read-only caller does not get it. Viewing a page is not an effect: like the built-in
  `/api-keys` page, the gate asks AuthBoundry (`gateway.authorize`) and writes no evidence. The
  operations the page then performs are effects and are recorded.
- **Routes.** Each route authorizes its own capability through `gateway.execute`, with the resource
  it acts on; allows and denials are recorded as effect evidence like the built-in services'.
  (`gateway.authorize` alone decides without recording, as for pages.)
- **Restricted API keys.** A key's capability restrictions name built-in capabilities only, so a
  restricted key is refused every extension capability (it fails closed). An unrestricted key is
  decided by AuthBoundry as usual.
- **Request tenant.** The built-in routes refuse a body `tenantId` that differs from the caller's;
  extension routes get no such check and must take the tenant from `req.auth`, never from input.
- **Tenancy.** The principal's `tenantId` comes from the host. The example extension scopes every read
  and write by it, and a test proves another tenant sees nothing. The host cannot enforce row scoping
  inside an extension's own queries; that is the extension's responsibility, as it is for every
  built-in service.
- **Navigation and discovery.** Extension pages appear in the shell's navigation, on the overview,
  and as `AppPort/ui/1` surfaces with the capabilities they drive, from the same functions that
  build the built-in ones (`createUiContribution`, `createUiPages`, `createUiDiscoveryDocument`, which
  now accept `{ extensions }`).

## Without extensions nothing changes

With no extensions, `services.capabilities` is the same `SERVICE_CAPABILITY_MANIFEST` object. The UI
contribution equals `APPPORT_UI_CONTRIBUTIONS[0]`, `/v1/extensions/*` is `404`, and the gateway refuses
undeclared names. With extensions, the built-in surfaces and manifest entries are unchanged; the
extension's are appended after them. `tests/extensions.test.ts` asserts each of these.

## What the extension mechanism deliberately does not do

- **No lifecycle hooks.** The needs seen so far are request-scoped. A
  background worker or migration hook would be added only when an extension demonstrably needs one.
- **No per-extension collection namespace enforcement.** Extensions share the host's FeltDB instance
  and must prefix their collections (the example uses `ext_notes`; a package with existing state keeps its prefix, e.g.
  `resolver_*`). Under a composed FeltDB state contract, an extension's collections must be declared
  like any other.
- **No Content-Security-Policy changes.** Pages are served with inline scripts, as the built-in pages
  are. An extension script is trusted code from a package the host chose to install, with the same
  trust as the host's other dependencies.
- **No caller-specific navigation.** As with the built-in pages, navigation lists every mounted page,
  and each page authorizes its own caller.

## Evidence

| Requirement | Test |
|---|---|
| Registers a page | `tests/extensions.test.ts` "1-2"; `tests/browser/extension-page.browser.ts` |
| Host displays its navigation entry | `tests/extensions.test.ts` "1-2" (page config, UI contribution); browser test (rendered shell navigation, `aria-current`) |
| Host enforces its declared permissions | `tests/extensions.test.ts` "3" (page needs all capabilities: 403 for read-only and no-grant callers, 401 without identity, no evidence for a page view; routes enforce their own; a refused write is recorded); "extension routes never run without a host identity" |
| Uses host FeltDB and identity | `tests/extensions.test.ts` "4" (`context.db === host db`, `context.gateway === services.gateway`, `createdBy` from the host adapter, tenant isolation, allow evidence); browser test (write from the page lands in the host db as the host identity) |
| Installed and removed without changing core pages | `tests/extensions.test.ts` "5-6" (built-in surfaces and manifest prefix identical with and without) |
| Unchanged with no extensions | `tests/extensions.test.ts` "5-6" (same manifest object, same contribution, 404s, gateway refuses `notes.read`) |
| Declarations are checked; only real registrations are mounted | `tests/extensions.test.ts`: "declarations are checked", "declarations cannot take built-in namespaces…", "an extension bound to another Services instance is refused", "the router mounts only registrations createServices made", "the gateway takes extension capabilities only in the shape…"; browser test (a page id that is an `Object.prototype` name renders) |

The example extension (`tests/support/notes-extension.ts`) is internal to the test suite and is not
part of the published package.

## Consumers

The first planned consumer is AppPort Resolver. Its compatibility findings, the authorization and
custody decisions, and the PR plan live in the Resolver repository
(`docs/services-extension-integration.md`), not here: this mechanism has no consumer-specific code
or documentation.
