# NEAR escrow implementation report — source draft

**Status:** operator-reported Rust host gate, Clippy and WASM compilation pass on Rust 1.97.0; local NEAR Sandbox integration acceptance remains outstanding. **Do not deploy this package to testnet yet.**

## Scope implemented in source

The repository now contains a separate Rust workspace for the hackathon's optional settlement proof:

- `contracts/job-escrow` — one buyer, one assigned NEAR account provider, one named resolver, one immutable allowlisted FT account and one immutable job agreement per job ID.
- `contracts/workrelay-test-token` — WorkRelay-controlled NEP-141/NEP-145/NEP-148 token `WRT`, six decimals, owner-only test mint and explicit no-monetary-value metadata.
- `contracts/integration-tests` — tests written against compiled contract WASM in local NEAR Sandbox.
- `scripts/near-escrow-terms.js` and `contracts/test-vectors/terms-v1.json` — fixed-order cross-language terms commitment and shared golden vector.

## Contract design currently represented

- Both initializers require a self-call from the deployed contract account and reject chain IDs other than `testnet` or local `sandbox`.
- WRT v1 is fixed at six decimals; escrow terms declaring another decimal count are rejected.
- The escrow pins one FT account at initialization and requires that exact token, the named buyer, the exact atomic amount, a `Created` job and the versioned deposit message.
- Invalid deposits are returned in full through the NEP-141 receiver result.
- Job terms are typed and hash-committed using compact UTF-8 JSON in a documented field order.
- Provider acceptance, submission, buyer acceptance/revision/dispute, named-resolver allocation and pre-submission refund claims are separate transitions. A revision can only be requested before the committed delivery deadline; if the provider does not resubmit by that deadline, the job enters dispute without automatic refund or payout.
- Submission alone creates no payout. Buyer silence after submission moves the job to an unresolved dispute after the review deadline; it does not auto-refund or auto-pay.
- WRT withdrawals use a pull claim, an in-flight amount and a private callback that finalizes on success or restores the same claim on failure.
- Native-NEAR storage refunds use a separate pull-claim ledger and private callback; excess job-creation deposits and measured archive refunds are never sent as unchecked fire-and-forget promises.
- The liability view reports WRT unsettled/claimable/in-flight accounting separately from native-NEAR refund liability. The two assets are never added together.
- Job IDs have permanent compact tombstones, including after job archival, so an archived ID cannot be reused. Archival credits only the storage cost actually released by removing the job record to the buyer's native-NEAR pull claim; the tombstone's storage remains reserved.
- Only hashes, terms and state are stored. Research bodies, evidence packets and personal data remain off-chain.

## Tests written but not yet executed

The Sandbox integration test source covers:

- successful create, exact deposit, provider acceptance, submission, buyer acceptance and provider withdrawal;
- exact preview/committed terms hash agreement;
- one revision and changed resubmission hash;
- unresolved dispute, resolver-only exact allocation and separate buyer/provider withdrawals;
- provider decline and pre-submission refund claim;
- provider non-acceptance deadline and accepted-but-not-delivered deadline refund paths;
- late revision requests are rejected, and a requested revision not resubmitted by the delivery deadline enters dispute with no automatic payout/refund;
- buyer silence after submission: review expiry enters unresolved dispute, with no automatic refund or payment;
- unauthorized role actions and duplicate withdrawal;
- unregistered withdrawal recipient with callback claim restoration;
- wrong allowlisted FT, wrong sender, wrong amount, malformed/unsupported deposit messages and duplicate deposit;
- six-decimal enforcement, archived job-ID non-reuse and contract-account-only initialization.

Six NEAR Sandbox integration test functions are now authored. The operator reports that both contracts compiled to WASM, host Clippy/unit-test gates passed (JobEscrow 5/5, WRT 4/4), and integration-test Clippy passed on Rust 1.97.0. The six Sandbox integration test functions themselves remain unexecuted because the `near-sandbox` binary download was blocked. The complete specification matrix is not yet covered. In particular, callback replay/recovery edge cases, storage refund measurements, and explicit liability/FT-balance invariant assertions after every negative transition need additional executable Sandbox cases before acceptance.

## Executed checks in this environment

