# Rust integration-test assertion correction

## Problem

`near_workspaces::ContractCall::transact().await?` yields an `ExecutionFinalResult` inside the outer RPC result. The `?` operator only unwraps the RPC result; it does not assert that the on-chain transaction succeeded. Likewise, calling `.is_err()` on the outer result does not prove that a contract call failed on-chain.

## Correction

Every expected-success transaction in `contracts/integration-tests/tests/escrow_sandbox.rs` now consumes `ExecutionFinalResult` through `into_result()` and propagates any execution/receipt failure. Expected-failure cases now unwrap the RPC result and assert `ExecutionFinalResult::is_failure()`. The unregistered-token withdrawal test explicitly asserts that the final execution record contains a failed receipt, then independently checks that the escrow callback restored the exact claim and liability.

The integration suite contains 68 transaction call sites: 54 expected-success results are consumed with `into_result()`, 13 expected-failure outcomes are asserted with `is_failure()`, and the remaining withdrawal callback case asserts the expected failed receipt before checking restored on-chain state.

## Test-token unit coverage

`workrelay-test-token` previously compiled with zero Rust unit tests. Four unit tests now cover WRT metadata/notice and the positive amount/registered receiver mint preconditions. The actual chain restriction and NEP-141 behavior remain covered by Sandbox integration tests, not by these pure unit tests.

## Formatting gates

- `npm run format:near-contracts` applies rustfmt intentionally and refreshes `SHA256SUMS.txt` for source files.
- `npm run check:near-host` now runs `cargo fmt --all -- --check` only; validation no longer silently rewrites files.
- `npm run test:near-contracts` separately runs Clippy for the integration-test crate with `-D warnings`, then executes the Sandbox tests.

## Execution status

These source corrections are not a claim that the integration tests have executed. They require the Rust/WASM/NEAR Sandbox environment. Run the formatter once, then the host gate, then the full WASM/Sandbox gate in WSL2. The formatter refreshes the source checksum manifest; the host gate does not mutate files.
