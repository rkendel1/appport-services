# AppPort Cross-Language Conformance: Follow-up and Remediation Plan

Date: 2026-10-22. Branch `experiment/rust-interop-assessment` (worktree `/home/user/rust-interop-experiment`).
This follows `experiments/rust-interop/REPORT.md` at `9f8e235`, which is preserved unchanged.
Everything new is under `experiments/conformance-followup/`.

**Evidence labels:**

| Label | Meaning |
|---|---|
| **[run]** | Executed in this session; output in `results/` |
| **[read]** | Verified by reading the cited code |
| **[read*]** | Read by a delegated review and spot-checked by me at the cited lines |
| **[hyp]** | Hypothesis, not demonstrated |

No production repository was modified. Nothing was pushed, published, or opened as a PR.

---

## 0. Summary

1. **Every material assessment finding reproduced exactly** [run] (`results/phase1-repro.txt`). The
   authoritative contract source is `rkendel1/appport`. Its HEAD `268c9b4` (protocol 1.2.1) produces the
   assessment's 127 UI expectations **byte for byte**, and the latest npm release 1.2.1 ships byte-identical
   `ui.js`/`names.js`/`errors.js` to 1.0.3 [run]. So the 1.0.3 oracle was the current contract.

2. **The most urgent problems are availability defects in AuthBoundry's subprocess bridge, not
   cross-language drift.** All of the following are reachable on the deployed route
   `/_authboundry/control-plane/applications/{id}/services`:
   - **No timeout:** one hung request blocks every other caller indefinitely [run].
   - **No restart:** after the child exits, every call fails until the server restarts [run].
   - **Failed start cached:** a failed first start is cached for the life of the process [run].
   - **Unbounded memory:** the per-application cache grows without limit, about 2.7 MB per application
     and superlinear. RSS passed 512 MB (the `fly.toml` VM size) at about 230 applications [run].
     Applications can be created by any authenticated user [read*].
   - **Response desync:** one stray stdout line shifts every later response to the wrong caller [run with
     a fault-injecting bridge]. A trigger in the shipped dependencies was looked for but **not** found
     [run].

3. **Drift findings:**
   - **Confirmed but latent:** AuthBoundry's divergent `crates/services` has no callers, is unpublished,
     and is documented as "legacy test scaffolding" in one doc but described as the production path in
     another.
   - **Confirmed and reachable, low impact:** Compute's UTF-16 length check, on a production route; its
     text is rendered as text.
   - **New contract questions:**
     - `parseCapabilityRef` accepts non-canonical versions (`@01`, `@0x1`, `@1e0`, `@ 1`) and rounds
       versions above 2^53.
     - AuthBoundry's AppPort authorizer drops the capability version.
     - `@appport/client` `discoverUi` returns documents it never validated.

4. **The conformance mechanism works.** The prototype has:
   - three corpora;
   - a reference-only blessing tool with a review gate;
   - a consumer gate with declared narrowings.

   On Compute's real validator it fails exactly on the two known over-acceptances. On AuthBoundry's
   webhook verifier it fails on 14 of 18 signatures. The Rust port passes it byte for byte. It refused
   every unreviewed expectation change in the tests [run].

5. **No Rust port of the bridge is warranted.** The demonstrated problems are the missing timeout, missing
   restart, unbounded cache and uncorrelated framing in about 100 lines of Rust and 200 lines of JS. Each
   is fixable in place.

---

## 1. Verified findings register

