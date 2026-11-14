# Deployment guide

## Supported deployment shape

The current build is suitable only for a **single Node.js process** with persistent local storage. It is not ready for horizontal scaling, serverless deployment or multiple workers sharing the JSON files.

Requirements:

- Node.js 20 or newer.
- One application instance.
- A writable, persistent private data directory.
- HTTPS in front of the app for public deployment.
- A strong, stable `DEMO_CREDIT_IP_SECRET`.
- A reverse proxy that strips client-supplied forwarding headers before setting its own, if proxy trust is enabled.

There is no Dockerfile, Compose file, database migration or multi-instance deployment configuration in this archive.

## Configure the environment

Start from `.env.example` and set deployment variables in the hosting platform's secret/environment manager. Do not commit a real `.env` file.

Required for production mode:

```text
NODE_ENV=production
DEMO_CREDIT_IP_SECRET=<random secret of at least 32 characters>
PORT=4173
TRUST_PROXY=false
```

The application currently checks that `DEMO_CREDIT_IP_SECRET` is present in production; using a random value of at least 32 characters is the deployment policy recommended here. Keep it stable across restarts or demo-credit IP identities will change.

`TRUST_PROXY` should remain `false` unless the app is reachable only through a trusted reverse proxy that overwrites `X-Forwarded-For` and `X-Forwarded-Proto`. Do not trust forwarding headers from direct clients. The proxy must terminate TLS and forward the original HTTPS scheme so production cookies can use the `Secure` attribute.

Keep all live payment settings disabled:

```text
X402_ALLOWED_NETWORKS=
X402_ALLOWED_ASSETS_JSON={}
X402_WALLET_ADAPTER_MODULE=
```

Do not install or configure a wallet adapter for this release. The current Agent Market A2A payment profile and the app-server's configured network profile have not been reconciled; there are also recipient-verification and duplicate-dispatch blockers. See [x402 payment authorization](X402_PAYMENT_AUTHORIZATION.md).

## Persistent storage

By default, WorkRelay writes runtime state beneath `./data/`, including:

- project sessions (`SESSION_STORE_PATH`);
- anonymous browser principals (`PRINCIPAL_STORE_PATH`);
- execution records (managed by the execution-record store); and
- sponsored demo-credit accounting (`DEMO_CREDIT_LEDGER_PATH`).

Mount a persistent private volume at the application data location. Back it up. Do not expose the directory through the web server, static file hosting, artifact CDN or public file bucket. Ensure file permissions restrict access to the application user.

The stores use local JSON files and single-process persistence. Atomic file replacement does not provide cross-process transactions or distributed locking. Running two app instances against the same files can cause lost updates and inconsistent ownership/accounting. For multi-instance operation, replace the stores with a transactional shared database and add concurrency controls before scaling.

## Demo and identity limitations

- Browser identity is an anonymous, revocable capability cookie, not a registered account. It does not provide MFA, identity verification, account recovery or cross-device recovery.
- The demo-credit ledger is scoped by a keyed hash of the visitor IP. Visitors behind the same public IP share an allowance; VPNs or network changes can alter the allowance.
- Default limits are a $1,000 global simulated pool, $10 per IP and $5 per project. These are not real funds.
- Add hosting-level rate limiting, abuse monitoring, request-size limits and operational alerts before exposing a public demo to substantial traffic.

## Pre-deployment checks

Run from the project directory:

```bash
npm test
NODE_ENV=production DEMO_CREDIT_IP_SECRET='<secret supplied by your secret manager>' PORT=4173 npm start
```

From another terminal, verify:

```bash
curl -fsS http://127.0.0.1:4173/api/health
```

Confirm the health response reports `commissioningConfigured: false` and an empty `paymentNetworks` array for the simulation-only deployment. Then open the app through the HTTPS public URL, create a demo project, refresh the browser, and confirm that project resumption works. Restart the process and confirm sessions and demo-credit balances persist.

Do not interpret a successful health check or passing test suite as evidence of live provider commissioning or payment settlement.
