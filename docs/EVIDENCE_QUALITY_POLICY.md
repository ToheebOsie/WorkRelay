# Evidence quality policy — Step 7

## Status and scope

This document describes the first five implementation increments of WorkRelay Step 7. It adds a deterministic evidence-quality policy layer over the committed evidence manifest. It does not replace the existing structural evaluator, source-capture guard or human acceptance state. Evidence quality review and package acceptance remain separate decisions.

Implementation: `src/evidence/evidence-quality.js`
Publisher registry record: `workrelay.publisher-authority-registry.v2`
Human review record: `workrelay.evidence-review.v2`
Policy version: `workrelay.evidence-quality-policy.v3`
Tests: `test/evidence-quality.test.js`
UI display: `public/app.js` execution cards

## 1. Source authority registry

Authority is a policy classification, not a property that can be inferred from a hostname. The preferred input is a human-confirmed, hash-committed `workrelay.publisher-authority-registry.v2` record created with `commitPublisherAuthorityRegistry()`. Each exact-host entry contains a publisher group, authority tier, non-empty human-readable subject scope, explicit `permittedClaimTypes` allowlist, review basis and expiry. The registry record itself contains a version, review timestamp, declared reviewer and review statement. A registry entry is treated as current only before its `validUntil` timestamp. A tampered digest, wildcard host or invalid record fails closed. Legacy exact-host maps can still be parsed for migration, but they are marked unversioned and do not satisfy the reviewed-registry requirement for material claims.

A reviewed registry can be committed as:

```js
commitPublisherAuthorityRegistry({
  registryId: 'workrelay-research-publishers',
  version: 1,
  reviewedAt: '2026-11-01T00:00:00.000Z',
  reviewer: { kind: 'human', id: 'registry-reviewer-1' },
  reviewStatement: 'Exact-host publisher classifications reviewed for this deployment.',
  entries: [
    {
      hostname: 'regulator.example',
      publisherGroup: 'example-regulator',
      authorityTier: 'regulator',
      scope: ['Rules and regulatory notices issued by this regulator'],
      permittedClaimTypes: ['regulatory', 'regulatory_current'],
      basis: 'Reviewed official regulator publisher domain.',
      validUntil: '2027-11-01T00:00:00.000Z'
    },
    {
      hostname: 'statistics.example',
      publisherGroup: 'example-statistics-office',
      authorityTier: 'primary',
      scope: ['Official statistical series and methodology issued by this statistics office'],
      permittedClaimTypes: ['numeric', 'market', 'monthly_series', 'quarterly_series', 'annual_series'],
      basis: 'Reviewed official statistics publisher domain.',
      validUntil: '2027-11-01T00:00:00.000Z'
    }
  ],
  confirmed: true
});
```

Supported tiers are `regulator`, `primary`, `academic`, `secondary` and `unknown`. Registry matching is exact-host only; wildcard and suffix matching are rejected. `permittedClaimTypes` is an enforceable allowlist: a material source mapped to a host that does not permit the claim type produces `check_failed`, even if the host otherwise has a high authority tier. The human-readable `scope` is shown in source assessments and must be assessed by a packet-bound reviewer for every material claim/source pair. A publisher group lets operators assign multiple hosts controlled by the same publisher to one group so subdomains do not masquerade as independent publishers.

Default minimum tiers are:

| Claim type | Minimum tier |
|---|---|
| `financial` | `primary` |
| `numeric` | `primary` |
| `market` | `primary` |
| `regulatory` | `regulator` |
| `regulatory_current` | `regulator` |
| `daily_series`, `monthly_series`, `quarterly_series`, `annual_series` | `primary` |
| Other types | `secondary` |

The publisher claim-type allowlist and minimum authority tier are separate gates: a source must pass both. A regulator tier does not grant permission outside the entry scope, and a permitted claim type does not waive the minimum authority tier. These are configurable starting defaults, not universal epistemic rules. A deployment owner must review, commit, version and renew the registry for the research domains it intends to rely on. A declared reviewer ID is not authenticated identity; authentication belongs to Step 8. Unknown, expired, unversioned or below-policy publishers remain review-required; the evaluator never invents a trusted tier.

### 1.1 Human scope assessment

The registry's human-readable `scope` describes the publisher's remit. The evaluator does not pretend to semantically prove that every page or claim falls within that prose description. Instead, the reviewer must submit a `scopeAssessments` record for every material `claimId` and every source linked to that claim with relationship `supports` or `contradicts`. Each assessment contains `claimId`, `sourceId`, `inScope` and a non-empty rationale. Missing pairs or mismatched extra pairs keep the review pending; any explicit `inScope: false` blocks acceptance with `check_failed`. This is packet-bound human judgment, not automated scope interpretation.

