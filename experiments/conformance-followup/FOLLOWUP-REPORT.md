# AppPort Cross-Language Conformance: Follow-up and Remediation Plan

Date: 2026-10-22. Branch `experiment/rust-interop-assessment` (worktree `/home/user/rust-interop-experiment`).
This follows `experiments/rust-interop/REPORT.md` at `9f8e235`, which is preserved unchanged.
Everything new is under `experiments/conformance-followup/`.

**Closeout:** §8 records the finalize-and-verify pass that followed this plan and the bridge hardening
(`BRIDGE-HARDENING-REPORT.md`). Its changes are local commits on dedicated branches in four product
repositories. Statements in §0–§7 about "unmodified" repositories describe the state before §8.

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

---

## 8. Closeout: finalize, verify and close out

Date: 2026-10-22. Every result in this section was run in this session unless it is marked [read].
Nothing was pushed, published, deployed or opened as a PR. No production configuration was changed.

### 8.1 Architecture decision

AppPort Services, the AppPort protocol and the SDKs stay in TypeScript/Node.js. Rust and TypeScript
share **contracts only**: versioned conformance corpora that each repository's own test suite gates.
There is no Rust port, WASM or Node-API binding, second implementation, sidecar or new protocol.

AuthBoundry keeps its Node subprocess bridge. It was hardened in place: same process model, same
JSON-lines framing. Protocol 2 is an additive, opt-in extension of it. Nothing in §8 gives new evidence
against this decision. The one new pressure is memory and throughput under growing state (§8.5), and it
lives in `@appport/services`/FeltDB local mode, not in the language boundary.

### 8.2 Repository and version map

| Repository | Base (remote `main`, verified current) | Closeout branch (local) | Commits | Relevant versions |
|---|---|---|---|---|
| `rkendel1/appport` | `268c9b4` | `closeout/protocol-contract-fixes` (`/home/user/appport-closeout`) | `bd70edb` | `@appport/protocol` 1.2.1 (unreleased change on top) |
| `rkendel1/appport-services` | `df0afbe` | `closeout/services-conformance` (`/home/user/services-closeout`) | `c442298` | `@appport/services` 0.4.12 |
| `rkendel1/compute` | `6025818` (the local checkout was stale at `b0900fe`) | `closeout/ui-contract-conformance` (`/home/user/compute-closeout`) | `62a2b49` | `compute-environment` 0.1.21 |
| `rkendel1/authboundry` | `02191c3` | `bridge-hardening` (`/home/user/authboundry-bridge`) | `2c7c72e`, `31462f3`, `9877fa0`, `ece93d0` | Pins `@appport/services` **0.4.5** and `@feltdb/core` 0.11.7 (override) |
| `rkendel1/rust-interop-experiment` worktree | — | `experiment/rust-interop-assessment` | through `412fd4a` and this report | Harnesses and results; not for release |
| `appboundry`, `flow_db`, `appworks` | — | none | — | Read only (§8.8) |

**Deployment runtime** [read + run]:
- AuthBoundry's Docker builder is `rust:1.88.0`.
- The runtime image installs Debian bookworm `nodejs`, which is **Node 18.20.4**.
- The Fly VM has 512 MB, 2 shared CPUs, and `FELTDB_DEPLOYMENT = 'local'`.
- All bridge suites were run on Node 18.20.4 (downloaded, checksum verified) and on Rust 1.88.0, as
  well as on Node 22 and Rust 1.97.

### 8.3 Changes