| ID | Where | Reachable? | In production? | Expected (source) | Observed | Kind | Severity |
|---|---|---|---|---|---|---|---|
| **B-1** | AuthBoundry `crates/server/src/appport_services.rs:66-95` `call()` | Yes: any session owning an application [read*: `control_routes.rs:772-868`, `control_authz.rs:244-251`] | Yes (Dockerfile:70, fly local mode) [read*] | A slow call must not block unrelated callers indefinitely | One `hang` request: a second caller still blocked after 10 s; no timeout exists [run: `results/bridge-faults.jsonl`] | Implementation defect | **High** (availability) |
| **B-2** | same, `:97-103` (`OnceLock<Result<…>>`) | Yes, whenever the child dies (OOM, crash) | Yes | A dead child is replaced | After SIGKILL every call fails `Broken pipe` (5/5); no respawn [run]. A missing bridge at first call stays an error after the file appears [run]. | Implementation defect | **High** |
| **B-3** | AuthBoundry `bridge/appport-services.cjs:187-199` (per-`application_id` `createServices` Map, never evicted) | Yes: applications are created by any session with no quota [read*: `control_routes.rs:2715-2850, 3090-3165`] | Yes | Bounded memory | RSS 137 → 393 → 1175 MB after 50, 200 and 400 distinct applications, superlinear (0.4.5 with feltdb 0.11.7, the AuthBoundry lock tree). Similar on 0.4.12 (1183 MB) [run: `results/bridge-memory-045-lock.jsonl`, `bridge-memory-0412.jsonl`] | Implementation defect | **High** together with B-2: OOM then a permanent outage |
| **B-4** | same client: no request correlation; `read_line` returns whatever line is next | Mechanism yes. Trigger in shipped deps **not found**: `DEBUG_CAS=1` writes to stdout in `@feltdb/core` `FileDB.cas`, but the local-mode path does not reach it [run] | Latent | Each response belongs to its request | One stray line made requests 3–5 receive the responses of 2–4 [run with fake bridge] | Robustness defect | Medium (misattributed responses across tenants if triggered) [hyp for reachability] |
| **B-5** | `call()` holds a std `Mutex` over write+read; thread-per-connection server [read*: `server.rs:864-881`] | Yes | Yes | — | Throughput is flat whatever the concurrency: about 60 snapshot/s and 130–150 writes/s. p95 queue wait reaches 0.9 s at 32 callers; the lock is unfair (p50 stays low, the tail grows) [run: `results/bridge-load.jsonl`] | Design limit | Low at current load |
| **B-6** | `control_routes.rs:856-861` | Yes | Yes | A failed or no-op operation is not reported as success; server faults are not 4xx | Every bridge failure (including a dead child) becomes HTTP **400** with internal text (`writing AppPort Services request: Broken pipe`) [read + run]. `api_keys.revoke` of a key outside the application returns **200 `null`**, a no-op reported as success [run: `results/cross-app-revoke.jsonl`] | Implementation defect | Medium (error semantics) |
| **V-1** | AuthBoundry `package.json:106` pins `@appport/services` 0.4.5; override forces `@feltdb/core` 0.11.7 (0.4.5 itself pins 0.11.6) | Yes | Yes | Current release 0.4.12 | 0.4.5's cross-application `revokeApiKey` bug **reproduces with a shared tenant string**, but is **unreachable via AuthBoundry**, which derives `tenant_id = "<tenant>:<appId>"` (no-op on both versions) [run]. Bridge works unchanged on 0.4.12, with or without the 0.11.7 override (attribution test) [run]. `package_version: '0.4.5'` is hard-coded in the bridge [read*]. | Obsolete dependency | Medium (defence in depth) |
| **V-2** | `bridge/appport-services.cjs:60-80` `OPERATION_SCOPES` | Only as an operation allowlist (`:118`); the arrays reach no decision [read*] | Yes | — | Holds pre-migration names (`files.read:any`, `schedules.write`, …) that `LEGACY_SCOPE_MIGRATION` says grant nothing | Obsolete code | Low (cosmetic, misleading) |
| **F-01** | AuthBoundry `crates/services/src/lib.rs:149-167` `WebhookAuthority` | **No callers**: only re-exported from `crates/boundary/src/lib.rs:23-25`. Not published (crates.io 404). [read*] | Latent | Accept `@appport/services` signatures (crate doc: "implementations of the published `@appport/services` contracts") | Rejects every genuine signature with secret ≤ 64 bytes, for both schemes. 14/18 corpus cases fail [run: `results/consume-authboundry-webhook.txt`]. No timestamp, in-memory replay set. | Obsolete implementation, plus doc defect: `docs/CREDENTIAL-BOUNDARY.md:187-189` describes it as the inbound path; `docs/architecture-invariants.md:82` calls it legacy scaffolding | Low now (fail-closed, unused); High if ever wired |
| **F-02** | same crate, `ApiKeyAuthority` | No callers | Latent | `@appport/services` key format and verifier (salted scrypt / HMAC-scrypt) | `abk_` keys, **unsalted SHA-256** verifier, linear scan [read] | Obsolete implementation | Low now; would weaken at-rest verifier strength if wired |
| **F-03** | Compute `crates/compute-environment/src/service_ui.rs:281` (`chars().count()`) and `:406` (`as_i64`) | Yes: `GET /services/{name}/ui` (`api.rs:1555`), Services page, Homebrew CI asserts it [read*] | Yes | Lengths in UTF-16 units; `order` per `Number.isInteger` (`@appport/protocol` `ui.ts`) | Accepts 2 documents the reference rejects (257 and 400 astral characters). Rejects `order` `1e21`, `20.0`, `2e1`, `-0` and numbers beyond f64 range, which the reference accepts [run: `results/consume-compute.txt`] | Implementation defect plus missing test | Low (text is rendered via `createTextNode` [read*]) |
| **F-03b** | Compute `tests/fixtures/appport-ui/*.json` pinned to 0.4.10 while `compatibility/published-stack/stack.json` pins 0.4.11 [read*] | — | — | Fixture tracks the shipped artifact | Drift | Missing test update | Low |
| **F-04a** | AuthBoundry `control_routes.rs:876-989` `normalize_contract_capabilities` | Yes (contract upload by application owner) | Yes | AppPort names (spec §8) | Accepts `CRM.Read`, `crm_x.read-all`, `1crm.read`, `http.get` and over-length names. No false allow found: AppPort can never call them [read*] | Contract ambiguity (AuthBoundry-native vs AppPort identifiers) | Low |
| **F-04b** | `@appport/protocol` `names.ts` `parseCapabilityRef` (`Number(...)`) | Used by `fulfillment.ts:160,200` [read] | Released (1.0.3–1.2.1) | Spec writes refs as `name@<integer>` and says nothing on canonical form | Accepts `@1.0`, `@01`, `@0x1`, `@1e0`, `@+1`, `@ 1`, `@1 ` (all → 1). `@9007199254740993` → `9007199254740992` [run: `capability-name-1`] | Contract defect candidate | Low to Medium (two spellings of one capability can coexist as distinct keys) |
| **F-04c** | AuthBoundry `dist/appport.js:55` (`capabilityFor` defaults to `request.capability.name`); exact identifier match in `control_routes.rs:991-1000` | Yes (`/_authboundry/authorize/check`) [read + read*] | Yes | Undefined: spec §12.3 authorizes by declared permissions, not by version | `name@1` and `name@2` get the same decision | Contract decision | Medium if versions differ in required permissions |
| **F-04d** | AuthBoundry `crates/boundary/src/runtime.rs:1398-1411` `validate_appport_capability` | Yes (`/_authboundry/propose` with `authority.apply`; `/auth/authorize` with a session) [read] | Yes | An AppPort-looking reference must be declared | `jobs@9.enqueue` skips the declared-capability check (first segment `jobs@9` is not a known service). No false allow found [read*] | Implementation defect | Low |
| **F-05** | `@appport/protocol` `ui.ts` `String(value.protocol)` | No untrusted path in available code: services validates its own contribution, `@appport/server` validates host config (`server.ts:99`), Compute is Rust [read] | Latent | Malformed protocol field → `INVALID_PROTOCOL` | `TypeError`, which servers would report as `INTERNAL_ERROR` [run] | Implementation defect | Low |
| **F-06** | `@appport/protocol` `ui.ts` route check (`/` prefix, no `//`, no `://`) | Only Compute builds URLs from routes, and it re-checks [read]. `composeUi` passes routes through [read]. | Latent | `docs/composable-ui.md`: "Surface routes are same-application routes" | Accepts `/ok/../../escape`, `/a\b`, `/a?x=1`, `/a#f`, `/a b`, `/a\u0000` [run] | Contract decision (protocol grammar vs host obligation) | Low now |
| **F-07** | `@appport/client` `composition.ts:70-99` `discoverUi` | No caller in available repos [read] | Latent | `docs/composable-ui.md`: "A host discovers contributions, validates them…" | Returns the remote document after checking only `protocol` [read] | Implementation gap | Low now; Medium for future hosts |