Increment 5 bumps the registry to `workrelay.publisher-authority-registry.v2` and review records to `workrelay.evidence-review.v2`. v1 records do not satisfy the active v2 contracts. Existing v1 registry records must be independently re-reviewed and re-issued as v2 with subject scopes and claim-type allowlists; v1 human reviews must be re-issued with source-by-source scope assessments. Legacy host maps remain unversioned and review-required.

## 2. Freshness

Freshness is evaluated at an explicit `evaluationAt` timestamp (UTC) and uses both publication time and capture time. Defaults:

| Claim type | Maximum publication age |
|---|---:|
| `financial` | 30 days |
| `numeric` | 90 days |
| `market` | 90 days |
| `regulatory` | 365 days |
| Other types | 180 days |

The default maximum capture/retrieval age is also claim-type-specific: `financial` 7 days, `numeric` 14 days, `market` 30 days and `regulatory` 90 days; other claim types use 30 days. Missing publication dates for sources supporting material claims require human review. Publication or retrieval timestamps more than five minutes in the future fail closed. All limits are configurable in the policy object. These values are conservative starting policies for this application, not externally validated industry standards; deployments must calibrate them to the data cadence and research use case.

A freshness pass means only that the dates fit the configured window. It does not prove that the source remains correct or relevant to the claim's context.

### 2.1 Cadence-specific profiles

Increment 4 adds claim types for explicitly declared series cadence:

| Claim type | Maximum publication age | Maximum retrieval age |
|---|---:|---:|
| `daily_series` | 7 days | 2 days |
| `monthly_series` | 60 days | 14 days |
| `quarterly_series` | 150 days | 30 days |
| `annual_series` | 550 days | 90 days |

These are WorkRelay operating tolerances informed by reviewed official-publisher release cadence; they are not official release deadlines or external standards. The claim type is an explicit workflow declaration, not an inferred property of a host. See `docs/EVIDENCE_FRESHNESS_CALIBRATION.md` for the research basis, limitations and operational guidance.

### 2.2 Current-regulatory-status claims

Use claim type `regulatory_current` for a material claim whose meaning depends on whether a law, rule or instrument is currently in force. For this type, publication age is not used as a proxy for current legal status; the source still needs a publication timestamp and a recent capture (30 days by default). A packet-bound claim finding must declare that the issuing authority's current consolidated version/status and relevant amendments, repeals or superseding instruments were checked. The output includes a separate `regulatory_current_status` check and claim-level assessment. This remains a declared human review, not authenticated legal advice or automatic verification that no later instrument exists. Legacy type `regulatory` retains its prior age window.

## 3. Claim-level provenance

Every material or explicitly required claim must have at least one link with relationship `supports`. Links must resolve to declared claim and source IDs. Recognized relationships are `supports`, `contradicts`, `contextualizes` and `unsupported`. Dangling references, duplicate record IDs and unknown relationship values fail closed. Contradictions require human adjudication. A source being linked to a claim is not the same as supporting it.

The report includes per-claim supporting source IDs, contradicting source IDs, publisher groups, provenance status and corroboration status. These outputs are intended to make the claim-to-source path inspectable.

## 4. Cross-source corroboration and copied/derivative reporting

For material claims, the default policy expects two distinct registered publisher groups and distinct source content hashes as corroboration candidates. The evaluator additionally normalizes captured text, creates five-word shingles and compares supporting source bodies using an overlap coefficient. When both bodies have at least eight shingles and at least 82% of the smaller body's shingles occur in the other body, it flags a `source_derivation_similarity` review item. The threshold, shingle size and minimum sample size are policy-configurable. This is not an automatic independence determination: publishers can repeat the same press release, cite one another or share ownership. The text-overlap heuristic only indicates possible shared or derivative text; it does not establish plagiarism, authorship, copying or common ownership. A possible similarity pair keeps the relevant check in `needs_human_review` until a packet-bound human reviewer considers all supporting source IDs and attests that the sources are independent, with a rationale.

Two subdomains mapped to the same `publisherGroup` count as one publisher group. A human attestation cannot overcome missing or unregistered publisher groups.

### 4.1 Explicit attribution and likely common-origin signals

The evaluator extracts only explicit attribution cues from verified captured source bodies: source/via/courtesy/distribution/republication lines, bylines, and press/news/media-release issuer statements. If two supporting sources from different registered publisher groups carry the same normalized attribution label, the evaluator emits a `source_attribution_reuse` check and a claim-level `possibleCommonOriginPairs` signal. Examples include two articles each naming the same wire service or two publications attributing a release to the same issuer.

