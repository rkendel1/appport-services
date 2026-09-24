# API Keys

An API key **identifies** a caller and its application. It does not decide what
the caller may do: AuthBoundry authorizes every capability (see
[AUTHORITY.md](./AUTHORITY.md)). Keys carry no scopes; `scopes` on creation and
`api.keys.scopes` in `appport.toml` are rejected with a migration error.

## Secret model

API keys use a recognizable public prefix and a high-entropy secret:

```text
app_live_<public-prefix>_<secret>
```

The prefix is stored separately so authentication can locate the candidate credential without scanning raw secrets.

## Lifecycle

Supported operations:

- create (`apikeys.create`, requires a verified caller)
- list / get (observation; `apikeys.read` through `invoke`)
- revoke (`apikeys.revoke`, requires a verified caller)
- authenticate

Creation returns:

- `id`
- `name`
- `prefix`
- `secret`

The secret is not returned again.

## Authentication flow

1. parse the public prefix from the presented credential
2. load the authoritative prefix record from FeltDB
3. load the corresponding API-key record
4. verify the secret hash with constant-time comparison
5. reject revoked keys
6. reject expired keys
7. reject keys bound to a different application (and legacy keys bound to none)
8. derive tenant and application ownership from the credential
9. update `lastUsedAt` with FeltDB version-checked state
10. return a verified `AuthenticatedPrincipal` (identity only, no scopes)

## Durable audit model

Custom audit records are stored durably in FeltDB with event types:

- `api_key.created`
- `api_key.revoked`
- `api_key.authenticated`

Audit records exclude raw secrets, presented credential values, and Authorization headers.
