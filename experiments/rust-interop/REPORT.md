# AppPort Services: Rust Interoperability and Migration Assessment

Date: 2026-10-22. Experimental branch `experiment/rust-interop-assessment` (local worktree
`/home/user/rust-interop-experiment`), never pushed. Nothing in production packages was modified.

Evidence labels used throughout: **[measured]** run in this session; **[code]** read from the
checked-out source; **[estimate]** a judgment with stated basis; **[hypothesis]** untested.

---

## A. Executive recommendation

**Decision: Outcome 2, "Share contracts only", combined with Outcome 1 for the runtime.** Keep AppPort
Services, the protocol package and the SDKs in TypeScript/Node.js. Do not introduce WebAssembly,
Node-API or a Rust service for AppPort logic. Instead, make the protocol's deterministic contracts
language-neutral **conformance corpora**: committed inputs plus the TypeScript oracle's exact output
bytes, run by every implementation that re-implements a contract. FeltDB's `*-contract-wasm` corpora
already establish this pattern in the stack.

Why:

1. **Nothing needs AppPort logic in-process in Rust.** Every Rust consumer reaches AppPort over a
   process or network boundary and is meant to:
   - **Compute** fetches `GET /v1/ui`, and runs `appport-services` as a managed Node service.
   - **Stack-Agent** replays recorded host snapshots, or reaches the host over MCP.
   - **AuthBoundry** runs a Node subprocess bridge to the real `@appport/services` package.

   A shared Rust library would have no in-process Rust caller. [code]
2. **The real problem is unverified drift, not language.** Where AppPort semantics are re-implemented
   in Rust, the copies disagree with TypeScript, and nothing tests them against each other:
   - AuthBoundry's Rust "implementation of the published `@appport/services` contracts"
     (`authboundry/crates/services`) rejects every `@appport/services` webhook signature whose secret
     is ≤ 64 bytes. [measured]
   - Compute's `AppPort/ui/1` validator accepts 2 documents the protocol rejects (it counts Unicode
     scalars, not UTF-16 units). [measured]
   - There are three mutually incompatible capability-name grammars. [code]

   Sharing a binary would fix only the copy that adopts it. A shared corpus checks every copy,
   including the deliberately stricter ones.
3. **The shared-Rust prototype works, but it costs a lot and buys nothing.**
   - A line-by-line Rust port of `validateUiContribution`/`filterUiContribution` matched the
     TypeScript oracle byte for byte on 126 of 127 corpus cases. It ran through WASM in Node and in
     Chromium, and through Node-API. With it swapped in, all 287 `appport-services` tests passed.
     [measured]
   - On the real caller path it is **15–17× slower per call** (13 µs vs 195–230 µs for the services
     contribution). [measured]
   - JSON marshalling across the boundary alone costs as much as the entire TypeScript call (15.7 µs
     vs 13.4 µs). [measured]
   - It adds 85 KB gzip (WASM) or 270–290 KB per platform (Node-API), a Rust toolchain in a
     TypeScript-only CI, and a contract hole for lone UTF-16 surrogates. [measured]

**Do not change:**
- The TypeScript `@appport/protocol` as the owner and oracle of protocol contracts.
- The in-process `createServices` / Express integration API.
- The PEP-in-Services / PDP-in-AuthBoundry split (`src/authority/gateway.ts` → host-supplied
  `ServiceAuthorizer`).
- The HTTP boundary through which Compute and Stack-Agent consume AppPort.
- Compute's deliberately stricter host checks. These are host policy, not drift. The corpus should
  record them as permitted narrowing.

**Do fix (separately, with approval; none of it is Rust-specific):**
- The divergent AuthBoundry `crates/services` webhook/API-key code: retire it, or make it conform.
- The `@appport/services` 0.4.5 pin and the stale scope table in AuthBoundry's bridge.
- Compute's UTF-16 length check.

---

## B. Current architecture (repository-grounded)

### Repository state at start

All six repos were clean on branch `claude/vigilant-maxwell-5sworx`.

| Repo | HEAD | What it is |
|---|---|---|
| `appport-services` | `df0afbe` | `@appport/services` 0.4.12 (TypeScript, about 10.7k LOC in `src/`), `@appport/runtime` 0.4.9, `create-appport` |
| `appboundry` | `42f6335` | AppPort monorepo (`@appport/sdk` 1.1.20, `appport` CLI, private protocol/core/schema/…; `packages/protocol` here is 1.0.0) |
| `authboundry` | `02191c3` | AuthBoundry (Rust workspace of 15 crates, plus npm `@authboundry/core` 1.15.3 shipping prebuilt CLI binaries) |
| `compute` | `b0900fe` | Compute (Rust, 22 crates, including `compute-stack-agent`) |
| `flow_db` | `24db630` | FeltDB (Rust `feltdb`, `feltdb-client`, `feltdb-server`, `feltdb-wasm`, `*-contract-wasm`; TS `@feltdb/core`) |
| `appworks` | `1300c33` | AppWorks (TypeScript, consumes published `@appport/protocol` 1.2.0) |
| `stack-agent` | `456f008` | Cloned read-only for this assessment. Compute pins `e73e74a`. |

Two caveats about source availability:
- `@appport/services` resolves `@appport/protocol` **1.0.3** from npm. That package lives in
  `rkendel1/appport`, which is not checked out here. The local `appboundry/packages/protocol` (1.0.0)
  has no `ui.ts`. The oracle used below is the installed published package.
