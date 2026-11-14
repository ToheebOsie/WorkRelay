#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

./scripts/check-near-host.sh
./scripts/build-near-contracts.sh

export WORKRELAY_JOB_ESCROW_WASM="$ROOT/artifacts/near/job_escrow.wasm"
export WORKRELAY_TEST_TOKEN_WASM="$ROOT/artifacts/near/workrelay_test_token.wasm"

# The integration-test crate is not part of the host-only unit-test gate above.
# Lint it explicitly so ignored ExecutionFinalResult values cannot hide behind
# a green contract-only Clippy run.
cargo clippy --locked -p workrelay-near-integration --all-targets -- -D warnings
cargo test --locked -p workrelay-near-integration -- --test-threads=1
npm test
npm run validate:publisher-candidates
