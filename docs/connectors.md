# Outbound HTTP connectors

`services.connectors` (`ConnectorService`) is outbound HTTP through the gateway, for integrations a
host would otherwise build itself (TURN credentials, speech to text, calendars).

```ts
const services = createServices({
  authorizer, credentials,
  connectors: [
    { id: 'turn', baseUrl: 'https://turn.example.com/api/', credentialRef: 'credential-ref:turn', allowedMethods: ['POST'] },
    { id: 'calendar', baseUrl: 'https://www.googleapis.com/calendar/v3/', credentialRef: 'credential-ref:calendar' },
    { id: 'stt', baseUrl: 'https://api.example.com', credentialRef: 'credential-ref:stt', auth: { type: 'header', name: 'xi-api-key' } },
  ],
});
const response = await services.connectors.request({ connector: 'turn', method: 'POST', path: 'credentials', json: { ttl: 3600 } }, principal);
// { connector, status, ok, headers, body, json? }
```

- **Definitions are trusted host code**: `id`, `baseUrl`, `allowedHosts` (exact names; default the base
  URL's host), `allowedMethods`, `credentialRef` (a reference, never a secret), `auth`
  (`bearer` default, `header`, `basic`, `query`), fixed non-secret `headers`, `timeoutMs`,
  `maxResponseBytes`.
- **`connectors.request`** is authorized per request with attributes `connector`, `method`, `host`,
  `path`, `credentialRef`; `connectors.read` lists definitions without secrets.
- **Refused before sending:** an unknown connector (`NOT_FOUND`), a host outside the allowlist
  (`DENIED`, `host_not_allowed`), a method not allowed, and caller headers that carry credentials
  (`Authorization`, `Cookie`, `X-Api-Key`, names containing token/secret/password/api-key/credential).
- **Sending:** the destination is validated (no private, loopback, link-local or metadata address unless
  the host sets `outboundDestinationPolicy: { allowPrivateNetworks: true }`), the connection is pinned to
  the validated address, redirects are returned, never followed, and `set-cookie` is dropped.
- **Evidence:** `service: "connectors"`, `provider: <connector id>`, the `credentialRef`, and the caller's
  `requestId` when given. The credential is resolved from custody for that request only.

`sendOutboundRequest` (the same client) is exported for hosts writing their own adapters inside an effect.
