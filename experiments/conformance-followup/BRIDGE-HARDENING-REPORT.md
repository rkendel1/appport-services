# AuthBoundry AppPort Services bridge hardening

**Repository and branch:** `rkendel1/authboundry`, worktree `/home/user/authboundry-bridge`, branch
`bridge-hardening`, created from `claude/vigilant-maxwell-5sworx` @ `02191c3`. The main checkout was clean
and is untouched.

**Commits:** `2c7c72e` and `31462f3`, both local only. Nothing was pushed, published or PR'd.

**Supporting material** is in this experiment branch (`experiments/conformance-followup/`):
- harnesses: `bridge/harness`, `bridge/harness-after`, `bridge/run-before-after.sh`;
- results: `results/hardening/`.

## 1. Root causes

| Defect (reproduced before the change) | Root cause | Where | Bridge or dependency |
|---|---|---|---|
| One hung request blocks all callers indefinitely | No deadline. `read_line` blocks under a `std::Mutex` held across write and read. | `appport_services.rs` (old `:66-95`) | Bridge client |
| A child exit fails every later call until the server restarts; a failed first start is cached | `static OnceLock<Result<Client, String>>` is never reset; there is no respawn; `Drop` never runs for a static, so the child is never reaped | old `:97-103` | Bridge client |
| A stray stdout line shifts every later response to the wrong caller | No correlation: the client took whatever line came next. Dependencies can print to stdout (`@feltdb/core` debug paths). | old `call()`; child protocol | Bridge (client and protocol). The output source is in dependencies. |
| Memory grows without bound with distinct application IDs | Map of per-application `createServices` instances with no eviction. **Each instance is a complete FeltDB runtime holding its own in-memory copy of the whole shared state.** Heap snapshot at 100 applications: 100 `FileJsDb`, 1 900 `Collection` with index objects, and 15 MB of strings. Dropping the reference releases it: 200 applications retain 83.5 MB of heap when kept, 15.9 MB when dropped. Active handles stay constant, so there are no timers pinning instances. | `bridge/appport-services.cjs` (old `:187-199`) | Bridge (no bound). Per-instance size comes from `@appport/services`/FeltDB local mode. |
| Bridge failures returned as HTTP 400 with internal text; snapshot failures as 503 with raw text | `Err(String)` mapped to `400 service_operation_failed` + message, or to `control_plane_unavailable(error)` | `control_routes.rs:786-861`, `credential_broker.rs:798-814` | Bridge callers |
| Revoking an unknown key returns 200 `null` | `ApiKeyService.revoke` returns `null` when the key is missing **or** not visible to the tenant (deliberately indistinguishable). The bridge passed `null` through as success. The same holds for `disableWebhookEndpoint`, `jobs.retry` and `schedules.disable`. | bridge `execute()` | Bridge. The dependency's contract is "null = nothing matched". |
| (found here) The bridge did not exit when stdin closed if a dependency held a handle | `main()` resolved, but the event loop stayed alive | bridge tail | Bridge |

**Not caused by the bridge, left unchanged:**
- **Pre-existing failure:** `test/audit/appport-services-enforcement.test.js` test 3 fails on `02191c3`
  and still fails afterwards, with the same message. The bridge's `webhooks.create` never passes the
  `signingCredentialRef` that `@appport/services` 0.4.5 requires, so that operation always fails. Fixing
  it needs a credential-custody design decision.
- **No HTTP 404 for deletes:** `notifications.delete`, `files.delete` and `configuration.delete` return
  nothing whether or not the item existed. The dependency does not distinguish the two, so the bridge
  cannot report 404 without an extra read. They stay `200 {"deleted":true}`, which is true of idempotent
  "ensure absent" semantics.

## 2. Design

### Request lifecycle (client)

