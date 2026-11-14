## 2026-11-14 — NEAR integration result assertions and test-token unit coverage

- Consume each successful `ExecutionFinalResult` using `into_result()` in the NEAR Sandbox integration suite.
- Assert expected contract failures using `is_failure()` after unwrapping the RPC result; assert the failed FT receipt and callback-restored claim/liability in the unregistered-withdrawal path.
- Add four WorkRelay Test Token host unit tests and a Node-side guard for all 68 integration transaction result paths.
- Make `check:near-host` a non-mutating formatting gate; add an explicit `format:near-contracts` command that refreshes the source checksum manifest, and add integration-test Clippy with `-D warnings` to the full Sandbox gate.
- Rust host/Clippy/WASM checks were subsequently reported passed by the operator on Rust 1.97.0; NEAR Sandbox execution remains outstanding.

## NEAR escrow source draft (2026-11-14)

- Added a separate Rust workspace for a narrow `job-escrow` contract and WorkRelay-controlled WRT NEP-141 test token.
- Added exact ordered terms commitment, shared Rust/Node golden vector and WRT six-decimal binding.
- Added buyer/provider/resolver state transitions, pre-submission refunds, conservative unresolved disputes, pull claims and failure-restoring callbacks.
- Added permanent job-ID tombstones; archival removes the job record but does not make an ID reusable, and refunds only the storage bytes actually freed at the original storage-byte price.
- Restricted contract initialization to a self-call by the deployed contract account and guarded both contracts against mainnet initialization.
- Added NEAR Sandbox integration-test source and reproducible build/test scripts. Rust/WASM/Sandbox gates remain unexecuted in the current environment; no testnet deployment or wallet UI exists.
- Preserved the full Node suite (224 passing in this Linux environment) and nine inactive publisher candidates.

# Changelog

## 0.1.0 — NEAR escrow deadline hardening

- Reject revision requests after the committed delivery deadline.
- Add a permissionless `RevisionRequested -> Disputed` transition after the delivery deadline when the provider does not resubmit.
- Keep the full escrow unsettled for the named resolver; no automatic payout or buyer refund is created.
- Add Sandbox integration coverage for late revision rejection, premature expiry rejection, and resolver-only allocation after revision expiry.
- Extend static guards to account for every transaction result in the enlarged Sandbox suite.
- Increase the WorkRelay Node regression suite to 228 tests, including a static guard for the new revision-expiry transition.


## Rust gate correction — NEAR escrow source (2026-11-14)

- Added missing direct `borsh` and `near-contract-standards` dependency declarations; aligned `near-sdk` and `near-contract-standards` at 5.30.1.
- Marked generated `#[ext_contract]` interface traits as macro-consumed to resolve dead-code warnings without removing the generated clients.
- Replaced detached create-job excess and archive storage-refund transfers with a native-NEAR pull-claim ledger and private callback restoration; increased callback gas to 25 Tgas.
- Removed the redundant WRT initializer self-transfer and require the token account to be pre-funded for initialization storage.
- Added a unit test for exact claim restoration when a native-NEAR refund transfer callback reports failure.
- Updated host checks to apply rustfmt, run Clippy with warnings denied and execute both contract unit-test suites before WASM/Sandbox checks.
- Rust/WASM/Sandbox acceptance remains outstanding; no testnet deployment or wallet UI is included.

## Step 7 — Increment 5 (2026-11-14)

- Bumped the active publisher authority contract to v2; exact-host entries now require a non-empty subject scope and explicit permitted claim-type allowlist.
- Bumped packet-bound human evidence reviews to v2 with source-by-source scope assessments for every material supporting or contradicting claim/source pair.
- The evaluator rejects material sources whose host registry does not permit the claim type, and blocks accepted reviews when a reviewer marks a source out of scope or omits/misidentifies a required pair.
- Raised minimum authority tiers for regulatory-current claims to regulator and for daily/monthly/quarterly/annual data series to primary.
- Kept the Nigeria fintech candidate pack inactive; no publisher is promoted or automatically trusted.
- Versioned the evidence-quality policy as `workrelay.evidence-quality-policy.v3`.
- Added adversarial regression coverage for under-tier authorities, omitted and extra scope assessments, legacy v1 records and scope-limited source use.

## Step 7 — Increment 4 (2026-11-14)

- Added inactive, source-researched Nigeria fintech publisher-authority candidates for exact-host deployment review; no candidate is auto-trusted.
- Recorded CBN/NIBSS ownership and governance affiliation as a reviewer caution rather than automatically merging publisher groups.
- Added daily, monthly, quarterly and annual series freshness profiles with separate publication and retrieval windows.
- Added `regulatory_current` claim handling, which separates publication age from current in-force status and requires an explicit packet-bound human status attestation.
- Exposed current-law review status in execution-card evidence panels.
- Added candidate-pack validation command and regression coverage.

## Step 7 — Increment 3 (2026-11-14)

- Added explicit source attribution and possible common-origin signals.
- Added claim-specific contradictory-source adjudication requirements.
- Expanded UI visibility and adversarial tests.

## Step 7 — Increments 1–2 (2026-11-14)

- Added evidence-quality authority, freshness, provenance and corroboration policy.
- Added captured-text similarity signals, source registry commitments and packet-bound human review records.
