# Coding-agent task — implement WorkRelay's isolated NEAR testnet escrow proof

**Status:** contract source draft has been patched after a first external Rust gate review. The first delivered source missed direct dependencies and failed Clippy/rustfmt; the current source addresses those specific findings but remains uncompiled/unaccepted until the full host, WASM and Sandbox gates pass.

## Read first

Read these files before coding:

- `docs/HACKATHON_SCOPE_RESET.md`
- `docs/NEAR_TESTNET_ESCROW_SPEC.md`
- `docs/SCHEMA_CONTRACTS.md`
- `docs/X402_PAYMENT_AUTHORIZATION.md`
- `src/contracts/schema.js`
- `src/market/near-a2a-quotes.js`
- `src/procurement/quote-and-procure.js`

The accepted repository baseline had a 220-test Node suite; the current terms-helper additions bring the working draft to 224 passing Node tests, versioned JobSpec/evidence/provider quote/settlement schemas, an unpaid Agent Market quote path and a complete no-wallet sandbox. Preserve them.

## Scope for this task

Implement the **Rust contracts and local NEAR Sandbox integration tests only**:

1. `contracts/job-escrow` — narrow one-buyer/one-provider/one-resolver escrow contract.
2. `contracts/workrelay-test-token` — WorkRelay-controlled NEP-141 test token with standard storage registration and metadata. Suggested symbol `WRT`; it must have no real monetary value and must never be labelled USDC.
3. A reproducible Rust workspace/toolchain/dependency lock and build configuration.
4. NEAR Sandbox integration tests implementing the complete matrix in `docs/NEAR_TESTNET_ESCROW_SPEC.md`.
5. Contract interface/ABI and a short contract README with local build/test commands.
6. A report containing actual toolchain versions, actual commands, all test results, coverage of the invariants, known limitations and a statement that no testnet deployment occurred.

Do not yet implement wallet UI or deploy to testnet. That is a separate task after local contract acceptance.

## Dependency/tooling baseline to confirm

At task start, verify current official NEAR releases. The currently inspected references indicate `near-sdk` and `near-contract-standards` 5.30.1 (Rust MSRV 1.95), `cargo-near` 0.23.0 and `near-workspaces` 0.24.0. Pin exact compatible versions rather than using floating `*` dependencies. If current stable versions have changed, record the official source and use a mutually compatible stable set.

Windows developers should use WSL2 for Rust/NEAR Sandbox contract development. Keep Node application tests runnable in native Windows PowerShell. Do not assume Git Bash is a Linux environment.

## Required engineering behavior

- Implement the exact state machine, role authorization, NEP-141 exact-token/exact-amount deposit, pull withdrawals, failure callbacks, one terminal allocation, deadline rules, storage staking and events/views in the spec.
- Keep full research content and private data off-chain. Commit hashes only.
- Distinguish `providerAccountId` (testnet signer/recipient) from `agentMarketHandle` (unpaid marketplace identity). The test contract must not call or pay an Agent Market provider.
- Keep the allowed FT contract immutable after initialization.
- No admin drain, recipient changes, mutable resolver, arbitrary token rescue, upgrade method, mainnet config or production signer.
- Never add a private key/seed phrase or backend signer.
- Do not create fake transaction hashes, USDC labels or explorer links.
- Use checked integer arithmetic and atomic token units. Do not use floating-point amounts in contract or client interfaces.
- A contract event is not proof of current state; integration tests must read contract views directly.
- Failed FT transfers must not reduce liabilities. Callback failure restores exactly the in-flight amount.
- No automatic payout when a provider merely submits; no automatic buyer refund after a submitted artifact just because the buyer is silent.

## Tests and acceptance

Before reporting complete:

1. Build both WASM contracts successfully with pinned tool versions.
2. Run all NEAR Sandbox integration tests, including every negative path in the specification.
3. Run the existing repository `npm test` suite; all current Node tests must continue to pass (224 in the current source draft).
4. Run the candidate validator; the nine publisher candidates must remain inactive.
5. Verify no existing sandbox route can trigger contract calls, wallet actions or live provider payment.
6. Add tests for any bridge/serialization code that touches existing schemas.
7. Run formatting, clippy and diff checks.

Return:

- complete ZIP;
- contract WASM build output/checksums;
- local NEAR Sandbox test report;
- Node regression test report;
- exact dependency/toolchain versions;
- contract method/argument reference;
- updated `docs/HANDOFF.md` and README;
- explicit statement that testnet deployment and wallet UI have not yet occurred.

Do not claim the contract is audited, production-safe or deployed. Stop after the local contract gate passes.