- AppWorks uses protocol 1.2.0, whose `canonicalize`/`digestOf` source is not in any checkout either.

### Runtimes

| Runtime | Components |
|---|---|
| **Node.js (≥20; CI uses 22)** | `@appport/services`: API keys, webhooks, jobs, schedules, secrets, files, notifications, configuration, intelligence, the `ServiceGateway` PEP, management UI, CLI. Persistence goes through `@feltdb/core` (TS), `express` and `node:crypto`/`http`/`dns`. Also the AppPort CLI and `@appport/core`, plus AuthBoundry's `bridge/*.cjs` sidecars. |
| **Rust** | The AuthBoundry server/PDP (`crates/authz`, `server`), Compute (including its `AppPort/ui/1` consumer), FeltDB server/client, and Stack-Agent (`chip-appport-source`, experiment-only). |
| **Browser / constrained** | `@appport/protocol`, `@appport/schema`, `@appport/client` (browser-safe). `@appport/sdk` targets browser, Node, React Native and Expo. Services' management pages run in the browser (Playwright CI job). FeltDB `@feltdb/core/wasm`. WASM guest apps (`AppBoundry.wasm`, `no_std`). |

### Who owns which semantics [code]

| Concern | Where | Kind |
|---|---|---|
| Capability naming (`isValidName`, `name@N`) | `@appport/protocol` `names.ts` | Determines validity |
| Services capability manifest + digest | `appport-services/src/authority/manifest.ts`: sha256 of `JSON.stringify` of a `localeCompare`-sorted table, "so AuthBoundry can pin the manifest" | Identity. **No consumer computes it.** |
| Discovery vs invocation | `runtime/discovery.ts` (anonymous, grants nothing) vs `authority/gateway.ts` `execute()` | Separated |
| Authorization | Services is the **PEP**. It validates, requires a verified principal, checks tenant/application, re-validates API-key restrictions, then asks the host `ServiceAuthorizer` (AuthBoundry). It never caches. | Enforces. The PDP is in Rust (AuthBoundry). |
| API-key restrictions | `api-keys/restrictions.ts` (`normalizeRestrictions`, `restrictionsPermit`, `restrictionsWithin`) | Authority-narrowing. No Rust counterpart. |
| Effects/evidence | `gateway.execute`: evidence `started` → `succeeded`/`failed`, with an `EffectEvidenceStore`; `evidenceFor` covers effects committed in FeltDB transactions | Distinguishes attempted from committed |
| Webhook signatures | `webhooks/secrets.ts`. Outbound: HMAC-SHA256(secret, body). Inbound: HMAC-SHA256(secret, `ts.body`) with replay store. | Security contract |
| UI contribution | `@appport/protocol` `ui.js` (`validateUiContribution`, `filterUiContribution`), used by `runtime/ui.ts` | Discovery contract |

### Transport vs. policy

**Transport only:**
- `runtime/http-adapter.ts`, `express-middleware.ts`, `management-host.ts`.
- AuthBoundry `crates/server/src/appport_services.rs`, which spawns `node bridge/appport-services.cjs`,
  serialized under a Mutex, with string errors.
- Compute `managed.rs`, which runs `appport-services` on bundled Node.

**Policy or outcome-determining:**
- `gateway.ts`, `restrictions.ts`, `principal.ts`, `destination.ts` (SSRF/DNS pinning).
- Webhook verify/replay, `evidence.ts`.
- AuthBoundry's `crates/authz`.
- Compute's `service_ui.rs` host checks.

### Cross-language duplication [code + measured]

| Semantic | TypeScript | Rust | Verified equal? |
|---|---|---|---|
| `AppPort/ui/1` validation | `@appport/protocol` `ui.js` | `compute/crates/compute-environment/src/service_ui.rs` ("mirrors validateUiContribution… fixtures pin the two together") | **No.** Two fixtures, checked on the Rust side only. 2 measured over-acceptances (§F). |
| Webhook signing / API keys | `appport-services/src/webhooks/secrets.ts`, `api-keys/service.ts` | `authboundry/crates/services/src/lib.rs` ("AuthBoundry implementations of the published `@appport/services` contracts"), re-exported by `crates/boundary` | **No.** Incompatible (§F). |
| Capability-name grammar | `names.ts` | `authboundry/crates/contract/src/invariant.rs:66` (`service@version.operation`), `crates/server/src/control_routes.rs:876` (allows `_ - A-Z`, string versions) | **No.** Three grammars. |
| Services catalog | `authority/manifest.ts` (0.4.12) | `authboundry/crates/dsl/src/model.rs:485` hard-codes the 0.4.5 operations | No |
| Canonical JSON | At least 5 TS variants in appboundry (`localeCompare` vs UTF-16 sort, `undefined` rules) plus RFC 8785 in protocol 1.2.0 | `compute-state/src/snapshot.rs` (a FeltDB port), FeltDB serde `BTreeMap` | FeltDB ADR says by design they need not match |

Shared contracts that already work:
- FeltDB's deterministic-contract corpora (native Rust ≡ independent WASM ≡ V8, byte for byte).
- `feltdb-client`, which shares Rust wire types by crate.
- AppWorks reusing `@appport/protocol` digests rather than re-implementing them.
- Stack-Agent comparing host-advertised fingerprints as opaque strings (it never recomputes them).

### External packages and guarantees

