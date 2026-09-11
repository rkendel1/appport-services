# Contract-driven AppPort demo

This application contains business behavior only. `appport.toml` declares HTTP, CORS, state, tenancy, API keys, webhooks, jobs, events, authorization, observability, and lifecycle. AppPort materializes them.

```sh
npm install
npx @appport/runtime api-key create --tenant development --name demo --scope invoices.write --created-by developer
npm run dev
```

The application does not import Express, FeltDB, `node:http`, or `@appport/services`; it does not create a server, worker, SSE stream, persistence layer, or signal handler.
