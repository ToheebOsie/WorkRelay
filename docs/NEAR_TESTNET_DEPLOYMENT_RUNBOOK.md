# WorkRelay NEAR testnet deployment runbook (hackathon fast path)

**Scope:** deploy the WRT test token and JobEscrow to disposable `.testnet` accounts, inspect their real chain configuration, and optionally execute one small, user-signed testnet escrow lifecycle. This does not deploy to mainnet, does not pay an Agent Market provider, and does not prove research truth.

## Important acceptance note

The contract source has reported host and WASM build success on Rust 1.97.0. The full local NEAR Sandbox integration suite was not confirmed as executed in the environment that produced the latest report. Prefer to run `npm run test:near-contracts` first. If the time/network restriction makes that impossible, a testnet deployment is an explicitly provisional smoke test using disposable accounts and WRT only; it is not a substitute for local contract acceptance or an audit. Do not reuse these contracts for mainnet or valuable assets.

## 1. Build the exact WASM from the latest source

From the WorkRelay root in WSL2 Ubuntu:

```bash
npm test
npm run test:near-terms
npm run format:near-contracts
npm run check:near-host
npm run build:near-contracts
```

If available, run the full local gate before deployment:

```bash
npm run test:near-contracts
```

The deploy script requires these files:

- `artifacts/near/workrelay_test_token.wasm`
- `artifacts/near/job_escrow.wasm`

Record their SHA-256 hashes and keep the Rust source, `Cargo.lock`, and WASM files together for the submission evidence.

## 2. Install and authenticate with near-cli-rs

