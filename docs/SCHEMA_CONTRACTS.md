# Versioned schema contracts

WorkRelay's Step 2 commitment layer is implemented in `src/contracts/schema.js`. It defines strict versioned records for the job agreement and the records that will later cross the workflow and escrow boundaries:

- `workrelay.jobspec.v1` — buyer, exact brief, scope, exclusions, geography, time window, provider identity, packages, quote terms, acceptance, dispute and privacy terms.
- `workrelay.acceptance-criteria.v1` — typed acceptance criteria and requiredness.
- `workrelay.evidence-manifest.v1` — claims, source records, claim/source relationships, method, limitations, reviews and raw-artifact hash.
- `workrelay.evidence-review.v2` — a human-declared review decision bound to one exact evidence-manifest digest, with claim findings, source-independence assessments and an explicit scope assessment for every material claim/source pair. Its digest commits the declaration; it does not authenticate reviewer identity.
- `workrelay.publisher-authority-registry.v2` — a human-confirmed exact-host registry whose entries bind publisher group and authority tier to a human-readable subject scope, an allowlist of permitted claim types, a review basis and an expiry. The registry digest commits the declaration; it does not prove source truth or authenticate reviewer identity.
- `workrelay.provider-quote.v1` — provider identity, exact quote request fingerprint, returned quote and terms.
- `workrelay.settlement-terms.v1` — buyer/provider identities, allowlisted asset, atomic amount, deadlines, revision allowance, verifier and dispute policy.
- `workrelay.event-record.v1` — append-only provenance event identity, actor, timestamp and payload.

Validation is strict. Required fields are explicit, unknown fields are rejected, identifiers are typed, atomic amounts are non-negative decimal strings, timestamps must be UTC ISO timestamps, hashes must be lowercase SHA-256 hex digests, and numbers must be finite safe values where integer semantics are required. Provider identity has a `kind` and `id` so an Agent Market handle cannot be silently confused with a NEAR account ID.

Canonical JSON applies NFC Unicode normalization to strings and object keys, sorts object keys lexicographically, preserves array order, converts negative zero to zero, rejects non-finite numbers and `undefined`, and rejects object keys that collide after normalization. `sha256Canonical(value)` hashes those exact UTF-8 canonical bytes. `commitRecord(value, validator)` validates and returns the normalized record, canonical bytes, schema version and digest together.

The digest is a commitment to the canonical bytes and terms supplied. It does not prove that research claims are true, that a source is authentic, that a provider identity is genuine, or that an off-chain artifact remains available. Full briefs, reports, source contents and personal data remain off-chain; later contract integration should commit only the appropriate digest and state.