`@appport/services` 0.4.x, `@appport/runtime`, `@appport/sdk`/`appport` 1.1.x and `@appport/protocol`
are published on npm, ESM, with no `engines` field in services. Consumers:
- AuthBoundry pins `@appport/services` **0.4.5** and `@appport/core` 1.0.2.
- Compute's configured distribution bundles `@appport/*`.
- AppWorks uses protocol 1.2.0.

`appboundry` keeps API snapshots (`release/api/*.json`). The services publish script refuses to publish
against an unpublished protocol range.

### Build, test, release

| Repo | CI and release |
|---|---|
| Services | CI: ubuntu, Node 22, `npm ci`, `npm test` (tsc, then 287 `node:test` tests), Playwright browser job. No Rust. Publish via `scripts/publish-packages.sh`. |
| appboundry | CI: Node 22 plus Python/Java/COBOL conformance. No Rust toolchain in CI. Committed `.wasm` guests. |
| AuthBoundry | 4-OS release matrix producing CLI binaries in `@authboundry/core-<plat>`. Docker image bundles Node for the bridges. |

### Observed operational costs and failure modes of the Node implementation [measured/code]

- Baseline `npm ci`: 2.6 s. `npm test`: 287/287 pass in 4 m 40 s wall (48 s CPU; mostly timers/IO).
  [measured]
- `DOGFOOD_REPORT.md` contains no benchmarks. No performance incident or Node-specific failure is
  recorded in any repo. [code]
- The concrete operational weaknesses are integration seams, not the runtime:
  - AuthBoundry's bridge is a single serialized child process. A crash surfaces as a string error,
    with no restart logic visible in `appport_services.rs`.
  - It pins a stale package version.
  - It carries pre-migration scope names (`files.read:any`, `schedules.write`, …) that
    `LEGACY_SCOPE_MIGRATION` says grant nothing. They are inert, because the bridge's authorizer is
    allow-all on the documented basis that AuthBoundry decided upstream.

---

## C. Candidate inventory

Classes:
- **A**: Keep in TypeScript/Node.
- **B**: WASM.
- **C**: Node-API.
- **D**: Native Rust service.
- **E**: Another approach (here, contract corpus / conformance).

| Module (location) | Det.? | Node/IO needs | Rust equivalent? | Sharing removes duplication? | Class | Rationale |
|---|---|---|---|---|---|---|
| `AppPort/ui/1` validate/filter (`@appport/protocol` `ui.js`; `services/src/runtime/ui.ts`) | Yes | None (browser-safe) | Yes, Compute `service_ui.rs` (stricter by design) | No: Compute keeps its host checks and HTTP fetch, so it would not drop its copy | **E** (A for runtime) | Experiment target. A corpus caught Compute's drift. A shared binary was slower and fixed nothing for Compute. |
| Capability-name grammar (`names.ts`) | Yes | None | Two divergent AuthBoundry grammars | Partly | **E** | Publish a name corpus. AuthBoundry's grammars are partly different concepts (`service@version.operation`), so a shared function would not fit them all. |
| Services capability manifest + digest (`authority/manifest.ts`) | Yes | `node:crypto` (sha256 only) | AuthBoundry hard-codes a 0.4.5 catalog | Yes, if AuthBoundry pinned the digest | **E** | Ship `capabilities.json` (already in `docs/`) and the digest vector. The digest depends on `JSON.stringify` key order and a `localeCompare` sort, so it must be specified before anyone re-implements it. |
| Webhook sign/verify (`webhooks/secrets.ts`) | Yes | `node:crypto` | AuthBoundry `crates/services` (incompatible) | Yes, but only on the receiving side; the TS sender stays | **E** | Test vectors (made in this assessment) suffice. HMAC is a standard primitive, so sharing code buys nothing. |
| API-key restrictions (`api-keys/restrictions.ts`) | Yes | None | None | n/a | **A**, plus a corpus if AuthBoundry ever evaluates them | Authority-narrowing and security-sensitive. No second consumer today. Note: attribute keys are sorted with `localeCompare` (locale-dependent). |
| API-key issue/verify (`api-keys/service.ts`, scrypt/HMAC) | Mostly | `node:crypto`, FeltDB | AuthBoundry `crates/services` (sha256, different format) | No | **A** | Rust copy is not a port. Retire or document it as a separate AuthBoundry format. |
| `ServiceGateway` PEP, evidence (`authority/*`) | No (async, IO) | FeltDB, AuthBoundry client | PDP in Rust (different role) | No | **A** | Moving the PEP would put a second enforcement point beside the PDP. |
| Webhook delivery, destination policy (`webhooks/service.ts`, `authority/destination.ts`) | No | `http`, `https`, `dns`, `net` | None | No | **A** | IO-bound, Node ecosystem. WASM cannot reach the network. |
| Jobs/schedules/notifications/files/configuration/intelligence services | No | FeltDB, timers | None | No | **A** | Domain/IO logic, 287 tests, in-process API. |
| Runtime/HTTP/Express/management UI/CLI | No | express, fs, http | None | No | **A** | Pure Node integration. |
| Whole Services package for AuthBoundry | No | — | Bridge subprocess today | Would remove the Node sidecar from AuthBoundry's image | **D**: not now (see §G) | Smallest next experiment: measure the bridge (§G). |

