# Contract-driven AppPort demo

This application contains business behavior only. `appport.toml` declares HTTP, CORS, state, tenancy, API keys, webhooks, jobs, events, authorization, observability, and lifecycle. AppPort materializes them.

```sh
npm install
# The operator is identified by your AuthBoundry module (exports { authorizer, identify }).
APPPORT_AUTHORITY=./operator-authority.mjs npx @appport/runtime api-key create --tenant development --name demo
npm run dev
```

The API key identifies the caller; it carries no scopes. What the caller may do
is decided by AuthBoundry (`src/authority.ts` is a development-only stand-in).

The application does not import Express, FeltDB, `node:http`, or `@appport/services`; it does not create a server, worker, SSE stream, persistence layer, or signal handler.
