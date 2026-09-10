# API Keys

## Secret format

Created secrets use a recognizable prefix plus a high-entropy secret:

```text
app_live_<public-prefix>_<secret>
```

The public prefix identifies the candidate credential record without exposing the secret material.

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

The secret is only returned once.

## Authentication flow

Authentication:

1. parses the public prefix from the presented secret
2. loads the candidate credential with `ApiKeyStore.find_by_prefix`
3. verifies the secret against the stored salted hash
4. rejects revoked credentials
5. rejects expired credentials
6. establishes tenant ownership from the credential
7. returns an authenticated machine principal
8. exposes granted scopes
9. records `last_used_at`

## Storage contract

`ApiKeyService` depends on `ApiKeyStore`:

- `create`
- `get`
- `find_by_prefix`
- `list`
- `revoke`
- `record_last_used`

No service-layer code reaches around this boundary.

## Audit boundary

`AuditSink` is the semantic audit boundary for:

- `api_key.created`
- `api_key.revoked`
- `api_key.authenticated`

Authentication metadata excludes raw credentials.
