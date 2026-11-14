# WorkRelay development handoff

**Repository:** `ToheebOsie/WorkRelay`  
**Baseline inspected:** `e67baf8` (source archive; uploaded ZIPs do not include `.git` metadata)  
**Current accepted product baseline:** Steps 1–7 Increment 5 and Step 6 browser QA are accepted. The NEAR escrow contracts below are a source draft only; local WASM/Sandbox acceptance is not complete.

## Hackathon scope decision

The owner has explicitly narrowed the remaining hackathon work. Step 7 Increment 5 is frozen as the current evidence-quality baseline; do not continue publisher-governance increments before the NEAR escrow proof. The nine Nigeria fintech publisher candidates remain inactive.

The three product modes are: (1) complete no-wallet Sandbox; (2) optional, separately entered, user-signed NEAR testnet proof using a WorkRelay-controlled test FT; and (3) Live Agent Market discovery/quotes/task inspection only where permitted, unpaid. Live Agent Market commissioning/payment and mainnet remain out of scope. A testnet escrow payment is not payment to an Agent Market provider.

## Phase status

- Steps 1–5 core workflow and schema/evidence/dependency implementation are accepted.
- Step 6 browser QA is accepted and closed based on operator-local browser QA and operator-confirmed native Windows regression run. See `docs/BROWSER_QA_REPORT.md`.
- Step 7 Increment 5 is accepted by the operator on Windows: 220 tests pass and all nine publisher candidates validate while remaining inactive. Treat this as the hackathon evidence baseline; additional publisher governance is deferred.
- **NEAR escrow contracts compile, but Sandbox acceptance remains pending:** `contracts/job-escrow`, `contracts/workrelay-test-token` and `contracts/integration-tests` are present. The operator reports that on Rust 1.97.0 the host gate passed (JobEscrow 5/5 and WRT 4/4 unit tests), both WASM contracts built (419 KB and 283 KB), and integration-crate Clippy passed. The local Sandbox integration tests have not executed because the `near-sandbox` binary download was blocked. See `docs/NEAR_ESCROW_IMPLEMENTATION_REPORT.md`.
- Optional user-signed browser testnet mode follows only after the local contract gate passes.
- Operational hardening and production paid execution are not prerequisites for the hackathon testnet proof and remain deferred.

## Current Step 7 capabilities

1. Source snapshot integrity checks with captured-body re-hashing and excerpt matching.
2. Versioned v2, exact-host publisher authority registry commitments; no wildcard or suffix matching, and every host is limited by subject scope and permitted claim types.
3. Claim-level provenance and corroboration candidate checks.
4. Captured-text similarity and explicit attribution/common-origin signals.
5. Explicit contradictory-source adjudication requiring substantive comparison rationale.
6. Claim-type publication and retrieval freshness windows, including daily/monthly/quarterly/annual series profiles.
7. A separate current-regulatory-status assessment for claims typed `regulatory_current`.
8. Human review v2 records committed to an exact evidence packet, including claim findings, source-independence declarations and scope assessments for every material claim/source pair; reviewer identity remains declared, not authenticated.
9. Evidence-quality panels in the simulated execution UI.

## Increment 5 files

- `src/evidence/evidence-quality.js` — v2 exact-host scope and permitted-claim enforcement, plus packet-bound source-by-source reviewer scope assessments.
- `src/contracts/schema.js` — active evidence-review and publisher-authority-registry schema identifiers bumped to v2.
- `test/evidence-quality.test.js` — regression coverage for claim-type scope restrictions, insufficient/extra scope assessments and out-of-scope reviewer declarations.
- `public/app.js` — displays registered publisher subject scope and permitted claim types in evidence source assessments.

## Increment 4 files

- `config/publisher-authority-candidates.nigeria-fintech.json` — nine exact-host candidates, inactive and not loaded by the evaluator.
- `docs/PUBLISHER_REGISTRY_RESEARCH_NIGERIA_FINTECH.md` — source basis and deployment-owner promotion process.
- `docs/EVIDENCE_FRESHNESS_CALIBRATION.md` — cadence rationale and freshness limits.
- `docs/STEP7_INCREMENT4_REPORT.md` — implementation and validation report.
- `scripts/validate-publisher-candidates.mjs` and `test/publisher-registry-candidates.test.js` — candidate-pack integrity checks.

## Increment 5 validation

- Accepted Step 7 Increment 5 baseline: `npm test` 220 passed on the operator Windows environment.
- Current contract-draft Node regression suite: `npm test` 228 passed, 0 failed, 0 skipped in the present Linux environment; four separate `npm run test:near-terms` checks cover the cross-language escrow terms helper.
- `npm run validate:publisher-candidates`: nine exact-host candidates validated with explicit subject scopes and permitted claim types; pack remains inactive.
- Syntax checks passed for evidence-quality engine, browser UI and candidate validator.
- Production smoke test and `/api/health` confirmed `commissioningConfigured: false` and `paymentNetworks: []`.
- Native Windows verification of Increment 5 was confirmed by the operator: 220 tests passed and all nine publisher candidates validated; the current 224-test total includes four new Node tests for the escrow terms helper.

