# Sponsored demo credits

WorkRelay includes a shared **$1,000 USD-equivalent simulated credit pool** so visitors and hackathon reviewers can try the product without creating an account, connecting a wallet or paying a provider.

## Default limits

- Global simulated pool: **$1,000**.
- Per-IP lifetime allowance: **$10**.
- Per-project budget: **$5**.
- A requested project budget is reserved when a demo plan is created.
- After quote comparison, simulated recommended spend is counted and unused reservation is released.
- Unused reservations expire after six hours.

Configure these limits with `DEMO_CREDIT_POOL_USD`, `DEMO_CREDIT_PER_IP_USD` and `DEMO_CREDIT_PER_PROJECT_USD`. Amounts are stored as integer cents.

## What credits mean

Credits are simulated access limits, not money, USDC, tokens, a wallet balance or a claim against WorkRelay. They cannot be withdrawn, transferred, redeemed or used to send an x402 payment. Demo mode uses local fixture providers and illustrative prices. It does not query the marketplace, hire a provider, sign a wallet transaction or move funds.

Live Agent Market mode is separate. It performs public discovery and unpaid quote requests only; demo credits never authorize live commissioning or payments.

## Identity and privacy

No signup is required. The demo-credit ledger computes an HMAC-SHA256 hash of the visitor's IP address and stores that hash rather than the raw IP. Set `DEMO_CREDIT_IP_SECRET` to a random secret of at least 16 characters; production startup refuses to run without it. Use at least 32 random characters for a public deployment, and preserve the value across restarts so visitor allowances remain stable.

The demo-credit cap is IP-scoped. Browser project ownership is a separate anonymous capability-cookie mechanism; it is not a registered account and has no MFA, account recovery or cross-device recovery.

By default, `X-Forwarded-For` is ignored. Set `TRUST_PROXY=true` only behind a trusted reverse proxy that overwrites forwarded headers. Do not enable it for direct public connections.

IP caps are abuse friction, not strong identity. VPNs and network changes can alter the allowance; people sharing a public IP share the same cap. Add hosting-level rate limiting and abuse monitoring before a broad public launch.

## Persistence and deployment

The default credit ledger is `data/demo-credit-ledger.json`, excluded from version control. It persists across restarts but is single-process only. Do not run multiple app instances against it. Use a persistent private disk, restrict filesystem access and back up the data. Horizontal scaling or serverless deployment requires a transactional shared store and atomic shared accounting first.

## API

- `GET /api/demo-balance` — returns the global pool and visitor allowance.
- `POST /api/plan` with `mode: "demo"` — reserves the requested budget against both caps.
- `POST /api/quote` — settles simulated recommendation spend and releases unused reservation.
