# WorkRelay

**An autonomous contractor for the NEAR Agent Economy.** WorkRelay turns a project objective and budget into a plan, finds specialist agents, compares provider quotes, coordinates work packages, evaluates deliverables and records project provenance.

## Current status

WorkRelay is a hackathon MVP with three deliberately distinct capabilities:

- **Simulation:** a no-wallet demo with sample providers, illustrative prices and simulated deliverables. Outputs are not live research or real provider work.
- **Live discovery and quote inspection:** public Agent Market discovery and unpaid A2A quote requests. A quote is not an approval, commission or payment.
- **Paid execution:** **not deployment-ready**. No wallet signer is bundled. The current app-server accepts EVM buyer networks (Base, Polygon and Arbitrum), while the current Agent Market A2A hiring guide documents a NEAR-mainnet delegated-transfer profile. These flows have not been reconciled. The exact historical shared recipient remains unverified, and the dispatch route needs an atomic duplicate-dispatch guard before live spending.

The Checkpoint 16 regression baseline is 161 passing tests. Those tests use mocks and local HTTP fixtures; they do not prove live paid execution. See [payment safety](docs/X402_PAYMENT_AUTHORIZATION.md).

## Requirements and quick start

- Node.js 20 or newer
- No npm runtime dependencies are declared in this build.

```bash
npm test
npm start
```

The server listens on port `4173` by default. Open `http://localhost:4173` for the browser app. Set `PORT` to change the port.

## CLI commands

All commands below are read-only with respect to marketplace spending:

```bash
npm run discover -- research
npm run rank -- "market research competitor analysis"
npm run plan -- 10 "Research the Kenyan fintech market, identify five competitors, analyse their positioning and produce a market-entry report"
npm run quote -- 10 "Research the Kenyan fintech market, identify five competitors, analyse their positioning and produce a market-entry report"
npm run probe -- cited-research-desk "Return the price quote only; do not begin paid work."
```

`plan` creates draft work packages and budget ceilings. A ceiling is not a provider price. `quote` requests unpaid provider quotes and compares them with package and project limits. `probe` inspects one provider's Agent Card and unpaid A2A response. None of these commands signs, commissions or pays a provider.

## Product boundaries

- Provider listings and quotes are untrusted external input.
- Work-package budgets are ceilings; the actual quote must be evaluated separately.
- Quote retrieval does not imply user approval.
- Approval does not imply commissioning.
- Commissioning does not imply delivery.
- Delivery does not imply acceptance.
- Acceptance does not imply payment settlement.
- Upstream artifacts are supplied to dependent packages only after structural evaluation and explicit human acceptance; the downstream request is newly quoted.
- Demo credits are simulated access limits, not money or a wallet balance.

## Deployment

For a hackathon demonstration, deploy **simulation-only** as a single Node.js process with HTTPS, persistent private storage and a strong `DEMO_CREDIT_IP_SECRET`. Do not configure a wallet adapter or live network allowlists. The JSON stores are single-process only; do not run multiple instances, serverless replicas or horizontally scaled workers against them.

See [deployment guide](docs/DEPLOYMENT.md) for environment setup, proxy, storage and verification requirements. Public demo-credit limits are abuse friction, not strong identity or rate limiting.

## Project guides

- [Deployment](docs/DEPLOYMENT.md) — safe single-instance demo deployment and preflight.
- [Demo credits](docs/DEMO_CREDITS.md) — limits, reservation accounting and privacy.
- [Quote and procurement](docs/QUOTE_AND_PROCUREMENT.md) — discovery, provider matching, quote validation and dependency handoff.
- [Execution orchestration](docs/EXECUTION_ORCHESTRATION.md) — commissioning state, task tracking, artifact evaluation and acceptance.
- [x402 payment authorization](docs/X402_PAYMENT_AUTHORIZATION.md) — protocol mismatch, signer boundary and live-spending blockers.

The repository also contains an isolated NEAR Intents Agent API client. It is not connected as a generic x402 signer and is not needed for the simulation-only hackathon deployment.

## License and status

This repository is a private MVP (`package.json` sets `private: true`). Do not treat the demo as a custody service, a production payment processor or a guarantee of provider performance.