```text
call ─► queued ─► running ─► succeeded | failed (operation refused; child kept)
          │          ├─► timed out      child killed + reaped; outcome unknown
          │          └─► child lost     exit / foreign id / oversized / stray flood; child replaced; outcome unknown
          ├─► overloaded (queue full, nothing started)
          ├─► timed out in queue (nothing started)
          └─► shut down
```

**Bounds:**
- One request in flight at a time, matching the child, which executes sequentially.
- A FIFO queue of at most `MAX_QUEUE` waiters (default 32). Overflow is rejected immediately.
- One deadline per call, covering queue, startup and execution (default 15 s).
- Child writes happen on a writer thread, and reads come through a reader thread into a bounded
  channel, so neither a stalled child nor a full pipe can hold a caller past its deadline.
- Lines are capped at 16 MiB.

### Correlation (protocol 2, opt-in)

The server sets `AUTHBOUNDRY_APPPORT_SERVICES_PROTOCOL=2`. Then:
- The child writes a ready line after loading `@appport/services` and checking its storage configuration.
  No request is dispatched before it.
- Every request carries a numeric id, echoed in its response.
- Only the in-flight id answers.
- Id-less output is ignored, up to 64 lines per request.
- Any other id, an oversized line, or a flood is a protocol violation, and the child is recycled.

This makes late answers harmless twice over:
- a request that timed out is answered by a child that has already been killed;
- even an unkilled child could not answer the next request with the wrong id.

Also, the child moves `console.log`/`info`/`debug` and direct stdout writes to stderr.

**Compatibility:** without the variable, the child speaks the original protocol. The existing JS tests use
it unchanged. The `code` and `id` fields are additive.

### Which failures restart the child

| Failure | Scope |
|---|---|
| Operation refused (`ok:false`) | That request only; child kept |
| Timeout while running, exit, foreign id, oversized line, stray flood | Child killed and reaped before the next request is admitted (`busy` is released only after reaping) |
| Idle child found dead or misbehaving before dispatch | Replaced, and the same request is sent once to the fresh child. Nothing was sent to the dead one, so this is not a replay. |
| Spawn error, exit before ready, no ready line within the startup bound | That request fails as not started. The start is **not cached**. |

**Replay:** never. Requests whose outcome is unknown (`Timeout(Running)`, `ChildExited`,
`ProtocolViolation`) are reported as such (`outcome_unknown()`), and the HTTP message says the outcome
is unknown.

**Crash-loop control:**
- The first failure restarts at once.
- Consecutive failures (start failures, lost children, running timeouts) back off at 250 ms × 2ⁿ,
  capped at 30 s.
- During the backoff, calls fail fast with 503 and start nothing.
- Any answered request resets the backoff.

**Shutdown:** `appport_services::shutdown()` or `Drop` marks the client closed, wakes every waiter with
`ShuttingDown`, and kills the running or idle child; the running caller then reaps it. The child also exits
on stdin EOF when the server process dies.

**Diagnostics:** one JSON line per lifecycle event on stderr. Fields: `kind`, `reason`, operation name,
pid, counters. There is no request or response content.

**Cancellation:** the server is thread-per-connection with blocking handlers. A client disconnect is not
observable before the handler returns, so caller cancellation is not propagated. Every call is bounded by
the deadline instead.

### Per-application cache (child)

- An LRU of `@appport/services` instances (`AUTHBOUNDRY_APPPORT_SERVICES_MAX_APPLICATIONS`, default 8).
- Eviction happens only between requests (the child is sequential), so no in-flight request is affected.
- Evicted instances hold no timers or handles and are reclaimed by GC.
- State is durable on disk, so a recreated instance reloads it. Interleaved writes from two applications
  sharing the path survived a restart in the follow-up test.
- Isolation is unchanged: one instance per application, with the same `options(application)`.

### HTTP mapping

Shapes are unchanged (`{error, reason, message}`); only status codes and messages change.

