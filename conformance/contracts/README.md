# Contract conformance corpora

These are the deterministic contracts `@appport/services` owns, pinned to this package as their
reference implementation. Other implementations run the same inputs to show that they implement the
contracts. They are test assets only and are not published with the package.

The format, review rules and consumer contract are the same as in the protocol repository's
`conformance/contracts/README.md` (`rkendel1/appport`).

| Corpus | Version | Contract | Reference |
|---|---|---|---|
| `webhook-signature-1` | 1.0.0 | Outbound `X-AppPort-Signature` = hex(HMAC-SHA256(secret, body)); inbound `x-appport-signature` = hex(HMAC-SHA256(secret, `${x-appport-timestamp}.${rawBody}`)). Secrets cover both sides of the 64-byte HMAC block boundary. | `src/webhooks/secrets.ts` |
| `api-key-restrictions-1` | 1.0.0 | API-key restriction validation and canonical form; default-deny `permit`; `within` (a managing key cannot mint a broader key) | `src/api-keys/restrictions.ts` |
| `services-manifest-1` | 1.0.0 | `SERVICE_CAPABILITY_MANIFEST`, `serviceCapabilityManifestDigest()`, `LEGACY_SCOPE_MIGRATION` | `src/authority/manifest.ts` |

**Determinism:** results are serialized with object keys in code-unit order. The stored canonical form
orders attribute keys with `localeCompare`, which is not part of any decision. The manifest digest was
checked under the C, en_US, tr_TR, sv_SE and ja_JP locales and is identical in each.

```sh
npm run build
node conformance/contracts/tools/bless.mjs <corpus> --check
node conformance/contracts/tools/bless.mjs <corpus> --write --accept=<id,...> --reason="..."
node conformance/contracts/tools/make-cases.mjs   # regenerates the restriction and manifest cases.json
```

`tests/conformance-corpus.test.ts` runs every corpus in `npm test`.

**Consumers today:** none outside this package. AuthBoundry's Rust `crates/services` re-implementation
of webhook signing is not on any execution path, and it fails `webhook-signature-1` on 14 of 18 cases.
AuthBoundry reaches these contracts only through this package (its Node bridge).
