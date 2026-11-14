# Testnet deployment readiness — hackathon fast path

## Delivered in this increment

- `scripts/deploy-near-testnet.sh`: guarded near-cli-rs deployment flow for the WRT and JobEscrow WASM files.
- `scripts/prepare-near-testnet-demo-terms.mjs`: generates a unique, canonical, hash-bound illustrative demo agreement with future deadlines.
- `docs/NEAR_TESTNET_DEPLOYMENT_RUNBOOK.md`: account creation/funding, deployment, on-chain read verification, WRT registration/mint, and one small user-signed CLI smoke lifecycle.
- npm scripts `deploy:near-testnet` and `prepare:near-testnet-demo-terms`.

## Safety guards

- All five operator-provided account IDs must be valid `.testnet` IDs and mutually distinct.
- The deployment script hard-codes `network-config testnet`.
- The script requires an explicit `DEPLOY-TESTNET` confirmation before signing deployment transactions.
- WRT is initialized with the buyer as owner; JobEscrow is initialized with the exact WRT account as its immutable allowed FT.
- No Agent Market paid endpoint, mainnet path, or real-asset flow is invoked.
- The terms helper labels its hashes as illustrative demo fixtures, not researched claims.

## Verification performed for this package

- Node suite: 228 passed, 0 failed, 0 skipped.
- NEAR JavaScript terms tests: 4 passed.
- Publisher candidate validation: 9 exact-host candidates validated; all remain inactive.
- Bash syntax check: passed.
- Node syntax check: passed.
- Demo terms generation and canonical hash validation: passed.
- Nested `ft_transfer_call` JSON message validation: passed.
- Deployment-script dry-run with a mock `near` executable: passed; no network, signing or real transaction occurred.
- SHA-256 manifest verification: passed.

## Not performed / still required

- No Rust compiler or Cargo is installed in the current ChatGPT execution environment.
- No new Rust host or WASM compilation was run here.
- No NEAR Sandbox binary is available here; Sandbox integration tests remain outstanding.
- No testnet account IDs, private keys, seed phrases or wallet approvals were supplied or used.
- No testnet deployment or on-chain transaction has occurred.

## Operator decision

Recommended: run the full `npm run test:near-contracts` Sandbox gate from the WSL2 environment first. If network restrictions and the hackathon deadline make that impossible, the runbook describes a clearly provisional testnet smoke using only disposable `.testnet` accounts and WRT (no monetary value). Such a smoke is not local contract acceptance, not an audit, not mainnet safety evidence, and not Agent Market payment.
