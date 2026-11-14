# WorkRelay testnet escrow method reference (v1)

This contract is a separate testnet proof. Its chain guard accepts only `testnet` and local `sandbox`; it rejects `mainnet`. It is not connected to Agent Market commissioning.

## Initialization

`new({ allowed_ft_contract_id })`

One-time initializer. The call must be signed by the contract account itself; this prevents an unrelated account from claiming an uninitialized deployment. The exact FT contract is immutable. `env::chain_id()` must be `testnet` or `sandbox`. WRT v1 uses exactly six decimals.

## Terms

`EscrowTerms` JSON fields, in commitment order:

1. `schema` — `workrelay.testnet-escrow-terms.v1`
2. `jobId`
3. `buyerAccountId`
4. `providerAccountId`
5. `agentMarketHandle` (nullable, descriptive only)
6. `briefHash`
7. `acceptanceCriteriaHash`
8. `verifierName`
9. `verifierVersion`
10. `ftContractId`
11. `tokenDecimals`
12. `atomicAmount` (canonical positive decimal string)
13. `providerAcceptanceDeadlineNs` (canonical decimal string)
14. `deliveryDeadlineNs` (canonical decimal string)
15. `buyerReviewDeadlineNs` (canonical decimal string)
16. `revisionLimit` (0 or 1)
17. `resolverAccountId`
18. `disputePolicyVersion`

Commitment v1 is SHA-256 of compact UTF-8 JSON serialized in this exact struct field order, with `agentMarketHandle: null` when absent. Numbers above JavaScript's safe-integer range are represented as decimal strings. Unknown fields, noncanonical amounts/deadlines and uppercase/non-64-byte hashes are rejected. Shared cross-language vector: `contracts/test-vectors/terms-v1.json`.

## Methods

| Method | Caller | Behavior |
|---|---|---|
| `preview_terms_hash({terms})` | View | Returns the deterministic terms commitment. |
| `create_job({terms})` | Named buyer, payable | Stores immutable terms and digest; attached NEAR pays measured storage growth; excess becomes a native-NEAR pull refund claim. |
| `ft_on_transfer({sender_id, amount, msg})` | Allowlisted FT only | Accepts only exact token, buyer, amount, Created state and versioned one-field deposit message. Invalid transfers return the full amount unused. |
| `accept_job({job_id})` | Assigned provider | Funded → ProviderAccepted, before acceptance deadline. |
| `decline_job({job_id, rationale_hash})` | Assigned provider | Funded → Refundable; creates buyer's full pull claim. |
| `submit_artifact({job_id, artifact_hash})` | Assigned provider | ProviderAccepted/RevisionRequested → Submitted. Resubmission hash must change. |
| `request_revision({job_id, rationale_hash})` | Buyer | Submitted → RevisionRequested; maximum committed one revision, requested no later than the committed delivery deadline. |
| `mark_revision_expired_disputed({job_id})` | Permissionless | After delivery deadline, RevisionRequested → Disputed if no resubmission arrived; no default allocation. |
| `accept_delivery({job_id})` | Buyer | Submitted → Accepted; creates provider pull claim. |
| `open_dispute({job_id, rationale_hash})` | Buyer | Submitted → Disputed. |
| `mark_review_expired_disputed({job_id})` | Permissionless | After buyer review deadline, Submitted → Disputed; no default allocation. |
| `make_pre_submission_refund_claimable({job_id})` | Permissionless | After provider-acceptance or delivery deadline, before submission; makes only buyer refund claimable. |
| `resolve_dispute({job_id, provider_amount, buyer_refund_amount, rationale_hash})` | Named resolver | Disputed → Resolved; exact sum must equal original amount. |
| `withdraw_claim({job_id})` | Buyer or provider | One-at-a-time pull withdrawal; claim is moved to in-flight until callback. Requires 1 yoctoNEAR. |
| `resolve_withdrawal(...)` | Private callback | Successful FT transfer reduces liability; failed transfer restores the exact claim. Replay/stale callback rejected. |
| `archive_terminal_job({job_id})` | Buyer | Removes an Accepted/Refundable/Resolved job only after all claims are withdrawn and no transfer is in flight. A permanent job-ID tombstone remains; storage actually released by removing the job record is credited as a native-NEAR pull refund. |
| `get_native_refund({account_id})` | View | Shows claimable and in-flight native-NEAR storage refunds. |
| `withdraw_storage_refund()` | Refund owner, payable | Pulls accumulated native-NEAR refunds; requires 1 yoctoNEAR and uses a private callback to restore failed transfers. |
| `resolve_native_refund(...)` | Private callback | Finalizes a successful native transfer or restores the exact refund claim after failure. |

## Views

- `get_job({job_id})`
- `get_contract_config()` — includes the allowlisted FT account, six token decimals, schema IDs and `mainnetEnabled: false`.
- `get_claim({job_id, account_id})`
- `is_job_id_used({job_id})`
- `get_liabilities()`

`get_liabilities` exposes unsettled escrow, WRT claimable and in-flight accounting, the separate native-NEAR refund liability, and whether the WRT amounts sum to total WRT liability. Native NEAR refunds are not combined with WRT atomic units. The FT token balance must be independently queried in the integration tests and must be at least total WRT liability.

## Events

Events use NEP-297 `EVENT_JSON:` records with standard `workrelay_escrow`, version `1.0.0`. Events are indexer aids only; read-only contract views are the source of current state.

## Not provided

No wallet UI, Agent Market payment bridge, mainnet config, token rescue, admin drain, contract upgrade or production signer is included. Testnet deployment commands are now documented separately in `docs/NEAR_TESTNET_DEPLOYMENT_RUNBOOK.md`; this repository has not itself performed a testnet deployment.


## Deployment and native refund notes

- The WRT contract account must be funded with enough liquid NEAR to cover its initial storage before its contract-account self-initialization call. `new` is non-payable and does not transfer attached funds to itself.
- `create_job` storage overpayment and measured archive storage release are credited to the buyer's native-NEAR pull-refund record. `withdraw_storage_refund` requires 1 yoctoNEAR and returns a callback Promise; a failed transfer restores the same claim. Native NEAR liabilities are reported separately from WRT escrow liabilities.