This is a conservative text-pattern signal. It is not a general syndication detector and does not prove that the publications share an origin. A human independence rationale must explicitly address attribution/origin/republication before that signal can be cleared. Ordinary mentions of an outlet in article prose are not treated as attribution lines. Unattributed copying, paraphrased derivatives without an explicit marker, shared ownership not represented in the registry and more complex editorial relationships may not be detected.

### 4.2 Conflicting datasets and passages

Contradiction remains explicit claim/source provenance: a source link marked `contradicts` raises `claim_contradictions` and `claim_conflict_adjudication` and produces a claim-level `conflictAssessment`. WorkRelay does not infer that two numbers conflict merely because they differ; the evidence collector or reviewer must declare the relationship and preserve the relevant source links.

A packet-bound `accept` review cannot clear a declared contradiction with a generic statement that the claim is supported. The claim finding rationale must compare at least two dimensions from period/time window, unit/denominator/population, method/definition/calculation and scope/coverage/dataset/inclusion. If this rationale is absent, the human review remains pending. A qualifying review records the adjudication and reviewer digest, but the attestation is not automated proof that the underlying facts are reconciled.

## 5. Human reviewer workflow

`recordEvidenceReview()` accepts an explicit `confirmed: true`, a declared `reviewer` with `kind: 'human'`, an `accept`, `request_revision` or `reject` decision, findings for claims, source-independence assessments and source-by-source scope assessments. It returns a canonical committed `workrelay.evidence-review.v2` record containing:

- `packetDigest` — the exact SHA-256 digest of the evidence manifest being reviewed;
- reviewer identity declaration and review timestamp;
- decision and explicit attestation statement;
- per-claim outcome (`supported`, `contradicted`, `insufficient` or `mixed`) and rationale;
- per-claim source IDs and an independence declaration with rationale;
- a scope declaration for every material supporting/contradicting `claimId`/`sourceId` pair, including an `inScope` boolean and rationale.

The evaluator rejects a review if its record digest is tampered with or if its packet digest does not match the manifest being evaluated. An accepted decision is only considered complete when every material claim has a `supported` finding, an independence assessment covering the complete set of supporting source IDs for that claim, and an in-scope assessment for every supporting or contradicting material claim/source pair. Any source declared out of scope blocks acceptance. This prevents a reviewer from attesting to a convenient subset while leaving an additional source, including a flagged similarity pair, unreviewed.

The reviewer identity is a declared identity only. The current application does not yet provide durable reviewer-account authentication, signatures or a persistent evidence-review store. The anonymous/revocable application capability is not an enterprise identity system. Those controls are part of Step 8 operational hardening. Do not treat the review digest as proof of who made the declaration.

## 6. Status semantics

- `complete`: configured deterministic checks passed and any required human review is present and accepted.
- `needs_human_review`: a required human judgment, unregistered publisher classification, missing publication date or independence assessment remains outstanding.
- `incomplete`: required coverage is missing, a source is stale or a reviewer requested revision/rejected the packet.
- `check_failed`: invalid manifest/relationships, unsafe or mismatched capture, hash mismatch, invalid timestamp or packet/review commitment mismatch.

`publisher_scope_review` is exposed as a separate check: missing or extra scope assessments require review, and an explicitly out-of-scope pair fails. `source_authority_policy` separately enforces the registry claim-type allowlist and minimum authority tier.

The output deliberately has no numeric trust score. Automated checks and human declarations remain visible as different evidence types.

## 7. Current limitations and next increments

The first five Step 7 increments provide the policy engine, scope-limited v2 publisher-registry commitment, research-backed but inactive Nigeria fintech publisher candidates, cadence-specific freshness windows, current-regulatory-status attestation, captured-text similarity signals, explicit attribution/common-origin signals, conflict-adjudication requirements, packet-bound v2 human review constructor with source-by-source scope assessments, claim-level assessments, demo execution-card display and adversarial regression tests. They do not yet provide:

1. a deployment-owner-reviewed, production-maintained authority registry; the Nigeria fintech candidate pack is inactive until each exact host, human-readable scope and permitted claim-type allowlist is reviewed and promoted;
2. persistent storage and authenticated reviewer accounts;
3. an HTTP review-submission API and full reviewer UI;
4. source snapshot archival/retention controls;
5. a broader cross-domain ownership graph and semantic detection of unattributed paraphrased derivatives; the current explicit-attribution, affiliation notes and text-overlap detectors are bounded signals;
6. independent factual adjudication or automated truth verification.

Authenticated reviewer accounts and durable registry/review persistence require Step 8 identity and persistence design; do not add ad hoc in-memory review state to the production path. Until the registry and authenticated review path are deployed, material claims with missing policy evidence must remain review-required.