Specific question: is shared runtime implementation needed? **No.** Every cross-language case found is
a validator or a signature that a second consumer re-implements, often deliberately stricter. Shared
fixtures plus a byte-exact oracle cover these, and they also catch the stricter re-implementations that a
shared binary would not replace. Generated types would not have caught any of the measured
divergences. Every one of them is behavioural: length units, integer domain, key derivation, signed
message.

---

## D. Prototype and test results

**Target:** `validateUiContribution` / `filterUiContribution` / `isValidName` from `@appport/protocol`
1.0.3, as `@appport/services` uses them in `src/runtime/ui.ts`.

Selection criteria it meets:
- It has a TS reference.
- It is deterministic.
- It is a discovery contract (not the most security-sensitive module).
- It is small (109 lines).
- An independent Rust re-implementation already exists (Compute).
- There is a real cross-language seam (HTTP `GET /v1/ui`).

### What was built (`experiments/rust-interop/`)

| Variant | Included? | Notes |
|---|---|---|
| TS baseline | yes | The oracle (`node/oracle.mjs`) |
| Rust → WASM | yes | `crates/ui-contract-wasm`: raw `wasm32-unknown-unknown` ABI (`ui_alloc` / `ui_handle` / `ui_free`, **zero imports**), FeltDB's pattern. wasm-bindgen was not used (it adds a JS glue generator and gives this boundary nothing). Not measured. |
| Rust → Node-API | yes | `crates/ui-contract-napi`: napi-rs 2, `handle(json) -> json` |
| Native Rust service | no | A stateless validator as a network service would put a network hop and a process on a 13 µs function. AuthBoundry's services bridge is the only plausible service-level case (§G). |
| Existing Rust (Compute) | yes, as an observer | `conformance/compute-observer` compiles Compute's **unmodified** `service_ui.rs` via `#[path]` and calls its public `discover()` over real HTTP for every corpus document |
| AuthBoundry webhook verifier | yes, as an observer | `conformance/webhook-signature` links AuthBoundry's **unmodified** `crates/services` and feeds it signatures made by `@appport/services`' own signer |

The port is `crates/ui-contract/src/lib.rs`. Faithfulness to the oracle required each of the following:
- Check order.
- Error code, message and `details`.
- UTF-16 length.
- `Number.isInteger`.
- Emulation of ECMAScript `String(value)`, including the **JS `TypeError` the TS reference throws** for
  `{"protocol":{"toString":"x"}}`. This is reproduced as a non-protocol failure; a server sanitizes it to
  `INTERNAL_ERROR`.
- Output key order (`serde_json` `preserve_order`).
- JS number spelling (`ryu-js`).

### Differential corpus

`fixtures/ui-contract-corpus.json` holds 127 cases (52 accepted, 75 rejected), generated by
`node/make-corpus.mjs` from the live oracle. It covers:
- Real documents: Compute's fixtures from services 0.4.10, and services 0.4.12 output.
- Boundaries at 512 and 513, and at 128 and 129.
- Empty, missing and wrong-type fields.
- Unicode: astral characters, NFC vs NFD (kept verbatim, never normalized), controls, escaped pairs,
  lone surrogates.
- Every name rule.
- Hostile routes.
- Error ordering with several defects.
- Wire quirks: duplicate keys, `__proto__`, raw numbers `20.0`, `2e1`, `-0`, `9007199254740993`, `1e400`.
- 64, 65 and 1000-surface documents.
- 6 filter cases.

### Results [measured]

| Test | Result |
|---|---|
| Recorded corpus still equals the live TS oracle (regression lock on the TS contract) | pass |
| Native Rust vs oracle, byte for byte | **126/127**. 1 documented: lone surrogate. |
| WASM in Node vs oracle | 126/127 (same one), and identical on repeat |
| Node-API vs oracle | 126/127 (same one), and identical on repeat |
| WASM in **Chromium 141** (Playwright, real browser) vs oracle | 126/127 (same one) |
| Malformed request bytes into WASM | error envelope, no trap |
| WASM linear memory after 500 calls on the 1000-surface document | no growth after the first call |
| `appport-services` UI suites (41 tests) with WASM swapped in via a module hook | 41/41. Hook log confirms 47 validate and 14 filter calls went through Rust. |
| Same, Node-API swapped in | 41/41 (61 calls via Rust) |
| **Full `appport-services` suite (287) with WASM swapped in** | **287/287** (121 calls via Rust) |
| Full suite, unmodified (baseline) | 287/287 |
| Mutation check (10 plausible porting mistakes, `scripts-mutation.sh`) | **10/10 caught**, all compiled |
| Rebuild from clean target | bit-identical `.wasm` and `.node` (same machine and path) |
| Compute's real validator vs oracle (117 validate cases) | 103 agree, 16 Compute-stricter, **2 Compute-more-lenient** (§F) |
| AuthBoundry Rust webhook verifier vs `@appport/services` signatures | **rejected for secrets ≤ 64 bytes**, accepted only above 64 (§F) |

### Failed attempts and iterations (kept, not hidden)

- **First port:** it differed on four raw-number inputs (`20.0`, `2e1`, `-0`, `2^53+1`): Rust echoed
  the input spelling, while JS re-spells the number.
  - Fixed by JS-number re-spelling. The "no JS number respelling" mutation shows the corpus catches
    this.
