# Webhook security

Webhooks are consequential effects in both directions. The rule from
[AUTHORITY.md](./AUTHORITY.md) applies: **@appport/services executes effects.
It does not decide who is allowed to cause them.**

## Outbound delivery

```
emit (verified principal)  →  AuthBoundry: webhooks.emit
        ↓ durable delivery record carries the emitting principal and the emit decision id
attest the delivery principal against allow-evidence for that decision
deliver attempt            →  AuthBoundry: webhooks.deliver (every attempt)
        ↓ allowed
re-validate bound destination (DNS resolved, every address checked)
        ↓
resolve signing credential through AuthBoundry custody (authorizationRef = decision id)
        ↓
POST to the validated address only; redirects are not followed
        ↓
evidence
```

### Destination binding

- A destination is fixed when the endpoint is registered
  (`webhooks.register`), together with its `signingCredentialRef`. AuthBoundry
  sees both as resource attributes (`destination`, `credentialRef`).
- `emitWebhookEvent` rejects `url`, `destination`, `endpointId`,
  `endpointIds`, `signingCredentialRef`, and `credentialRef`. Callers choose
  an event, never a destination or a credential.
- Delivery uses only the stored endpoint URL and its bound credential
  reference.

### SSRF / private destination policy

`validateDestination` rejects the following:

- schemes other than `http` and `https`, and URLs that embed credentials
- the hostnames `localhost`, `*.localhost`, `*.internal`, `metadata`,
  `metadata.google.internal`, `metadata.goog`, and `instance-data`
- any destination whose **resolved** address is in one of these ranges:
  - loopback (`127/8`, `::1`)
  - private (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`)
  - carrier-grade NAT (`100.64/10`, which covers the Alibaba metadata address)
  - link-local (`169.254/16`, which covers `169.254.169.254`; `fe80::/10`)
  - unspecified (`0.0.0.0/8`, `::`)
  - documentation and benchmarking ranges
  - multicast and reserved ranges
  - IPv4-mapped and NAT64 IPv6 forms of any of the above

Every resolved address must pass, not just the first. The hostname is
resolved again before **each** delivery attempt, and the connection is
pinned to the address that passed, so DNS rebinding cannot redirect a
delivery. This check does not rely on string matching alone.

`allowPrivateNetworks` exists only as a constructor option for trusted host
code (local development and tests). It cannot be set from `appport.toml` or
from any request.

### Redirects

Redirects are **disabled**. A `3xx` response is a terminal `PROVIDER_ERROR`
("redirects are not followed"), and the `Location` header is never
contacted. A delivery authorized for `https://customer.example.com` cannot
turn into a request to `http://127.0.0.1`.

### Failure handling

| Outcome | Delivery status |
| --- | --- |
| `DENIED` (no grant, revoked or cross-tenant credential, anonymous delivery) | `failed`; provider never called |
| `AUTHORITY_UNAVAILABLE` / `AUTHORIZATION_TIMEOUT` | `retrying`; no attempt consumed; provider never called |
| `INVALID_REQUEST` (destination now forbidden, endpoint has no credential ref) | `failed`; provider never called |
| `PROVIDER_ERROR` 5xx / 408 / 429 / network | `retrying` with backoff, until the retry limit is reached |
| `PROVIDER_ERROR` other 3xx and 4xx | `failed` |

## Inbound webhooks

The webhook is not the principal. The **integration** is.

```
Webhook
   ↓
resolve durable integration (id in the route; never from the payload)
   ↓
integration principal  integration:<provider>
   ↓
AuthBoundry: webhooks.receive
   ↓
resolve signing credential through AuthBoundry custody
   ↓
verify signature (HMAC-SHA256 over "<timestamp>.<raw body>", constant time)
   ↓
durable replay check (FeltDB)
   ↓
handler runs as the integration principal; every effect it causes → AuthBoundry
```

- Register a source with
  `webhooks.registerIntegration({ provider, signingCredentialRef }, principal)`
  (capability `webhooks.integrations.register`).
- Route handlers with `appport({ inbound: { stripe: handler } })` or
  `webhooks.registerInboundHandler('stripe', handler)`. The HTTP runtime
  accepts `POST /_appport/webhooks/inbound/:integrationId`.
- These required headers are verified together: `x-appport-event-id`,
  `x-appport-timestamp` (within ±5 minutes), and `x-appport-signature`.
- The payload cannot choose the principal, the tenant, or the credential.
  Fields such as `principal`, `actor`, `tenantId`, or
  `signingCredentialRef` in the body are plain data.

### Durable replay protection

Accepted events are stored in the FeltDB collection `inbound_webhook_events`,
keyed by `sha256(integrationId:eventId)`, using a `requireAbsent` insert.
A second delivery of the same event is `DENIED`, including after a process
restart. No other database is involved. Delivery is at most once: if a
handler fails after acceptance, the event is not processed again.
