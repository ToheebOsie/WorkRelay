# Revision deadline state-machine correction

## Problem

A buyer could previously request a revision after the committed provider delivery deadline because `request_revision` checked only the buyer review deadline. The provider could not resubmit after the delivery deadline, and the state machine had no expiry transition for `RevisionRequested`. That could leave the escrow unsettled indefinitely.

## Correction

- `request_revision` now requires the current block timestamp to be no later than both the buyer review deadline and the provider delivery deadline.
- `mark_revision_expired_disputed(job_id)` is permissionless only when the job is `RevisionRequested` and the provider delivery deadline has passed.
- The transition changes the state to `Disputed`, creates no buyer refund claim and no provider payout, and leaves the original WRT escrow unsettled for the named resolver.
- The named resolver remains the only role that can allocate the exact escrow amount.

## New Sandbox test coverage

The new `sandbox_revision_deadline_expiry_uses_dispute_path` scenario checks:

1. A buyer's late revision request fails after the delivery deadline.
2. The submitted job can still enter the ordinary dispute route before the buyer review deadline.
3. A revision-expiry trigger fails before the delivery deadline.
4. A revision that is not resubmitted by the delivery deadline enters `Disputed` after expiry.
5. No automatic refund or provider payout is created by expiry.
6. The named resolver can allocate the exact amount, buyer/provider claims can be withdrawn, and WRT liability returns to zero.

The Sandbox scenario is written but has not yet executed because the `near-sandbox` binary was unavailable in the operator's environment. It must pass as part of `npm run test:near-contracts` before local contract acceptance.
