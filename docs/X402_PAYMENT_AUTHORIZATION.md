# x402 payment authorization and safety status

## Deployment decision

**Paid Agent Market A2A execution is disabled for deployment.** No wallet, private key, seed phrase, signer or wallet adapter is bundled. The optional adapter hook is not an audited signer, and the current payment profile mismatch and dispatch race are hard blockers. Keep these settings empty:

```dotenv
X402_ALLOWED_NETWORKS=
X402_ALLOWED_ASSETS_JSON={}
X402_WALLET_ADAPTER_MODULE=
```

Do not install an adapter, enable spending or remove recipient quarantine until the blockers in this document are resolved.

## Two distinct NEAR payment profiles

Do not conflate these public integration descriptions:

### Agent Market A2A+x402 hiring profile

The current Agent Market A2A hiring guide documents a marketplace-specific profile:

- the buyer sends an unpaid A2A `SendMessage` request;
- the marketplace returns an HTTP 402 payment challenge with a `near:mainnet` requirement and a NEAR USDC asset identifier;
- the buyer signs a NEAR delegated `ft_transfer`, where the token contract is the delegate receiver and `payTo` is the transfer recipient;
- the signed delegate action is serialized into the `X-PAYMENT` header;
- the buyer repeats the same A2A request and polls `GetTask` while the task is working;
- the marketplace says it holds the payment and settles on successful delivery; failed/rejected/cancelled jobs are not charged.

The Agent Market worker-flow documentation says the caller pays the marketplace treasury, not the individual agent, and that the marketplace distributes the agent owner's share after delivery.

### General NEAR Agentic Payments / 1Click profile

NEAR's general Agentic Payments material describes x402 buyer payments on Base, Polygon or Arbitrum and a 1Click/NEAR Intents route that uses a deposit address to route funds to the seller's configured destination. This is a distinct integration description. It does not, by itself, prove that the Agent Market A2A endpoint currently uses this same buyer-payment profile.

### WorkRelay implementation mismatch

`src/app-server.js` currently accepts only:

- `eip155:8453` — Base;
- `eip155:137` — Polygon;
- `eip155:42161` — Arbitrum.

It rejects `near:mainnet`. Therefore the current app-server configuration is not compatible with the payment network shown in the current Agent Market A2A hiring guide. Do not infer compatibility merely because both integrations mention x402, USDC or NEAR. Obtain marketplace confirmation of the exact current A2A payment profile, capture an unpaid 402 response, and implement the specific required signing payload before enabling paid execution.

## Shared recipient finding

The marketplace worker-flow document gives a plausible explanation for multiple agent handles returning a common marketplace treasury recipient. Reuse alone is not evidence of fraud and does not prove that the agents share an owner.

However, the official public documents inspected for Checkpoint 17 do not map the historical WorkRelay address `ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc` to the official treasury. The archive also does not contain the raw multi-provider 402 captures or independent on-chain confirmation needed to verify that mapping.

**Keep the exact address quarantined.** Obtain an explicit mapping from Agent Market or independently verifiable chain/settlement evidence before treating it as an approved recipient. The source audit also found that the recipient-review evaluator is not wired into the app and that duplicate detection alone does not quarantine every unique, unverified recipient.

## x402 v2 challenge requirements

The x402 v2 specification requires a `resource` object containing a URL, alongside the `accepts` payment requirements. WorkRelay's authorization wrapper requires the resource URL, the exact accepted requirement, a configured network/asset, valid amount and timeout, a fresh quote, provider-host binding and the exact original A2A request.

The public Agent Market A2A guide's abbreviated 402 example does not show `resource`. That may be an abbreviated example; Checkpoint 17 did not make a paid request and did not establish that a fresh live 402 response omits the field. Capture an exact unpaid response, including relevant headers and raw body, and validate it against the x402 v2 schema before proceeding.

## Optional adapter boundary

`X402_WALLET_ADAPTER_MODULE` can load a local file or installed package that exports `createSigner({ config })` and returns `createPaymentHeader(input)`. Remote module URLs are rejected. The WorkRelay wrapper binds the adapter call to the proposal approval, execution/package IDs, stable idempotency key, provider endpoint, original A2A request, x402 challenge/resource, selected requirement, network, asset, recipient, amount, timeout, quote freshness and spend cap.

The adapter is trusted deployment code. The wrapper checks echoed fingerprints, but echoed hashes are not cryptographic proof that the adapter produced a valid signature for the intended payment. Any future adapter must receive separate security review covering custody, key isolation, payer identity, chain/RPC, token contract and decimals, balance/allowance, amount and timeout limits, nonce/replay protection, idempotency, logs, exception handling, rotation and recovery. Secrets must never enter the browser, repository, logs or ordinary plaintext configuration.

The separate NEAR Intents Agent API client in `src/near-intents/agent-api-client.js` is not a generic x402 signer and is not wired as one.

## Dispatch and ambiguity blockers

The Checkpoint 17 audit found that the app-server does not atomically claim an execution before dispatch. Two concurrent HTTP requests can read the same not-started state and race into the commissioner. Atomic JSON file replacement does not make the full read/check/dispatch operation atomic. A durable atomic claim and a simultaneous-request regression test are required before paid dispatch.

Failure handling distinguishes a definitive rejection before the paid POST begins from an ambiguous outcome after it begins. An ambiguous outcome must not be retried automatically. The current reconciliation endpoint records an owner attestation and labels it `owner_attestation_not_independently_verified`; it does not fetch or validate the evidence URL's contents. That attestation is not proof of payment failure, task status or settlement.

## Official references

- Agent Market A2A hiring: https://docs.market.near.ai/a2a/hire-agent-using-x402
- Agent Market worker/payment flow: https://market.near.ai/skill/flows/a2a-x402.md
- NEAR Agentic Payments overview: https://www.near.org/agentic-payments
- x402 v2 specification: https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md

Re-check the current official documentation and save a fresh **unpaid** 402 fixture before implementing or enabling any paid adapter. Tests with mocked providers or mock signers do not prove real signing, commissioning, delivery or settlement.
