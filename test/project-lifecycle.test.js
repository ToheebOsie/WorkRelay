import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProcurementProposal } from '../src/procurement/quote-and-procure.js';
import { buildDependencyBoundRequest } from '../src/orchestration/dependency-handoff.js';
import { createHash } from 'node:crypto';
import {
  authorizeProjectExecution,
  dispatchApprovedProject,
  reconcileCommissionOutcome,
  recordPackageDeliverable,
  evaluatePackageDeliverable,
  acceptPackageDeliverable,
  recordPaymentSettlement,
  summarizeExecution
} from '../src/orchestration/project-lifecycle.js';
import { saveExecution, loadExecution } from '../src/storage/json-ledger.js';

const plan = {
  planId: 'wr-lifecycle', budget: { amount: 10, currency: 'USDC' },
  workPackages: [{ id: 'research', title: 'Research', brief: 'Research the target market and provide evidence.', acceptanceCriteria: ['Claims include source URLs', 'Evidence gaps are identified'], budgetCeiling: 8,
    providerCandidates: [{ handle: 'provider-a', name: 'Provider A', score: 90, adjustedSuccessRate: 85, verification: 'identity_verified' }] }]
};
const asset = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const quoteProposal = () => buildProcurementProposal(plan, {
  allowedAssets: [asset], allowedNetworks: ['near:mainnet'],
  quoteRequester: async () => ({ status: 'quote_received', quote: { alternatives: [{ scheme: 'exact', network: 'near:mainnet', asset, amount: '2000000', payTo: 'provider-a-wallet', maxTimeoutSeconds: 600 }] } })
});
const approvalFor = (proposal) => ({ confirmed: true, proposalId: proposal.proposalId, approvedBy: 'demo-user', approvedAt: '2026-11-14T04:00:00.000Z', maxSpend: proposal.budget.recommendedSpend, currency: proposal.budget.currency });

test('requires exact, explicit proposal-scoped approval before creating execution', async () => {
  const proposal = await quoteProposal();
  assert.throws(() => authorizeProjectExecution(proposal, { confirmed: true }), /Approval does not match/);
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  assert.equal(execution.status, 'approved_pending_dispatch');
  assert.equal(execution.packages[0].commissioning.status, 'not_started');
  assert.equal(execution.packages[0].payment.status, 'not_sent');
  assert.equal(execution.budget.committed, 2);
});


test('approved downstream execution preserves the accepted upstream manifest and quote-bound brief', async () => {
  const content = 'Accepted research findings with source evidence: https://example.com/report';
  const contentHash = createHash('sha256').update(content, 'utf8').digest('hex');
  const upstream = {
    packageId: 'research', provider: 'provider-a', taskId: 'task-research',
    delivery: { content, contentHash },
    evaluation: { passed: true, status: 'evaluation_passed' },
    acceptance: { status: 'accepted', acceptedAt: '2026-11-14T04:00:00.000Z' }
  };
  const downstream = { id: 'synthesis', title: 'Synthesis', brief: 'Write conclusions from the research.', acceptanceCriteria: ['Use source-backed findings'], dependsOn: ['research'] };
  const handoff = buildDependencyBoundRequest({ workPackage: downstream, packageRecords: [upstream] });
  const focusedPlan = {
    planId: 'wr-dependent-lifecycle', budget: { amount: 4, currency: 'USDC' },
    workPackages: [{
      id: 'synthesis', title: 'Synthesis', originalBrief: downstream.brief, brief: handoff.brief,
      acceptanceCriteria: downstream.acceptanceCriteria, budgetCeiling: 4, dependsOn: [], dependencyHandoff: handoff,
      providerCandidates: [{ handle: 'provider-c', name: 'Provider C', score: 90, adjustedSuccessRate: 85, verification: 'identity_verified' }]
    }]
  };
  const proposal = await buildProcurementProposal(focusedPlan, {
    allowedAssets: [asset], allowedNetworks: ['near:mainnet'],
    quoteRequester: async ({ workPackage }) => ({
      status: 'quote_received', endpoint: 'https://provider-c.market.near.ai/a2a',
      requestPayload: { params: { message: { parts: [{ kind: 'text', text: workPackage.brief }] } } },
      quote: { alternatives: [{ scheme: 'exact', network: 'near:mainnet', asset, amount: '1000000', payTo: 'provider-c-wallet', maxTimeoutSeconds: 600 }] }
    })
  });
  assert.equal(proposal.status, 'ready_for_user_approval');
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  assert.equal(execution.packages[0].brief, handoff.brief);
  assert.equal(execution.packages[0].dependencyHandoff.quoteStatus, 'quoted_bound');
  assert.equal(execution.packages[0].dependencyHandoff.sourceManifest[0].contentHash, contentHash);
  assert.equal(execution.packages[0].dependencyHandoff.sourceManifest[0].acceptanceStatus, 'accepted');
  assert.equal(execution.packages[0].dependencyHandoff.sourceManifest[0].evaluationPassed, true);
});

