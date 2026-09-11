# AppPort Runtime

The public, contract-driven entry point for AppPort applications.

```sh
npm install @appport/runtime
npx @appport/runtime init
```

`init` interactively selects capabilities and generates both a complete `appport.toml` application contract and the authoritative `feltdb.flow`. Use `--use api,jobs,webhooks` only for non-interactive automation.

```js
import { appport } from '@appport/runtime';

const app = await appport();
await app.api.keys.createApiKey(/* ... */);
```

`appport()` compiles the contract once and materializes HTTP, state, tenancy, events, API keys, webhooks, jobs, observability, and lifecycle. The runtime installs its CLI and capability implementation transitively.
