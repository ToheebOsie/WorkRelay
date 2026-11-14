# Rust gate correction report — current WorkRelay source checkpoint

**Status:** source corrections are applied, but this report does not claim Rust compilation, Clippy, formatting, WASM, or NEAR Sandbox acceptance. The current ChatGPT execution container has no Rust toolchain and cannot resolve `static.rust-lang.org`.

## Findings from the operator's first Rust run

The operator reported the following against the earlier source ZIP:

1. Both contract crates lacked a direct `borsh` dependency with the `derive` feature.
2. `job-escrow` imported `near_contract_standards` without declaring it as a direct dependency.
3. Clippy reported two macro-consumed `ExtFungibleToken` / `ExtJobEscrow` traits as dead code.
4. Clippy reported three discarded `Promise` values: the job-creation excess deposit, archival storage refund and token initializer self-transfer.
5. `cargo fmt --check` reported formatting changes in the two contract files and the Sandbox test file.

On a throwaway copy, the operator added the missing dependency declarations and reported that the four existing `job-escrow` unit tests then passed. Clippy and formatting still failed. The current source package applies further changes; it has not yet been run as delivered.

## Changes in this checkpoint

- Added direct `borsh = 1.5.7` with `derive` to the workspace and both contract packages.
- Added direct `near-contract-standards` declarations and aligned both `near-sdk` and `near-contract-standards` to 5.30.1. The official NEAR SDK release/tag material identifies 5.30.1 as the matching release; the SDK declares Rust 1.95 MSRV.
- Marked the `#[ext_contract]` interface traits as macro-consumed (`allow(dead_code)`) rather than deleting the interfaces required to generate the clients.
- Removed the detached native-NEAR transfer promises. `create_job` excess and archive storage refunds now accrue to a native-NEAR pull-claim ledger. `withdraw_storage_refund` returns a chained transfer/callback Promise; its private callback reduces the native refund liability on success or restores the exact claim on failure.
- Removed the token initializer's redundant transfer-to-self Promise. WRT initialization is non-payable and requires the deployed token account to be pre-funded for its measured initialization storage.
- Added a unit test that asserts a failed native refund callback restores the exact amount, clears the in-flight attempt and preserves the liability. The current `job-escrow` source therefore contains five unit tests.
- Changed the repository toolchain file to Rust 1.97.0, which the operator reported is installed. The workspace still declares Rust 1.95 as its MSRV. The WASM target is no longer auto-requested by `rust-toolchain.toml`, so host formatting/Clippy/unit gates can run independently when target downloads are blocked.
- The initial host script reformatted files during validation; after the operator flagged this, formatting was split into an explicit `npm run format:near-contracts` command and a non-mutating `cargo fmt --all -- --check` in `scripts/check-near-host.sh`. The current ZIP still requires that explicit formatter command in WSL2 because rustfmt is unavailable in this container.
- Simplified `scripts/test-near-contracts.sh`: it runs the host gate, builds both WASM files, executes the Sandbox integration crate, then reruns the Node suite and inactive publisher validator.

## Checks actually run in this ChatGPT environment

| Check | Result |
|---|---|
| `npm test` | 227 passed, 0 failed, 0 skipped |
| `npm run test:near-terms` | 4 passed, 0 failed |
| `npm run validate:publisher-candidates` | 9 exact-host candidates validated; pack remains inactive |
| `bash -n` on NEAR shell scripts | Passed |
| JavaScript syntax checks | Passed |

The tests above do not compile or validate the Rust contracts.

## Required operator commands

Run in WSL2 Ubuntu, from the repository root:

```bash
rustc --version   # expected 1.97.0
cargo --version
npm test
npm run test:near-terms
npm run validate:publisher-candidates
npm run check:near-host
```

First run `npm run format:near-contracts` once to apply formatting and refresh `SHA256SUMS.txt`. Then `check:near-host` checks formatting without mutation, generates/uses `Cargo.lock`, runs Clippy with `-D warnings`, and executes the two contract crates' host unit tests. It does not require the WASM target or Sandbox binary.

Only after that passes, install the target and run the full contract gate:

```bash
rustup target add wasm32-unknown-unknown --toolchain "${RUSTUP_TOOLCHAIN:-1.97.0}"
npm run test:near-contracts
```

The full gate builds the WASM files, runs the five Sandbox integration test functions, then reruns the Node suite and inactive-candidate validator. `near-workspaces` must be able to access its local Sandbox runtime; if the binary download is blocked with HTTP 403, the Sandbox tests remain unexecuted and the contract is not accepted.

## Not claimed

- Rust formatting, compilation, Clippy and host unit-test results for this exact ZIP.
- WASM artifacts or WASM checksums.
- NEAR Sandbox integration-test results.
- Testnet deployment, wallet UI or any on-chain state change.
- Audit, production readiness, or live Agent Market payment support.

## Version references

- NEAR SDK 5.30.1 release metadata and dependency list: https://docs.rs/crate/near-sdk/5.30.1 and https://github.com/near/near-sdk-rs/releases/tag/near-sdk-v5.30.1
- NEAR contract-standards 5.30.1 release: https://github.com/near/near-sdk-rs/releases/tag/near-contract-standards-v5.30.1
- NEAR SDK `Promise` documentation specifies that a promise should be returned or explicitly detached; the current source returns both withdrawal chains and does not silently detach a transfer: https://docs.rs/near-sdk/5.30.1/near_sdk/struct.Promise.html


## Follow-up correction after operator review

The local NEAR integration test file now consumes all `ExecutionFinalResult` values explicitly. Expected-success calls use `into_result()`; expected-failure calls use `is_failure()` after unwrapping the RPC result; the failed FT withdrawal test asserts a failed receipt and independently verifies restored claim/liability. The test-token crate now has four Rust unit tests instead of zero.

Formatting is now a non-mutating host acceptance gate (`cargo fmt --all -- --check`). Run `npm run format:near-contracts` once before the check if formatting changes are needed. The full Sandbox script now runs Clippy over `workrelay-near-integration` with `-D warnings` before executing its integration tests.

This source package has not been formatted, compiled, Clippy-checked, WASM-built or Sandbox-executed in this environment because Rust/Cargo/NEAR Sandbox tooling is unavailable here. Do not treat the source changes as passing those gates until the WSL2 commands are run.


## Formatting and manifest behavior

The source archive is intentionally not pre-formatted because `rustfmt` is unavailable in the packaging environment. Run `npm run format:near-contracts` once in WSL2. That command formats the Rust workspace and refreshes `SHA256SUMS.txt` for source files. It deliberately excludes `Cargo.lock` (generated by the host gate) and build/runtime directories. After formatting, `npm run check:near-host` is a read-only gate and must not rewrite Rust files.

If the repository's pinned Rust 1.97.0 toolchain cannot be fetched but the installed `stable` reports exactly `rustc 1.97.0`, set `export RUSTUP_TOOLCHAIN=stable` for the commands. Do not use an arbitrary newer compiler as a substitute without recording it.
