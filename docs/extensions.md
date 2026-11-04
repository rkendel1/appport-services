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
`db` and `gateway`. The router mounts only extensions bound to the gateway it is given. An extension
registered with another Services instance is refused with `another Services instance`.

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
| `id` | `[a-z][a-z0-9-]{1,30}`. It is the namespace of everything below. It may not be a built-in page or route name: `overview`, `services`, `api-keys`, `webhooks`, `jobs`, `schedules`, `notifications`, `files`, `configuration`, `intelligence`, `secrets`, `extensions`, `v1`, `_appport`. |
| `capabilities` | Each is named `<id>.<segment>[.<segment>…]` (for example `notes.read` or `resolver.keys.create`), may not be a built-in capability name, and declares an `effect` (`observation` or `consequential`), an `operation`, and a `resource` type. They join the gateway's manifest as `service: extension:<id>`, `invocable: false`. Extensions call `gateway.execute` / `gateway.authorize` from their own routes; they are not reachable through `invoke()`. |
| `routes(router, context)` | Mounted at `/v1/extensions/<id>` on the management router, after the host's authentication middleware, so `req.auth` is the host's verified principal. `context` holds the host's `db`, `gateway`, and `application`. |
| `pages[]` | `id` is `<id>` or `<id>-<name>`. `route` is `/<id>` or under it. Each page has a title, an `order` (built-in pages use 0–80), a description shown on the overview, and the **non-empty** list of declared capabilities it drives. |
| `pages[].script` | The renderer. It registers `window.AppPortServicesPages[<page id>] = (ui) => node`. `ui` holds the helpers the built-in pages use: `S` (Stack UI), `el`, `request`, `at`, `failureOf`, `config`. The script is included in a `<script>` element before the shared page script, and only on that page. It must be under 256 KiB and may not contain `</script`. |

`defineServicesExtension` throws `ServicesExtensionError` on the first violation and returns the
declaration frozen. `createServices` also refuses two extensions with the same id or page id.

## What the host enforces

- **Pages.** `GET <page.route>` authenticates the caller with the host adapter (no identity: `401`).
  It then authorizes **every** capability the page declares, through the gateway, for the caller's
  tenant. Any refusal is `403`, and the refusal is recorded in `service_effect_evidence`. A page that
  only reads but has a form that writes therefore declares both, and a read-only caller does not get it.
- **Routes.** Each route authorizes its own capability through `gateway.execute` or
  `gateway.authorize`, with the resource it acts on. Allows and denials are recorded as effect
  evidence like the built-in services'.
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

- **No lifecycle hooks.** The example and Resolver's management needs are request-scoped. A
  background worker or migration hook would be added only when an extension demonstrably needs one.
- **No per-extension collection namespace enforcement.** Extensions share the host's FeltDB instance
  and must prefix their collections (the example uses `ext_notes`, Resolver already uses
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
| Host enforces its declared permissions | `tests/extensions.test.ts` "3" (page needs all capabilities: 403 for read-only and no-grant callers, 401 without identity; routes enforce their own; refusal evidence recorded) |
| Uses host FeltDB and identity | `tests/extensions.test.ts` "4" (`context.db === host db`, `context.gateway === services.gateway`, `createdBy` from the host adapter, tenant isolation, allow evidence); browser test (write from the page lands in the host db as the host identity) |
| Installed and removed without changing core pages | `tests/extensions.test.ts` "5-6" (built-in surfaces and manifest prefix identical with and without) |
| Unchanged with no extensions | `tests/extensions.test.ts` "5-6" (same manifest object, same contribution, 404s, gateway refuses `notes.read`) |
| Declarations are checked; foreign gateways refused | `tests/extensions.test.ts` (last two tests) |

The example extension (`tests/support/notes-extension.ts`) is internal to the test suite and is not
part of the published package.

## Resolver compatibility

Checked against `appport-resolver` at `01a3e35` (`packages/server`, `packages/core`). Nothing below
has been implemented in Resolver.

### Fits the contract as is

- **Capability names.** Resolver's capabilities are already `resolver.*` (`resolver.resolve`,
  `resolver.put`, `resolver.history`, `resolver.rollback`, `resolver.revoke`, `resolver.list`,
  `resolver.watch`, `resolver.grant`, `resolver.ungrant`, `resolver.grants`, `resolver.keys.create`,
  `resolver.keys.revoke`, `resolver.keys.list`). Every one is a valid extension capability for id
  `resolver` and collides with no built-in.
- **Collections.** Resolver's state is in `resolver_*` collections, which is the prefixing the
  extension contract expects.
- **Page model.** Resolver's pages already have the extension page's shape: `PAGES` in
  `src/ui/contribution.ts` has `id`, `title`, `route`, `order`, `description`, and `capabilities`.
- **Fine-grained grants have a carrier.** Resolver grants are per reference pattern (`ref://…/*`).
  `ServiceResource` already has `id` and `attributes`, so a route can authorize
  `resolver.put` on `{ type: 'reference', tenantId, id: 'ref://…' }` and the host's AuthBoundry policy
  can decide by pattern.

### Pages that port

