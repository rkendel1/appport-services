# Intelligence configuration

`@appport/services` is the one canonical authority for which model service an
application uses: **provider, model, endpoint, credential**. Applications, their setup
screens (FeltKit Studio → Models) and the model executor all read and write this same
configuration through AppPort. None of them keeps its own copy.

```
   FeltKit Studio → Models / `feltkit model set` / other setup UIs
          |
           AppPort capability   (services.invoke / intelligence.*)
                   |
          @appport/services     validates configuration, never calls a model
                   |
                FeltDB          durable state (existing configuration collections)
                   |
        provider/model/endpoint/credential-ref   (intelligence.resolve, runtime-internal)
                   |
       FeltKit ModelHost        executes the model call: decisions, and generation
                   |            (streamed, with tool calls), inside custody's withSecret
             Model provider
```

| Owner | Responsibility |
| --- | --- |
| `@appport/services` | owns and validates provider/model configuration; holds credential references, never runs a model |
| FeltDB | owns durable state, including the records of every model decision and generation |
| AppPort | owns capability transport; a model's tool calls are AppPort capability invocations |
| FeltKit (`ModelHost`) | executes configured model/provider calls and orchestrates agent work in an application (proposals, approvals, execution as the owner) |
| Resolver | owns runtime references: when an application names `ref://…`, the model and its credential come from Resolver, validated against this catalog |
| AuthBoundry | owns authority: every Services capability call is authorized there |

**Provider credentials are Services configuration (a `credential-ref`), never application or
executor state.** The executor uses the material only inside custody's `withSecret` callback for
one call; it is not written to FeltDB, records, logs or errors. Services performs no inference
and has no provider SDK. Intelligence is optional: with nothing configured, `intelligence.read`
returns `{ configured: false }` and the rest of the platform is unaffected.

There is no separate model-execution service: an earlier version of this page named one ("FX"),
together with separate agent-behavior and governance components. Model execution and agent
orchestration are FeltKit's (`docs/GENERATION.md`, `docs/AGENT-OPERATIONS.md` in
`@feltdb/feltkit`); human approval is FeltKit's action lifecycle, authorized through AuthBoundry.

## Catalog is not configuration

`intelligence.catalog` returns discovery metadata (OpenAI, Anthropic, OpenCode,
Ollama, Custom OpenAI-compatible; their models, known endpoints and credential
requirement). It is static code and is never persisted. The durable configuration is
only the selected identifiers. A model id is a provider-defined string: providers marked
`modelSelection: "free"` accept any id (the listed models are suggestions); providers marked
`"catalog"` reject ids they do not list.

## Capabilities

Declared in the service capability manifest and reached through `services.invoke(...)`
with a verified principal. Every call is authorized by AuthBoundry; there is no
`/api/providers` or `/api/models` route.

| Capability | Effect |
| --- | --- |
| `intelligence.catalog` | list providers, models, endpoints |
| `intelligence.read` | current configuration (no credential) |
| `intelligence.write` | set `{ provider, model, endpoint?, credentialRef? }` |
| `intelligence.credential.set` | replace the credential reference |
| `intelligence.credential.remove` | remove the credential (only where optional) |
| `intelligence.resolve` | runtime-internal (not invocable); `provider, protocol, model, endpoint, credentialRef` for the executor (FeltKit's ModelHost) |

`endpoint` is omitted/`"default"` for the provider's standard endpoint, or a URL for providers
that allow one (`ollama`, `opencode`, `custom`), e.g. `http://localhost:11434/v1`. URLs must be
http(s), carry no userinfo, query or fragment, and plain `http` is limited to loopback and
private-network hosts.

## Credentials

Like all service configuration, a credential is a `credential-ref:<id>` into AuthBoundry
custody. Raw key material is rejected with a migration error and is never stored or logged.
Reads return `credentialConfigured: true|false` and never the credential or its reference.
Replacing a credential does not read the previous one. A credential is bound to the provider
and endpoint it was configured for: changing either without supplying a new `credentialRef`
detaches the old one, so a key is never silently sent to a host the user did not choose.

## Storage

No new collection. The selection is the configuration variable `INTELLIGENCE_CONFIG` (JSON) and the
credential is the configuration secret binding `INTELLIGENCE_CREDENTIAL`, scoped by tenant,
application and environment (default `production`) like all configuration. Changes are audited
without secret material.
