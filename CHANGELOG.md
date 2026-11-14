# Changelog

## Checkpoint 15 — 2026-11-14

- Added validation for project dependency DAGs, including topological ordering and cycle/reference checks.
- Added dependency-bound downstream briefs assembled from accepted, evaluated upstream artifacts with SHA-256 integrity checks and provenance manifests.
- Deferred dependent live packages from initial quote requests; added a separate owner-scoped unpaid quote stage for each downstream package.
- Enforced exact A2A request/brief binding, downstream brief-hash integrity, fresh proposal approval and approval-time source revalidation.
- Made pending downstream quote state independent across packages.
- Made demo execution dependency-aware: upstream work must be structurally evaluated and human-accepted before dependent simulated tasks run.
- Added procurement, lifecycle and mocked-HTTP integration tests for successful handoff, stale/tampered inputs, budget accounting and state boundaries.
- Preserved live commissioning/payment blockers and shared-recipient quarantine.


## Checkpoint 16 — 2026-11-14

- Added a strict x402 v2 server-side authorization wrapper bound to the exact approved proposal, quote challenge/resource, selected payment requirement, A2A request, provider endpoint, idempotency key, quote freshness, per-network asset and payment cap.
- Added an optional operator-installed server-side wallet adapter hook; no signer, key, or wallet code is bundled. Remote code URLs are rejected.
- Replaced the implicit NEAR-mainnet live payment default with explicit Base/Polygon/Arbitrum network and per-network token configuration; empty configuration leaves quotes review-only.
- Preserved the NEAR Agent Market A2A `X-PAYMENT` request header and corrected x402 v2 challenge extraction so the top-level version/resource is retained.
- Added owner-scoped, same-origin manual reconciliation with official marketplace URL checks, explicit confirmation and an audit marker that owner evidence is not independently verified.
- Required positive `not_sent` evidence for definitive rejection and blocked reuse of the old quote/approval after any definitive rejection.
- Distinguished definitive pre-payment rejection from ambiguous failures after the paid A2A POST begins; added regression coverage for signer denial, endpoint change and post-write transport failure.
- Closed cross-network asset-list fallback so readiness and commissioning require an explicit per-network token entry.
- Final regression run: 161 passed, 0 failed, 0 skipped.
- Extended the project overview, browser lifecycle interface, documentation and regression suite for safe optional dispatch and recovery.
- No real wallet signer, provider commission, or payment was used during this checkpoint.

## Documentation cleanup — 2026-11-14

- Removed milestone-by-milestone checkpoint reports from the application package; their historical detail is not required to run or operate the current MVP.
- Removed superseded planning and integration-decision notes that duplicated current guides or described older payment assumptions.
- Consolidated current operating guidance into the README and five focused guides: deployment, demo credits, procurement, orchestration and x402 safety.
- Corrected the payment documentation to distinguish the Agent Market A2A NEAR-mainnet profile from NEAR's separate EVM/1Click payment route.
- No application source code, tests, runtime configuration or product features were changed.