| Category | Status | Message shown to the client |
|---|---|---|
| `INVALID_REQUEST` | 400 | The service's message, secrets redacted |
| `NOT_FOUND` | 404 | The service's message, secrets redacted |
| `CONFLICT` | 409 | The service's message, secrets redacted |
| `DENIED` | 403 | Fixed |
| Dependency `UNAVAILABLE` | 503 + `Retry-After` | Fixed |
| `INTERNAL` | 500 | Fixed |
| Overloaded, bridge unavailable, child lost, shutting down | 503 + `Retry-After` | Fixed |
| Timeout | 504 | Fixed |

Fixed messages say whether the outcome is unknown. The portal reads `body.message || body.error`, so it
keeps working.

**Externally observable changes** (documented in `docs/APPPORT-SERVICES-BRIDGE.md`):
- 400 becomes 403/404/409/500/503/504 where the category says so.
- Raw internal error text is no longer returned.
- Revoking an unknown key, disabling an unknown webhook or schedule, and retrying an unknown job become
  404 instead of 200 `null`.

These are changes to an internal control-plane route used by AuthBoundry's own portal, not to the AppPort
protocol or to `@appport/services`.

## 3. Before and after

**Setup:**
- Same machine (4-core Xeon 2.8 GHz container), Node 22.22.0.
- Same npm tree: `@appport/services` 0.4.5 + `@feltdb/core` 0.11.7, AuthBoundry's lock.
- Before: original client and bridge. After: the new ones.
- Medians of 2 repetitions. `results/hardening/load.jsonl`, `memory.jsonl`.

### Load, `snapshot` (fresh state per run)

| Callers | Before: throughput · p50 · p95 · max | After: throughput · p50 · p95 · max |
|---|---|---|
| 1 | 44/s · 23 · 28 · 31 ms | 38/s · 26 · 34 · 39 ms |
| 4 | 40/s · 24 · 398 · 949 ms | 37/s · 104 · 140 · 149 ms |
| 16 | 35/s · 32 · 1235 · 1703 ms | 33/s · 450 · 594 · 598 ms |
| 32 | 40/s · 107 · 1396 · 1576 ms | 38/s · 798 · 873 · 877 ms |

### Load, `configuration.create_variable`

| Callers | Before | After |
|---|---|---|
| 1 | 79/s · 12 · 19 · 27 ms | 74/s · 13 · 21 · 31 ms |
| 32 | 73/s · 16 · 1235 · 1656 ms | 76/s · 410 · 459 · 468 ms |

**Interpretation:**
- **Throughput is unchanged** within noise (−6 % to +5 %). The child is sequential in both versions.
- **FIFO admission replaces the unfair mutex.** The p95 queue wait at 32 callers falls from about
  1.4 s to about 0.87 s. The worst case falls from about 1.6 s to about 0.88 s and now equals queue
  length × service time.
- **p50 rises** because waiting is now shared evenly instead of starving some callers. That is the
  intended trade.
- **Single-caller cost:** +2–3 ms per call (writer/reader thread hand-off and id framing).

### Memory under application churn

400 distinct applications, child RSS after every 50 applications, `results/hardening/memory.jsonl`:

| Applications | 50 | 100 | 200 | 300 | 400 |
|---|---|---|---|---|---|
| Before | 138 | 193 | 390 | 716 | **1186 MB** |
| After (limit 8) | 137 | 172 | 248 | 313 | **342 MB** |

Retained heap after forced GC, from `test/appport-services-bridge-limits.test.js`, growth over 200
requests after a warm-up:

| Workload | Growth |
|---|---|
| One application | 4.1 MB |
| 200 new applications, limit 1 | 2.4 MB |
| 200 new applications, limit 4 | 9.7 MB |
| 200 new applications, limit 1000 (unbounded) | 352.8 MB |

**What remains, and why:**
- Every request writes durable evidence, and every cached instance holds an in-memory copy of the
  growing shared state.
