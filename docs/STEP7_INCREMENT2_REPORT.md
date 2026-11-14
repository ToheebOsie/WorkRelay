# Step 7 implementation report — increment 2

**Date:** 2026-11-14
**Status:** Increment 2 implemented; Step 7 remains in progress.

## Scope delivered

This increment extends the initial evidence-quality policy without changing the evidence-manifest v1 contract or enabling any live provider/payment path.

### 1. Versioned publisher authority registry

- Added schema identifier `workrelay.publisher-authority-registry.v1`.
- Added `commitPublisherAuthorityRegistry()` to create a canonical SHA-256 committed registry record.
- Registry records require an explicit confirmation, declared human reviewer, registry ID/version, review timestamp and statement.
- Each exact-host entry requires a publisher group, authority tier, review basis and `validUntil` timestamp.
- Wildcards, path-bearing hostnames, duplicate host entries, invalid tiers and invalid expiry windows are rejected.
- Expired entries remain visible but do not satisfy the reviewed publisher-authority requirement.
- Legacy exact-host maps remain readable for migration but are explicitly marked unversioned and do not satisfy reviewed-registry requirements for material claims.
- Reviewer identity remains a declaration, not authenticated identity; that is Step 8 work.

### 2. Claim-type retrieval freshness

Added a configurable `maxRetrievalAgeDaysByClaimType` policy alongside publication-age windows.

| Claim type | Publication age | Capture/retrieval age |
|---|---:|---:|
| `financial` | 30 days | 7 days |
| `numeric` | 90 days | 14 days |
| `market` | 90 days | 30 days |
| `regulatory` | 365 days | 90 days |
| Other | 180 days | 30 days |

These are configurable starting defaults, not externally validated universal standards. The evaluator now returns the effective freshness policy and status per source, and includes source-specific reasons in the aggregate check.

### 3. Possible copied/shared/derivative reporting signal

- Captured source text is normalized using Unicode NFKC and case-folding.
- The evaluator constructs configurable word shingles (default: five words).
- It flags supporting source pairs when both bodies meet the minimum sample size (default: eight shingles) and the smaller body's shingles have at least 82% overlap with the other body.
- The new `source_derivation_similarity` check is a review signal only. It does not assert plagiarism, copying, authorship, syndication, common ownership or factual falsity.
- Human independence review must cover the complete supporting source-ID set for the relevant claim before corroboration can be accepted. This prevents a reviewer from attesting only to a convenient subset.

### 4. UI changes

Execution cards now expose:
- authority registry state and validity deadline;
- per-source publication/retrieval freshness status and effective retrieval window;
- possible shared/derivative source pairs and their similarity signal;
- existing claim-level provenance and corroboration details.

### 5. Adversarial regression coverage

Added tests for:
- stale retrieval windows differing by claim type;
- unversioned registry maps remaining review-required;
- wildcard host rejection and missing explicit registry confirmation;
- expired and tampered registry commitments;
- high-overlap source text being flagged;
- incomplete reviewer source coverage not closing similarity/corroboration review;
- packet-bound human adjudication of a flagged pair;
- short documents below the minimum shingle sample not triggering similarity warnings.

## Validation

- `npm test`: **200 passed, 0 failed, 0 skipped** in the available Linux environment.
- JavaScript syntax checks passed for the changed application, policy, schema and test files.
- Production-mode smoke test passed.
- `/api/health` returned `ok: true`, `commissioningConfigured: false` and `paymentNetworks: []`.
- `/`, `/app.js` and `/styles.css` returned HTTP 200.
- No new npm runtime dependencies were added.
- No wallet, signer, provider commissioning, or payment code was enabled.

## Outstanding work in Step 7

1. Curate and independently review the actual publisher domains WorkRelay will support. No default universal trust registry is bundled.
2. Validate the proposed freshness defaults against the intended research categories and source-update cycles; operators may override them per deployment.
3. Extend adversarial evaluation to syndicated wire copy, press-release republication, shared ownership, paraphrased derivatives and conflicting datasets.
4. Coordinate authenticated reviewer submission, durable review records and registry persistence with Step 8 rather than adding ad hoc local production state.
5. Define source-snapshot retention, access and deletion controls with Step 8 storage design.

## Platform qualification

The 199-test final run in this environment is Linux. The operator confirmed the prior Step 7 increment passed natively on Windows, but this increment changes source/tests and requires a fresh `npm test` on the operator's Windows machine before it is adopted as the next baseline.
