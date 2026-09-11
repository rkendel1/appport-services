# AppPort Runtime

The public, contract-driven entry point for AppPort applications.

```sh
npm install @appport/runtime
npx appport init --use api,webhooks,jobs
```

```js
import { appport } from '@appport/runtime';

const app = await appport();
await app.api.keys.createApiKey(/* ... */);
```

`appport()` reads `appport.toml` and initializes only its declared capabilities. The runtime installs its CLI and capability implementation transitively.
