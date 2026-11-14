import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoExecution, runDemoExecution, evaluateDemoDeliverable, reviewDemoDeliverable, buildDemoFinalReport } from '../src/orchestration/demo-execution.js';

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
  for(const pkg of ex.packages){assert.equal(pkg.status,'delivered_pending_evaluation');assert.equal(pkg.contentHash.length,64);assert.match(pkg.deliverable,/DEMONSTRATION OUTPUT/);}
});
test('structural evaluation is separate from human acceptance',()=>{
  const ex=runDemoExecution(createDemoExecution(proposal));
  evaluateDemoDeliverable(ex,'a');
  assert.equal(ex.packages[0].status,'awaiting_human_review');
  assert.equal(ex.packages[0].acceptance.status,'not_reviewed');
  reviewDemoDeliverable(ex,'a','accept');
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
  reviewDemoDeliverable(ex, 'research', 'accept');
  runDemoExecution(ex);
  const synthesis = ex.packages.find((item) => item.packageId === 'synthesis');
  assert.equal(synthesis.status, 'delivered_pending_evaluation');
  assert.equal(synthesis.dependencyInputs.length, 1);
  assert.equal(synthesis.dependencyInputs[0].packageId, 'research');
  assert.equal(synthesis.dependencyInputs[0].contentHash, ex.packages[0].contentHash);
  assert.match(synthesis.deliverable, /Accepted upstream context received/);
  assert.match(synthesis.deliverable, /BEGIN UNTRUSTED UPSTREAM ARTIFACT/);
  assert.equal(synthesis.dependencyHandoff.quoteStatus, 'not_applicable_simulation');
});
