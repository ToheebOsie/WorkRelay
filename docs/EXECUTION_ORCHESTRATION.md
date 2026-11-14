# Execution orchestration and delivery lifecycle

WorkRelay separates procurement, approval, commissioning, task status, artifact evaluation, human acceptance and payment settlement. A state in one area must not be inferred from another.

## Lifecycle

1. **Plan and quote.** Work packages have budget ceilings. Provider quotes are retrieved separately and compared against both package ceilings and remaining project budget.
2. **Approval.** The approval must refer to the exact proposal, provider allocation, quote and payment terms shown to the user. Approval is not a payment or task commission.
3. **Commissioning.** The execution bridge calls a marketplace commissioner only when the required approval and readiness checks pass. A stable idempotency key is included in the commission request.
4. **Task tracking.** Provider task status is read through A2A `GetTask`. A task can be submitted or working after it has been commissioned; WorkRelay must not label it delivered until a result is retrieved.
5. **Artifact receipt.** Retrieved text is stored against the commissioned task with a SHA-256 hash and provenance. Provider output remains untrusted content.
6. **Evaluation.** Each acceptance criterion needs an explicit result and evidence. Failed criteria require further work; a passing structural evaluation is only `passed_pending_human_acceptance`.
7. **Human acceptance.** A separate user action accepts the deliverable. WorkRelay must not accept a provider's marketplace job merely because its own evaluator passed.
8. **Settlement.** Payment state is separately recorded from the task and deliverable state. Settlement requires authoritative transaction or marketplace evidence; a response header or provider statement alone is not sufficient proof.

## Dependency handoff

A dependent package is not ready to quote merely because its prerequisites were dispatched. Each required upstream package must have an artifact whose hash matches the recorded content, a passing structural evaluation and explicit human acceptance. WorkRelay then creates a new downstream brief containing the accepted output, its hash and provenance manifest.

The downstream request is a new request and must receive a fresh unpaid quote. Its proposal and approval bind to that exact brief. If an upstream artifact changes, the downstream request must be rebuilt and requoted. Provider output is untrusted input and cannot change WorkRelay's system policy, budgets, provider selection or payment destination.

## Failure and reconciliation states

- A failure before the paid A2A POST begins can be recorded as a definitive pre-payment rejection.
- Once the paid POST begins, transport failures, HTTP errors without a confirmed task, missing task IDs or interrupted responses are ambiguous and must not be retried automatically.
- An ambiguous request must be reconciled against an official marketplace/provider record before another action is considered.
- The current manual reconciliation route records an owner attestation and explicitly marks it `owner_attestation_not_independently_verified`. WorkRelay does not fetch or validate the evidence content.
- A definitive pre-payment rejection cannot reuse the previous quote and approval; a new quote and approval are required.

## Important current blockers

A source audit found no atomic per-execution dispatch claim around the app-server's load/check/dispatch sequence. Concurrent requests could race even though individual JSON writes use atomic file replacement. Do not enable paid dispatch until this is replaced with a durable atomic claim and a concurrency regression test proves only one commissioner invocation can occur.

The current build uses local JSON persistence and a single-process store. It is not safe for multi-instance concurrent operation. The paid Agent Market A2A protocol profile is also not reconciled with the network profile accepted by the app-server; see [x402 payment authorization](X402_PAYMENT_AUTHORIZATION.md).

## State invariants

- quoted ≠ approved
- approved ≠ commissioned
- commissioned ≠ completed
- completed ≠ accepted
- accepted ≠ paid/settled

## Regression command

```bash
npm test
```

The tests use local fixtures and mocks. They do not prove real marketplace commissioning, task delivery, payment signature validity or settlement.
