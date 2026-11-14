#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

cargo fmt --all

# The source manifest is updated after intentional formatting so a later
# `sha256sum -c SHA256SUMS.txt` still describes the distributed source tree.
# Generated lockfiles and build/runtime output are intentionally excluded.
find . -type f \
  ! -path './.git/*' \
  ! -path './node_modules/*' \
  ! -path './target/*' \
  ! -path './artifacts/*' \
  ! -path './data/*' \
  ! -name 'SHA256SUMS.txt' \
  ! -name 'Cargo.lock' \
  -print0 \
  | sort -z \
  | xargs -0 -r sha256sum > SHA256SUMS.txt

echo "Rust formatting applied; SHA256SUMS.txt refreshed for source files."