| Check | Result |
|---|---|
| `npm test` | 228 passed, 0 failed, 0 skipped (current source checkpoint) |
| `npm run test:near-terms` | 4 passed, 0 failed |
| `npm run validate:publisher-candidates` | 9 exact-host candidates validated; pack remains inactive |
| JavaScript syntax checks | Passed |
| Shell script syntax checks (`bash -n`) | Passed |
| Production Node server smoke test | Passed; homepage HTTP 200 |
| `/api/health` | `commissioningConfigured: false`, `paymentNetworks: []` |

The Node results and terms tests do not validate on-chain behavior. The operator reports successful Rust host tests and WASM compilation, but the six NEAR Sandbox integration test functions remain source-only until run against the compiled WASM with an actual local Sandbox binary in WSL2/Linux. The current ZIP does not include Cargo.lock; retain the lockfile generated by the passing operator run with the exact source and WASM artifacts.

## Unexecuted gates and environment limitation

This container does not have `rustc`, `cargo`, `rustup` or a NEAR Sandbox executable. Its outbound dependency-host DNS is unavailable. Consequently:

- This ChatGPT container cannot independently rerun Rust formatting, Clippy, host unit tests, WASM compilation or Sandbox tests because it lacks the Rust toolchain and NEAR Sandbox binary; the operator reports the host and WASM gates passed on Rust 1.97.0.
- The NEAR Sandbox integration suite has not been executed.
- `Cargo.lock` is not included in this ZIP; preserve the generated lockfile from the operator's tested environment.
- No testnet deployment, wallet UI or on-chain transaction has occurred.

The escrow package now declares the direct `borsh` and `near-contract-standards` dependencies; the test-token package declares its direct `borsh` dependency. Both NEAR crates are aligned at 5.30.1. The macro-only remote-interface traits are explicitly marked as consumed by `#[ext_contract]`. The former detached native-NEAR transfer paths have been replaced by callback-protected pull-refund accounting. WRT initialization is a non-payable self-call funded by the deployed token account's liquid balance, so it no longer schedules a redundant self-transfer. The repository toolchain is Rust 1.97.0; the workspace minimum is Rust 1.95. Run `npm run format:near-contracts` once to apply rustfmt and refresh `SHA256SUMS.txt`, then `npm run check:near-host` verifies formatting without changing source, runs Clippy and both contract crates' host unit tests. The first host-check invocation generates `Cargo.lock`; review and retain that generated lockfile with the tested source so transitive dependency resolution is frozen.

## Required next action — WSL2 Ubuntu

On Windows, use WSL2 Ubuntu rather than Git Bash for Rust/NEAR Sandbox work. Copy the project into the WSL Linux filesystem (for example `~/workrelay`) and run:

```bash
rustup toolchain install 1.97.0
rustup component add rustfmt clippy --toolchain 1.97.0
# If pinned download is blocked but installed stable is exactly 1.97.0:
export RUSTUP_TOOLCHAIN=stable

rustc --version
cargo --version
rustup target list --installed

npm test
npm run validate:publisher-candidates
npm run format:near-contracts
npm run check:near-host
rustup target add wasm32-unknown-unknown --toolchain "${RUSTUP_TOOLCHAIN:-1.97.0}"
npm run test:near-contracts
```

The contract test script builds both WASM contracts, runs Rust unit tests, runs local NEAR Sandbox integration tests, then reruns the Node regression suite and inactive publisher-candidate validator. It does not deploy to testnet.

Before testnet deployment, run the complete Sandbox matrix including native-refund and FT-callback failure paths, inspect the generated `Cargo.lock`, inspect WASM checksums, and require every local gate to pass.

## Explicit boundaries

- No Agent Market provider is commissioned or paid by this contract.
- No mainnet support, mainnet funding CTA, production signer, backend key, arbitrary FT, token rescue, admin drain, contract upgrade or cross-chain route is implemented.
- WRT is a no-value test token, not USDC.
- A testnet transaction proves only the tested contract state transition; it does not prove research truth, provider delivery or Agent Market payment.


## Operator review follow-up

- Corrected all integration-test transaction result handling: successful transactions explicitly consume the final execution result; expected failures assert the final on-chain failure status; failed FT withdrawal asserts the failed receipt and then checks restored claim/liability state.
- Added four unit tests to the WorkRelay test-token crate (metadata/notice and mint preconditions).
- Added integration-test Clippy with `-D warnings` to the full Sandbox script.
- Made host formatting verification non-mutating and added `npm run format:near-contracts` as the explicit formatter command.
- The WASM and Sandbox gates remain pending until run in WSL2.
