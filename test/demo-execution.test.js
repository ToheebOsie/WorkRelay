import test from 'node:test';
import assert from 'node:assert/strict';
import { assessEvidenceGate, approveDemoDownstreamQuote, createDemoExecution, requestDemoDownstreamQuote, resetDemoExecution, runDemoExecution, runDemoScenario, evaluateDemoDeliverable, reviewDemoDeliverable, buildDemoFinalReport } from '../src/orchestration/demo-execution.js';

const OVERRIDE = { evidenceOverride: { reviewer: { kind: 'human', id: 'reviewer-1' }, reason: 'Reviewed the failing fixture source manually and accept the demo deliverable.' } };
const proposal = { status:'simulation_only', proposalId:'p1', packages:[
  {packageId:'a',title:'Evidence gathering',brief:'Gather evidence for the task',acceptanceCriteria:['Include source URLs'],recommendation:{provider:'researcher',providerName:'Demo Researcher',price:1,currency:'USD'}},
  {packageId:'b',title:'Analysis',brief:'Analyse the findings',acceptanceCriteria:['Compare alternatives'],recommendation:{provider:'analyst',providerName:'Demo Analyst',price:1,currency:'USD'}}
]};

test('demo execution only accepts simulation proposals and creates disclosed tasks',()=>{
  assert.throws(()=>createDemoExecution({...proposal,status:'ready_for_user_approval'}),/simulation-only/);
  const ex=createDemoExecution(proposal);
  assert.equal(ex.mode,'simulation_only');
  assert.equal(ex.packages.length,2);
  assert.match(ex.warning,/simulated/);
});
test('runs provider-shaped simulated tasks and records content hashes',()=>{
  const ex=runDemoExecution(createDemoExecution(proposal));
  assert.equal(ex.status,'deliverables_ready_for_review');
  for(const pkg of ex.packages){assert.equal(pkg.status,'delivered_pending_evaluation');assert.equal(pkg.contentHash.length,64);assert.match(pkg.deliverable,/DEMONSTRATION OUTPUT/);assert.equal(pkg.evidencePacket.record.rawArtifactHash,pkg.contentHash);assert.equal(pkg.evidencePacket.verification.status,'check_failed');}
});
test('structural evaluation is separate from human acceptance',()=>{
  const ex=runDemoExecution(createDemoExecution(proposal));
  evaluateDemoDeliverable(ex,'a');
  assert.equal(ex.packages[0].status,'awaiting_human_review');
  assert.equal(ex.packages[0].acceptance.status,'not_reviewed');
  reviewDemoDeliverable(ex,'a','accept',OVERRIDE);
  assert.equal(ex.packages[0].status,'accepted');
  assert.equal(buildDemoFinalReport(ex).completedPackages,1);
});
test('rejects invalid transitions and records revision requests',()=>{
  const ex=runDemoExecution(createDemoExecution(proposal));
  assert.throws(()=>reviewDemoDeliverable(ex,'a','accept'),/evaluation/);
  evaluateDemoDeliverable(ex,'a');
  reviewDemoDeliverable(ex,'a','request_revision');
  assert.equal(ex.packages[0].status,'review_required');
  assert.equal(ex.packages[0].acceptance.status,'revision_requested');
});
test('final report never represents simulated work as paid or factual',()=>{
  const ex=runDemoExecution(createDemoExecution(proposal));
  const report=buildDemoFinalReport(ex);
  assert.equal(report.payment.status,'not_applicable_simulation');
  assert.equal(report.payment.amountSpent,0);
  assert.match(report.disclosure,/simulated/);
});