- **Lone surrogate:** the first corpus could not even be loaded by `serde_json`, because a lone
  surrogate in an expected result cannot exist in a Rust `String`.
  - The corpus now stores only serialized expectations.
  - The surrogate case is a permanent, asserted divergence of any UTF-8 JSON boundary.
- **Browser compile hypothesis (refuted):** I predicted Chromium would forbid synchronous
  `new WebAssembly.Module` for a 218 KB module on the main thread. That would have forced an async API
  and broken the synchronous `validateUiContribution`. Chromium 141 allowed it. Firefox and Safari were
  not tested.
- **Ablation:** dropping `preserve_order` and `arbitrary_precision` makes the port only about 20%
  faster, and it then fails the byte-equality test.

### Reproduce

```sh
cd /home/user/rust-interop-experiment            # worktree; node_modules is a symlink to the main checkout's
npx tsc -p tsconfig.json                         # builds dist/ (gitignored)
cd experiments/rust-interop
node node/make-corpus.mjs                        # regenerate corpus from the TS oracle
cargo test --release -p appport-ui-contract      # native vs corpus
cargo build --release -p appport-ui-contract-wasm --target wasm32-unknown-unknown
cargo build --release -p appport-ui-contract-napi
cp target/wasm32-unknown-unknown/release/appport_ui_contract_wasm.wasm build/ui-contract.wasm
cp target/release/libappport_ui_contract_napi.so build/ui-contract.linux-x64-gnu.node
node --test node/differential.test.mjs           # TS vs WASM vs Node-API
node --test node/browser.test.mjs                # Chromium
RUNS=5 ITERATIONS=20000 node node/bench.mjs      # benchmarks -> results/bench.json
./scripts-mutation.sh                            # mutation check
(cd conformance/compute-observer && cargo build --release) && \
  target/compute-observer/release/compute-ui-observer fixtures/ui-contract-corpus.json > results/compute-observer.jsonl && \
  node node/compare-compute.mjs
node node/make-webhook-vectors.mjs && (cd conformance/webhook-signature && cargo test --release -- --nocapture)
# services suite through Rust:
cd ../.. && APPPORT_UI_RUST=wasm NODE_OPTIONS="--import=$PWD/experiments/rust-interop/node/swap-register.mjs" \
  node --test --test-concurrency=1 'dist/tests/**/*.test.js'
```

---

## E. Benchmark report

### Environment

| | |
|---|---|
| Machine | 4-core Intel Xeon @ 2.80 GHz, 16 GB, Linux x64 cloud container (shared tenancy: absolute numbers are noisy) |
| Toolchain | Node v22.22.0, rustc 1.97.0, release profile with LTO and `codegen-units=1` |

### Method

- `node/bench.mjs` runs each variant in **its own fresh process**, interleaved, **5 runs × 20,000
  timed calls** (400 for the 1000-surface document), after 2,000 warm-up calls.
- Reported values are the median across runs of per-call p50/p95, timed with `performance.now()`.
- Cold start: 20 fresh processes per variant, each covering import + init + one caller-path call.
- Raw data: `results/bench.json`. Text: `results/bench.txt`.
- The **complete caller path** is measured:
  - For WASM/Node-API that is `JSON.stringify` → copy → Rust parse/validate/serialize → `JSON.parse`
    → rethrow as `AppPortError`.
  - "validate+filter" is what `createUiDiscoveryDocument` does. The Rust filter must re-validate,
    because nothing validated can be held across the boundary.

### Per-call latency, p50 / p95 µs (median of 5 runs) [measured]

| Workload | TS | WASM | Node-API |
|---|---|---|---|
| validate, anonymous `/v1/ui` (1 surface) | 1.3 / 2.4 | 16.8 / 34.6 | 13.3 / 20.6 |
| validate+filter, anonymous | 1.6 / 2.6 | 36.5 / 75.9 | 29.8 / 58.1 |
| validate, services full (10 surfaces) | 12.6 / 24.3 | 94.0 / 198.5 | 102.1 / 204.9 |
| **validate+filter, services full (real caller path)** | **13.4 / 27.6** | **194.6 / 385.8** | **230.0 / 436.6** |
| validate, 64 surfaces | 48.3 / 103.9 | 532.4 / 1011.8 | 550.9 / 1060.3 |
| validate+filter, 64 | 48.8 / 95.9 | 1034 / 1930 | 1134 / 2064 |
| validate, 1000 surfaces (172 KB) | 854 / 1523 | 10518 / 18105 | 11123 / 18606 |
| rejected (bad capability) | 7.1 / 10.1 | 20.5 / 40.4 | 18.0 / 31.8 |
| **JS marshalling only** (stringify in + parse out, no Rust), full | **15.7** / 25.8 | — | — |
| JS marshalling only, 1000 surfaces | 1578 / 2903 | — | — |

### Native Rust, no JS boundary (`examples/native_bench.rs`, p50) [measured]

| Document | p50 |
|---|---|
| 1 surface | 8.2 µs |
| services full | 75.6 µs |
| 64 surfaces | 379 µs |
| 1000 surfaces | 7.1 ms |

The 1000-surface breakdown: parse 2.4 ms, validate 3.9 ms, serialize 0.6 ms. `serde_json::Value`
allocates per node, and V8's `JSON.parse` and object model are faster for this dynamic-document
workload.

### Startup, memory, size and build [measured]

