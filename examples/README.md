# Examples

Use `createApiKeyService(...)` with FeltDB deployment options and then call `createApiKey`, `listApiKeys`, `getApiKey`, `revokeApiKey`, or `authenticateApiKey` from application code.

## feedback-store

`feedback-store/example.mjs`: an AppPort SDK feedback provider backed by `FeltDbFeedbackStore`, through a provider
restart. Run from the repository root after `npm run build`. Executed by `tests/feedback-example.test.ts`.
