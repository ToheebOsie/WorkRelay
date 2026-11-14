# WorkRelay NEAR testnet escrow — narrow contract specification

**Status:** implementation draft exists in `contracts/`; it has not yet been compiled, run in NEAR Sandbox or deployed. Local acceptance remains mandatory.

**Purpose:** demonstrate one human-readable, hash-bound research job agreement and a conservative escrow state machine on NEAR testnet. This is separate from Agent Market A2A quotes and payment.

## Scope

Build exactly two Rust contracts:

1. `job-escrow` — one buyer, one assigned NEAR testnet provider account, one named resolver, one allowlisted test fungible token and one job agreement per job ID.
2. `workrelay-test-token` — a WorkRelay-controlled NEP-141/NEP-145/NEP-148 test token (suggested symbol `WRT`, decimals fixed in metadata) with owner-only test minting. It must say prominently that the token has no real monetary value. It is not USDC and is not an Agent Market asset.

No mainnet, arbitrary tokens, cross-chain route, NEAR Intents, multi-provider allocation, paid Agent Market commissioning or admin drain/upgrade path. WRT v1 is fixed to six token decimals.

## Canonical agreement commitment

Define a versioned contract-side record `workrelay.testnet-escrow-terms.v1`. It must bind at least:

- `jobId`;
- `buyerAccountId` (NEAR testnet account; must equal the transaction predecessor at job creation);
- `providerAccountId` (NEAR testnet account that will accept/submit/withdraw; this is not an Agent Market handle);
- optional `agentMarketHandle` as descriptive off-chain metadata only, never as a token recipient;
- `briefHash` and `acceptanceCriteriaHash` (lowercase SHA-256 hex);
- `verifierName` and `verifierVersion`;
- exact `ftContractId` and `tokenDecimals`;
- `atomicAmount` as a positive decimal integer string; never use floating point;
- `providerAcceptanceDeadlineNs`, `deliveryDeadlineNs`, `buyerReviewDeadlineNs`;
- `revisionLimit` (first version supports at most one revision);
- `resolverAccountId` and explicit `disputePolicyVersion`.

The contract must compute the terms digest from the normalized typed terms, not blindly trust a caller-supplied digest. Expose a read-only `preview_terms_hash(terms)` method so the UI can display the digest before the user signs. `create_job(terms)` must recompute the same digest and persist the terms plus digest. Add cross-language golden vectors proving the JS preview and Rust contract digest agree. The exact serialized commitment format must be documented and versioned.

Full briefs, evidence packets, source snapshots, personal data and deliverables stay off-chain. The contract stores only terms fields required for enforcement, hashes and state.

## State machine

Primary flow:

`Created -> Funded -> ProviderAccepted -> Submitted -> (RevisionRequested -> Submitted)* -> Accepted`

Alternative states:

- `Refundable` only before provider submission, when provider declines or an eligible pre-submission deadline is missed;
- `Disputed` after submission when the buyer disputes or a review deadline expires without acceptance/revision; it must remain unresolved until the named resolver acts;
- `Resolved` after the named resolver allocates the exact escrow amount between buyer and provider;
- `Archived` only after terminal allocation has been withdrawn. The job record is removed, but a compact permanent job-ID tombstone remains so IDs cannot be reused; only the storage actually released by removing the job record is refunded.

### Role rules

- Buyer creates a job and funds it; only buyer can request revision, accept a deliverable or open a dispute.
- Only the assigned provider NEAR account can accept, decline or submit.
- Only the exact resolver account named in immutable terms can resolve a dispute.
- Permissionless calls may trigger an objectively eligible pre-submission refund transition, but the refund claimant is still only the buyer.
- No actor can change provider, buyer, token, amount, hashes, verifier, deadlines, revision limit or resolver after job creation/funding.

### Deadline rules

- Provider must accept before `providerAcceptanceDeadlineNs`.
- Provider must submit before `deliveryDeadlineNs` after acceptance.
- Buyer may accept, request the allowed revision or dispute before `buyerReviewDeadlineNs`.
- Provider decline or missed pre-submission acceptance/delivery deadline can make a full buyer refund claim available.
- Do not automatically refund after submission solely because the buyer is silent.
- Do not automatically pay solely because the provider submitted.
- On buyer-review expiry after submission, leave allocation unresolved and require the named resolver. No default split or admin-controlled shortcut.