### Not reproduced or not applicable (recorded, not hidden)

- **Read latency grows with stored evidence:** about 90 → 890 ms per `snapshot` over 400 calls.
  - This happens only with `@feltdb/core` **0.11.6**, which is npm's default resolution for
    `@appport/services` 0.4.5.
  - It is **not** AuthBoundry's tree (override to 0.11.7: flat at about 17 ms) [run]. Not an AuthBoundry
    finding.
  - The first concurrency sweep used 0.11.6 by mistake. It is kept as `results/*.feltdb-0.11.6.*`;
    `results/ENVIRONMENTS.txt` records which environment produced which file.
- **Lost writes when two applications' `createServices` instances share one local state path:** not
  reproduced [run: interleaved writes, restart, all present].
- **An earlier sweep was invalid:** the bridge state at `<path>.appport-services` was not cleaned between
  runs. It is kept as `results/bridge-load.INVALID-*` with a README.

### Process note

A delegated read-only agent included the user's e-mail address in a `User-Agent` header of one request
to crates.io while checking publication status. It did not repeat it. Nothing else was sent.

---

## 2. Conformance corpus: proposal and validation

The full format is in `corpus-v1/SPEC.md`. In summary:

- **Layout:** per corpus, a reviewed `cases.json` (inputs and intent, raw wire text) and a generated
  `expected.json` (reference output bytes plus verdict, code and field views, bound to the
  `cases.json` hash, with a history).