test('rejects provider or payment-term changes after approval', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  execution.packages[0].provider = 'attacker-agent';
  let called = false;
  await assert.rejects(() => dispatchApprovedProject(execution, { commissioner: { commission: async () => { called = true; return { status: 'commissioned', taskId: 'bad' }; } } }), /changed after approval/);
  assert.equal(called, false);
});

test('fails closed when no real marketplace commissioner is configured', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  await assert.rejects(() => dispatchApprovedProject(execution), /No marketplace commissioner/);
  assert.equal(execution.packages[0].commissioning.status, 'not_started');
});

test('dispatches only through injected commissioner and keeps payment status separate', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  let call;
  await dispatchApprovedProject(execution, { commissioner: { commission: async (input) => { call = input; return { status: 'commissioned', taskId: 'market-job-123', paymentStatus: 'unknown', paymentMode: 'x402_delivery_escrow' }; } } });
  assert.equal(call.idempotencyKey, 'wr-proc-wr-lifecycle:research:provider-a');
  assert.equal(execution.status, 'work_in_progress');
  assert.equal(execution.packages[0].commissioning.taskId, 'market-job-123');
  assert.equal(execution.packages[0].payment.status, 'unknown');
  assert.equal(execution.packages[0].payment.mode, 'x402_delivery_escrow');
});

test('does not automatically retry a commission with ambiguous outcome', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  await dispatchApprovedProject(execution, { commissioner: { commission: async () => { throw new Error('socket timeout'); } } });
  assert.equal(execution.status, 'dispatch_blocked_reconciliation_required');
  let called = false;
  await dispatchApprovedProject(execution, { commissioner: { commission: async () => { called = true; return { status: 'commissioned', taskId: 'duplicate' }; } } });
  assert.equal(called, false);
  assert.equal(execution.packages[0].commissioning.status, 'outcome_unknown');
});

test('reconciles ambiguous commission using explicit marketplace evidence', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  await dispatchApprovedProject(execution, { commissioner: { commission: async () => { throw new Error('timeout'); } } });
  assert.throws(() => reconcileCommissionOutcome(execution, { packageId: 'research', outcome: 'commissioned', taskId: 'job-1' }), /evidence/);
  reconcileCommissionOutcome(execution, { packageId: 'research', outcome: 'commissioned', taskId: 'job-1', paymentStatus: 'held', evidenceReference: 'https://market.near.ai/jobs/job-1', reconciledBy: 'owner-principal-1' });
  assert.equal(execution.status, 'work_in_progress');
  assert.equal(execution.packages[0].commissioning.taskId, 'job-1');
});



test('a definitive pre-payment rejection cannot be retried under the old quote or approval', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  let calls = 0;
  await dispatchApprovedProject(execution, { commissioner: { commission: async () => { calls++; return { status: 'rejected_before_payment', reason: 'Provider rejected the request before payment.' }; } } });
  assert.equal(execution.packages[0].commissioning.status, 'failed_definitive');
  await assert.rejects(() => dispatchApprovedProject(execution, { commissioner: { commission: async () => { calls++; return { status: 'commissioned', taskId: 'duplicate' }; } } }), /fresh quote and approval/);
  assert.equal(calls, 1, 'the same quote must never be commissioned a second time');
});

test('a rejected reconciliation requires confirmed non-payment and official marketplace evidence', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  await dispatchApprovedProject(execution, { commissioner: { commission: async () => { throw new Error('timeout'); } } });
  assert.throws(() => reconcileCommissionOutcome(execution, { packageId: 'research', outcome: 'rejected', paymentStatus: 'unknown', evidenceReference: 'https://market.near.ai/jobs/job-2', reconciledBy: 'owner-1' }), /positive evidence that payment was not sent/);
  assert.throws(() => reconcileCommissionOutcome(execution, { packageId: 'research', outcome: 'rejected', paymentStatus: 'not_sent', evidenceReference: 'https://example.com/fake', reconciledBy: 'owner-1' }), /official HTTPS marketplace URL/);
  reconcileCommissionOutcome(execution, { packageId: 'research', outcome: 'rejected', paymentStatus: 'not_sent', evidenceReference: 'https://market.near.ai/agents/provider-a/jobs/job-2', reconciledBy: 'owner-1' });
  assert.equal(execution.packages[0].commissioning.status, 'failed_definitive');
  assert.equal(execution.packages[0].payment.status, 'not_sent');
});