| Repository / commit | Files | What |
|---|---|---|
| appport `bd70edb` | `packages/protocol/src/names.ts` | `parseCapabilityRef` accepts only `name@` + `^[1-9][0-9]*$` within the safe-integer range (was `Number(...)`) |
| | `packages/protocol/src/ui.ts` | `validateUiContribution` is total: a hostile `protocol` value gives `INVALID_PROTOCOL`, and any non-AppPort throw while reading becomes `INVALID_REQUEST` with the cause attached. Ordinary messages are unchanged. |
| | `conformance/contracts/{README.md, tools/{reference,bless}.mjs, appport-ui-1/*, capability-name-1/*}` | Corpus home: 127 UI cases and 44 name cases, version 1.1.0, history imported from the prototype |
| | `packages/protocol/test/{conformance-corpus,protocol,fulfillment,ui}.test.ts`, `docs/audit.json` (+2 lines) | Corpus gate, canonical-reference tests, error-boundary tests |
| appport-services `c442298` | `conformance/contracts/{README.md, tools/{reference,bless,make-cases}.mjs, webhook-signature-1/*, api-key-restrictions-1/*, services-manifest-1/*}`, `tests/conformance-corpus.test.ts` | Corpora for the contracts this package owns: 18 + 45 + 3 cases, gated in `npm test`. No source change. |
| compute `62a2b49` | `crates/compute-environment/src/service_ui.rs` | Text length in UTF-16 code units, plus an in-module corpus gate test |
| | `crates/compute-environment/tests/fixtures/appport-conformance/appport-ui-1/{cases,expected,narrowings}.json` | Vendored corpus 1.1.0 (sha256 pinned) and 16 declared narrowings |
| authboundry `2c7c72e`, `31462f3` | See `BRIDGE-HARDENING-REPORT.md` §6 | Bounded, recoverable bridge client; protocol 2; LRU cache; error mapping |
| authboundry `9877fa0` | `bin/authboundry.js`, `test/cli-launcher.test.js` | The npm launcher points the native runtime at the packaged `bridge/appport-services.cjs`. Before, it fell back to a path baked in on the build machine. The test fails before the change and passes after. |
| | `crates/server/tests/{appport_services_bridge.rs, fixtures/fake-appport-bridge.cjs}` | New-client/old-bridge test: an old bridge is never sent a request |
| | `crates/server/tests/credential_boundary.rs` | Non-disclosure test: revoking a foreign key is byte-identical to revoking a nonexistent one, and the foreign key stays usable |
| | `docs/APPPORT-SERVICES-BRIDGE.md` | Compatibility matrix, non-disclosure contract, verified runtimes |
| authboundry `ece93d0` | `docs/APPPORT-SERVICES-BRIDGE.md` | Measured sizing under sustained load (§8.5) |
| experiment `412fd4a` and this commit | `bridge/harness-after/src/main.rs`, `results/closeout/*` | `sustained` load scenario; load and corpus results |

### 8.4 Conformance results per consumer