- **IDs:** stable and never encode class or verdict.
- **Classes:** valid / invalid / boundary / security (rationale required) / versioned (through
  `referenceDefect.intended` and `decisionRequired`).
- **Regeneration:** `bless.mjs --check` is the CI gate. `--write` requires every changed and removed id in
  `--accept` and a reason. No mode blesses an implementation under test.
- **Consumers:** a `narrowings.json` per consumer, with a comparison level (exact / error / verdict) and
  declared, rationale-carrying divergences. The gate fails on an undeclared divergence, a stale narrowing,
  an unknown id, or a checksum mismatch.
- **Distribution:** vendored copies pinned by checksum, synced from a tag of `rkendel1/appport`. No new
  package or service; Rust CI needs no Node.

### Prototype contents

| Corpus | Cases | Reference | Status |
|---|---|---|---|
| `appport-ui-1` | 127 (valid 20, invalid 61, boundary 32, security 14; 2 `referenceDefect`) | `@appport/protocol` 1.0.3; also checked against source `268c9b4` | Expectations identical to the assessment's 127/127 [run] |
| `capability-name-1` | 44 (27 names, 17 refs; 8 `decisionRequired`) | `@appport/protocol` 1.0.3 | blessed |
| `webhook-signature-1` | 18 (2 schemes × 7 secrets + 4 boundary) | `@appport/services` 0.4.12 `secrets.ts` | blessed |

### Mechanism validation [run]

| Test | Result |
|---|---|
| `--check` against protocol source HEAD build | pass |
| `--check` against a mutated reference (max 511) | exit 1, the 3 affected ids named |
| `--write` with no `--accept`, or with a partial one | exit 2, nothing written |
| Id migration without listing removed ids | refused |
| Compute `service_ui` (verdict level, 16 declared narrowings) | 101 equal, 2 match intended (F-05), 16 declared; **fails on exactly the 2 F-03 over-acceptances** |
| AuthBoundry `WebhookAuthority` (verdict level, no narrowings) | **fails 14/18** (F-01) |
| Assessment Rust port via WASM (exact level, 1 representation narrowing) | 126 byte-equal + 1 declared: **pass** |
| Stale narrowing, re-pinned corpus, unknown id | each exit 1 |

---

## 3. Bridge reliability and performance report

### What the bridge is [read, read*]

**Execution model:**
- The Rust server is thread-per-connection.
- `appport_services::call` lazily spawns **one** `node bridge/appport-services.cjs` (a `OnceLock`, never
  reset).
- Each call holds a `std::sync::Mutex` while it writes one JSON line and reads one line.
- The bridge handles lines strictly in sequence.
- stderr is inherited, and the environment is inherited from the server.
- There is no timeout, no correlation id and no health check.
- `Drop` never runs for the static, so a dead child is never reaped.

**Authority boundary:**
- AuthBoundry authenticates the session and checks application ownership (`owned_application`).
- It sets `authority.verified_by = "authboundry"` (a constant) and the actor from the session.
- The bridge's authorizer **allows everything**, by documented design.
- So ownership is the only gate. There is no capability or policy check on these routes [read*].
- `tenant_id` and `application_id` come from the stored record. `environment` and `input` are caller
  controlled.

**Deployment:** Docker and Fly, local FeltDB mode at `/data/authboundry.appport-services`, Debian
`nodejs` [read*]. I ran Node 22, so absolute numbers on Debian's Node may differ.

### Method

