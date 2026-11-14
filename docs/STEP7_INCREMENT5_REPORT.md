# Step 7 implementation report — Increment 5

**Date:** 2026-11-14  
**Status:** Implemented; Step 7 remains in progress.

## Objective

Prevent an official publisher's authority tier from becoming blanket permission to support any claim. Increment 4's candidate pack already described subject scopes and permitted claim types, but the active registry contract did not preserve or enforce those fields. Increment 5 closes that mismatch.

## Changes delivered

### 1. Publisher-authority registry v2

`workrelay.publisher-authority-registry.v2` now requires each exact-host entry to include:

- `hostname` — exact DNS host only; wildcards and ports are rejected;
- `publisherGroup` — grouping for corroboration;
- `authorityTier` — regulator, primary, academic, secondary or unknown;
- `scope` — one or more human-readable descriptions of the publisher remit;
- `permittedClaimTypes` — non-empty unique allowlist from the supported WorkRelay claim types;
- `basis` and `validUntil` — review basis and expiry.

The evaluator separately enforces the claim-type allowlist and minimum authority tier for each material claim/source link. A host whose registry entry does not permit the claim type fails `source_authority_policy`, even if its tier would otherwise be sufficient. Minimum tiers now explicitly require regulator for `regulatory` and `regulatory_current`, and primary for financial/numeric/market and daily/monthly/quarterly/annual series.

### 2. Evidence review v2

`workrelay.evidence-review.v2` adds mandatory `scopeAssessments`. Each record identifies a `claimId`, `sourceId`, `inScope` boolean and rationale. For every material claim/source pair linked as `supports` or `contradicts`, the latest packet-bound review must contain exactly the relevant assessments. Missing or mismatched pairs remain review-required; an explicit out-of-scope finding blocks acceptance with `check_failed`.

This is a human scope judgment. The runtime does not claim to semantically interpret the free-text registry scope. It displays the scope and enforces the claim-type allowlist, while requiring the reviewer to assess the exact source/claim pair.

### 3. Version migration and inactive candidate governance

The active registry and review schema identifiers were bumped to v2. v1 committed records are not accepted as v2 records. Existing v1 registry records must be independently reviewed and re-issued with scopes and claim-type allowlists; v1 review records must be re-issued with the new source-by-source assessments. Legacy unversioned host maps remain review-required.

The nine Nigeria fintech exact-host candidates remain `candidate_only_not_active`. Candidate validation confirms pack structure only; it does not approve or activate any publisher. A new owner-review worksheet records the decision fields without pre-populating approval.

### 4. User interface and adversarial tests

Execution evidence panels display registry subject scope and permitted claim types. Regression tests cover missing scope fields, unsupported claim types, claim-type restrictions, under-tier regulatory-current sources, missing or extra scope assessments, explicit out-of-scope reviewer declarations and rejection of legacy v1 commitments.

## Validation

- `npm test`: 220 passed, 0 failed, 0 skipped in the available Linux environment (includes nested subtests).
- `npm run validate:publisher-candidates`: passed; nine exact-host candidates validated with explicit scopes and permitted claim types; candidate pack remains inactive.
- Syntax checks passed for the evidence engine, browser UI and candidate validator.
- Clean extraction, checksum verification and production-mode smoke test passed.
- Health endpoint retained `commissioningConfigured: false` and `paymentNetworks: []`.
- Native Windows verification of Increment 5 remains required before adopting this package as the cross-platform baseline.

## Limitations and deferred work

- The human-readable scope is not automatically semantically interpreted; each material source/claim pair requires reviewer assessment.
- Human reviewer identifiers are declarations, not authenticated identities. Authenticated accounts and durable review persistence belong to Step 8.
- Candidate publishers are still inactive pending deployment-owner review.
- Authority scope and type allowlists do not establish factual truth, source authenticity or independence.
- Registry/review durable storage, source retention/deletion controls and operational audit retention remain Step 8 concerns.

## Safety boundary

No live provider commissioning, wallet signing, settlement or real payment capability was added or enabled. Simulation labels and payment-disabled defaults are preserved.
