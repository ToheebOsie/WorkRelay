#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NEAR_CLI_BIN="${NEAR_CLI_BIN:-near}"
DEPLOY_STEP="${WORKRELAY_DEPLOY_STEP:-all}"
BUYER="${WORKRELAY_BUYER_ACCOUNT:-}"
PROVIDER="${WORKRELAY_PROVIDER_ACCOUNT:-}"
RESOLVER="${WORKRELAY_RESOLVER_ACCOUNT:-}"
WRT="${WORKRELAY_WRT_ACCOUNT:-}"
ESCROW="${WORKRELAY_ESCROW_ACCOUNT:-}"
WRT_WASM="${WORKRELAY_TEST_TOKEN_WASM:-$ROOT/artifacts/near/workrelay_test_token.wasm}"
ESCROW_WASM="${WORKRELAY_JOB_ESCROW_WASM:-$ROOT/artifacts/near/job_escrow.wasm}"

fail() { echo "ERROR: $*" >&2; exit 1; }

[[ "$DEPLOY_STEP" == "all" || "$DEPLOY_STEP" == "wrt" || "$DEPLOY_STEP" == "escrow" ]] \
  || fail "WORKRELAY_DEPLOY_STEP must be all, wrt, or escrow"

for name in BUYER PROVIDER RESOLVER WRT ESCROW; do
  value="${!name}"
  [[ -n "$value" ]] || fail "Set WORKRELAY_${name}_ACCOUNT to a .testnet account ID"
  [[ "$value" == *.testnet ]] || fail "$name account must end exactly in .testnet; mainnet is prohibited"
  [[ "$value" =~ ^[a-z0-9][a-z0-9._-]*\.testnet$ ]] || fail "$name is not a valid lower-case testnet account ID"
done

[[ "$BUYER" != "$PROVIDER" && "$BUYER" != "$RESOLVER" && "$PROVIDER" != "$RESOLVER" ]] \
  || fail "Buyer, provider and resolver must be three distinct accounts"
[[ "$WRT" != "$ESCROW" ]] || fail "WRT and escrow must be separate contract accounts"
for contract_account in "$WRT" "$ESCROW"; do
  for role_account in "$BUYER" "$PROVIDER" "$RESOLVER"; do
    [[ "$contract_account" != "$role_account" ]] || fail "Contract account $contract_account must differ from role account $role_account"
  done
done

command -v "$NEAR_CLI_BIN" >/dev/null 2>&1 || fail "near-cli-rs command not found. Install the official Rust-based near CLI and confirm: near --version"

if [[ "$DEPLOY_STEP" == "all" || "$DEPLOY_STEP" == "wrt" ]]; then
  [[ -s "$WRT_WASM" ]] || fail "WRT WASM missing: $WRT_WASM. Build with npm run build:near-contracts first."
fi
if [[ "$DEPLOY_STEP" == "all" || "$DEPLOY_STEP" == "escrow" ]]; then
  [[ -s "$ESCROW_WASM" ]] || fail "Escrow WASM missing: $ESCROW_WASM. Build with npm run build:near-contracts first."
fi

printf '\nWorkRelay TESTNET deployment preflight\n'
printf 'Network:             testnet (hard-coded)\n'
printf 'Buyer / WRT owner:   %s\n' "$BUYER"
printf 'Assigned provider:   %s\n' "$PROVIDER"
printf 'Named resolver:      %s\n' "$RESOLVER"
printf 'WRT contract:        %s\n' "$WRT"
printf 'Escrow contract:     %s\n' "$ESCROW"
printf 'Deployment step:     %s\n' "$DEPLOY_STEP"

if [[ "$DEPLOY_STEP" == "all" || "$DEPLOY_STEP" == "wrt" ]]; then
  echo "WRT WASM: $(wc -c < "$WRT_WASM") bytes"
  sha256sum "$WRT_WASM"
  echo "Checking WRT contract account balance (must be funded before deployment):"
  "$NEAR_CLI_BIN" tokens "$WRT" view-near-balance network-config testnet now
fi
if [[ "$DEPLOY_STEP" == "all" || "$DEPLOY_STEP" == "escrow" ]]; then
  echo "Escrow WASM: $(wc -c < "$ESCROW_WASM") bytes"
  sha256sum "$ESCROW_WASM"
  echo "Checking escrow contract account balance (must be funded before deployment):"
  "$NEAR_CLI_BIN" tokens "$ESCROW" view-near-balance network-config testnet now
fi

cat <<'NOTICE'

Safety boundary:
- This script can only target .testnet accounts and hard-codes network-config testnet.
- It deploys WRT first, then JobEscrow (or the selected stage).
- It never deploys to mainnet and does not call Agent Market.
- Deployment is a real testnet transaction signed by your local NEAR CLI keychain.
- The contract has not been audited; use disposable testnet accounts and test tokens only.
NOTICE

read -r -p "Type DEPLOY-TESTNET to submit the listed testnet deployment transaction(s): " confirmation
[[ "$confirmation" == "DEPLOY-TESTNET" ]] || fail "Deployment cancelled by operator"

if [[ "$DEPLOY_STEP" == "all" || "$DEPLOY_STEP" == "wrt" ]]; then
  echo "\nDeploying WRT and self-initializing owner=$BUYER ..."
  "$NEAR_CLI_BIN" contract deploy "$WRT" \
    use-file "$WRT_WASM" \
    with-init-call new \
    json-args "{\"owner_id\":\"$BUYER\"}" \
    prepaid-gas '100 TGas' \
    attached-deposit '0 NEAR' \
    network-config testnet \
    sign-with-keychain \
    send
  echo "\nVerifying WRT metadata and notice ..."
  "$NEAR_CLI_BIN" contract call-function as-read-only "$WRT" ft_metadata json-args '{}' network-config testnet now
  "$NEAR_CLI_BIN" contract call-function as-read-only "$WRT" get_token_notice json-args '{}' network-config testnet now
fi

if [[ "$DEPLOY_STEP" == "all" || "$DEPLOY_STEP" == "escrow" ]]; then
  echo "\nDeploying JobEscrow and self-initializing allowed_ft_contract_id=$WRT ..."
  "$NEAR_CLI_BIN" contract deploy "$ESCROW" \
    use-file "$ESCROW_WASM" \
    with-init-call new \
    json-args "{\"allowed_ft_contract_id\":\"$WRT\"}" \
    prepaid-gas '100 TGas' \
    attached-deposit '0 NEAR' \
    network-config testnet \
    sign-with-keychain \
    send
  echo "\nVerifying escrow config and empty liability ledger ..."
  "$NEAR_CLI_BIN" contract call-function as-read-only "$ESCROW" get_contract_config json-args '{}' network-config testnet now
  "$NEAR_CLI_BIN" contract call-function as-read-only "$ESCROW" get_liabilities json-args '{}' network-config testnet now
fi

echo "\nDeployment step completed. Preserve the actual transaction IDs printed above. Verify chain_id=testnet, allowedFtContractId=$WRT, tokenDecimals=6, mainnetEnabled=false, and WRT notice says no monetary value."
