#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

rustc --version
cargo --version
# The workspace MSRV is Rust 1.95; rust-toolchain.toml pins Rust 1.97.0.

rustup target list --installed | grep -qx 'wasm32-unknown-unknown' || {
  echo "Install wasm32-unknown-unknown: rustup target add wasm32-unknown-unknown" >&2
  exit 1
}

if [[ ! -f Cargo.lock ]]; then
  cargo generate-lockfile
fi

cargo build --locked --release --target wasm32-unknown-unknown -p job-escrow -p workrelay-test-token

mkdir -p artifacts/near
cp target/wasm32-unknown-unknown/release/job_escrow.wasm artifacts/near/
cp target/wasm32-unknown-unknown/release/workrelay_test_token.wasm artifacts/near/
sha256sum artifacts/near/*.wasm | tee artifacts/near/WASM-SHA256SUMS.txt
