# API Keys

## Secret model

API keys use a recognizable public prefix and a high-entropy secret:

```text
app_live_<public-prefix>_<secret>
```

The prefix is stored separately so authentication can locate the candidate credential without scanning raw secrets.

## Lifecycle

Supported operations:

- create
- list
- get
- revoke
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
7. derive tenant ownership from the credential
8. update `lastUsedAt` with FeltDB version-checked state
9. return an `AuthenticatedPrincipal`

## Durable audit model

Custom audit records are stored durably in FeltDB with event types:

- `api_key.created`
- `api_key.revoked`
- `api_key.authenticated`

Audit records exclude raw secrets, presented credential values, and Authorization headers.