- **Harness:** `bridge/harness/` compiles AuthBoundry's **unmodified** `appport_services.rs` via
  `#[path]`. It drives the **unmodified** bridge script (sha256 `29a3428a…`, identical to
  `authboundry/bridge/`) with the server's own environment variables.
- **npm trees:** four, listed in `results/ENVIRONMENTS.txt`.
  - The production-equivalent one is `env-045-lock`: 0.4.5 with the `@feltdb/core` 0.11.7 override, as
    `authboundry/package.json` and its lockfile resolve.
- **Fault injection:** a fake bridge speaking the same line protocol (`bridge/fake/bridge.cjs`) injects
  hangs and stray stdout.
- **Isolation:** throwaway state under the scratchpad, fresh per run. Loopback only; no production system
  was touched.
- **Sweep:** `run-load.sh`. Concurrency 1/4/16/32 threads, 64 snapshot and 128 `create_variable` calls
  per run, 3 repetitions, medians reported.
- **Environment:** 4-core Xeon 2.8 GHz cloud container, Node 22.22.0, rustc 1.97.

### Results, production-equivalent tree [run: `results/bridge-load.jsonl`]

| op | callers | throughput | p50 | p95 | p99 | p95 queue wait (p95 − p50 at 1 caller) | child RSS |
|---|---|---|---|---|---|---|---|
| snapshot | 1 | 58/s | 17 ms | 21 ms | 23 ms | — | 96 MB |
| snapshot | 4 | 59/s | 17 ms | 282 ms | 776 ms | 266 ms | 96 MB |
| snapshot | 16 | 61/s | 17 ms | 764 ms | 979 ms | 747 ms | 96 MB |
| snapshot | 32 | 61/s | 89 ms | 903 ms | 1025 ms | 887 ms | 92 MB |
| create_variable | 1 | 134/s | 7 ms | 9 ms | 11 ms | — | 96 MB |
| create_variable | 32 | 133/s | 8 ms | 677 ms | 822 ms | 670 ms | 95 MB |

Errors: 0 across all 24 runs.

### Memory [run]

| Workload | Calls | Child RSS |
|---|---|---|
| Same application, snapshot | 200 | flat (92 → 108 MB) |
| Distinct application per call, 0.4.5 lock tree | 50 / 100 / 200 / 300 / 400 | 137 / 194 / 393 / 718 / 1175 MB |
| Distinct application per call, 0.4.12 | 400 | 1183 MB |

With distinct applications, per-round time also grows (1.1 s → 6.0 s per 50 calls).

### Faults [run: `results/bridge-faults.jsonl`]

| Fault | Observed |
|---|---|
| Hung request | All other callers block (> 10 s, no timeout) |
| Child killed | Permanent `Broken pipe`; never respawned |
| Bridge missing at first use | Error cached forever |
| One stray stdout line | Every later response off by one (misattributed) |
| `DEBUG_CAS=1` on the real bridge | No desync in local mode (trigger not reached) |

### Interpretation

- **Throughput is not the problem.** About 60 reads/s and 130 writes/s for an owner-only control-plane
  route is ample. There is no evidence of real load at this level.
- **The demonstrated risks are:**
  - (a) unbounded blocking (no timeout, unfair queue);
  - (b) no recovery after a child failure;
  - (c) unbounded per-application memory, which (b) turns into a lasting outage;
  - (d) uncorrelated framing.
- **A persistent HTTP interface is not a drop-in.** `appport-services serve` hosts one application per
  process behind its own authentication adapter (`src/runtime/management-host.ts`, `management.ts:108`),
  while the bridge multiplexes many applications.
  - Replacing it would need one process per application, or a new multi-application API, which would be
    an invented interface.
  - So it was **not** measured.
- **A Rust port is not indicated.** None of the defects is a language issue.

---

## 4. Prioritized remediation plan

Security and availability fixes are separate from compatibility cleanup. Each item is an independent
change with its own rollback.

### P1: AuthBoundry bridge client: timeout, respawn, typed failures (High; B-1, B-2, B-6)

**Intended behaviour:**
- Every call has a deadline (e.g. 10 s, configurable).
- On timeout, EOF, write error or malformed response, the child is killed, reaped and replaced on the next
  call, with backoff.
- A start failure is retried, not cached.
- Bridge unavailability maps to **503** with a generic message. Internal error text is logged, not
  returned.

