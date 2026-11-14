# Step 7 implementation report — increment 3

**Date:** 2026-11-14
**Status:** Increment 3 implemented; Step 7 remains in progress.

## Scope delivered

This increment expands adversarial evidence review while preserving the existing evidence-manifest v1 and evidence-review v1 contracts. No live provider, wallet, signer, or payment path was changed.

### 1. Explicit attribution and likely common-origin signals

- Added deterministic extraction of explicit source/via/courtesy/distribution/republication lines, bylines, and press/news/media-release issuer statements from captured source bodies that already passed snapshot hash checks.
- Matching normalized attribution labels across supporting sources in different registered publisher groups produce `source_attribution_reuse` and claim-level `possibleCommonOriginPairs` review signals.
- A human independence rationale must explicitly address attribution/origin/syndication/republication before this check can be cleared.
- Ordinary text mentions of a wire service are not treated as attribution lines.
- The detector is deliberately narrow. It does not prove syndication or origin and does not reliably detect unattributed paraphrasing.

### 2. Explicit claim-conflict adjudication

- Added claim-level `conflictAssessment` and a `claim_conflict_adjudication` check for claims with source links marked `contradicts`.
- A generic accepted finding cannot clear a contradiction. The claim-specific rationale must compare at least two dimensions among period/time window, units/denominator/population, method/definition/calculation, and scope/coverage/dataset/inclusion.
- Successful adjudication records the contradictory source IDs, declared reviewer, review digest and rationale in the claim assessment.
- The evaluator does not automatically infer a conflict from differing numeric values; the evidence collector/reviewer must link the source as contradictory.

### 3. UI visibility

Execution cards now display explicit attribution markers, repeated attribution/origin pairs, and conflict status/adjudication reviewer details alongside the existing source freshness, authority, claim provenance and similarity signals.

### 4. Adversarial regression coverage

Added tests for:
- wire-copy reports with repeated attribution across unrelated publisher groups;
- press-release/news-release republication with different prose;
- ordinary mentions of a wire service not triggering attribution matching;
- same registered ownership group remaining a single corroboration group;
- attribution findings not being cleared by generic independence rationale;
- conflict findings requiring comparison rationale rather than generic acceptance;
- substantive conflict rationale recording an explicit adjudication.

## Validation

- `npm test`: **205 passed, 0 failed, 0 skipped** in the available Linux environment.
- JavaScript syntax checks passed for evidence-quality engine, UI and tests.
- UI regression tests verify the new attribution and conflict signals are rendered.
- Evidence manifest v1 and evidence review v1 contracts remain unchanged.
- Native Windows validation of this increment is still required before adopting it as the next cross-platform baseline.

## Outstanding work in Step 7

1. Curate a deployment-specific exact-host publisher registry using independent source research and documented review basis; no universal trust registry is bundled.
2. Calibrate freshness windows against actual source cadence and research task classes.
3. Extend detection for unattributed paraphrase, broader shared-ownership evidence and source-specific methodology conflicts; current pattern and text-overlap detectors are heuristics.
4. Coordinate authenticated reviewer submission and durable review/registry storage with Step 8.
5. Define source snapshot retention, access and deletion controls with Step 8 storage design.

## Safety boundary

The new signals expose review needs. They do not assert factual truth, plagiarism, common ownership, legal authority or actual source independence. Reviewer IDs remain declared identities rather than authenticated accounts. Paid execution remains disabled.