## Increment 4 validation

- `npm test`: 212 passed, 0 failed, 0 skipped (Linux validation environment).
- `npm run validate:publisher-candidates`: nine exact-host candidates validated; pack remains inactive.
- JavaScript syntax checks passed.
- Evidence manifest v1, evidence review v1 and publisher-authority registry v1 contracts remain unchanged.
- Native Windows verification of Increment 4 is required before adopting it as the cross-platform baseline.

## Important limitations

- Candidate publisher classifications are proposals, not active trust grants. A deployment owner must independently confirm each hostname and scope, assign groups/tiers, supply review basis and expiry, and explicitly commit a registry version.
- The CBN/NIBSS ownership and governance affiliation is recorded as a review signal; the evaluator does not yet consume a general publisher-relationship graph.
- Freshness windows are WorkRelay operating tolerances. They must be validated against actual source calendars, revisions and use cases.
- `regulatory_current` requires a reviewer declaration that the current in-force version and relevant amendments/repeals/superseding instruments were checked. It is not legal advice or automated law-status verification.
- Attribution, similarity and ownership signals do not prove plagiarism, common origin, independence or factual truth.
- Human reviewer IDs remain declared identities. Authenticated reviewer accounts, durable review/registry storage and source snapshot retention/access/deletion are Step 8 work.
- Live provider commissioning, wallet signing and settlement remain disabled. No provider credentials, wallet keys or runtime data are included.

## NEAR escrow source-draft status

- `Cargo.toml`, `rust-toolchain.toml` and `.cargo/config.toml` define a Rust workspace using Rust 1.97.0 (workspace MSRV 1.95), `near-sdk` 5.30.1, `near-contract-standards` 5.30.1 and `near-workspaces` 0.24.0. The WASM target is installed separately so host checks can run when target download is blocked.
- `contracts/job-escrow` contains a hash-bound single-buyer/provider/resolver state machine, exact allowlisted WRT deposit, pull claims, callback restoration, storage accounting and permanent job-ID tombstones.
- `contracts/workrelay-test-token` contains a WorkRelay-controlled WRT test FT with standard token, storage management and metadata interfaces.
- `contracts/integration-tests` contains six Sandbox test functions covering success/revision/dispute/refund paths; role boundaries; exact deposits; wrong-token/wrong-sender/wrong-amount/malformed/reused-deposit rejection; unregistered-recipient withdrawal restoration; contract-self initialization; provider non-acceptance and accepted-but-not-delivered deadline refunds; buyer silence after submission remaining unresolved until the named resolver acts; and late revision rejection plus dispute entry when a requested revision is not resubmitted by the delivery deadline. Deadline tests use `near-workspaces` time-forwarding rather than wall-clock sleeps.
- The cross-language canonical terms golden vector is shared by Rust and Node tests.
- **Not independently verified in this ChatGPT environment:** Rust formatting, compilation, WASM build, Cargo dependency lock and Rust unit tests. The operator reports the host gate and WASM build passed on Rust 1.97.0 (JobEscrow 5/5, WRT 4/4; WASM 419 KB and 283 KB) and integration-crate Clippy passed. The six Sandbox test functions have not executed; testnet deployment, wallet UI and chain state remain pending.
- The current ChatGPT execution container has no `rustc`, `cargo`, `rustup` or NEAR Sandbox executable, and cannot resolve the Rust distribution host. The operator reports that Rust 1.97.0 host checks and both WASM builds now pass, and integration-crate Clippy passes. The NEAR Sandbox tests remain unexecuted because the `near-sandbox` binary download was blocked. If your pinned Rust 1.97.0 toolchain cannot be downloaded but installed `stable` is exactly 1.97.0, set `export RUSTUP_TOOLCHAIN=stable` before npm/cargo commands. This ZIP does not include Cargo.lock; preserve the generated lockfile from the tested environment with the final source and WASM artifacts.

## Recommended next sequence

1. Keep the accepted Step 7 Increment 5 evidence baseline frozen. The new draft ZIP layers the contract work on top without changing live marketplace payment behavior.
2. In WSL2 Ubuntu, run `rustup show`, `rustc --version`, `cargo --version` and `rustup target list --installed`. The repository toolchain file selects Rust 1.97.0; the workspace minimum supported version is 1.95. If the pinned channel cannot be downloaded and installed `stable` is exactly 1.97.0, use `export RUSTUP_TOOLCHAIN=stable` for the session. The WASM target is deliberately not auto-installed by the toolchain file.
3. Run `npm test` and `npm run validate:publisher-candidates` first.
4. Run `npm run format:near-contracts` once to format sources and refresh `SHA256SUMS.txt`, then run `npm run check:near-host`. The latter generates Cargo.lock on first run, verifies rustfmt without mutation, runs Clippy with warnings denied and executes both contract crates' host unit tests.
5. Install `rustup target add wasm32-unknown-unknown --toolchain "${RUSTUP_TOOLCHAIN:-1.97.0}"`, ensure the local Sandbox binary is available, then run `npm run test:near-contracts`. This builds both WASM files, runs the NEAR Sandbox integration tests and reruns the Node suite/candidate validator. Inspect the generated Cargo.lock and WASM checksums.
6. Only after local contract acceptance, build the optional user-signed NEAR testnet wallet adapter as a separate mode.
7. Deploy only escrow and WRT test token to testnet, then query actual contract state and transaction outcomes. Never connect the testnet escrow to Agent Market payment.
8. Rehearse the judge walkthrough: sandbox evidence workflow first; optional testnet escrow proof second; explain that neither verifier pass nor testnet transaction proves factual truth or Agent Market provider payment.

