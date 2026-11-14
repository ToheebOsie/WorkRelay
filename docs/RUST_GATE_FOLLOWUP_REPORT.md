# NEAR escrow integration-test and host-gate follow-up

**Status:** source/test-harness corrections are prepared. The local Rust/WASM/NEAR Sandbox acceptance gate is still pending.

## Operator findings addressed

1. Every `ExecutionFinalResult` returned from the NEAR Sandbox integration tests is now explicitly consumed or asserted. The source has 68 `.transact()` call sites: 54 expected-success results use `into_result()`, 13 expected contract failures use `is_failure()`, and the remaining failed FT withdrawal checks for a failed receipt before validating callback restoration of the claim and liability. The tests no longer mistake an outer RPC `Result::is_err()` for proof of an on-chain contract rejection.
2. The WorkRelay Test Token now contains four Rust host unit tests for WRT metadata/notice and positive amount/registered receiver mint preconditions. These pure unit tests do not replace Sandbox checks of NEP-141 behavior or chain restrictions.
3. `scripts/check-near-host.sh` is read-only with respect to source formatting: it runs `cargo fmt --all -- --check`, then Clippy with warnings denied and both contract crates' unit tests. It does not silently rewrite source.
4. `npm run format:near-contracts` is the explicit mutating formatter. It runs `cargo fmt --all` and refreshes `SHA256SUMS.txt` for source files, excluding `Cargo.lock` and generated/runtime directories.
5. `scripts/test-near-contracts.sh` runs Clippy over `workrelay-near-integration` with `-D warnings` before executing the NEAR Sandbox integration suite.
6. A Node regression test guards the 68 transaction-result paths and verifies the formatter/host-gate separation.

## Checks executed in this packaging environment

| Check | Result |
|---|---:|
| `npm test` | 227 passed, 0 failed, 0 skipped |
| `npm run test:near-terms` | 4 passed, 0 failed |
| `npm run validate:publisher-candidates` | 9 exact-host candidates validated; pack remains inactive |
| `bash -n` for all repository shell scripts | Passed |
| `node --check` for repository JavaScript files | Passed |
| `sha256sum -c SHA256SUMS.txt` | 120/120 source files passed |

## Not executed here

This environment has no Rust/Cargo/rustfmt/NEAR Sandbox toolchain. Therefore this package has **not** been formatted, compiled, Clippy-checked, Rust-unit-tested, WASM-built or Sandbox-executed here. There is no generated `Cargo.lock`, no WASM binary and no testnet deployment. The source tree is intentionally unformatted in this archive; the explicit formatter command must be run in WSL2 before the non-mutating host gate.

## Required WSL2 sequence

Use Rust 1.97.0. If the pinned toolchain cannot be downloaded but the installed `stable` reports exactly `rustc 1.97.0`, set `export RUSTUP_TOOLCHAIN=stable` for the session. Do not silently substitute another version.

```bash
npm test
npm run test:near-terms
npm run validate:publisher-candidates
npm run format:near-contracts
npm run check:near-host
rustup target add wasm32-unknown-unknown --toolchain "${RUSTUP_TOOLCHAIN:-1.97.0}"
npm run test:near-contracts
```

Retain the generated `Cargo.lock`, formatted Rust sources and WASM checksums from the successful run. If the NEAR Sandbox runtime download is blocked, mark the Sandbox tests as not run; do not accept the contract and do not deploy it to testnet.

## Safety boundary

The no-wallet WorkRelay sandbox remains fully usable. WRT/JobEscrow testnet settlement is a separate proof and does not pay or commission an Agent Market provider. Mainnet deposits and live Agent Market paid commissioning remain disabled.