test('dependent simulated work waits for upstream evaluation and acceptance, then consumes hashed outputs', () => {
  const linkedProposal = { status: 'simulation_only', proposalId: 'p-linked', packages: [
    { packageId: 'research', title: 'Research', brief: 'Gather market evidence.', acceptanceCriteria: ['Include source URLs'], dependsOn: [], recommendation: { provider: 'researcher', providerName: 'Demo Researcher', price: 1, currency: 'USD' } },
    { packageId: 'synthesis', title: 'Synthesis', brief: 'Synthesise the research into a report.', acceptanceCriteria: ['Use accepted evidence'], dependsOn: ['research'], recommendation: { provider: 'analyst', providerName: 'Demo Analyst', price: 1, currency: 'USD' } }
  ] };
  const ex = runDemoExecution(createDemoExecution(linkedProposal));
  assert.equal(ex.packages.find((item) => item.packageId === 'research').status, 'delivered_pending_evaluation');
  assert.equal(ex.packages.find((item) => item.packageId === 'synthesis').status, 'queued_waiting_for_dependencies');
  assert.deepEqual(ex.lastRun.held[0].waitingOn, ['research']);
  assert.equal(buildDemoFinalReport(ex).sections.find((item) => item.title === 'Synthesis').deliverable, null);
  evaluateDemoDeliverable(ex, 'research');
  runDemoExecution(ex);
  assert.equal(ex.packages.find((item) => item.packageId === 'synthesis').deliverable, null, 'evaluation alone is not enough; explicit acceptance is required');
  reviewDemoDeliverable(ex, 'research', 'accept', OVERRIDE);
  runDemoExecution(ex);
  const synthesis = ex.packages.find((item) => item.packageId === 'synthesis');
  assert.equal(synthesis.status, 'queued_waiting_for_downstream_quote');
  const quote = requestDemoDownstreamQuote(ex, 'synthesis');
  assert.equal(quote.status, 'quoted_not_approved');
  assert.equal(quote.freshQuote, true);
  runDemoExecution(ex);
  assert.equal(synthesis.status, 'queued_waiting_for_downstream_approval');
  approveDemoDownstreamQuote(ex, 'synthesis');
  assert.equal(synthesis.simulatedDownstreamQuote.status, 'approved');
  runDemoExecution(ex);
  assert.equal(synthesis.status, 'delivered_pending_evaluation');
  assert.equal(synthesis.dependencyInputs.length, 1);
  assert.equal(synthesis.dependencyInputs[0].packageId, 'research');
  assert.equal(synthesis.dependencyInputs[0].contentHash, ex.packages[0].contentHash);
  assert.match(synthesis.deliverable, /Accepted upstream context received/);
  assert.match(synthesis.deliverable, /BEGIN UNTRUSTED UPSTREAM ARTIFACT/);
  assert.equal(synthesis.dependencyHandoff.quoteStatus, 'not_applicable_simulation');
});

test('sandbox branches expose success, revision, refund and unresolved-dispute paths without settlement', () => {
  for (const scenario of ['success', 'revision', 'refund_before_submission', 'unresolved_dispute']) {
    const ex = createDemoExecution(proposal);
    runDemoScenario(ex, scenario);
    assert.equal(ex.sandbox.scenario, scenario);
    assert.equal(ex.sandbox.settlement, 'not_applicable_simulation');
    assert.match(ex.simulationLabel, /SIMULATED/);
    assert.ok(ex.ledger.some((entry) => entry.event.includes('demo_')));
  }
  const success = createDemoExecution(proposal);
  runDemoScenario(success, 'success');
  assert.equal(success.status, 'success_with_evidence_overrides');
  assert.equal(success.sandbox.evidenceOverrides, 2);
  const revision = createDemoExecution(proposal);
  runDemoScenario(revision, 'revision');
  assert.equal(revision.status, 'revision_required');
  assert.ok(revision.packages.some((pkg) => pkg.acceptance.status === 'revision_requested'));
  const refund = createDemoExecution(proposal);
  runDemoScenario(refund, 'refund_before_submission');
  assert.equal(refund.status, 'refunded_before_submission');
  assert.ok(refund.packages.every((pkg) => pkg.deliverable === null));
  const dispute = createDemoExecution(proposal);
  runDemoScenario(dispute, 'unresolved_dispute');
  assert.equal(dispute.status, 'unresolved_dispute');
  assert.ok(dispute.packages.some((pkg) => pkg.acceptance.status === 'dispute_open'));
});

test('sandbox reset clears prior outputs and makes replay possible', () => {
  const ex = createDemoExecution(proposal);
  runDemoScenario(ex, 'success');
  const oldExecutionId = ex.executionId;
  resetDemoExecution(ex);
  assert.equal(ex.executionId, oldExecutionId);
  assert.equal(ex.status, 'queued');
  assert.ok(ex.packages.every((pkg) => pkg.status === 'queued' && pkg.deliverable === null && pkg.evidencePacket === null));
  runDemoExecution(ex);
  assert.ok(ex.packages.some((pkg) => pkg.status === 'delivered_pending_evaluation'));
});

function evaluated() {
  const ex = runDemoExecution(createDemoExecution(proposal));
  evaluateDemoDeliverable(ex, 'a');
  return ex;
}

test('acceptance is refused while evidence checks have not passed, and nothing is recorded', () => {
  const ex = evaluated();
  const pkg = ex.packages[0];
  assert.equal(assessEvidenceGate(pkg).passed, false);
  assert.equal(assessEvidenceGate(pkg).verificationStatus, 'check_failed');
  assert.equal(assessEvidenceGate(pkg).qualityStatus, 'check_failed');
  const attempts = [
    undefined,
    {},
    { evidenceOverride: null },
    { evidenceOverride: { reviewer: { kind: 'human', id: 'r' }, reason: 'too short' } },
    { evidenceOverride: { reviewer: { kind: 'human', id: 'r' }, reason: ' '.repeat(40) } },
    { evidenceOverride: { reviewer: { kind: 'human', id: 'r' }, reason: 'x'.repeat(1001) } },
    { evidenceOverride: { reason: 'A sufficiently long written reason for the override.' } },
    { evidenceOverride: { reviewer: { kind: 'human', id: '  ' }, reason: 'A sufficiently long written reason for the override.' } }
  ];
  for (const options of attempts) assert.throws(() => reviewDemoDeliverable(ex, 'a', 'accept', options), /Evidence checks have not all passed|override/);
  assert.equal(pkg.status, 'awaiting_human_review');
  assert.equal(pkg.acceptance.status, 'not_reviewed');
  assert.ok(!ex.ledger.some((entry) => entry.event === 'demo_deliverable_accepted'));
  assert.equal(buildDemoFinalReport(ex).completedPackages, 0);
});