**Change:**
- `crates/server/src/appport_services.rs`: replace `OnceLock<Result<…>>` with `Mutex<Option<BridgeProcess>>`
  plus a reader thread or `recv_timeout`.
- `control_routes.rs:856-861` and the `credential_broker.rs:798` caller: status mapping.

**Regression fixtures:** port the four harness scenarios (`hang`, `kill`, `missing`, `noise`) into
`crates/server/tests/` with the fake bridge.

**Must stay green:**
- `test/appport-services-bridge.test.js`
- `test/audit/appport-services-enforcement.test.js`
- `cargo test -p appport-auth-mesh-server --test credential_boundary`

**Version/migration:** none.

**Acceptance:**
- A hung call returns 503 within the deadline, and a concurrent caller completes.
- After `kill -9` of the child, the next call succeeds.

**Rollback:** revert the commit. There is no state change.

### P2: AuthBoundry bridge: request correlation (Medium; B-4)

**Intended behaviour:** every request carries an `id` that the bridge echoes. A mismatched or
unparseable line is a protocol error: the child is recycled under P1, and no response is ever delivered to
the wrong caller.

**Change:** `bridge/appport-services.cjs` (echo `id`, 2 lines) and `appport_services.rs` (check `id`).
Deploy the bridge before, or together with, the client: the old client ignores the extra field.

**Fixture:** the `noise` scenario must yield one error, then correct attribution.

**Rollback:** revert both. The format is backward compatible.

### P3: AuthBoundry bridge: bound the per-application cache, and quota decision (High with P1; B-3)

**Intended behaviour:** at most N `createServices` instances (LRU, e.g. 32), with eviction closing the
instance's FeltDB handle if `@appport/services` exposes a close.

**Change:** `bridge/appport-services.cjs:187-199`.

**Product decision:** a per-account limit on organisations and applications (`control_routes.rs:2715-2850,
3090-3165`) is a separate, policy-level change.

**Fixture:** the `memory … distinct` scenario: RSS after 400 distinct applications stays below a set
ceiling (e.g. 300 MB).

**Must stay green:** the bridge restart and durability test (eviction must not lose data: state is on
disk, as verified by the multi-application restart test).

**Rollback:** revert.

### P4: AuthBoundry: upgrade `@appport/services` 0.4.5 → 0.4.12 (Medium; V-1, V-2)

This is a separate PR from P1–P3.

**Changes:**
- Bump the pin.
- Decide the `@feltdb/core` override: 0.4.12 declares 0.12.0, and the bridge works with both 0.12.0 and the
  forced 0.11.7 [run]. Prefer dropping the override, with AuthBoundry's FeltDB compatibility test as the
  gate.
- Replace the hard-coded `package_version: '0.4.5'` with the installed version.
- Drop the legacy names in `OPERATION_SCOPES` (keep the operation allowlist).
- Re-pin the manifest digest where it is pinned: 0.4.12 adds capabilities.
- Map the `null` revoke result to 404.

**Fixtures:**
- `bridge/cross-app-revoke.cjs`: a revoke with a shared tenant string must not revoke on the new version.
- The bridge tests assert the version dynamically.

**Rollback:** re-pin 0.4.5. Data written by 0.4.12 must be checked for readability by 0.4.5 before
release (FeltDB 0.12 journal format): **an open question**.

### P5: Corpus home in `rkendel1/appport` (enabler for P6–P9)

**Change:** add `conformance/contracts/{appport-ui-1,capability-name-1}` plus `tools/bless.mjs` and
`references.mjs` from this prototype, adapted to the monorepo (reference = `packages/protocol` build).
Add `bless --check` to `ci.yml`. Put `webhook-signature-1` in `appport-services`, which owns that
reference.

**Acceptance:** CI fails when a protocol change alters any expectation without a reviewed bless.

**Version:** none (test assets).

**Rollback:** delete the directory.

### P6: Compute adopts `appport-ui-1` (Low; F-03, F-03b)

**Change:**
- Vendor the corpus plus `narrowings.json` (start from `corpus-v1/consumers/compute/narrowings.json`).
- Add a test that runs `service_ui::interpret` (or `discover` through the existing stand-in server) over
  all cases.
- Fix the length check to UTF-16 units (`text.encode_utf16().count()`).
- Decide the `order` semantics: accept JS-integral numbers, or keep the narrowing as `over-rejection`
  with a rationale.