test('requires evaluation evidence and human acceptance independently of x402 settlement', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  await dispatchApprovedProject(execution, { commissioner: { commission: async () => ({ status: 'commissioned', taskId: 'job-2', paymentStatus: 'held' }) } });
  recordPackageDeliverable(execution, { packageId: 'research', taskId: 'job-2', content: 'Market evidence: https://example.com/source. Evidence gaps remain around private company revenue.' });
  await evaluatePackageDeliverable(execution, { packageId: 'research', evaluator: async ({ acceptanceCriteria }) => ({ criterionResults: acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: 'Located in section 1 of the deliverable.' })) }) });
  assert.equal(execution.packages[0].delivery.status, 'evaluation_passed');
  assert.equal(execution.packages[0].acceptance.status, 'not_requested');
  // A2A x402 settles after provider delivery, not after WorkRelay's later quality review.
  recordPaymentSettlement(execution, { packageId: 'research', status: 'settled', transactionId: 'tx-1' });
  assert.equal(execution.packages[0].payment.status, 'settled');
  acceptPackageDeliverable(execution, { packageId: 'research', acceptedBy: 'demo-user' });
  assert.equal(execution.status, 'completed_and_settled');
});

test('failed criterion triggers revision rather than acceptance', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  await dispatchApprovedProject(execution, { commissioner: { commission: async () => ({ status: 'commissioned', taskId: 'job-3' }) } });
  recordPackageDeliverable(execution, { packageId: 'research', taskId: 'job-3', content: 'A short but valid deliverable with some research details.' });
  await evaluatePackageDeliverable(execution, { packageId: 'research', evaluator: async ({ acceptanceCriteria }) => ({ criterionResults: acceptanceCriteria.map((criterion, i) => ({ criterion, passed: i === 0, evidence: 'Checked evidence.' })) }) });
  assert.equal(execution.status, 'revision_required');
  assert.throws(() => acceptPackageDeliverable(execution, { packageId: 'research', acceptedBy: 'demo-user' }), /has not passed evaluation/);
});

test('persists and reloads the execution ledger', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  const directory = await mkdtemp(join(tmpdir(), 'workrelay-'));
  try {
    const path = join(directory, 'execution.json');
    await saveExecution(path, execution);
    const restored = await loadExecution(path);
    assert.equal(restored.executionId, execution.executionId);
    assert.equal(summarizeExecution(restored).packages[0].payment, 'not_sent');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('escrow-mode settlement still requires human acceptance', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  execution.packages[0].payment.mode = 'marketplace_escrow';
  await dispatchApprovedProject(execution, { commissioner: { commission: async () => ({ status: 'commissioned', taskId: 'escrow-job', paymentStatus: 'held', paymentMode: 'marketplace_escrow' }) } });
  assert.throws(() => recordPaymentSettlement(execution, { packageId: 'research', status: 'settled', transactionId: 'escrow-tx' }), /before human acceptance/);
});


test('x402 delivery escrow cannot settle before provider delivery', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  await dispatchApprovedProject(execution, { commissioner: { commission: async () => ({ status: 'commissioned', taskId: 'x402-task', paymentStatus: 'unknown', paymentMode: 'x402_delivery_escrow' }) } });
  assert.throws(() => recordPaymentSettlement(execution, { packageId: 'research', status: 'settled', transactionId: 'x402-tx' }), /before a deliverable is recorded/);
});

test('records a completed artifact returned in the paid commissioning response', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  await dispatchApprovedProject(execution, { commissioner: { commission: async () => ({
    status: 'commissioned', taskId: 'task-with-artifact', paymentStatus: 'unknown', paymentMode: 'x402_delivery_escrow',
    artifacts: [{ text: 'A completed research deliverable returned directly in the A2A response with source links.' }]
  }) } });
  assert.equal(execution.packages[0].delivery.status, 'delivered_pending_evaluation');
  assert.equal(execution.packages[0].delivery.contentHash.length, 64);
});

test('generic rejected result after a commission attempt is ambiguous and cannot be retried', async () => {
  const proposal = await quoteProposal();
  const execution = authorizeProjectExecution(proposal, approvalFor(proposal));
  await dispatchApprovedProject(execution, { commissioner: { commission: async () => ({ status: 'rejected', reason: 'HTTP 402 after X-PAYMENT' }) } });
  assert.equal(execution.packages[0].commissioning.status, 'outcome_unknown');
  let retried = false;
  await dispatchApprovedProject(execution, { commissioner: { commission: async () => { retried = true; return { status: 'commissioned', taskId: 'duplicate' }; } } });
  assert.equal(retried, false);
  assert.equal(execution.packages[0].commissioning.status, 'outcome_unknown');
});