test('an explicit override is bound to the packet, recorded on the package and ledger, and shown in the report', () => {
  const ex = evaluated();
  const pkg = ex.packages[0];
  reviewDemoDeliverable(ex, 'a', 'accept', OVERRIDE);
  assert.equal(pkg.status, 'accepted');
  const gate = pkg.acceptance.evidenceGate;
  assert.equal(gate.status, 'overridden');
  assert.equal(gate.packetDigest, pkg.evidencePacket.digest);
  assert.equal(gate.override.packetDigest, pkg.evidencePacket.digest);
  assert.equal(gate.override.reviewer.id, 'reviewer-1');
  assert.match(gate.override.reason, /failing fixture/);
  const overrideEvent = ex.ledger.find((entry) => entry.event === 'demo_evidence_gate_overridden');
  assert.equal(overrideEvent.details.packetDigest, pkg.evidencePacket.digest);
  assert.equal(overrideEvent.details.qualityStatus, 'check_failed');
  const report = buildDemoFinalReport(ex);
  assert.equal(report.evidenceOverrides, 1);
  assert.equal(report.sections[0].acceptance.evidenceGate.status, 'overridden');
  assert.equal(report.sections[0].evidenceGate.passed, false);
});

test('requesting a revision never needs an override, and a missing evidence packet blocks acceptance', () => {
  const ex = evaluated();
  reviewDemoDeliverable(ex, 'a', 'request_revision');
  assert.equal(ex.packages[0].acceptance.status, 'revision_requested');
  const missing = evaluated();
  missing.packages[0].evidencePacket = null;
  assert.equal(assessEvidenceGate(missing.packages[0]).verificationStatus, 'missing');
  assert.throws(() => reviewDemoDeliverable(missing, 'a', 'accept'), /Evidence checks have not all passed/);
});

test('acceptance passes without an override only when both evidence layers are complete', () => {
  const ex = evaluated();
  const pkg = ex.packages[0];
  pkg.evidencePacket.verification = { ...pkg.evidencePacket.verification, status: 'complete' };
  assert.throws(() => reviewDemoDeliverable(ex, 'a', 'accept'), /Evidence checks have not all passed/, 'quality policy must also be complete');
  pkg.evidencePacket.qualityEvaluation = { ...pkg.evidencePacket.qualityEvaluation, status: 'complete' };
  assert.equal(assessEvidenceGate(pkg).passed, true);
  reviewDemoDeliverable(ex, 'a', 'accept');
  assert.equal(pkg.acceptance.evidenceGate.status, 'passed');
  assert.equal(pkg.acceptance.evidenceGate.override, null);
  assert.equal(buildDemoFinalReport(ex).evidenceOverrides, 0);
  assert.ok(!ex.ledger.some((entry) => entry.event === 'demo_evidence_gate_overridden'));
});

test('the scripted success branch overrides visibly, and a downstream package is told its input was overridden', () => {
  const linked = { status: 'simulation_only', proposalId: 'p-linked', packages: [
    { packageId: 'research', title: 'Research', brief: 'Gather market evidence.', acceptanceCriteria: ['Include source URLs'], dependsOn: [], recommendation: { provider: 'researcher', providerName: 'Demo Researcher', price: 1, currency: 'USD' } },
    { packageId: 'synthesis', title: 'Synthesis', brief: 'Synthesise the research.', acceptanceCriteria: ['Use accepted evidence'], dependsOn: ['research'], recommendation: { provider: 'analyst', providerName: 'Demo Analyst', price: 1, currency: 'USD' } }
  ] };
  const ex = createDemoExecution(linked);
  runDemoScenario(ex, 'success');
  assert.equal(ex.status, 'success_with_evidence_overrides');
  const events = ex.ledger.filter((entry) => entry.event === 'demo_evidence_gate_overridden');
  assert.equal(events.length, 2);
  assert.ok(events.every((entry) => entry.details.reviewer.kind === 'system' && /not a real review/.test(entry.details.reason)));
  const synthesis = ex.packages.find((item) => item.packageId === 'synthesis');
  assert.equal(synthesis.dependencyHandoff.sourceManifest[0].evidenceGateStatus, 'overridden');
  assert.match(synthesis.deliverable, /Evidence gate: accepted with a documented override/);
  assert.equal(buildDemoFinalReport(ex).evidenceOverrides, 2);
});
