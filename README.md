# WorkRelay

**An evidence-backed research procurement workflow.** A buyer describes one research decision. WorkRelay splits it into work packages, compares provider quotes, passes accepted upstream results to dependent packages with a fresh quote and a separate approval, and shows claim-by-claim evidence that a human reviewer can inspect before accepting anything.

**Live demo:** _add the deployed URL here_

> The demo is a **simulation**. No wallet, account, provider or real money is involved. Every simulated item carries the label `SIMULATED — no provider, wallet, or funds involved`.

## Try it in two minutes

1. Open the app and choose **Build project plan** on the sample research brief.
2. **Compare quotes** and inspect the terms, budget cap and provider ranking.
3. **Run simulated project**, then open the **Evidence packet** and **Structural evaluation** panels. Each check shows what it verified and what it does *not* prove. One source is deliberately bad, so a check fails visibly and accepting that package needs a documented override.
4. Accept an upstream deliverable (the deliberately bad source means you will be asked to record an override reason). The dependent package is built from the exact accepted content and needs its own fresh quote and approval.
5. Run the four branches: success, revision request, refund before submission, and unresolved dispute. Reset and replay at any time.
6. Download the project report (`.md`).

## What is real and what is simulated

| Mode | What it does | Status |
|---|---|---|
| **Simulation** (default) | Sample providers, illustrative prices, simulated deliverables, simulated credits. | Complete |
| **Live discovery and quotes** | Reads public Agent Market listings and requests *unpaid* quotes. A quote is not an approval, commission or payment. | Read-only |
| **Payment** | Commissioning and paying real providers. | **Disabled.** See [limitations](#known-limitations). |

## How the evidence checks work

- Provider output is treated as **untrusted input**; its content hash is preserved.
- Deliverables carry a structured evidence packet: claims, sources (with retrieval time and content hash), claim–source links and stated limitations.
- Checks are deterministic and typed (schema and hash integrity, safe source capture, excerpt match, freshness, independent-source counts, reproducible arithmetic, unsupported or contradicted claims). Results are `complete`, `incomplete`, `needs human review` or `check failed`.
- There is **no truth score**. A passing check means only that the named check passed. Whether work is accepted is a separate, explicit human decision.
- **Evidence gates acceptance.** A deliverable can be accepted without ceremony only when both the evidence verification and the evidence-quality policy report `complete`. Otherwise acceptance is refused unless the reviewer records a written override (at least 20 characters). The override is bound to the exact packet digest and is shown on the package, in the ledger, in dependent packages' handoff and in the downloaded report.
- **Missing evidence is never a pass.** A source with no captured snapshot, or a verification run with no raw artifact, is reported `incomplete`.

Details: [evidence pipeline](docs/EVIDENCE_PIPELINE.md), [evidence quality policy](docs/EVIDENCE_QUALITY_POLICY.md), [sandbox and handoff](docs/SANDBOX_AND_HANDOFF.md).

## Product boundaries

- Quotes and provider listings are untrusted external input.
- Retrieving a quote is not approval. Approval is not commissioning. Commissioning is not delivery. Delivery is not acceptance. Acceptance is not payment.
- Demo credits are simulated access limits, not money.

## Run locally

Requires Node.js 20 or newer. There are no npm runtime dependencies.

```bash
npm test
npm start          # http://localhost:4173  (set PORT to change)
```

Optional read-only command-line tools (none of them spend money):

```bash
npm run discover -- research
npm run plan -- 10 "Research the Kenyan fintech market, identify five competitors and produce a market-entry report"
npm run quote -- 10 "Research the Kenyan fintech market, identify five competitors and produce a market-entry report"
```

## Deploy

Run the simulation as a **single Node.js process** behind HTTPS with a persistent private volume and a strong `DEMO_CREDIT_IP_SECRET`. Do not configure a wallet adapter. See [deployment](docs/DEPLOYMENT.md) and [`.env.example`](.env.example).

## Known limitations

- **Live payment is intentionally off.** The app's payment allowlist covers EVM networks, while the current Agent Market hiring guide documents a NEAR-mainnet transfer profile; the two are not reconciled. The historical payment recipient is unverified, and dispatch needs an atomic duplicate-call guard before any live spending. See [payment safety](docs/X402_PAYMENT_AUTHORIZATION.md).
- **No on-chain settlement is included in this submission.** A NEAR escrow contract was explored but is not part of this repository.
- **Source capture is not wired into the app yet.** `captureSource` (HTTPS only, public addresses only, connection pinned to the validated address, redirect, size and time limits) is tested but no route calls it, and the demo packet is a fixed fixture. The evidence layer is not yet the live workflow.
- **Evidence checks are structural, not factual.** They show traceability and completeness; they do not establish that a claim is true.
- **Reviewer identity is declared, not authenticated**, and review state is not yet persisted per account.
- **Single instance only.** Sessions and credits use local JSON files and must not be shared across replicas.
- **Demo-credit limits are abuse friction**, not strong identity or rate limiting.
- **Live marketplace discovery** depends on the marketplace host being reachable from the server.

## Project guides

- [Deployment](docs/DEPLOYMENT.md) · [Demo credits](docs/DEMO_CREDITS.md)
- [Quote and procurement](docs/QUOTE_AND_PROCUREMENT.md) · [Execution orchestration](docs/EXECUTION_ORCHESTRATION.md)
- [Schema contracts](docs/SCHEMA_CONTRACTS.md) · [Evidence pipeline](docs/EVIDENCE_PIPELINE.md) · [Evidence quality policy](docs/EVIDENCE_QUALITY_POLICY.md) · [Freshness calibration](docs/EVIDENCE_FRESHNESS_CALIBRATION.md)
- [Sandbox and handoff](docs/SANDBOX_AND_HANDOFF.md) · [Payment safety](docs/X402_PAYMENT_AUTHORIZATION.md)

## License

[MIT](LICENSE). The package keeps `"private": true` only to prevent an accidental `npm publish`.

## Status

Hackathon MVP. It is not a custody service, a payment processor or a guarantee of provider performance.