- Retained memory is therefore about limit × state size. It grows with the total amount of stored
  evidence, not with the number of applications. The one-application run grows as well.
- That growth is in `@appport/services`/FeltDB local mode: unbounded evidence held in memory.
- RSS stays above retained heap because V8 does not return all freed pages.

### Faults, after

Run against the deterministic fake (`results/hardening/faults-after.jsonl`); compare
`results/bridge-faults.jsonl` for before.

| Scenario | Before | After |
|---|---|---|
| Hung request | Second caller blocked > 10 s with no end | Hung call `Timeout(Running)` at 2.0 s (deadline); the queued caller is then served by a new child |
| Child killed | 5/5 later calls `Broken pipe`, forever | 5/5 succeed; the idle death is detected before dispatch and the child replaced |
| One stray stdout line | Requests 3–5 got the answers of 2–4 | All 6 answered correctly |
| Bridge missing at first call | Error cached after the file appeared | Recovers on the next call |

Property check of the bridge script alone, before → after (`results/hardening/bridge-properties-before-after.jsonl`):

| Property | Before | After |
|---|---|---|
| Unknown-key revoke | `{"ok":true,"value":null}` | `NOT_FOUND` |
| Dependency stdout lines ahead of a response | 6 | 0 |
| stdin EOF with an open handle | Still running after 5 s | Exits 0 |

## 4. Tests

| Command | Before (`02191c3`) | After |
|---|---|---|
| `cargo test --workspace` | 478 passed, 0 failed, 6 ignored (run against the original bridge script) | **495 passed**, 0 failed, 6 ignored (+16 bridge, +1 HTTP revocation) |
| `npm test` | 69/69 | 69/69 |
| `node --test test/audit/appport-services-enforcement.test.js` | 2/3 (pre-existing failure, see §1) | 2/3 (same failure, same message) |
| `node --test test/appport-services-bridge-limits.test.js` (new) | 0/5 against the original script | 5/5 |
| `cargo test -p appport-auth-mesh-server --test appport_services_bridge` (new) | does not compile (no bounded client) | 16/16; also 8/8 with 4 copies run concurrently under CPU contention |

The before column for the new JS suite fails mostly on the missing ready line. The protocol-independent
property check above isolates the individual defects.

**New tests, mapped to the requested coverage:**

| # | Requirement | Test (`appport_services_bridge.rs` unless noted) |
|---|---|---|
| 1 | Stall bounded | `a_stalled_request_times_out_and_the_next_caller_gets_a_fresh_child` |
| 2 | No late misattribution | `a_late_answer_is_never_delivered_to_a_later_caller` |
| 3 | Child death settles all affected requests | `child_death_settles_the_running_request_and_queued_callers_recover` |
| 4 | Recovery after restart, and crash-loop backoff | `a_crash_loop_backs_off_without_spawning_and_then_recovers` |
| 5 | Startup retry | `a_failed_start_is_retried_not_cached`, `a_missing_bridge_is_found_once_it_exists`, `a_child_that_never_becomes_ready_fails_within_the_startup_bound` |
| 6 | Stray and malformed output | `stray_output_cannot_shift_answers_and_floods_recycle_the_child`, `foreign_ids_and_oversized_lines_are_protocol_violations`; JS: `output a dependency prints never reaches the response stream` |
| 7 | Concurrency (16 threads × 25, mixed with noise) | `concurrent_callers_receive_only_their_own_answers` |
| 8 | Queue limit and deadline | `the_queue_is_bounded_and_every_caller_returns_within_the_deadline` |
| 9 | Memory under churn | JS `per-application state is bounded under sustained application churn` |
| 10 | Shutdown and child reaping | `shutdown_settles_running_and_queued_work_and_kills_the_child`, `dropping_the_client_kills_its_idle_child`; JS `exits when its owner closes stdin` |
| 11 | Sanitized errors | `client_facing_errors_are_sanitized_and_mapped_to_their_status` |
| 12 | Truthful revocation | `credential_boundary.rs::services_revocation_reports_what_actually_happened` (HTTP 404 / 200 / idempotent 200); JS revocation test |
| — | No replay | `requests_whose_outcome_is_unknown_are_never_replayed` |
| — | Error categories keep the child | `operation_errors_keep_the_child_and_carry_their_category` |

