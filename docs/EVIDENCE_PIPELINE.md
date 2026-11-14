# Evidence pipeline

The Step 3 implementation lives in `src/evidence/evidence-pipeline.js`. It keeps provider artifacts untrusted and produces a versioned `workrelay.evidence-manifest.v1` record through the Step 2 canonicalization and SHA-256 commitment layer.

`captureSource()` is the source-fetching boundary. It allows HTTPS only, rejects credentials and fragments, resolves and rejects loopback, private, link-local and unspecified addresses, limits redirects, revalidates every redirect, bounds response bytes, and records content type, status, retrieval time, publisher hostname, excerpt and content hash. The caller must still treat captured content as untrusted. The implementation does not execute scripts or follow instructions embedded in source or provider content.

`verifyEvidencePacket()` performs narrow deterministic checks for schema completeness, raw-artifact hash integrity, safe URL/capture metadata, excerpt matching, freshness when a window is supplied, claim coverage, duplicate and independent-source signals, unsupported claims, contradictions and supplied arithmetic. Results are typed (`complete`, `incomplete`, `needs_human_review`, or `check_failed`); they are not a truth score. A missing source snapshot is not proof that the source was safely captured.

## Step 7 — evidence-quality policy layer

The Step 7 implementation lives in `src/evidence/evidence-quality.js`. It is an additional policy layer over the immutable Step 2/3 evidence manifest; it does not silently upgrade the meaning of `workrelay.evidence-manifest.v1`. It adds: exact-host publisher authority classification constrained by registered subject scope and permitted claim types, claim-type freshness windows, source-snapshot verification, claim/source referential integrity, claim-level supporting/contradicting relationships, publisher-group corroboration candidates, and packet-bound human review attestations. The implementation and defaults are described in `docs/EVIDENCE_QUALITY_POLICY.md`.

Important boundaries:

- Authority tiers come only from an explicitly supplied, reviewed exact-host registry. WorkRelay does not infer authority from a domain name, page design, search ranking or provider assertion. No universal trusted-source registry is bundled.
- Freshness is evaluated against a supplied evaluation time and policy. Missing publication dates on material claims require human review; stale records are incomplete; implausibly future timestamps fail closed.
- Two domains or two content hashes are only corroboration candidates. Distinct domains do not prove independent reporting. An accepted human review must attest independence for the exact supporting source IDs and publisher groups before the corroboration check can be considered complete.
- Every material claim needs an explicit supporting source relationship. Dangling references and unsupported relationship types fail closed. Contradictory links require human adjudication.
- `recordEvidenceReview()` creates a canonical, SHA-256-committed `workrelay.evidence-review.v2` record bound to the exact evidence packet digest. In addition to claim and independence findings, v2 requires explicit in-scope/out-of-scope assessments for every material claim/source pair. The publisher authority registry is `workrelay.publisher-authority-registry.v2`; each exact-host entry carries subject scope and a permitted claim-type allowlist. The records are human declarations, not cryptographic signatures or identity proofs. Durable storage and authenticated reviewer accounts belong to the later operational-hardening phase. v1 review and registry records do not satisfy the v2 contracts and must be re-reviewed/re-issued; legacy exact-host maps remain unversioned and review-required.
- The demo evidence fixture intentionally remains bad: it uses an unavailable source and an unsupported claim. The new quality panel should show those defects rather than manufacture a clean score.

Neither verifier establishes factual truth, source authenticity, legal authority, actual publisher independence, authorship or provider quality. A human reviewer remains responsible for interpreting the source material, context, conflicts and limitations.