| Resolver page today | As an extension page | Notes |
|---|---|---|
| `overview` `/resolver` | `resolver` `/resolver` | Needs a capability (pages must declare one). Use `resolver.list`. |
| `references` `/references` | `resolver-references` `/resolver/references` | All six capabilities it drives are already listed. |
| `models` `/models` | `resolver-models` `/resolver/models` | Uses `/_resolver/catalog`, which reads `INTELLIGENCE_CATALOG` from `@appport/services`. In a host this is the host's own catalog, so it aligns. |
| `secrets` `/secrets` | `resolver-secrets` `/resolver/secrets` | The current route **collides** with the Services `/secrets` page. Namespacing forces `/resolver/secrets`, which keeps the two distinct. |
| `access` `/access` | not ported as is | It manages Resolver API keys and grants, which duplicates host identity and the host's authorization. In a host, API keys are the host's `/api-keys` page and grants are host AuthBoundry policy. See below. |

### What needs alignment

1. **Second Services instance.** `createResolverRuntime` calls `createServices({ application:
   'resolver', … })` (`src/runtime.ts`). Services collections (`api_keys` and the rest) are not
   prefixed by application, so on a shared FeltDB this collides with the host's. As an extension,
   Resolver must take `context.db` and `context.gateway` and not create Services. The standalone
   Resolver server keeps its own `createServices`, because it *is* the host there.
2. **Second authorization layer.** Resolver's `authorizer.ts` answers both the Services gateway and
   its own operations (`decide`) from `resolver_grants`, with a `resolver-operator` principal type
   that bypasses grants. As an extension, every Resolver operation should go through
   `gateway.execute(capability, principal, { type: 'reference', tenantId, id: ref }, …)`, so the host's
   authorizer decides and the effect is recorded. Resolver's grant store either becomes a
   `ServiceAuthorizer` the host composes into its own policy (an adapter Resolver ships, which the host
   chooses to use), or stays standalone-only. Core Services does not change for either option.
3. **Second identity layer.** The management router accepts the host adapter, `Bearer` API keys, and
   its own cookie sessions (`/_resolver/session`). As an extension only the host adapter applies
   (`req.auth`). Bearer and session handling stays in the standalone server.
4. **Routes.** The JSON API moves from `/_resolver/*` to `/v1/extensions/resolver/*`. The page script
   (`ui/management.js`, 880 lines, about 20 `request('/_resolver/…')` calls) would need to take its base path
   from one constant, register its renderers on `window.AppPortServicesPages`, and use the `ui` helpers
   in place of its own copies.
5. **Dependency versions.** Resolver pins `@appport/services` 0.9.1, `@feltdb/core` 0.18.0, and a
   vendored Stack UI 0.3.0. The host shell is Services 0.14 with Stack UI 0.6.1. An extension must be
   built against the host's Services major/minor (it is a peer dependency, not a dependency). Its
   renderers must use Stack UI 0.6.1 components through `ui.S`, and the vendored 0.3.0 copy is not
   loaded on an extension page.
6. **Versioned custody.** Resolver needs a `SecretCustody` with versions (`isVersionedCustody`) for
   revision-consistent `revealSecret`. The Services `SecretCustody` contract has no version, and a host
   (for example FeltKit's `HostCredentials`) may not provide one. The extension context should not
   gain a custody field until this is settled. Resolver should take a versioned custody as its own
   extension option, and refuse to register secret pages and routes when it is absent. It should not
   fall back to unversioned custody silently.

### How shared Resolver deployments expose their UI

The accepted direction (resolver#5) is one shared Resolver per operator domain. In that shape the
Resolver server is the **host**, and its UI is a Services management host whose `extensions`
include the Resolver extension. The standalone server is then a host with exactly one extension.
Applications that consume a shared Resolver use the client (`@appport/resolver-client`) and do not
mount Resolver's pages. Mounting the Resolver extension in every application's own host
(embedded-per-app) is possible with this mechanism but is not recommended now, per the owner's
direction not to rush it. It would also put custody and grants in each application.

## Resolver integration follow-up plan

Each step is a separate PR. None of them publishes a package or changes a production deployment.

1. **Services: release the extension API.** This change, after review, in the next Services minor.
   Publication waits for the owner.
2. **Resolver: extract `resolverExtension(options)`** in `packages/server`, with `options.custody`
   (versioned, required for secret routes). It takes `context.db` and `context.gateway`, declares the 13
   `resolver.*` capabilities, mounts the JSON routes under `/v1/extensions/resolver`, and authorizes
   each route through the gateway with `{ type: 'reference', id: ref }`. It contains no
   `createServices` and no sessions. Tests: the six properties above, against a Services host.
3. **Resolver: grants as a `ServiceAuthorizer`.** Ship the grant policy as an adapter a host can
   compose into its AuthBoundry authorizer, keyed on `resource.id` patterns, so a host can keep
   Resolver's pattern grants without a second decision point. Prove that a revoked grant denies on the
   next request through the gateway (the existing revocation guarantee).
4. **Resolver: port the renderers** for references, models, and secrets to
   `window.AppPortServicesPages` on Stack UI 0.6.1, through the shared helpers. Access is replaced by the
   host's API-key page plus a grants page that uses step 3's policy store.
5. **Resolver: standalone server becomes a host** of its own extension. Bearer and session auth stay
   there. The existing standalone behavior and its tests must remain green.
6. **Dependency alignment.** Move Resolver to `@appport/services` as a peer dependency at the
   released minor, and to the host's `@feltdb/core` range.

Open decisions for the owner: whether Resolver's pattern grants become host AuthBoundry policy (step 3)
or stay standalone-only; and whether versioned custody becomes a Services contract or remains a
Resolver extension option (alignment item 6).