| | TS | WASM | Node-API |
|---|---|---|---|
| Cold process (whole) | 43.9 ms | 57.0 ms | 47.4 ms |
| Module load/init in process | 10.9 ms | 12.5 ms | 11.9 ms |
| First caller-path call | 1.1 ms | 5.2 ms | 0.5 ms |
| RSS after the run | 97.7 MB | 117.2 MB | 104.8 MB |
| Artifact | `ui.js` + `names.js` + `errors.js` = 13.3 KB (4.5 KB gzip) | 218 KB (85.7 KB gzip) | 617 KB / 511 KB stripped (270–292 KB gzip), **per platform** |
| Clean build | tsc (services, whole) 6.0 s | 6.7 s | 20.9 s |
| Runtime deps | none | none (no imports) | glibc ≥ 2.34 (from `objdump`), so it fails on older glibc and on musl without separate builds |

Bare Node cold process: 27.7 ms.

### Interpretation

- **The Rust variants lose on every workload** (2.5× on the cheapest rejection, up to 22× on the 1-surface caller path). The structural reason, not port quality: for the real
  document, marshalling alone (15.7 µs) already exceeds TS's entire validate+filter (13.4 µs). Even an
  infinitely fast Rust function could not win at this boundary.
- **A different boundary would not change the outcome.** For example, Node-API walking JS objects
  directly instead of JSON: about 60 property reads for the real document. [estimate]
- **Performance does not matter anyway.** The function runs once per `GET /v1/ui` and at module load,
  and 13 µs is immaterial next to an HTTP request.

### Limitations

- A shared, noisy container: p95 values vary about 2× between runs.
- One OS and architecture. Node-API builds for darwin, arm64 or musl were not attempted.
- Firefox and Safari were not tested.
- wasm-bindgen was not measured.
- The Rust port was not optimized beyond removing one O(n²) loop. A typed, borrowing parser might be
  2–5× faster natively [hypothesis], which still could not overcome the marshalling floor.

---

## F. Compatibility and security findings

### Behavioural differences: Rust port vs TS oracle [measured]

The only remaining divergence is the **lone UTF-16 surrogate**.
- JavaScript accepts `"\ud800"` in any string field.
- A UTF-8 JSON boundary (`serde_json`, a Rust `String`) cannot represent it, so the Rust side fails with
  `SyntaxError`.
- This is permanent for any WASM or Node-API port that uses JSON text.
- It is asserted in the tests, so any *new* divergence fails.

**Domain narrowing across the boundary [code].** The TS function accepts any JS value (getters,
prototypes, `Date` objects in `entities`, `undefined`). Through `JSON.stringify` these become JSON:
- `Date` becomes a string.
- `undefined` fields disappear.
- `NaN` becomes `null`.

The wire output of `GET /v1/ui` is unaffected, but in-process callers would see different object types.

### Existing cross-language drift found [measured]

1. **AuthBoundry `crates/services` vs `@appport/services` webhooks** (`results/webhook-signature.txt`).
   - The Rust verifier keys HMAC with `sha256(secret)`. `@appport/services` keys with the raw secret.
   - Standard HMAC hashes only keys over 64 bytes, so the two agree only when the secret exceeds
     64 bytes:

     | Secret bytes | 1 | 17 | 33 | 64 | 65 | 66 | 101 |
     |---|---|---|---|---|---|---|---|
     | Verdict | Invalid | Invalid | Invalid | **Invalid** | accepted | accepted | accepted |

   - The Rust code has no notion of the inbound `x-appport-timestamp` scheme.
   - Its replay key is `endpoint:delivery_id` in memory, vs the durable `sha256(integration:eventId)`.
   - API keys differ too: `abk_…`/sha256 vs `app_live_…`/scrypt or hmac-scrypt. [code]
   - Impact: the crate is re-exported but has no callers in this checkout. **Latent, not live.** [code]
   - It is documented as implementing the published contract, which it does not.
2. **Compute `service_ui.rs`, more lenient than the protocol in 2 cases.**
   - Titles of 257 and 400 astral characters (514 and 800 UTF-16 units) are accepted, because the
     length check counts Unicode scalars.
   - Low severity: text is rendered as text, and links are built, not copied.
   - This is a real contract violation, invisible to its two-fixture pin.
3. **Compute, stricter in 16 cases.** Permitted host narrowing:
   - Routes containing `..`, whitespace, `\`, `?`, `#` or controls.
   - More than 64 links.
   - Composition needs context Compute lacks.

   Unintended over-rejections of valid documents:
   - `order` as `1e21`, `20.0`, `2e1` or `-0` (it uses `as_i64`).
   - Documents with numbers beyond f64 range, or lone surrogates (`serde_json` refuses them).
4. **The protocol itself accepts routes Compute considers unsafe** (`/ok/../../escape`, `/a?x=1`).
   - Not a vulnerability in Compute, which re-checks.
   - Every other host must also re-check. Worth a protocol-level decision.
5. **Within TypeScript:** outbound webhook signatures (HMAC over the body) and inbound verification
   (HMAC over `ts.body`) are different, documented schemes (`README.md`, `docs/WEBHOOK-SECURITY.md`).
   One AppPort service cannot verify another's delivery with `receiveWebhook`. Intentional or not, it
   needs a corpus entry that says so.
6. **The TS reference throws a raw `TypeError`** for a `protocol` object with its own `toString` key. An
   AppPort server turns this into `INTERNAL_ERROR` rather than `INVALID_PROTOCOL`. Minor protocol-level
   bug. The port reproduces it, bug-compatibly; it should be fixed in TS first.

