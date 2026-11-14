# WorkRelay

**An evidence-backed research procurement workflow.** A buyer describes a research decision. WorkRelay splits it into work packages, compares provider quotes, passes accepted upstream results to dependent packages with a fresh quote and separate approval, and presents evidence for human review before acceptance.

> The default demo uses sample providers, illustrative prices and simulated deliverables. It does not hire agents, connect a wallet or move real funds. Live discovery, when configured, reads public listings and requests unpaid quotes only.

Live demo: https://workrelay-production.up.railway.app/

## Try it in two minutes

1. Open the app and choose **Build project plan** on the sample research brief.

1. Choose **Compare quotes** to inspect terms, budget limits and provider rankings.

1. Choose **Run simulated project**, then expand the **Evidence packet** and **Evidence quality** details. Each check explains what it verifies and what it does *not* prove. A deliberately weak source makes the limits visible; accepting that package requires a written override.

1. Review and accept an upstream deliverable. A dependent package uses the accepted content and requires its own fresh quote and separate approval.

1. Try the success, revision, refund-before-submission and unresolved-dispute branches. Reset clears execution state; it does not restore simulated credits already spent on quote comparison.

1. Download the project report (`.md`).

## What is real and what is simulated

| Mode | What it does | Status |
| --- | --- | --- |
| **Simulation** (default) | Sample providers, illustrative prices, simulated deliverables and demo credits. | Available |
| **Live discovery and quotes** | Reads public Agent Market listings and requests unpaid quotes. A quote is not an approval, commission or payment. | Unpaid requests only |
| **Real payment** | Commissioning and paying providers. | **Disabled** |

## How evidence is used

- Provider output is treated as **untrusted input**; its content hash is preserved.

- Evidence packets organize claims, sources, claim–source links and stated limitations.

- Checks are deterministic and structural. They can report completeness, traceability or policy issues, but they do **not** establish that a claim is true.

- Evidence is a separate gate for acceptance. Where the gate is incomplete, acceptance requires a written override tied to the reviewed packet.

- Missing evidence is not a pass. Human review remains a separate decision and does not itself verify the reviewer’s identity or provide legal advice.

Technical details: [evidence pipeline](docs/EVIDENCE_PIPELINE.md), [evidence quality policy](docs/EVIDENCE_QUALITY_POLICY.md), and [sandbox and handoff](docs/SANDBOX_AND_HANDOFF.md).

## Product boundaries

- Provider listings and quotes are untrusted external input.

- A quote is not approval. Approval is not commissioning. Commissioning is not delivery. Delivery is not acceptance. Acceptance is not payment.

- Demo credits are simulated access limits, not money.

## Run locally

Requires Node.js 20 or newer. There are no npm runtime dependencies.

```bash
npm test
npm start          # http://localhost:4173  (set PORT to change)
```

Optional read-only command-line tools:

```bash
npm run discover -- research
npm run plan -- 10 "Research the Kenyan fintech market, identify five competitors and produce a market-entry report"
npm run quote -- 10 "Research the Kenyan fintech market, identify five competitors and produce a market-entry report"
```

## Self-hosting

The current deployment model supports a **single application process** with private persistent storage. Multi-instance hosting requires a shared transactional store. Follow the [deployment guide](docs/DEPLOYMENT.md) for operator setup and safeguards. Real payments remain disabled; do not enable a payment integration for this version.

## Current limitations

- **Real payments are disabled.** WorkRelay does not commission or pay a provider.

- **Evidence checks are not fact verification.** Review results are policy and traceability signals, not a guarantee of accuracy.

- **Human review does not authenticate the reviewer.** Treat a review as a recorded decision, not proof of identity.

- **Live discovery requires access to the marketplace host** from the server; otherwise, use the default simulation.

## Project guides

- [Deployment](docs/DEPLOYMENT.md) · [Demo credits](docs/DEMO_CREDITS.md)

- [Quote and procurement](docs/QUOTE_AND_PROCUREMENT.md) · [Execution orchestration](docs/EXECUTION_ORCHESTRATION.md)

- [Schema contracts](docs/SCHEMA_CONTRACTS.md) · [Evidence pipeline](docs/EVIDENCE_PIPELINE.md) · [Evidence quality policy](docs/EVIDENCE_QUALITY_POLICY.md) · [Freshness calibration](docs/EVIDENCE_FRESHNESS_CALIBRATION.md)

- [Sandbox and handoff](docs/SANDBOX_AND_HANDOFF.md) · [Payment safety](docs/X402_PAYMENT_AUTHORIZATION.md)

## License

[MIT](LICENSE).

## Status

Simulation-first product prototype. WorkRelay is not a custody service or payment processor, and it does not guarantee provider performance.