## Safety boundary

Keep the sandbox fully usable without a wallet. The optional testnet proof may be enabled only after both Rust contracts compile, the local NEAR Sandbox suite passes and the terms hash vector matches across Rust and Node. Keep live Agent Market commissioning/payment and all mainnet funding disabled throughout the hackathon.


## NEAR escrow source compile correction (current source checkpoint)

The first Rust gate review found missing direct `borsh` / `near-contract-standards` declarations, macro-only trait dead-code warnings, unformatted Rust files and three detached native NEAR transfer promises. The current source checkpoint adds the direct dependencies (and aligns both NEAR crates at 5.30.1), marks the macro-consumed `#[ext_contract]` traits appropriately, routes create-job excess and archive storage refunds through a callback-protected native-NEAR pull-claim ledger, and removes the redundant WRT initializer self-transfer. A unit test now covers exact restoration of a failed native-NEAR refund callback.

The operator reports that formatting, host Clippy/unit tests, WASM compilation and integration-test Clippy pass on Rust 1.97.0. The Sandbox suite is still unexecuted because the runtime binary could not be downloaded. Retain the generated Cargo.lock from the tested Rust environment; this ZIP does not include it. Do not deploy until all six Sandbox test functions execute successfully and the contract state/accounting assertions pass.


## Rust gate correction checkpoint (2026-11-14)

The first operator-side Rust review exposed missing direct dependencies (`borsh` in both contract crates and `near-contract-standards` in the escrow crate), dead-code lints on macro-consumed external-interface traits, three discarded native transfer promises and rustfmt drift. The current source checkpoint adds the direct dependencies and aligns `near-sdk`/`near-contract-standards` at 5.30.1; preserves the generated external-call interfaces with explicit `allow(dead_code)` annotations; replaces unchecked native-NEAR pushes with a pull-refund ledger and callback; removes the WRT initializer's redundant self-transfer; and adds a failed native-refund callback restoration unit test.

The ChatGPT container cannot run Cargo. Its verified checks for this checkpoint are the 228-test Node suite, four separate terms tests, inactive publisher candidate validation, JavaScript/shell syntax checks and a source checksum verification. The operator reports that Rust 1.97.0 format/host/Clippy/unit-test gates, both WASM builds and integration-test Clippy pass. The Sandbox runtime tests remain unexecuted and are the current acceptance blocker. See `docs/RUST_GATE_CORRECTION_REPORT.md` and `docs/REVISION_DEADLINE_FIX.md`.


## Current NEAR escrow source-draft follow-up

The latest source correction addresses operator feedback about ignored `ExecutionFinalResult` values, the missing test-token unit suite and the expired-revision state-machine gap. There are 82 integration transaction calls: 66 expected successes consume `into_result()`, 15 expected failures assert `is_failure()`, and the failed-FT-withdrawal path asserts a failed receipt before checking callback restoration. The WRT crate now has four unit tests. A new sixth Sandbox test checks late revision rejection and resolver-only allocation when the provider does not resubmit by the delivery deadline.

Before the host gate, run `npm run format:near-contracts` once if rustfmt reports drift; then `npm run check:near-host` must be a read-only check. The full Sandbox gate runs Clippy for the integration test crate with `-D warnings` before the integration test binary.

**Acceptance remains blocked** until the six NEAR Sandbox integration tests execute successfully with the real `near-sandbox` binary. The operator reports formatting, host checks, WASM build and integration-test Clippy passed on Rust 1.97.0. This ChatGPT environment cannot independently rerun Rust or Sandbox gates.

## Hackathon testnet deployment path

The guarded testnet deployment script and fast runbook are available at `scripts/deploy-near-testnet.sh` and `docs/NEAR_TESTNET_DEPLOYMENT_RUNBOOK.md`. The script requires five distinct `.testnet` accounts, prebuilt WASM artifacts, local near-cli-rs keychain access, and an explicit `DEPLOY-TESTNET` confirmation. It hard-codes `network-config testnet`, deploys WRT before JobEscrow, and runs read-only post-deployment views. `WORKRELAY_DEPLOY_STEP=escrow` can resume only the escrow deployment if WRT was already deployed successfully. Never rerun an initializer for an account already initialized.

The optional CLI-signed happy-path smoke uses one WRT only and is separate from Agent Market. It does not replace local NEAR Sandbox acceptance. Mainnet and live Agent Market paid execution remain disabled.