**Authorization, tenant isolation and evidence are untouched:**
- Route authentication and ownership checks are unchanged.
- The bridge's verified-actor checks and allow-all authorizer are unchanged.
- `tenant_id` and `application_id` derivation is unchanged.
- No changes to `@appport/services`.
- The existing authority, enforcement and credential suites pass.

## 5. Remaining risks and recommended operating limits

**Throughput is still serial.** Sustained load above about 35 snapshots/s or about 75 writes/s queues,
then sheds with 503.
- With the defaults, a call can wait at most 15 s, and the queue holds 32.
- For tighter interactive latency, use `AUTHBOUNDRY_APPPORT_SERVICES_TIMEOUT_MS=5000` and `MAX_QUEUE=8`.
- Size against snapshot cost, which grows with stored data.

**Memory is about `MAX_APPLICATIONS` × state size.** State grows without bound because evidence is never
compacted in `@appport/services`/FeltDB local mode.
- On the 512 MB Fly VM keep `MAX_APPLICATIONS` ≤ 8, and watch child RSS.
- Lower values trade memory for re-load latency on cache misses (tens of ms here, more as state grows).
- Bounding evidence growth needs a change in `@appport/services`/FeltDB, out of scope here.

**Unknown outcomes are reported, not resolved.** After a 504, or a 503 with outcome unknown, a create may
or may not have happened.
- The portal shows the message.
- An idempotency key on mutating operations would let a retry be safe. That needs `@appport/services`
  support and is not added here.

**Configuration secret custody:** if the bridge call fails after the secret was sealed, the custody record
remains, as before this change. That ordering predates this change and was not modified.

**Application quota:** none was added. A per-account limit on organisations and applications (they are
creatable by any session) is a separate product decision. The bounded cache removes the memory exhaustion
it enabled.

**Platform:** `/proc`-based reaping checks in tests are Linux-only, and the tests run on Linux in CI.
Measurements used Node 22; the deployed image installs Debian's `nodejs`, possibly Node 18. The bridge uses
no syntax newer than the original's.

**Deployment order:** the client and the bridge ship together (same image and npm package). The new
client requires the protocol-2 bridge. Mixing a new client with an old bridge fails safely: it never sees
a ready line, so it returns 503 "not started" with backoff.

## 6. Changed files (`git diff --stat 02191c3`)

| File | Change |
|---|---|
| `crates/server/src/appport_services.rs` | Bounded, recoverable client; `error_response` |
| `crates/server/src/control_routes.rs` | 2 callers use `error_response` |
| `crates/server/src/credential_broker.rs` | 1 caller uses `error_response` (keeps secret redaction) |
| `bridge/appport-services.cjs` | Protocol 2, stdout isolation, LRU cache, categories, NOT_FOUND, exit on EOF |
| `crates/server/tests/appport_services_bridge.rs` | New: 16 tests |
| `crates/server/tests/fixtures/fake-appport-bridge.cjs` | New: test-only fault-injecting child |
| `crates/server/tests/credential_boundary.rs` | +1 HTTP revocation test |
| `test/appport-services-bridge-limits.test.js` | New: 5 real-bridge tests |
| `test/fixtures/appport-bridge/{noisy-dependency,open-handle,heap-probe}.cjs` | New: test-only preloads |
| `docs/APPPORT-SERVICES-BRIDGE.md` | New: lifecycle, protocol, limits, HTTP mapping, configuration |

The working tree is clean. A platform-specific rewrite of the tracked `node_modules/.package-lock.json`
by `npm ci` was reverted and is not part of the change.
