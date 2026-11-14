# Provider discovery, quoting and procurement

## Workflow

1. WorkRelay queries public NEAR Agent Market listings and ranks candidates against each work package.
2. The provider origin is derived from a validated marketplace handle. WorkRelay fetches the Agent Card and uses the JSON-RPC endpoint declared by that card; it does not guess an endpoint or accept arbitrary caller-supplied URLs.
3. The package brief is mapped to the provider's advertised input schema. Unknown required fields cause a safe unsupported-schema result rather than an invented value.
4. WorkRelay sends an unpaid A2A `SendMessage` request. It does not attach `X-PAYMENT` during quote retrieval.
5. It inspects an HTTP 402 payment challenge or an A2A `input-required` response carrying payment metadata.
6. Payment terms are checked for supported scheme, network, asset, amount, recipient, timeout and required x402 v2 challenge binding.
7. The selected amount is checked against both the package ceiling and the remaining project budget. An unused ceiling on another package does not silently authorize overspend.
8. WorkRelay returns a procurement proposal with provider comparisons, quote evidence, budget remainder and a requirement for explicit user approval.

## Provider selection

The current quality score combines:

- marketplace match score: 35%;
- adjusted delivery reliability: 35%;
- identity verification: 10%; and
- capability fit: 20%.

The final selection score weights provider quality at 75% and relative price value at 25%. The score is decision support, not a guarantee of deliverable quality. Small reliability samples are adjusted toward a neutral prior by the matcher.

## Budget semantics

A work-package budget ceiling is a maximum the planner assigns for later quote evaluation; it is not a quote or a commitment. The provider's actual quote is evaluated separately. The procurement proposal must remain within the overall approved project budget as well as each package ceiling.

## Dependency-aware packages

When dependency-aware procurement is enabled, only root packages are quoted first. A dependent package is deferred until each prerequisite has a hash-valid artifact, passing structural evaluation and explicit human acceptance. WorkRelay builds a new brief containing the accepted upstream outputs and provenance, then requests a fresh unpaid quote for that exact request. Changed or tampered inputs require a new quote and approval.

## Fail-closed behaviour

- No quote request sends `X-PAYMENT`, signs a transaction, creates a paid marketplace task or transfers funds.
- Provider handles and Agent Card endpoints are validated; cross-host endpoint changes are rejected.
- Unknown required provider input fields are not guessed.
- Unsupported payment terms and assets outside the configured allowlists are not made eligible.
- A quote above its package ceiling is rejected even if another package has unused budget.
- Provider messages and deliverables are untrusted; they cannot change budget, approvals or recipients.
- Quote retrieval never implies user approval or hiring.

## Recipient review limitation

The procurement code detects a repeated `payTo` value across provider handles and can quarantine affected recommendations. A source audit found that the separate human recipient-review evaluator is not wired into the application and that a unique, unverified recipient is not necessarily quarantined by the duplicate-detection rule. A proposal status is therefore not independent proof of recipient identity or routing safety. Do not enable paid dispatch while the current review gap and exact historical recipient remain unresolved.

The marketplace's published worker flow explains that A2A callers pay a marketplace treasury and that the marketplace distributes the agent owner's share on delivery. That makes a shared treasury plausible, but it does not independently identify the historical WorkRelay address. See [x402 payment authorization](X402_PAYMENT_AUTHORIZATION.md).

## CLI

```bash
npm run discover -- research
npm run rank -- "market research competitor analysis"
npm run plan -- 10 "Research the Kenyan fintech market and produce a market-entry report"
npm run quote -- 10 "Research the Kenyan fintech market and produce a market-entry report"
npm run probe -- cited-research-desk "Return the payment quote only; do not begin paid work."
```

`quote` and `probe` are unpaid. A live quote may still be returned for inspection even when its payment network is not currently allowlisted for paid procurement; such a quote must remain review-only.

## Current protocol compatibility warning

The current Agent Market A2A hiring guide documents a `near:mainnet` payment requirement and a NEAR delegated `ft_transfer` carried in `X-PAYMENT`. The current app-server instead accepts only the EVM buyer networks `eip155:8453`, `eip155:137` and `eip155:42161`. These are not interchangeable profiles. The mismatch must be resolved against a fresh unpaid 402 response and official marketplace confirmation before any paid integration is attempted.
