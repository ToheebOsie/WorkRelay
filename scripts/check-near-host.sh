#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

rustc --version
cargo --version

# Formatting is a non-mutating acceptance gate. Run `npm run format:near-contracts`
# once when intentionally updating Rust sources, then keep this check read-only.
cargo fmt --all -- --check

if [[ ! -f Cargo.lock ]]; then
  cargo generate-lockfile
fi
cargo clippy --locked -p job-escrow -p workrelay-test-token --all-targets -- -D warnings
cargo test --locked -p job-escrow
cargo test --locked -p workrelay-test-token