Official installation options are documented in the [near-cli-rs repository](https://github.com/near/near-cli-rs). On WSL2, the official installer is:

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh | sh
near --version
```

Create/login to your **testnet** buyer account through the CLI or wallet. Never paste a seed phrase/private key into this repository, chat, shell history, `.env`, or a shared terminal transcript. The deployment commands use your local CLI keychain.

## 3. Choose five separate accounts

Set these names in your WSL shell. The buyer account is also the WRT mint owner. All five must end in `.testnet` and be distinct:

```bash
export WORKRELAY_BUYER_ACCOUNT='YOUR-BUYER.testnet'
export WORKRELAY_PROVIDER_ACCOUNT='provider.YOUR-BUYER.testnet'
export WORKRELAY_RESOLVER_ACCOUNT='resolver.YOUR-BUYER.testnet'
export WORKRELAY_WRT_ACCOUNT='wrt.YOUR-BUYER.testnet'
export WORKRELAY_ESCROW_ACCOUNT='escrow.YOUR-BUYER.testnet'
```

The provider is a NEAR account for this controlled demonstration, **not** an Agent Market handle. The resolver is a separate account to make the dispute authority explicit.

Create/fund the four subaccounts if they do not already exist. Example syntax using near-cli-rs; this creates a fresh keypair for each account and stores it in the local keychain:

```bash
near account create-account fund-myself "$WORKRELAY_WRT_ACCOUNT" '12 NEAR' autogenerate-new-keypair save-to-keychain sign-as "$WORKRELAY_BUYER_ACCOUNT" network-config testnet sign-with-keychain send
near account create-account fund-myself "$WORKRELAY_ESCROW_ACCOUNT" '12 NEAR' autogenerate-new-keypair save-to-keychain sign-as "$WORKRELAY_BUYER_ACCOUNT" network-config testnet sign-with-keychain send
near account create-account fund-myself "$WORKRELAY_PROVIDER_ACCOUNT" '0.5 NEAR' autogenerate-new-keypair save-to-keychain sign-as "$WORKRELAY_BUYER_ACCOUNT" network-config testnet sign-with-keychain send
near account create-account fund-myself "$WORKRELAY_RESOLVER_ACCOUNT" '0.5 NEAR' autogenerate-new-keypair save-to-keychain sign-as "$WORKRELAY_BUYER_ACCOUNT" network-config testnet sign-with-keychain send
```

The 12 NEAR contract-account allocations are a conservative testnet starting allowance based on the prior WASM sizes (~283 KiB WRT and ~419 KiB escrow) and NEAR's per-byte storage staking model. Check actual account balances; if deployment reports insufficient balance, stop and inspect the precise required amount rather than repeatedly transferring funds. These are testnet tokens with no real monetary value.

If the account already exists, do not run `create-account` again. Ensure its access key is available to near-cli-rs keychain and that it has sufficient liquid balance.

## 4. Deploy WRT first, then escrow

The contract initializers require a **self-call**. The near-cli-rs `near contract deploy ... with-init-call ... sign-with-keychain send` flow submits the deployment and initializer call under the contract account itself. Official command syntax is shown in the [near-cli-rs deployment guide](https://github.com/near/near-cli-rs/blob/main/docs/GUIDE.en.md).

Run the guarded script:

```bash
npm run deploy:near-testnet
```

It prints the account IDs, file sizes and WASM hashes, checks contract-account balances, requires the literal confirmation `DEPLOY-TESTNET`, deploys WRT first, then JobEscrow, and performs read-only post-deployment views. Network selection is hard-coded to `testnet`; all account IDs are rejected unless they end in `.testnet`.

If WRT deployed successfully but the escrow step failed, do not redeploy WRT. Resume only the escrow step:

```bash
WORKRELAY_DEPLOY_STEP=escrow npm run deploy:near-testnet
```

If neither was deployed, use the default `all` step. If escrow deployed but WRT did not, stop and diagnose; do not initialize escrow with a different token by guesswork.

## 5. Verify the deployed contracts from chain state

The script calls the following read-only methods. Inspect their returned JSON:

```bash
near contract call-function as-read-only "$WORKRELAY_WRT_ACCOUNT" ft_metadata json-args '{}' network-config testnet now
near contract call-function as-read-only "$WORKRELAY_WRT_ACCOUNT" get_token_notice json-args '{}' network-config testnet now
near contract call-function as-read-only "$WORKRELAY_ESCROW_ACCOUNT" get_contract_config json-args '{}' network-config testnet now
near contract call-function as-read-only "$WORKRELAY_ESCROW_ACCOUNT" get_liabilities json-args '{}' network-config testnet now
```

Required values:

- WRT metadata `symbol` is `WRT`, `decimals` is `6`, and its name says no monetary value.
- WRT notice says it is not USDC and cannot be used for Agent Market payment.
- Escrow `chainId` is `testnet`.
- Escrow `allowedFtContractId` equals `WORKRELAY_WRT_ACCOUNT`.
- Escrow `tokenDecimals` is `6` and `mainnetEnabled` is `false`.
- Initial WRT liabilities are zero and `accountingInvariantHolds` is true.

Keep the actual transaction IDs and testnet explorer URLs printed by the CLI. Never invent explorer links.

## 6. Optional smallest end-to-end escrow smoke test (WRT only)

Only proceed after both read-only contract views are correct. This is a real testnet transaction sequence signed locally by the buyer/provider accounts, but WRT has no monetary value.

### 6.1 Register provider and escrow with WRT

First inspect the minimum registration deposit:

```bash
near contract call-function as-read-only "$WORKRELAY_WRT_ACCOUNT" storage_balance_bounds json-args '{}' network-config testnet now
```

Use the returned `min` (converted from yoctoNEAR to NEAR) as `FT_STORAGE_DEPOSIT`. A small overpayment is acceptable but remains locked as that account's token-storage balance; do not use a large arbitrary deposit.

```bash
export FT_STORAGE_DEPOSIT='0.01 NEAR' # replace with the returned minimum in NEAR units
near contract call-function as-transaction "$WORKRELAY_WRT_ACCOUNT" storage_deposit json-args "{\"account_id\":\"$WORKRELAY_PROVIDER_ACCOUNT\",\"registration_only\":true}" prepaid-gas '30 TGas' attached-deposit "$FT_STORAGE_DEPOSIT" sign-as "$WORKRELAY_BUYER_ACCOUNT" network-config testnet sign-with-keychain send
near contract call-function as-transaction "$WORKRELAY_WRT_ACCOUNT" storage_deposit json-args "{\"account_id\":\"$WORKRELAY_ESCROW_ACCOUNT\",\"registration_only\":true}" prepaid-gas '30 TGas' attached-deposit "$FT_STORAGE_DEPOSIT" sign-as "$WORKRELAY_BUYER_ACCOUNT" network-config testnet sign-with-keychain send
```

The buyer is pre-registered by the WRT initializer. The escrow must be registered as a token receiver before `ft_transfer_call`; the provider must be registered before it can withdraw.

### 6.2 Mint one WRT to the buyer

```bash
near contract call-function as-transaction "$WORKRELAY_WRT_ACCOUNT" mint json-args "{\"receiver_id\":\"$WORKRELAY_BUYER_ACCOUNT\",\"amount\":\"1000000\"}" prepaid-gas '20 TGas' attached-deposit '1 yoctoNEAR' sign-as "$WORKRELAY_BUYER_ACCOUNT" network-config testnet sign-with-keychain send
```

`1000000` atomic units = `1 WRT` at six decimals. Mint is an owner-only demo action; it is not USDC or an asset with monetary value.

### 6.3 Generate a fresh, hash-bound demo job

```bash
npm run prepare:near-testnet-demo-terms
```

This writes `artifacts/near/testnet-demo-terms.json` and prints the local canonical terms SHA-256. Its brief/criteria hashes are deliberately illustrative demo text, **not researched facts**. The helper sets three ordered future deadlines and a unique job ID.

### 6.4 Create job and fund it with exact WRT

```bash
TERMS_JSON="$(cat artifacts/near/testnet-demo-terms.json)"
JOB_ID="$(node -e "const t=JSON.parse(require('fs').readFileSync('artifacts/near/testnet-demo-terms.json','utf8')); process.stdout.write(t.jobId)")"

near contract call-function as-transaction "$WORKRELAY_ESCROW_ACCOUNT" create_job json-args "{\"terms\":$TERMS_JSON}" prepaid-gas '100 TGas' attached-deposit '2 NEAR' sign-as "$WORKRELAY_BUYER_ACCOUNT" network-config testnet sign-with-keychain send
near contract call-function as-transaction "$WORKRELAY_WRT_ACCOUNT" ft_transfer_call json-args "{\"receiver_id\":\"$WORKRELAY_ESCROW_ACCOUNT\",\"amount\":\"1000000\",\"memo\":\"WorkRelay testnet escrow demo\",\"msg\":\"{\\\"schema\\\":\\\"workrelay.escrow-deposit.v1\\\",\\\"jobId\\\":\\\"$JOB_ID\\\"}\"}" prepaid-gas '100 TGas' attached-deposit '1 yoctoNEAR' sign-as "$WORKRELAY_BUYER_ACCOUNT" network-config testnet sign-with-keychain send
```

`create_job` attaches 2 NEAR for measured native storage. Excess becomes a buyer pull-refund claim; it is not an escrow payment. The FT transfer is exactly 1 WRT.

### 6.5 Provider accepts, submits a demo artifact, and buyer accepts

Create a clearly labelled illustrative artifact digest (not a claim of actual research):

```bash
printf '%s' 'WorkRelay hackathon testnet demo artifact; not factual research.' > artifacts/near/demo-deliverable.txt
ARTIFACT_HASH="$(sha256sum artifacts/near/demo-deliverable.txt | awk '{print $1}')"
```

Then sign each action with the account whose role is required:

```bash
near contract call-function as-transaction "$WORKRELAY_ESCROW_ACCOUNT" accept_job json-args "{\"job_id\":\"$JOB_ID\"}" prepaid-gas '20 TGas' attached-deposit '0 NEAR' sign-as "$WORKRELAY_PROVIDER_ACCOUNT" network-config testnet sign-with-keychain send
near contract call-function as-transaction "$WORKRELAY_ESCROW_ACCOUNT" submit_artifact json-args "{\"job_id\":\"$JOB_ID\",\"artifact_hash\":\"$ARTIFACT_HASH\"}" prepaid-gas '20 TGas' attached-deposit '0 NEAR' sign-as "$WORKRELAY_PROVIDER_ACCOUNT" network-config testnet sign-with-keychain send
near contract call-function as-transaction "$WORKRELAY_ESCROW_ACCOUNT" accept_delivery json-args "{\"job_id\":\"$JOB_ID\"}" prepaid-gas '20 TGas' attached-deposit '0 NEAR' sign-as "$WORKRELAY_BUYER_ACCOUNT" network-config testnet sign-with-keychain send
```

### 6.6 Provider withdraws and verify the final views

```bash
near contract call-function as-transaction "$WORKRELAY_ESCROW_ACCOUNT" withdraw_claim json-args "{\"job_id\":\"$JOB_ID\"}" prepaid-gas '80 TGas' attached-deposit '1 yoctoNEAR' sign-as "$WORKRELAY_PROVIDER_ACCOUNT" network-config testnet sign-with-keychain send
near contract call-function as-read-only "$WORKRELAY_ESCROW_ACCOUNT" get_job json-args "{\"job_id\":\"$JOB_ID\"}" network-config testnet now
near contract call-function as-read-only "$WORKRELAY_ESCROW_ACCOUNT" get_liabilities json-args '{}' network-config testnet now
near contract call-function as-read-only "$WORKRELAY_WRT_ACCOUNT" ft_balance_of json-args "{\"account_id\":\"$WORKRELAY_PROVIDER_ACCOUNT\"}" network-config testnet now
```

Expected final job state: `accepted`; provider claim should have been withdrawn; `get_liabilities.accountingInvariantHolds` should be `true`; provider WRT balance should reflect the 1 WRT payout. Confirm from contract views and FT balance, not events alone.

## 7. Stop conditions and truthful hackathon claims

Stop and preserve logs if any transaction fails, a view does not match, the FT balance is below escrow liabilities, or a callback leaves an unexpected in-flight claim. Do not rerun a paid/withdrawal action blindly; inspect contract state first.

For the submission, say only what you demonstrated:

- A real NEAR **testnet** contract deployment and user-signed test-token transaction.
- The deployed escrow accepted WRT test-token funding and the tested state transition.
- WRT has no monetary value; this did not pay a real research provider.
- The escrow is not connected to Agent Market A2A commissioning.
- A testnet transaction does not prove mainnet safety, audited correctness, research truth or production payment readiness.

Mainnet deployment, real assets and live Agent Market paid commissioning remain out of scope.