### Authority invariants per option [code]

| Invariant | TS (keep) | WASM | Node-API | Rust service |
|---|---|---|---|---|
| Capability identity/canonicalization | unchanged | identical output (126/127) | same | would need re-implementation |
| Discovery vs invocation | unchanged | unchanged (the validator authorizes nothing) | same | risk: a new service boundary between PEP and resources |
| Authority checks / least privilege | PEP in services, PDP in AuthBoundry | unchanged | unchanged | a second enforcement point or a moved PEP; Rust rewrite of `gateway.ts` |
| Effects/evidence, attempted vs committed | `started`/`succeeded`/`failed` + `evidenceFor` | n/a | n/a | must be re-proven |
| Denied ≠ success | `AppPortError`s preserved | preserved, rethrown with code and details | same | must be re-proven |

New risks by option:
- **WASM:** a zero-import module has no host capability, the smallest possible surface.
- **Node-API:**
  - Native code in the server process; `unsafe` at the ABI.
  - A per-platform binary supply chain.
  - glibc floor.
  - A crash takes down the Node process instead of throwing.

No memory-safety benefit can be claimed for Rust here. The ported code has no memory-unsafe TS
counterpart (it is pure JS), and no vulnerability class in the current code path is removed.

### Unresolved

- The protocol 1.0.3 and 1.2.0 source (`rkendel1/appport`) was not inspected.
- AuthBoundry `crates/services` has no callers here. Other consumers (published crate
  `appport-auth-mesh-services`?) were not checked.
- The AuthBoundry bridge was not load-tested.

---

## G. Decision matrix

Scores run 1–5 (5 is best), with the default weights. Confidence: H/M/L.

| Criterion (weight) | A: Keep TS (as is) | E: TS + shared conformance corpora | B: Rust → WASM lib | C: Rust → Node-API | D: Rust service |
|---|---|---|---|---|---|
| Correctness (25%) | 4: is the oracle; drift elsewhere undetected (H) | 5: locks TS contract; detected 3 drifts; mutation-proven (H) | 4: 126/127, surrogate hole, domain narrowing (H) | 4: same (H) | 2: 10.7k LOC and 287 tests to re-prove (M) |
| Architecture fit/reuse (20%) | 3: duplication unmanaged (H) | 5: fits the FeltDB precedent; covers stricter re-implementations (H) | 2: no in-process Rust consumer (H) | 1: Node-only, protocol package is browser/RN (H) | 2: relocates logic; TS SDK and in-process API remain (M) |
| Security/authority (15%) | 4 (H) | 5: makes webhook/name semantics testable cross-language (M) | 4: zero-import sandbox; new toolchain in supply chain (M) | 3: native ABI, crash surface (M) | 2: second enforcement point risk (M) |
| Maintenance/ops (15%) | 5 (H) | 4: fixtures to bless and version (H) | 2: Rust in TS-only CI, dual ownership (H) | 1: platform build matrix (H) | 1: new service to run and debug (M) |
| Integration/distribution (10%) | 5 (H) | 5: no consumer change (H) | 3: +85 KB gzip; works in Node and Chromium (H) | 1: per-platform binaries, glibc ≥ 2.34 (H) | 1: breaks in-process `createServices` (H) |
| Measured performance (10%) | 5 (H) | 5 (H) | 1: 2.9–22× slower; 14.5× on real path (H) | 1: 2.5–18× slower; 17× on real path (H) | 3: unmeasured (L) |
| Portability (5%) | 5 (H) | 5 (H) | 4 (M) | 1 (H) | 3 (L) |
| **Weighted total** | **4.20** | **4.85** | **2.90** | **2.05** | **1.90** |

### Disqualifiers

- **C (Node-API) for `@appport/protocol` or the SDK:** it cannot run in browsers or React Native/Expo.
  That is a contract break for published consumers.
- **D (Rust service):** it cannot preserve the published in-process API (`createServices`, Express
  middleware) without keeping the TS package, so it fails "existing contracts must remain compatible".
- **B:** not disqualified. It simply has no beneficiary.

### Trade-offs hidden by the totals

- E's score assumes the corpora are owned by `@appport/protocol` and run in each consumer's CI. If
  nobody runs them in AuthBoundry or Compute CI, E collapses to A.
- B is competitive on correctness. Were there an in-process Rust consumer with a large hot loop, the
  matrix could flip for that one module.

### Confidence

- High that Rust runtime sharing is not justified for the UI contract and similar validators.
- Medium for the service-level question, which hinges on AuthBoundry's bridge.

### Smallest next experiment that could change the decision

Load-test and fault-inject AuthBoundry's `bridge/appport-services.cjs` path:
- p95 latency and throughput under concurrent control-plane calls through the single Mutex-serialized
  child.
- Behaviour on child crash or hang.
- Upgrade from 0.4.5 to 0.4.12.

