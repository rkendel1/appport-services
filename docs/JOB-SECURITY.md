# Job security

Jobs are consequential effects. **A scheduled or background job never runs
as anonymous process authority**, and the worker process is never the
authority. See [AUTHORITY.md](./AUTHORITY.md).

## Durable execution identity

```
Job
├── application
├── principal        (captured from the authorized enqueue)
├── delegation       (optional AuthBoundry delegation id)
├── capability       (jobs.execute, plus whatever the handler invokes)
├── resource         (job id, jobType)
└── run              (<jobId>:<attempt>)
```

Example:

```
job:quote-followup
      ↓
principal: quote-agent
      ↓
run: run_123
      ↓
notifications.send
      ↓
AuthBoundry
```

- `jobs.enqueue(input, principal)` requires `jobs.create`. The job record
  durably stores the verified principal (id, type, tenant, application,
  credential id) and the optional `delegationId`. Input cannot set the
  principal; a `principal` field is rejected.
- `jobs.scheduleRecurring(input, principal)` requires `schedules.create`.
  Every job the schedule creates inherits the schedule's durable principal.
- `tx.queueJob(input, context)` requires a single-use `jobs.create` context
  from `services.authorize(...)`.
- The durable principal records `authorizedBy`, the decision id of the
  authorized enqueue or schedule creation. Execution requires matching
  allow-evidence in FeltDB. Job metadata written directly to storage
  (including a real decision id copied onto a different principal) is
  therefore not identity. The public transaction and state APIs refuse
  service-owned collections such as `jobs`.
- `delegationId` is sent to AuthBoundry as a resource attribute on
  `jobs.create` and `schedules.create`, so a caller cannot attach a
  delegation that is not theirs.

## Authorization on every run

```
load job
    ↓
restore durable principal (verifiedBy: 'job', delegationId, runId)
    ↓
AuthBoundry: jobs.execute   (context.delegation_id, context.run_id)
    ↓ allowed
handler(job, { principal, context, runId })
    ↓ each effect the handler causes
invoke(capability, input, { principal })  →  AuthBoundry again
```

A job is never authorized once and trusted afterwards. There is no
in-memory cache of grants, decisions, or delegation status. Each run, and
each effect inside a run, is a fresh AuthBoundry decision.

| Situation | Result |
| --- | --- |
| Job has no durable principal (legacy or anonymous record) | `failed` with `DENIED: anonymous job execution…`; the handler never runs |
| Durable principal not attested by allow-evidence | `failed` with `DENIED: Durable principal…`; the handler never runs |
| AuthBoundry denies `jobs.execute` (for example, the delegation was revoked) | `failed` with `DENIED: …`; the handler never runs |
| An effect inside the handler is denied | the run fails as `DENIED`; that effect is not performed |
| AuthBoundry unavailable or timed out | `retrying`; no attempt consumed; the handler never runs |
| Handler error | normal retry/backoff |

## Revocation

1. The job exists and has a valid execution identity.
2. The job runs successfully.
3. The delegation or principal authority is revoked in AuthBoundry.
4. The job runs again (retry, schedule tick, or a new worker).
5. The effect is **denied**.

Because the only authority state lives in AuthBoundry/FeltDB, restarting the
service process, the worker, or AuthBoundry does not restore revoked
authority. `tests/service-boundary.test.ts` proves this across a full
restart.

## Workers

`JobWorker` and `executeJob(tenantId, jobId, workerId)` use `workerId` only
as a lease owner. The managed runtime loop honours retry backoff
(`nextAttemptAt`), so a job waiting on unavailable authority is not retried
in a tight loop.

## CLI

Mutating CLI commands (`job enqueue`, `job schedule`,
`job schedule-recurring`, `job retry`, `job disable-schedule`) need an
operator identity and an authorizer. Set `APPPORT_AUTHORITY` to a module
exporting `{ authorizer, identify }`, or set `APPPORT_API_KEY`. Use
`--delegation <id>` to run a job under an AuthBoundry delegation.
`--created-by` is rejected.
