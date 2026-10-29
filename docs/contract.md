# The services' FeltDB contract

An application-scoped FeltDB authority (Managed FeltDB) stores only the collections and
fields its promoted contract declares: a record with an undeclared field, a value of the
wrong type, or a `null` where the field is not nullable is refused. To run services there,
a host declares what the services store next to its own collections. This package owns
those declarations; a host composes them and never lists the services' collections itself.

```ts
import { servicesContract } from '@appport/services';

const services = servicesContract(['files', 'notifications', 'jobs', 'schedules']);
const contract = {
  collections: [...myCollections, ...services.collections],
  indexes: [...myIndexes, ...services.indexes],
  policies: myPolicies, // the host's decision, as for its own collections
};
```

| Export | What it is |
| --- | --- |
| `servicesContract(names \| 'all')` | The entries for the named services and the services they need: every collection they store, each once, in name order. The same set of names always yields the same fragment, in any order; no names yields none; an unknown name is refused. |
| `SERVICE_COLLECTIONS` | Every collection the services store, by name, declared once: each field's FeltDB type, `required`, `nullable`. |
| `SERVICE_REQUIREMENTS` | Per service: the collections it stores and the services it needs. |
| `SERVICE_NAMES`, `ServiceName` | `files`, `notifications`, `configuration`, `apiKeys`, `webhooks`, `jobs`, `schedules`, `intelligence`. |
| `SERVICES_CONTRACT_VERSION` | Bumped when a declaration changes in a way a promoted contract must follow. |

What a service stores:

| Service | Collections | Needs |
| --- | --- | --- |
| every service | `service_effect_evidence` (the gateway's evidence for each effect) | |
| `files` | `files`, `file_audit_events` | |
| `notifications` | `notifications`, `notification_deliveries`, `notification_audit_events` | |
| `configuration` | `ConfigurationVariables`, `ConfigurationSecrets`, `ConfigurationAuditEvents`, `Secrets`, `SecretVersions`, `SecretAuditEvents` (value-free credential metadata from `credential.store`) | |
| `apiKeys` | `api_keys`, `api_key_prefixes`, `api_key_audit_events` | |
| `webhooks` | `webhook_endpoints`, `webhook_deliveries`, `webhook_audit_events`, `webhook_integrations`, `inbound_webhook_events` | |
| `jobs` | `jobs`, `job_audit_events` | |
| `schedules` | `job_schedules` | `jobs` |
| `intelligence` | `ConfigurationVariables`, `ConfigurationSecrets`, `ConfigurationAuditEvents` (its selection is configuration) | |

Conventions, as FeltDB's own agent-state entries (`FELTDB_AGENT_STATE_CONTRACT`): `id` is
required text; every other field is nullable and optional; `integer` where a service only
writes counts or versions; objects and arrays are `json`. `__version` is FeltDB's record
identity and is not declared. The services declare no indexes.

## How it is kept true

`tests/services-contract.test.ts`:

- drives every write path of each service through its public API (`invoke`, job execution,
  webhook delivery and receipt, API-key authentication, schedule processing) on a fresh
  FeltDB instance, reads every committed record from FeltDB's operation journal, and
  requires each collection and field to be declared for that service, with a value FeltDB
  would accept for the declared type, and every declared collection to be written;
- reads the TypeScript type of the record each store writes (`tests/support/stored-records.ts`)
  and requires the declared fields to be exactly its properties, with consistent types and
  nullability, so a field cannot be added to a stored record without a declaration;
- checks composition is deterministic and that the fragment is frozen.

Compatibility: additive. Nothing about how services store records changed; a host that
does not compose the fragment behaves exactly as before.