- Update the fixtures to the 0.4.11 artifact.

**Must stay green:**
- `cargo test -p compute-environment --test service_ui`
- `--lib service_ui`
- the Homebrew configured-stack check

**Version:** a patch release of Compute.

**Rollback:** revert. The narrowing file documents the pre-fix behaviour.

### P7: AuthBoundry retires or conforms `crates/services` (cleanup; F-01, F-02)

**Recommendation:**
- Remove the crate and its re-export: there are no callers and it is unpublished.
- Correct `docs/CREDENTIAL-BOUNDARY.md:187-189`.

**If it is kept:** it must pass `webhook-signature-1` at verdict level with no narrowings, and adopt the
`@appport/services` key verifier. Never keep the unsalted SHA-256 verifier.

**Version:** none externally (unpublished crate).

**Rollback:** revert.

### P8: Protocol bug fix: `String(value.protocol)` (Low; F-05)

**Intended behaviour:** any non-`"AppPort/ui/1"` protocol value → `INVALID_PROTOCOL`, with a safe rendering
of the offending value.

**Change:** `packages/protocol/src/ui.ts`, patch release.

**Corpus:** a reviewed re-bless that accepts exactly the 2 `referenceDefect` ids and removes their markers.
Consumers already implementing `intended` (Compute) need no change.

**Rollback:** revert. This is a pure tightening of an error path.

### P9: AuthBoundry small authority fix: `validate_appport_capability` (Low; F-04d)

**Change:** treat any reference whose service part (before `@`) is a known service, or that contains `@`,
as AppPort-shaped. Then `jobs@9.enqueue` is checked and refused.

**Fixture:** add `jobs@9.enqueue` next to the existing `crates/boundary/tests/authority.rs:183` case.

**Rollback:** revert.

### Decisions, not fixes (owners must decide before any change)

These are D-1 to D-4 in §6:
- F-04b: canonical refs.
- F-04c: version-blind authorization.
- F-06: route grammar vs host obligation.
- F-07: `discoverUi` validating.
- F-04a: AuthBoundry-native identifier grammar.

### Order

| Step | Items | Why |
|---|---|---|
| 1 | P1 → P3 → P2 | Reachable availability; P2 depends on P1's recycle path |
| 2 | P5 | Enabler |
| 3 | P6, P9 | Reachable, low |
| 4 | P4 | Defence in depth; needs a rollback-compatibility check |
| 5 | P8, P7 | Latent |
| 6 | Decisions D-1 to D-4 | Then any resulting contract versions |

---

## 5. Repository-by-repository implementation plan

| Repository | Changes, as separate PRs | Gate |
|---|---|---|
| **authboundry** | P1 bridge client hardening; P2 correlation id (client + `bridge/*.cjs`); P3 bounded cache (+ quota decision); P4 services upgrade + `OPERATION_SCOPES` cleanup + 404 mapping; P7 retire `crates/services` + doc fix; P9 capability guard | `npm ci && npm test`; `cargo test -p appport-auth-mesh-server --test credential_boundary`; `cargo test -p appport-auth-mesh-boundary`; new fault and memory tests |
| **appport** (protocol) | P5 corpus home + CI `bless --check`; P8 TypeError fix (patch release); later the D-1/D-3/D-4 outcomes | `pnpm test`; `bless --check`; `release/api` snapshot |
| **appport-services** | Host `webhook-signature-1` (+ `services-manifest-1` next) with `bless --check` in `ci.yml`. Optionally document both signature schemes in one place. | `npm test` (287) |
| **compute** | P6: vendored `appport-ui-1` consumer test, UTF-16 fix, order decision, fixture 0.4.11 | `cargo test -p compute-environment` |
| **flow_db, appworks, stack-agent** | None. Stack-Agent compares fingerprints as opaque strings; AppWorks reuses protocol digests. | — |

---

## 6. Unresolved questions and required decisions

