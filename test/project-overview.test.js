import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProjectOverview } from '../src/orchestration/project-overview.js';

const base = {
  id: 'project-1', mode: 'demo',
  plan: { workPackages: [{ id: 'research', providerCandidates: [{ name: 'A' }] }] },
  proposal: null, execution: null
};

test('project overview presents a plan-ready demo without implying quotes, approval or execution', () => {
  const overview = buildProjectOverview(base);
  assert.equal(overview.mode, 'SIMULATED');
  assert.equal(overview.projectStatus, 'plan_ready');
  assert.equal(overview.steps.find((step) => step.id === 'plan').status, 'complete');
  assert.equal(overview.steps.find((step) => step.id === 'quotes').status, 'current');
  assert.equal(overview.steps.find((step) => step.id === 'approval').status, 'not_applicable');
  assert.equal(overview.steps.find((step) => step.id === 'execution').status, 'locked');
  assert.equal(overview.safety.liveSpendingEnabled, false);
  assert.equal(overview.safety.approvalGranted, false);
});

test('live quote stage remains unpaid and blocks commissioning without an execution record', () => {
  const overview = buildProjectOverview({ ...base, mode: 'live', proposal: { packages: [{ packageId: 'p1' }] } });
  assert.equal(overview.mode, 'LIVE_UNPAID_QUOTES');
  assert.equal(overview.projectStatus, 'quotes_received');
  assert.equal(overview.steps.find((step) => step.id === 'quotes').status, 'complete');
  assert.equal(overview.steps.find((step) => step.id === 'approval').status, 'blocked');
  assert.equal(overview.steps.find((step) => step.id === 'execution').status, 'blocked');
  assert.match(overview.steps.find((step) => step.id === 'execution').detail, /disabled/);
  assert.equal(overview.safety.paymentSent, false);
});

test('simulated execution advances evaluation and report stages without claiming external work', () => {
  const overview = buildProjectOverview({
    ...base,
    proposal: { packages: [{ packageId: 'p1' }] },
    execution: { mode: 'simulation_only', packages: [
      { packageId: 'p1', status: 'awaiting_human_review', evaluation: { status: 'structural_checks_passed', passed: true }, acceptance: { status: 'not_reviewed' } },
      { packageId: 'p2', status: 'delivered_pending_evaluation', evaluation: { status: 'not_evaluated', passed: null }, acceptance: { status: 'not_reviewed' } }
    ] }
  });
  assert.equal(overview.projectStatus, 'delivery_under_review');
  assert.equal(overview.counts.executionPackages, 2);
  assert.equal(overview.counts.structurallyEvaluated, 1);
  assert.equal(overview.counts.humanAccepted, 0);
  assert.equal(overview.steps.find((step) => step.id === 'execution').status, 'complete');
  assert.equal(overview.steps.find((step) => step.id === 'review').status, 'current');
  assert.equal(overview.steps.find((step) => step.id === 'report').status, 'available');
  assert.match(overview.steps.find((step) => step.id === 'execution').detail, /no external agent/);
});

test('all accepted demo packages are presented as human-accepted, not paid', () => {
  const overview = buildProjectOverview({
    ...base,
    execution: { packages: [{ packageId: 'p1', status: 'accepted', acceptance: { status: 'accepted' }, evaluation: { passed: true } }] }
  });
  assert.equal(overview.projectStatus, 'all_deliverables_accepted');
  assert.equal(overview.steps.find((step) => step.id === 'review').status, 'complete');
  assert.equal(overview.safety.paymentAuthorized, false);
});

test('live proposal approval is not confused with commissioning or payment', () => {
  const overview = buildProjectOverview({
    ...base, mode: 'live', proposal: { packages: [{ packageId: 'p1' }] }, executionId: 'exec-approved-12345678'
  });
  assert.equal(overview.projectStatus, 'approved_waiting_for_commissioning');
  assert.equal(overview.steps.find((step) => step.id === 'approval').status, 'complete');
  assert.equal(overview.steps.find((step) => step.id === 'execution').status, 'in_progress');
  assert.equal(overview.safety.approvalGranted, true);
  assert.equal(overview.safety.hiringStarted, false);
  assert.equal(overview.safety.paymentAuthorized, false);
  assert.equal(overview.safety.paymentSent, false);
});


test('configured server-side adapter is shown as a prerequisite, not permission to spend', () => {
  const overview = buildProjectOverview({ ...base, mode: 'live', proposal: { packages: [{ packageId: 'p1' }] } }, { commissioningConfigured: true });
  assert.equal(overview.safety.commissioningConfigured, true);
  assert.equal(overview.safety.liveSpendingEnabled, true);
  assert.equal(overview.steps.find((step) => step.id === 'approval').status, 'blocked');
  assert.equal(overview.steps.find((step) => step.id === 'execution').status, 'current');
  assert.match(overview.steps.find((step) => step.id === 'execution').detail, /separate explicit paid-dispatch confirmation/);
  assert.equal(overview.safety.paymentSent, false);
});
