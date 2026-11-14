# WorkRelay NEAR contracts

This workspace contains two intentionally narrow Rust contracts:

- `job-escrow`: one buyer, one assigned NEAR account provider, one named resolver, one allowlisted FT contract and one immutable job agreement per job.
- `workrelay-test-token`: a WorkRelay-controlled NEP-141/NEP-145/NEP-148 token named WorkRelay Test Token (`WRT`). It has no real monetary value and is not USDC.

Neither contract commissions Agent Market providers. Both initializers require a self-call from the deployed contract account; this prevents an unrelated account from claiming an uninitialized deployment. Both contracts reject mainnet. Do not deploy either contract to mainnet.

## Toolchain

- Rust toolchain `1.97.0` (workspace minimum supported version `1.95`)
- `near-sdk = 5.30.1`
- `near-contract-standards = 5.30.1`
- `near-workspaces = 0.24.0`
- target `wasm32-unknown-unknown`

Use WSL2 Ubuntu on Windows for Rust and NEAR Sandbox contract tests. The existing Node test suite remains runnable in native Windows PowerShell.

## Host checks and build

Run the explicit formatter once, then the host-only gate. `npm run format:near-contracts` formats the Rust workspace and refreshes `SHA256SUMS.txt`; `npm run check:near-host` generates `Cargo.lock` on first use, verifies formatting without mutation, runs Clippy with warnings denied and executes both contract crates' unit tests. It does not require a WASM target or Sandbox binary.

```bash
npm run format:near-contracts
npm run check:near-host
```

Then install the WASM target and build both contract artifacts:

```bash
rustup target add wasm32-unknown-unknown --toolchain 1.97.0
./scripts/build-near-contracts.sh
```

WASM output is copied to `artifacts/near/`. A SHA-256 manifest is created next to the binaries.

## Local Sandbox integration tests

```bash
./scripts/test-near-contracts.sh
```

The integration tests deploy the compiled WASM into a fresh local NEAR Sandbox. They do not target testnet. They read contract views after state transitions; event logs are not treated as authoritative state.

## Standard registration

Before an escrow deposit:

1. Deploy the WRT token on sandbox/testnet and pre-fund the token contract account with enough liquid NEAR to cover its initial storage; the contract account itself performs the initializer self-call. The initializer is not payable and does not send a redundant self-transfer.
2. Register the buyer and assigned provider with WRT via `storage_deposit`.
3. Register the `job-escrow` contract account with WRT via `storage_deposit`.
4. Mint test WRT to the buyer (owner-only test operation).
5. Create the job with a measured NEAR storage deposit. Any excess is credited to the buyer as a native-NEAR pull refund; archive refunds are handled the same way.
6. The refund owner calls `withdraw_storage_refund()` with 1 yoctoNEAR; the private callback finalizes success or restores the claim after failure.
7. Deposit the exact atomic amount using WRT `ft_transfer_call` with message `{ "schema": "workrelay.escrow-deposit.v1", "jobId": "..." }`.

WRT uses six decimals; the escrow contract rejects terms that specify a different decimal count. The provider and buyer must be registered with the FT before withdrawing. If a recipient is unregistered, the FT transfer fails and the escrow callback restores the in-flight claim.

## Safety boundaries

- The contracts reject `mainnet` chain ID and accept only `testnet` or local `sandbox`.
- The allowlisted FT contract is immutable.
- The contract does not store briefs, research, personal data or full deliverables; only hashes and state.
- Agent Market handles are descriptive off-chain metadata, never payment recipients.
- No arbitrary token rescue, admin drain, mutable resolver, mutable provider, upgrade method, backend signer or mainnet option exists.
- A testnet escrow transfer is not Agent Market provider payment.
- The contract is not audited. Passing tests do not establish production safety.

## Current verification status

The Rust source and Sandbox integration tests are still an unaccepted draft: this ChatGPT container cannot compile them. The source has been patched for the reported missing dependencies, detached Promise paths and lint issues, but run `npm run format:near-contracts` then `npm run check:near-host` in WSL2 Ubuntu first. Then install `wasm32-unknown-unknown` for Rust 1.97.0 and run `npm run test:near-contracts`; see `docs/NEAR_TESTNET_DEPLOYMENT_RUNBOOK.md`.

## Testnet deployment tooling

A guarded near-cli-rs deployment script is provided at `scripts/deploy-near-testnet.sh`; see `docs/NEAR_TESTNET_DEPLOYMENT_RUNBOOK.md`. It only accepts `.testnet` account IDs and hard-codes `network-config testnet`. No testnet transactions have been performed by this source package. The local NEAR Sandbox integration gate remains the preferred prerequisite; a rushed testnet-only smoke is provisional and must use disposable test accounts and WRT only.