If the bridge proves a real bottleneck or reliability problem, compare:
- (a) an HTTP or long-lived JSON-RPC boundary to a normal `appport-services` process;
- (b) moving a narrow responsibility (for example API-key verification for AuthBoundry's own use)
  into Rust, guarded by the corpora.

Only (b) would be a Rust migration, and only for that responsibility.

---

## H. Migration plan: not recommended. The lower-cost alternative instead

Each step is separately approvable. No version changes to published behaviour unless noted.

1. **Corpus home.** Add `conformance/contracts/` to the protocol repo (`rkendel1/appport`), following
   FeltDB's layout. Each corpus has:
   - inputs as raw JSON text;
   - the oracle's `expectedJson` bytes;
   - a blessing script that refuses to bless unless the TS oracle produced the output;
   - an explicit list of permitted narrowings per consumer.

   Start with:
   - `ui-contract-corpus.json` (this experiment's 127 cases, plus generator);
   - a capability-name corpus;
   - a webhook signature vectors corpus covering both outbound and inbound schemes, secrets around the
     64-byte boundary, and Unicode bodies;
   - services manifest `capabilities.json` plus `serviceCapabilityManifestDigest()` vector.

   Acceptance: the TS oracle passes in protocol CI.
2. **Compute.** Run the UI corpus against `service_ui::interpret` in `cargo test`, through a small
   test-only seam or via `discover()` as this harness does. Fix:
   - UTF-16 length;
   - `Number.isInteger` semantics for `order`, or declare them as narrowing in the corpus.

   Acceptance: 0 unexplained divergences.
3. **AuthBoundry.**
   - Decide whether `crates/services` is meant to verify `@appport/services` signatures. If yes, make
     it pass the vectors. If no, rename it and remove the "implementations of the published contracts"
     claim.
   - Run the name corpus against `normalize_contract_capabilities` / `declares_appport_capability`, or
     document those grammars as distinct.
   - Bump the bridge to the current services version and drop the legacy scope names.
4. **TS fixes, in a protocol release.**
   - Make `String(protocol)` safe so the hostile case returns `INVALID_PROTOCOL`.
   - Decide on route strictness (Compute's rules are a good candidate).
   - Specify the manifest digest serialization: don't depend on `JSON.stringify` insertion order or
     on `localeCompare`.

   These are contract changes and need a version decision.
5. **Rollback.** Corpora are additive test assets. Removing one restores the status quo, with no
   runtime artifact to roll back.

### Acceptance for the whole programme

Every Rust re-implementation of an AppPort contract either:
- passes the corpus byte for byte; or
- appears in the corpus's declared-narrowing list.

Any change to a TS contract fails protocol CI until the corpus is re-blessed deliberately.

---

## I. Exact repository state

### Worktree and branch

- Worktree `/home/user/rust-interop-experiment`, branch `experiment/rust-interop-assessment`, created
  from `appport-services` `df0afbe`.
- Local commits only. **Nothing was pushed, published or PR'd.** No production file was modified in
  any repository.
- `node_modules` in the worktree is a symlink to the main checkout's install. It is excluded via the
  local `.git/info/exclude` only.

### Other repositories

- `appboundry`, `authboundry`, `compute`, `flow_db` and `appworks`: unmodified; read, or compiled
  as path dependencies into `target/` under the experiment.
- `appport-services` main checkout: `npm ci` and `npm test` produced `node_modules/` and `dist/`, both
  gitignored. Status is clean.
- `stack-agent`: shallow read-only clone at `/home/user/rkendel1/stack-agent` (`456f008`).

### Files added, all under `experiments/rust-interop/`

| Path | Contents |
|---|---|
| `Cargo.toml` | Experimental workspace |
| `crates/ui-contract/` | Port, corpus test, `examples/native_bench.rs`, `phases.rs` |
| `crates/ui-contract-wasm/` | Raw-ABI WASM binding |
| `crates/ui-contract-napi/` | Node-API binding |
| `conformance/compute-observer/` | Compute's unmodified `service_ui.rs` over HTTP |
| `conformance/webhook-signature/` | AuthBoundry `crates/services` vs services signatures |
| `node/oracle.mjs`, `make-corpus.mjs`, `bindings.mjs` | Oracle, corpus generator, bindings |
| `node/differential.test.mjs`, `browser.test.mjs` | Differential and Chromium tests |
| `node/bench.mjs`, `bench-worker.mjs` | Benchmarks |
| `node/swap-loader.mjs`, `swap-register.mjs`, `protocol-shim.mjs` | Production-untouched module swap |
| `node/compare-compute.mjs`, `make-webhook-vectors.mjs` | Conformance helpers |
| `scripts-mutation.sh` | Mutation check |
| `fixtures/ui-contract-corpus.json`, `webhook-signature-vectors.json` | Corpora |
| `results/` | `bench.json`, `bench.txt`, `build-times.txt`, `compute-observer.jsonl`, `compute-vs-oracle.json`, `webhook-signature.txt`, `mutation.txt`, `reproducibility.txt`, `services-suite-wasm-swap.txt` |
| `build/` | `ui-contract.wasm`, `ui-contract.linux-x64-gnu.node`, `ui-contract.stripped.node`: binary artifacts, committed for reproducibility of the reported numbers |
| `REPORT.md` | This report |

`target/` is gitignored.

### Tests executed

| Suite | Result |
|---|---|
| `appport-services` `npm test` | 287/287 |
| Full suite with WASM swap | 287/287 |
| UI subset with WASM swap | 41/41 |
| UI subset with Node-API swap | 41/41 |
| `cargo test` corpus | pass |
| `node --test differential` | 5/5 |
| `node --test browser` | 1/1 |
| Mutation check | 10/10 caught |
| Compute observer | 117 documents compared |
| Webhook vectors | 7 secrets × 2 schemes |
| Benchmark | 5 × 3 processes + 80 cold starts |