| Corpus (version) | Consumer | Comparison | Result |
|---|---|---|---|
| `appport-ui-1` (1.1.0, 127 cases) | `@appport/protocol` source (reference) | exact bytes | 127/127, gated in `pnpm test` |
| `capability-name-1` (1.1.0, 44 cases) | `@appport/protocol` source (reference) | exact bytes | 44/44, gated in `pnpm test` |
| `appport-ui-1` (1.1.0) | Compute `service_ui` | verdict | 105 identical, 16 declared narrowings, 6 not applicable (filter operation), **0 undeclared**. Before the UTF-16 fix the gate failed on the 2 astral over-acceptances. |
| `webhook-signature-1` (18) | `@appport/services` source 0.4.12 (reference) | exact | 18/18, gated in `npm test` |
| | `@appport/services` **0.4.5** (AuthBoundry's pin) | exact | 18/18 [`results/closeout/services-corpora-by-version.txt`] |
| | AuthBoundry `crates/services` `WebhookAuthority` | exact | 4/18 (from §2 prototype). **Not reachable**: no callers, not published. |
| `api-key-restrictions-1` (45) | 0.4.12 | exact | 45/45 |
| | 0.4.5 | — | Not applicable: 0.4.5 has no restrictions module. The feature postdates it. |
| `services-manifest-1` (3) | 0.4.12 | exact | 3/3; digest `74fd1a3f…c020`, identical under 5 locales |
| | 0.4.5 | exact | 1/3. Legacy-scope map identical; manifest and digest differ because 0.4.12 adds operations. This is a version difference, not a defect. |

**Compute narrowings by kind:**
- 10 host-policy: composition ×2, 65 and 1000 surfaces, 6 routes.
- 5 over-rejection: `order` written `1e21`, `20.0`, `2e1`, `-0`, or beyond f64 range. Compute rejects
  these, so it is stricter, never looser.
- 1 representation: a lone UTF-16 surrogate, which `serde_json` cannot hold.

The gate also fails on stale or unknown narrowings and on a checksum change.

**Mutation checks** (each gate caught a deliberate defect, then the source was restored):
- **Protocol:** with the `names.ts`/`ui.ts` fixes stashed, the vitest corpus gate failed on the
  versioned ids.
- **Services:** widening restriction containment to `return true` failed
  `akr1.within.child-drops-resources`.
- **Compute:** reverting to `chars().count()` failed on the 2 astral cases.

### 8.5 Bridge results

**Failure modes** (all covered by tests; see `BRIDGE-HARDENING-REPORT.md` §4):
- stall, which is bounded by the deadline;
- late answer, never misattributed;
- child death, crash loop with backoff, and failed or missing start;
- a child that never becomes ready;
- stray, foreign-id and oversized output;
- 16-thread concurrency;
- the queue bound;
- shutdown and reaping;
- sanitized errors;
- no replay;
- new client against an old bridge: no request is sent.

**Throughput and latency, short runs:**
- About 60 snapshots/s and 130–150 writes/s, serial. These numbers come from `BRIDGE-HARDENING-REPORT.md`
  §3 and were measured on fresh state.

**Sustained load (new):**
- Setup: Node 18.20.4, 16 caller threads, 24 applications, 70% `snapshot` and 30%
  `configuration.create_variable`, production deadline (15 s) and queue (32).
- Results: `results/closeout/sustained-node18-16x24*.jsonl`.

| `MAX_APPLICATIONS` | Duration, calls | Throughput, first → last 30 s | p50 / p95 / max latency, last 30 s | State on disk at end | Child RSS (peak) | Timeouts, shed, recycles, errors |
|---|---|---|---|---|---|---|
| 2 | 240 s, 1441 | 13.2 → 4.1 /s | 4.0 / 5.1 / 5.8 s | 28 MB | 357 MB (361) | 0, 0, 0, 0 |
| 8 (default) | 600 s, 2527 | 14.9 → 2.6 /s (low 1.9) | 6.0 / 7.2 / 7.5 s (peak p95 10.8 s at 540 s) | 49 MB | 903 MB (968) | 0, 0, 0, 0 |
| 24 (all cached) | 240 s, 3526 | 25.9 → 8.7 /s | 1.8 / 2.3 / 2.5 s | 61 MB | 1858 MB (2514) | 0, 0, 0, 0 |

**Interpretation:**
1. **The bridge stayed correct throughout.** One child served every call: no timeout, shed request,
   recycle or error.
2. **Per-call cost grows with stored state, whatever the cache size** (compare 24 against 2 and 8).
   - The state is a single `state.json` plus journals, and it reached 24 MB at 2527 operations.
   - Every operation writes durable evidence, so the state, and the work per call, only grow.
   - This is `@appport/services`/FeltDB local-mode behaviour. Cache misses add a full state reload on
     top (compare 8 against 24).
3. **Memory is about `MAX_APPLICATIONS` × in-memory state** (about 110 MB per cached instance at 24 MB of
   `state.json`).
   - With the default of 8, the child passed the 512 MB VM once state reached about 27 MB (t = 180 s).
     In production that means an OOM kill. The client then recovers (503 outcome unknown, backoff,
     respawn), but repeatedly.
   - With 2, RSS stayed at or below 361 MB at 28 MB of state, at about the same throughput as 8.
   - (Superseded in turn by §9.3: no cache size is a fix.) `BRIDGE-HARDENING-REPORT.md` §5 recommended "≤ 8 on the 512 MB VM". **That is superseded:** use 2
     on a 512 MB VM. Size the VM by `MAX_APPLICATIONS` × state, or decide the evidence retention
     question (D-9).
4. **Throughput is serial.** At about 2–4 calls/s, latency approaches the 15 s deadline after a few
   thousand operations against one state file. This bounds how long a local-mode deployment can absorb
   write-heavy use.

The default was **not** changed in code: it is a production setting and the decision is listed in D-9.
The guidance is in `docs/APPPORT-SERVICES-BRIDGE.md` ("Sizing").

**Recovery:**
- Every recovery path recovered in tests on Node 18.20.4 and on 22.
- The old bridge with an open dependency handle never exits after stdin closes. A leftover test process
  from the before-run was still alive after 80 minutes and needed SIGTERM.
- The new bridge exits on EOF (`limits` test).

### 8.6 Tests (exact commands, on the closeout commits)

| Repository | Command | Before (base) | After |
|---|---|---|---|
| appport | `pnpm build && pnpm test` | 1667 passed, 3 skipped | **1676 passed, 0 failed, 3 skipped** |
| appport | `pnpm typecheck`, `pnpm build`, `pnpm boundary:check` | — | pass |
| appport | `node conformance/contracts/tools/bless.mjs <corpus> --check` (both) | — | pass |
| appport-services | `npm test` | 287/287 | **293/293** |
| appport-services | `npm run test:browser` | — | 13/13 |
| compute | `cargo test -p compute-environment --lib service_ui` | 9/9 | **10/10** (the new test fails before the fix) |
| compute | `cargo test -p compute-environment --test service_ui` | 9/9 | 9/9 |
| compute | `cargo test -p compute-environment --test headless` | — | 7/7 |
| compute | `cargo clippy -p compute-environment`, `cargo fmt --check` | — | clean |
| authboundry | `cargo test --workspace` | 478 passed, 0 failed, 6 ignored | **497 passed, 0 failed, 6 ignored** (re-run on `9877fa0`; `ece93d0` is docs only) |
| authboundry | `npm test` | 69/69 | **70/70** |
| authboundry | `node --test test/appport-services-bridge-limits.test.js test/appport-services-bridge.test.js test/cli-launcher.test.js` | — | 11/11 on Node 22.22.0 and on Node 18.20.4 |
| authboundry | `node --test test/audit/appport-services-enforcement.test.js` | 2/3 | **2/3**. Same pre-existing failure (D-8), unchanged message: `signingCredentialRef is required and must be a credential-ref:<id>` |
| authboundry | `CARGO_TARGET_DIR=target/msrv-1.88 cargo +1.88.0 test -p appport-auth-mesh-server --test appport_services_bridge --test credential_boundary`, `AUTHBOUNDRY_NODE=<node 18.20.4>` | — | 17/17 and 11/11 |

**Notes:**
- Baselines for appport were taken on a built tree in a temporary worktree. An unbuilt tree skips 8, not
  3.
- appport-services, compute and appport were run after their final commits. They were not re-run after
  the AuthBoundry re-run, and nothing in them has changed since.

### 8.7 Behavioural changes

1. **`parseCapabilityRef`** (`@appport/protocol`) rejects non-canonical versions (`@01`, `@1.0`, `@1e0`,
   `@0x1`, `@+1`, `@ 1`, `@1 `) and versions above 2^53−1. They returned 1 or a rounded number before.
   - Effect: a fulfillment claim spelled that way is refused instead of keyed as a second spelling.
   - Justification: spec §8 writes references as `name@<integer>`, and two spellings of one capability
     could coexist as distinct keys (F-04b).
   - Search of all available repositories: no non-canonical reference outside tests.
     `feltdb.public.substrate@1.0` in `flow_db` is a FeltDB contract label that is never parsed by
     `parseCapabilityRef`.
   - Corpus `capability-name-1` 1.1.0 records the 8 changed ids.
   - **Unreleased:** releasing it is decision D-1.
2. **`validateUiContribution`** never throws a non-AppPort error. A hostile `protocol` value gives
   `INVALID_PROTOCOL` (was `TypeError`). Two corpus ids are versioned in 1.1.0.
3. **Compute** counts UI text in UTF-16 code units. It now rejects the 2 documents with 257 and 400 astral
   characters that the reference rejects.
4. **AuthBoundry services routes:**
   - Status codes 400/403/404/409/500/503/504 by category, with fixed messages for server faults (was 400
     or 503 with raw internal text).
   - Revoking, disabling or retrying an unknown item gives **404** (was **200 `null`**). This keeps
     non-disclosure: foreign and nonexistent are byte-identical, and the test guards it.
   - Deletes stay `200 {deleted:true}`, because the dependency cannot distinguish the two cases.
   - `Retry-After` on 503.
5. **AuthBoundry bridge:**
   - deadline, bounded queue, recycle, backoff, no replay, LRU application cache;
   - the child exits on stdin EOF;
   - protocol 2 is opt-in by environment variable, and the old protocol is unchanged.
6. **AuthBoundry npm launcher** uses the packaged bridge path when `AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE`
   is unset.

### 8.8 Findings register: final classification

Classes: **1** fixed, **2** already fixed and verified, **3** not reachable (with evidence), **4**
deferred pending a decision, **5** out of scope.

| ID | Class | Evidence or decision |
|---|---|---|
| B-1 no timeout | 1 | `2c7c72e`; stall and deadline tests |
| B-2 no restart, failed start cached | 1 | `2c7c72e`; crash-loop, failed-start and missing-bridge tests |
| B-3 unbounded application cache | 1 (bridge), **4** (growth) | LRU bound fixed. Growth of state and memory per instance remains (§8.5): D-9 |
| B-4 response desync | 1 | Protocol 2 ids and stdout isolation; stray, foreign and late-answer tests |
| B-5 serial throughput | 4 | Design limit, measured (§8.5). Concurrency needs a dependency or architecture decision: D-9 |
| B-6 400 for all failures; revoke 200 `null` | 1 | `error_response`; HTTP revocation and non-disclosure tests |
| V-1 `@appport/services` 0.4.5 | 3 + 4 | Cross-application revoke bug not reachable: `tenant_id = "<tenant>:<appId>"` [run]. Webhook signatures conform on 0.4.5. Upgrade is D-6. |
| V-2 stale `OPERATION_SCOPES` names | 4 | Cosmetic. They reach no decision. Rides with the D-6 upgrade. |
| F-01 `crates/services` webhook verifier | 3 | No callers, not published (crates.io 404). Removal is D-7. |
| F-02 `crates/services` API-key verifier | 3 | Same: D-7 |
| F-03 Compute UTF-16 length | 1 | `62a2b49` |
| F-03 Compute `order` over-rejection | 4 | Declared narrowing (stricter than the reference). Whether Compute should accept `1e21`/`20.0` spellings is the Compute owner's call. Safe as is. |
| F-03b Compute fixture 0.4.10 vs stack 0.4.11 | 5 | Fixture refresh in Compute, unrelated to AppPort Services |
| F-04a AuthBoundry identifier grammar | 4 | D-5 (unchanged from §6) |
| F-04b non-canonical refs | 1, release **4** | `bd70edb`, unreleased: D-1 |
| F-04c version-blind authorization | 4 | AuthBoundry's contract is per identifier (`normalize_contract_capabilities` rejects duplicates; the version is metadata). Changing it alters an authority boundary: D-2 |
| F-04d `validate_appport_capability` skips `jobs@9.enqueue` | 4 | No false allow found [read*]. It is an authority-boundary change, so it was not made: D-2 |
| F-05 `String(value.protocol)` TypeError | 1 | `bd70edb` |
| F-06 permissive route grammar | 4 | D-3 |
| F-07 `discoverUi` returns unvalidated documents | 4 | D-4. No caller in available repositories. |
| Audit `webhooks.create` requires `signingCredentialRef` | 4 | Pre-existing failure, unchanged. Needs a credential-custody decision; no reference was fabricated: D-8 |
| Duplicate ad-hoc `name@version` parsers (`packages/integration/*`, `client/host.ts`) | 5 | Left as is; they follow the D-1 release |
| `appboundry` vendors `@appport/protocol` 1.0.0 with the old `parseCapabilityRef` (used in `packages/cli`) | 5 | Another product. It follows the D-1 release. |
| Configuration secret custody after a failed bridge call | 5 | Ordering predates the bridge work. It is not a bridge defect. |
| Q-2 deployed Node version | 2 | Node 18.20.4, verified (§8.2) |

### 8.9 Known limitations

1. **Local-mode state grows without bound, and so do per-call cost and per-instance memory** (§8.5). The
   default `MAX_APPLICATIONS=8` exceeds the 512 MB VM once state is about 27 MB. Set 2 on that VM.
2. **Throughput is serial:** about 2–15 calls/s under mixed load, depending on state size.
3. **Unknown outcomes** after a 504 or a lost child are reported, not resolved. There is no idempotency
   key, and no retry was added for writes.
4. **Audit test failure:** 1 of 3 tests in `test/audit/appport-services-enforcement.test.js` fails, as
   before.
5. **`@appport/core` requires Node ≥ 20.** The bridge does not use it; the JS SDK does. The Debian
   runtime is Node 18, so anything that loads `@appport/core` in that image is unsupported.
6. **Corpora don't yet run in other repos' CI.** They are gated in each repository's own test suite.
   Compute vendors a pinned copy and must refresh it deliberately.
7. **Platform:** the reaping tests use `/proc` and are Linux only.

### 8.10 Required decisions

| # | Decision | Owner | Evidence |
|---|---|---|---|
| D-1 | Release `@appport/protocol` with canonical references and the total UI validator (1.1.0 corpora). Patch or minor? | Protocol | §8.7 (1)–(2) |
| D-2 | Version-aware authorization in AuthBoundry, including the `validate_appport_capability` guard (F-04c, F-04d) | AuthBoundry / spec §12.3 | §6 |
| D-3, D-4, D-5 | Route grammar; `discoverUi` validation; AuthBoundry identifier grammar | Protocol / AuthBoundry | §6 |
| D-6 | Upgrade AuthBoundry to `@appport/services` 0.4.12. This needs the downgrade-safety check (Q-1), removal of the `@feltdb/core` override, the hard-coded `package_version` and the `OPERATION_SCOPES` cleanup. | AuthBoundry | §1 V-1 |
| D-7 | Delete AuthBoundry `crates/services` (and correct `docs/CREDENTIAL-BOUNDARY.md`). Out-of-tree users cannot be ruled out (Q-3). | AuthBoundry | §1 F-01/F-02 |
| D-8 | Webhook signing-credential custody for `webhooks.create` (who mints and holds `credential-ref:<id>`) | Security / product | audit test |
| D-9 | Production sizing and evidence retention: set `MAX_APPLICATIONS=2` (or a larger VM); decide evidence compaction or retention in `@appport/services`/FeltDB, or move off local mode | Operations / product | §8.5 |
| D-10 | Per-account application quota (was D-6 in §6) | Product | §1 B-3 |

### 8.11 Final status

**DONE WITH EXPLICIT LIMITATIONS.**

- **Done:**
  - Every reachable defect within AppPort Services' boundaries is fixed and tested on the deployed
    runtimes (Node 18.20.4, Rust 1.88.0): B-1, B-2, B-3 bridge, B-4, B-6, F-03, F-05 and F-04b.
  - Conformance is gated per consumer, with 0 undeclared divergences.
- **Limitations:**
  - Local-mode growth: state, per-call cost and memory (§8.9).
  - The default cache size exceeds the 512 MB VM under sustained writes; this needs D-9 before heavy
    production use.
- **Not done here, by instruction:**
  - Push, release (D-1), dependency upgrade (D-6) and deployment.
  - Changes that alter authority, custody or retention (D-2, D-8, D-9).

---

## 9. Decision follow-up: D-1, D-6, D-9

Scope: only these three decisions. D-2, D-3, D-4, D-5, D-7 and D-10 stay deferred as documented in §8.10.
D-8 blocks webhook creation only if that capability is required. Everything here is a local commit;
nothing was pushed, released or deployed.

### 9.1 D-1: canonical capability references (approved in direction; release not done)

| Check | Result |
|---|---|
| Canonical grammar documented | Added to spec §8.3 (`spec/appport-1.0.md`): canonical decimal `[1-9][0-9]*`, at most 2^53 − 1, one written form per version. appport `76544b0`. |
| Release notes | Unpublished entry at the top of `RELEASE_NOTES.md`: what now fails, how it shows, migration, evidence. Version (minor or major) is left to the release owner per `PUBLISHING.md`. appport `76544b0`. |
| Old and new behaviour in conformance | `capability-name-1` 1.1.0 has 8 `versioned` cases and `appport-ui-1` 1.1.0 has 2. Each carries `change.before` and `change.after`, plus a `history` entry in `expected.json`. |
| Known consumers | See the table below |
| Downstream upgrade | AppWorks and `@appport/services` suites unchanged against the patched build (below) |

**Known consumers of `@appport/protocol`** [read: every `package.json` outside `node_modules`]:

| Consumer | Pin | Uses the changed code? | Effect of a release |
|---|---|---|---|
| AppWorks (8 packages) | `1.2.0` exact | Yes: `claimsFor` and `evaluateFulfillment` (`packages/workspace/src/discovery.ts`) call `parseCapabilityRef` | Only when AppWorks re-pins |
| `@appport/services` | `^1.0.3` | `validateUiContribution`, `filterUiContribution` (`src/runtime/ui.ts`) | **Picked up on the next lockfile refresh** |
| Compute `packages/compute-appport` | `1.0.2` exact | Not found | Only when it re-pins. Its Rust UI validator is gated by the vendored corpus (§8.4). |
| AppBoundry | Its own workspace copy, `@appport/protocol` 1.0.0 | Yes: `packages/cli` calls its own `parseCapabilityRef` | **None.** It does not consume the published package. Aligning it is AppBoundry's own change. |
| AuthBoundry, flow_db | Do not depend on `@appport/protocol` | — | None |
| AppPort's own packages | Exact pins, released together per `PUBLISHING.md` | `@appport/core` resolves claims through protocol | Re-released with it |

Non-canonical spellings in available repositories, searched across all source and JSON: only test inputs.
`feltdb.public.substrate@1.0` in flow_db is a FeltDB contract label and is never parsed as a capability
reference.

**Downstream suites against the patched build:**
- **Method:** the build at `bd70edb` was substituted into each consumer's installed `@appport/protocol` in
  throwaway copies. The consumers' checkouts and `node_modules` were not touched.
  - Built `dist/` differs from published 1.2.0 only in `names.js`, `names.d.ts` and `ui.js`.
  - Resolution was confirmed in each copy: `parseCapabilityRef("a.b@01")` gives `null`.
- **Results:**

| Consumer | Command | Published protocol | Patched |
|---|---|---|---|
| AppWorks `origin/main` `1300c33` | `pnpm install --frozen-lockfile && pnpm build && pnpm test` | 405 passed, 6 skipped; 49/49 | 405 passed, 6 skipped; 49/49 |
| `@appport/services` `c442298` | `npm run build && npm test && npm run test:browser` | 293/293, 13/13 (with 1.0.3) | 293/293, 13/13 (with 1.2.1 + patch) |
| appport `76544b0` | `pnpm test` | — | First run: 1 failure, 1675 passed, 3 skipped (below). Re-run: **1676 passed, 3 skipped** |

The one failure is `spec/test/behavioral-replacement-e2e.test.ts` › "independent Python provider…". It
failed with `TypeError: Cannot read properties of undefined (reading 'status')`.
- The test spawns Python processes and does not touch the changed code.
- It passed 3/3 in isolation and on the full re-run.
- This commit changes only `RELEASE_NOTES.md` and the spec text.
- Recorded as intermittent and unrelated. It was not investigated further.

**Recommendation:**
- The protocol change is ready for release review.
- Before publishing, the release owner chooses the version. Item 1 can make previously accepted input
  fail, so `PUBLISHING.md` asks for a deliberate minor/major call.
- Separately, `@appport/services`'s caret range means its next lockfile refresh adopts the change. Its
  suite passes with it.

### 9.2 D-6: are the "no upgrade needed" assumptions true in deployment?

**Assumption 1: every bridge call carries a per-application tenant string.** [read]
- The bridge has three call sites: `control_routes.rs:792` (snapshot), `:851` (operations) and
  `credential_broker.rs:803`.
- All of them send `"tenant_id": format!("{authority_tenant_id}:{application.id}")`. No path sends a
  caller-supplied tenant.
- The bridge uses `request.tenant_id` for every service call and identifies the principal with the same
  tenant and application.

**Assumption 2: that string is unique per application.** [read]
- Application ids are caller-chosen, can be any non-blank string (including `:`), and are globally
  unique: `create_application` returns 409 `application_exists`.
- Tenant ids are created only at bootstrap from operator configuration (`production.rs`
  `bootstrap_tenant`, CLI `serve`). There is no request path that creates a tenant. The deployment
  configures a single tenant (`fly.toml` `AUTHBOUNDRY_TENANTS = 'default'`).
- With one tenant, `default:<appId>` is unique per application.
- **Residual condition:** two applications could share a string only if an operator configured two
  tenants where one is the other plus `:` and a prefix (for example `a` and `a:b`).
- Recorded as an operating constraint, not changed: tenant ids must not contain `:` when more than one
  is configured.

**Assumption 3: what 0.4.12 fixes is not reachable through the bridge.** [read: `git diff f76a87e
df0afbe -- src`, 0.4.5 → 0.4.12]
- Unchanged between the versions: webhooks, jobs, schedules, notifications and files.
- Changed:
  - **API keys:**
    - **Revoke:** 0.4.5 checks the key's tenant only; 0.4.12 also checks the application (`owns`).
      Covered by assumption 2: the tenant string already encodes the application.
    - **New in 0.4.12:** restrictions, rotation, revoke-all and audit. The bridge does not expose them.
  - **Gateway (`enforceCredential`):** re-validates **API-key-authenticated** principals on every call.
    Bridge principals are `principalType: 'authboundry_session'` (`appport-services.cjs:159`), and
    nothing in AuthBoundry authenticates with services API keys (searched: no `authenticateApiKey`
    caller). Not applicable.
  - **Configuration:** ownership resolution was refactored into a shared function with the same checks.
    No behaviour change.
- The webhook signature corpus is identical on 0.4.5 and 0.4.12 (18/18, §8.4).

**Conclusion:**
- No security property that AuthBoundry relies on today differs between 0.4.5 and 0.4.12. The upgrade is
  not required for safety.
- Keep D-6 as a planned maintenance upgrade. It needs the downgrade check (Q-1) and must not be made just
  to align versions.
- The tenant-id constraint above is the one assumption that configuration could break.

### 9.3 D-9: memory and state growth (decision data; decision not made)

**New measurements:** Node 18.20.4, real bridge.
- Results:
  - `results/closeout/growth-node18.jsonl` and `growth-instances-node18.jsonl` (`bridge/growth-probe.mjs`);
  - `sustained-node18-16x24-cache2-from24mb.*` and `…-cache2-heap256-from24mb.*`.

**Bytes per call:**
- A `snapshot` adds **14.5 KB** of durable state. It makes 7 service reads; that each read records
  evidence is inferred, not traced.
- A write adds 6.4 KB.
- State grows with **page views**, not only with changes.

**One caller, growing state** (cache 1; "state" is the `.appport-services` directory):

| State | `state.json` | Snapshot (cached) | Snapshot (miss) | Write | Child RSS (peak) |
|---|---|---|---|---|---|
| 6 MB | 0 | 45 ms | 200 ms | 22 ms | 148 (153) MB |
| 20 MB | 6.5 MB | 93 ms | 300 ms | 29 ms | 224 (287) MB |
| 36 MB | 13.1 MB | 158 ms | 590 ms | 73 ms | 289 (381) MB |
| 55 MB | 24 MB | 233 ms | 840 ms | 75 ms | 413 (473) MB |

**Per cached application (fresh child):**

| `state.json` | RSS with 1 cached | Added per extra cached application |
|---|---|---|
| ~0 | 89 MB | about 12 MB |
| 12.7 MB | 114 MB | about 26 MB |
| 24 MB | 163 MB | about 42 MB |

**Under load from a 24 MB `state.json`** (16 callers, 24 applications, cache 2):

| Child heap | Throughput | p50 latency | RSS | Timeouts and recycles |
|---|---|---|---|---|
| Default | 1.2–1.5 calls/s | 11–13 s | 348–635 MB | 0 |
| `--max-old-space-size=256` | 1.1–1.4 calls/s, between backoff windows | 12–14 s | 279–324 MB | 5 in 4 min; 503 fast-fail during backoff |

**What this changes in §8.5:**
- The multi-second latencies there were mostly **queueing behind 16 callers**. One caller sees 45–233 ms
  for a cached snapshot over this whole range.
- The real limits are:
  1. **Miss cost.** When more applications are active than are cached, throughput is about 1 / miss
     cost, and the miss cost grows linearly with state (200 → 840 ms).
  2. **Memory.** RSS grows with state even with one application cached, and passes 400 MB at about 55 MB
     of state.
  3. **Growth.** State only grows, about 14.5 KB per page view.
- **No setting fixes this.** `MAX_APPLICATIONS=2` delays the memory limit, and a heap cap bounds memory
  by trading it for timeouts.

**Is the load test representative?** [read]
- Production callers are human-driven, with no polling of this route:
  - the Services page (one snapshot per view, plus one after each action);
  - the Credentials page (one snapshot per selected application);
  - configuration secrets (`credential_broker`).
- Sixteen continuous callers is far above expected interactive load, so queueing will be much smaller.
- State growth per page view is real at any load, and so is memory growth with state.

**Runway, for illustration only:** at 14.5 KB per page view, 1,000 Services/Credentials page views a day
add about 14.5 MB of state a day. The state would reach the measured trouble zone (about 50 MB: misses
near 1 s, RSS 400+ MB) in about three to four days from empty.

The current production state size is unknown here. **The first action is to measure it:**

```sh
du -sh /data/authboundry.appport-services
```

on the Fly volume, together with the child's RSS.

**Options (the decision is yours):**

| Option | Effect | Cost or risk |
|---|---|---|
| A. Pilot on 512 MB with guards: `MAX_APPLICATIONS=2`; alert when the state passes 30 MB, child RSS passes 350 MB, or there are `request_timeout` recycles | Delays the limit; makes it visible | Not safe indefinitely; someone must act on the alert |
| B. Larger VM (e.g. 1–2 GB) | Extends runway roughly linearly in memory | Does not change miss cost or growth |
| C. Evaluate remote FeltDB mode (`FELTDB_URL`, already supported by the bridge) | Unknown: **not measured**. Whether instances still materialize the whole state remotely must be tested before relying on it. | Needs a FeltDB deployment and credentials |
| D. Decide evidence retention in `@appport/services`/FeltDB (compaction, archival, or not recording read evidence) | Addresses growth at the source | Product, audit and retention decision; a dependency change. **Evidence must not be pruned without that policy.** |

**What I'd need from you:**
1. the memory ceiling for the child (proposal: 350 MB on a 512 MB VM);
2. the latency target (proposal: p95 under 2 s at expected concurrency);
3. the current production state size;
4. whether B, C or D is pursued.

Until then, the honest status is: safe for a monitored pilot under option A, **not production-ready for
sustained use on 512 MB local mode.**

### 9.4 Status after this follow-up

| Area | Status |
|---|---|
| Engineering investigation (architecture, conformance, bridge, runtimes) | **Closed** |
| D-1 protocol release | Ready for release review. Not released. |
| D-6 | Not required for safety. Maintenance upgrade later, with Q-1. |
| D-9 | **Blocking production deployment on 512 MB local mode.** Decision inputs listed above. |
| D-2, D-3, D-4, D-5, D-7, D-10 | Deferred as documented |
| D-8 | Blocks webhook creation only if that capability is required |

**Commits in this follow-up (local):**
- appport `76544b0` (spec §8.3, release notes);
- authboundry `3ab5ba2` (sizing documentation);
- experiment: this commit (`bridge/growth-probe.mjs`, `results/closeout/growth-*`,
  `results/closeout/sustained-*-from24mb.*`).