| # | Question |
|---|---|
| D-1 | **Canonical capability references.** Should `parseCapabilityRef` reject non-canonical versions (`^[1-9][0-9]*$`, ≤ 2^53−1)? Rejecting them is a behaviour change for `fulfillment.ts` keys. Find out first whether any published manifest uses such spellings. |
| D-2 | **Version-aware authorization.** Should AuthBoundry decide on `name@version` (or on the permissions a version declares) rather than the name? This needs the spec (§12.3) to state whether versions of one name may differ in required permissions. |
| D-3 | **Route grammar.** Should `AppPort/ui/1` keep its permissive route grammar and state host obligations normatively ("hosts MUST NOT resolve routes outside the product origin/base path")? Or should a tightened grammar ship as a versioned change? Per spec, tightening an input bound is breaking. |
| D-4 | **`discoverUi` validation.** Should `discoverUi` call `validateUiContribution` (a behaviour change for callers that pass invalid documents today), or should the docs say callers must? |
| D-5 | **AuthBoundry identifier grammar.** Is the contract-upload grammar (F-04a) meant to cover AppPort capability names? If yes, align it with `isValidName` for AppPort-sourced applications. If no, document it as an AuthBoundry-native identifier space. |
| D-6 | **Application quota.** Is a per-account organisation and application quota acceptable product policy (B-3 defence in depth)? |
| Q-1 | **0.4.12 downgrade safety.** Can 0.4.5 / `@feltdb/core` 0.11.7 read state written by 0.4.12 / 0.12.0? This decides whether P4 can be rolled back. |
| Q-2 | **Deployed Node version.** Debian's `nodejs` in the runtime image is probably Node 18 [hyp]. Measurements here used Node 22. Re-run `run-load.sh` in the deployed image before sizing timeouts. |
| Q-3 | **Other `crates/services` consumers.** Out-of-tree consumers of `appport-auth-mesh-services` or `-boundary` cannot be ruled out from these checkouts (crates.io: unpublished). |

---

## 7. Exact repository state

**Branch and commits:**
- `experiment/rust-interop-assessment`: `f3ebc4e`, `9f8e235` (assessment, unchanged) and `b890e70` (this
  follow-up's harnesses and results). The final commit adds this report.
- Local only. Nothing pushed, published or merged. No PR.

**New repositories in the session (read-only):**
- `rkendel1/appport` cloned at `/home/user/appport` (`268c9b4`).
- `rkendel1/stack-agent` at `/home/user/rkendel1/stack-agent` (from the assessment).

**Production repositories:** `authboundry`, `compute`, `appport-services`, `appboundry`, `flow_db`,
`appworks` and `appport` are unmodified.
- `authboundry`'s `node_modules` was **not** installed into. The bridge ran from copies (byte-identical
  script) under `experiments/conformance-followup/bridge/env*/`, with their own `node_modules`
  (gitignored; lockfiles committed).

**Added, all under `experiments/conformance-followup/`:**

| Path | Contents |
|---|---|
| `FOLLOWUP-REPORT.md` | This report |
| `corpus-v1/SPEC.md` | Corpus format specification |
| `corpus-v1/tools/` | `bless.mjs`, `consume.mjs`, `references.mjs`, `convert-ui-corpus.mjs`, `make-*-cases.mjs` |
| `corpus-v1/{appport-ui-1,capability-name-1,webhook-signature-1}/` | `cases.json`, `expected.json` |
| `corpus-v1/consumers/{compute,authboundry-webhook,rust-port-wasm}/` | Adapters, results and narrowings |
| `bridge/harness/` | Rust harness (`#[path]` to the unmodified `appport_services.rs`) |
| `bridge/fake/bridge.cjs` | Fault-injecting bridge |
| `bridge/run-load.sh`, `bridge/cross-app-revoke.cjs` | Load sweep and cross-application revoke test |
| `bridge/env{,-045-lock,-0412,-0412-override}/` | npm trees |
| `results/` | `phase1-repro.txt`, `review-gate.txt`, `consumer-gate.txt`, `consume-*.txt`, `bridge-faults.jsonl`, `bridge-load.jsonl`, `bridge-memory-*.jsonl`, `cross-app-revoke.jsonl`, `ENVIRONMENTS.txt`, plus labelled superseded and invalid runs |

Build output goes to `experiments/rust-interop/target/` (gitignored). Throwaway state lives in the session
scratchpad.

**Tests executed in this follow-up:**

| Test | Result |
|---|---|
| Assessment re-run: corpus regeneration, native, differential, Compute observer, webhook | All identical to the committed results |
| Corpus against protocol source HEAD | 127/127 |
| Bless and consume gates | All expected passes and failures |
| Bridge | Fault scenarios ×5; load sweep 24 runs (0 errors); memory 6 runs; multi-application durability; cross-application revoke on 2 versions |