### Revision rules

- Revision requests are allowed only from buyer, only while Submitted and before the review deadline.
- The count may not exceed the immutable revision limit (maximum one in v1).
- A provider resubmission must supply a new 32-byte SHA-256 artifact digest.

### Dispute resolution

- Resolver may allocate `providerAmount` and `buyerRefundAmount` in atomic units.
- Checked arithmetic must require `providerAmount + buyerRefundAmount == original atomicAmount`.
- Resolution can occur once only, and creates pull-withdrawal claims. No direct automatic transfer inside the resolver method.

## NEP-141 token flow

- The escrow accepts only `ft_on_transfer` calls from the exact immutable allowlisted FT contract.
- Parse a narrow versioned transfer message containing only the job ID.
- Accept only when the job is Created, `sender_id == buyerAccountId`, and `amount == atomicAmount` exactly.
- On any invalid job, sender or amount, return the full received amount as unused so the NEP-141 token contract refunds it. Never partially accept an escrow deposit.
- On valid receipt, transition to Funded and record the escrow liability.
- Provider/buyer withdrawals use NEP-141 `ft_transfer` from the escrow contract, with the standard attached 1 yoctoNEAR. Recipients must be registered with the test FT; expose a clear registration check/instruction.
- The FT contract must implement the standard storage management and metadata interfaces. The escrow itself must be registered with the FT before deposits.

## Pull withdrawals and accounting

- No automatic push payment on acceptance or dispute resolution.
- Create claimable balances for the rightful recipient(s), then let each recipient explicitly withdraw.
- Before the external FT transfer, move the amount from `claimable` to `inFlight`; do not decrement total liability yet.
- A private callback may finalize the withdrawal on success. On failure it must restore exactly the amount in flight to the same claimant. Callback replay or unrelated predecessor must fail.
- Track total escrow liability and prove the invariant: contract FT balance is at least all unsettled escrow plus claimable and in-flight liabilities. Define the exact liability view and update points.
- Never let a job be refunded and released, or allocated twice.

## Storage economics

- Document NEAR storage staking and FT storage registration explicitly.
- `create_job` must require a payable storage deposit measured against actual storage usage (`storage_usage` delta multiplied by `storage_byte_cost`) and reject insufficient deposit. Excess is credited to a native-NEAR pull-refund ledger; it is not sent as an unchecked transfer promise.
- Pre-create the buyer's fixed-size native-refund record before measuring job storage so its storage cost is included in the buyer's measured stake.
- Keep the required per-job storage stake recorded. Provide an archive path only when the job is terminal, all token claims are withdrawn, and no transfer is in flight; remove the job record and credit only the storage cost actually released to the buyer's native-NEAR pull-refund ledger. Emit an archive event after state accounting is updated. The permanent job-ID tombstone remains reserved.
- `withdraw_storage_refund()` must be a separate buyer-authorized 1-yoctoNEAR pull action with a private callback. On success, reduce the native-refund liability; on failure, restore the exact amount and retain the liability. Never mix native-NEAR liabilities with WRT atomic units.
- If the implementation chooses a different storage model, document the owner-funded reserve and prove it cannot become an unbounded unpaid storage liability. Do not silently ignore storage costs.

## Contract methods and views

Minimum methods:

- `new(allowed_ft_contract_id)` — one-time initialization signed by the contract account itself; reject mainnet chain IDs; immutable token allowlist. WRT terms must declare six decimals.
- WRT `new(owner_id)` — one-time contract-account self-call. The deployed WRT account must be funded with enough liquid native NEAR to cover initialization storage; the constructor is non-payable and must not schedule a redundant transfer to itself.
- `preview_terms_hash(terms)` — view.
- `create_job(terms)` — buyer only; payable storage stake; computes and stores exact commitment.
- `ft_on_transfer(sender_id, amount, msg)` — NEP-141 receiver.
- `accept_job(job_id)` / `decline_job(job_id)` — assigned provider only.
- `submit_artifact(job_id, artifact_hash)` — assigned provider only.
- `request_revision(job_id, rationale_hash)` / `accept_delivery(job_id)` / `open_dispute(job_id, rationale_hash)` — buyer only.
- `make_pre_submission_refund_claimable(job_id)` — permissionless transition only when objective pre-submission conditions hold.
- `resolve_dispute(job_id, provider_amount, buyer_refund_amount, rationale_hash)` — named resolver only.
- `withdraw_claim(job_id)` and private FT transfer callback.
- `get_native_refund(account_id)` and `withdraw_storage_refund()` with private native-NEAR transfer callback.
- `archive_terminal_job(job_id)` — after all claim/liability and in-flight checks pass; retain a permanent compact job-ID tombstone and refund only actual released job-record storage.
- Views: `get_job`, `get_contract_config`, `get_claim`, `get_native_refund`, `get_liabilities`.

Emit standard NEAR events (NEP-297 format) for job creation, funding, provider acceptance/decline, submission, revision, acceptance, refund-claimable, dispute, resolution, withdrawal and archive. Events are an indexer aid, not the sole source of truth; tests must query contract views directly.

No admin drain, arbitrary token rescue, mutable recipient, mutable resolver, self-upgrade or owner override of job state.

## Local integration test matrix (NEAR Sandbox)

Tests must run against deployed WASM in a local sandbox, not only mocked JavaScript or `near-sdk` unit context.

1. Successful create -> exact test FT deposit -> provider accepts -> submits -> buyer accepts -> provider withdraws.
2. Exact digest recomputation and mismatch/material-term mutation tests.
3. Wrong FT contract, wrong sender, wrong amount, malformed message and reused job ID are safely rejected/refunded.
4. Buyer cannot act as provider; provider cannot accept/revise/dispute as buyer; unassigned provider cannot submit; non-resolver cannot resolve.
5. Provider decline enables buyer refund; provider non-acceptance deadline enables refund; accepted-but-not-delivered deadline enables refund.
6. After submission, buyer silence never auto-refunds or auto-pays; review expiry stays unresolved and requires resolver.
7. Buyer can request no more than committed revision limit; provider must resubmit.
8. Dispute allocation must sum exactly; zero/over/under-allocation and second resolution fail.
9. Pull withdrawal can occur once; duplicate calls/callbacks do not double pay; callback failure restores only the amount in flight.
10. Unregistered recipient and FT transfer failure preserve claim safely.
11. Deadline ordering, stale states, FT storage registration and contract storage stake/overpayment/archival refunds.
12. FT balance and liability invariant after every transition and withdrawal.
13. Contract views recover current state without relying on the WorkRelay API or an indexer.

`cargo test`/NEAR Sandbox integration suite and contract WASM build must pass before testnet deployment. Keep the Node regression suite green.

## Optional browser testnet integration (after local contract gate)

- Add a separate **NEAR testnet proof** mode. Do not overload Sandbox mode or Live Agent Market mode.
- Use a currently supported NEAR wallet connector; do not add the legacy Wallet Selector without current justification. The wallet signs directly in the browser; no secret key, seed phrase or private key reaches WorkRelay's server.
- Before opening the wallet, show network=`testnet`, escrow contract account, FT contract account, buyer/provider/resolver accounts, exact test-token symbol/decimals, atomic amount and formatted amount, terms hash, exact method/arguments, expected state transition, deadline and any native NEAR storage/transaction fee.
- After signing/submission, wait for the transaction outcome and then query contract views/RPC for actual state. Never optimistically display success from the wallet response or indexer event alone.
- Real explorer links require actual transaction hashes returned by the network. Do not fabricate hashes or explorer URLs.
- A no-wallet visitor retains the complete Sandbox.

## Deployment gate

- Local sandbox tests pass for all required cases.
- WASM build is reproducible and contract source/dependency versions are pinned.
- Deploy only to `.testnet` accounts and use only the WorkRelay test FT deployed on testnet.
- Deployment scripts and UI config must fail closed if network is not testnet or contract/token accounts are missing/invalid.
- Testnet proof is optional, explicitly user-signed and fully separate from Agent Market.
- No mainnet deployment or funding method is included.
