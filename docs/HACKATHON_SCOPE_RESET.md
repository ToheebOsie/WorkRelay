# Hackathon scope reset — accepted implementation path

**Decision:** Freeze the current evidence-quality implementation at Increment 5 and prioritize the separate NEAR testnet escrow proof. Do not continue adding publisher-governance increments for the hackathon unless a judge requirement or a reproducible demo defect makes one necessary.

## Product position

WorkRelay is an **evidence-backed research procurement workflow for one narrow decision**: a source-backed market-entry or partner-selection brief for a small fintech/Web3 team. This buyer/use-case is a hypothesis, not validated demand.

The product's main differentiator is the buyer-visible evidence workflow: material claims, supporting and contradicting sources, dates, calculations, uncertainty, source provenance, accepted upstream artifacts and exact downstream handoff inputs. NEAR escrow is a separate settlement proof, not the differentiator by itself.

## Three user-visible modes

1. **Sandbox** — complete no-wallet mode. No account, real provider, chain call, wallet or real funds. Preserve all existing deterministic scenarios and labels.
2. **NEAR testnet proof** — optional, separately entered, user-signed interaction with the WorkRelay escrow contract and one WorkRelay-controlled test fungible token. Show the exact testnet network, contract, token, account, method, arguments, atomic amount, terms hash and state transition before the wallet opens. Test tokens have no real monetary value.
3. **Live Agent Market discovery** — unpaid discovery, quote inspection and permitted task-status/artifact reads only. This is not escrow funding, provider commissioning or payment.

There is no live paid marketplace/payment mode for this hackathon. Do not add a mainnet funding CTA.

## Freeze and defer

- Accept Step 7 Increment 5 as the current evidence-quality baseline for hackathon purposes. Its registry candidates remain inactive. Do not spend another increment expanding the publisher registry before the contract proof is built.
- Keep current provider discovery and unpaid A2A quote path as a separate capability. Do not change its payment behavior.
- Defer production identity, shared database, production persistence, full publisher governance and production signer/custody hardening. Record their boundaries; do not block the hackathon proof on them.
- Do not implement Agent Market paid x402, mainnet deposits, NEAR Intents, cross-chain routes, arbitrary tokens, multi-provider splits, generalized escrow marketplace or production commissioning.

## Build sequence from the accepted repository

1. Preserve the current repository baseline and 220-test Node suite.
2. Build one narrow Rust NEAR JobEscrow contract and one WorkRelay-controlled NEP-141 test token.
3. Run local NEAR Sandbox integration tests for every role, transition, deadline, callback and accounting invariant.
4. Only after the local contract gate passes, add a separate optional browser testnet adapter where the user wallet signs directly.
5. Deploy the escrow and test token to testnet only; inspect actual on-chain state and transactions.
6. Rehearse one uninterrupted judge demo: sandbox evidence workflow first, then optional testnet proof as a separate clearly labelled segment.

## Claims and boundaries

- A manifest hash proves which bytes were committed, not truth, authorship, source authenticity or data availability.
- A verifier pass means only that named deterministic checks passed.
- A testnet escrow transaction proves only the tested contract interaction. It does not pay an Agent Market provider, prove task delivery, prove factual research, or demonstrate mainnet safety.
- A `near-account` used by the test contract is a NEAR account identifier; it must not be silently conflated with an Agent Market handle.
