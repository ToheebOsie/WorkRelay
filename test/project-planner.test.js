import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectPlan, decomposeObjective, validateProjectPlan } from '../src/contractor/project-planner.js';

const agents = [
  {
    handle: 'web-research', name: 'Web Research', description: 'Market research and competitor analysis with citations',
    category: 'research', tags: ['market-research', 'competitor-analysis', 'citations'], listing_status: 'live',
    availability: 'available', available_now: true, funding_paused: false, delivered_jobs: 52, success_rate: 72,
    sla_seconds: 180, payable_with: ['USDC'], builder: { verification: { level: 'none' } }
  },
  {
    handle: 'cited-research-desk', name: 'Cited Research Desk', description: 'Cited research briefs and fact checking',
    category: 'research', tags: ['citations', 'market-research'], listing_status: 'live',
    availability: 'available', available_now: true, funding_paused: false, delivered_jobs: 2, success_rate: 100,
    sla_seconds: 3600, payable_with: ['USDC'], builder: { verification: { level: 'identity_verified' } }
  }
];

test('decomposes a market-entry competitor report into distinct packages', () => {
  const packages = decomposeObjective('Research the Kenyan fintech market, identify competitors and produce a market-entry report');
  assert.deepEqual(packages.map((item) => item.id), ['evidence-gathering', 'competitor-mapping', 'synthesis-and-recommendations']);
  assert.ok(Math.abs(packages.reduce((sum, item) => sum + item.weight, 0) - 1) < 1e-9);
});

test('creates a budget-bounded draft and ranks actual provider-shaped records', () => {
  const plan = createProjectPlan({
    objective: 'Research the Kenyan fintech market, identify five competitors, analyse positioning and produce a report',
    budget: 10,
    agents
  });
  assert.equal(plan.status, 'draft_requires_user_approval');
  assert.equal(plan.pricing.status, 'unquoted');
  assert.equal(plan.execution.hiringStarted, false);
  assert.equal(plan.execution.paymentsAuthorized, false);
  assert.equal(plan.workPackages.length, 3);
  assert.ok(plan.workPackages.every((item) => item.budgetCeiling > 0));
  assert.ok(plan.workPackages.every((item) => item.quotedPrice === null));
  assert.ok(plan.workPackages[0].providerCandidates.some((provider) => provider.handle === 'web-research'));
  assert.equal(validateProjectPlan(plan).valid, true);
});

test('rejects a plan whose work-package ceilings exceed the budget', () => {
  const plan = createProjectPlan({ objective: 'Write a report', budget: 5, agents });
  plan.workPackages[0].budgetCeiling = 6;
  const result = validateProjectPlan(plan);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('exceed')));
});

test('rejects invalid budgets and empty objectives', () => {
  assert.throws(() => createProjectPlan({ objective: 'Research', budget: 0, agents }), /positive/);
  assert.throws(() => createProjectPlan({ objective: '', budget: 10, agents }), /non-empty/);
});


test('excludes explicit specialist-domain mismatches from Kenyan fintech packages', () => {
  const expandedAgents = [...agents,
    { handle: 'kinship-research', name: 'Kinship Research', description: 'Evidence-based family history research for the former USSR and Russian Empire', category: 'research', tags: ['genealogy', 'archives'], listing_status: 'live', availability: 'available', available_now: true, funding_paused: false, delivered_jobs: 1, success_rate: 50, sla_seconds: 86400, payable_with: ['USDC'], builder: { verification: { level: 'identity_verified' } } },
    { handle: 'infinito-absoluto', name: 'Verified Research — US Hispanic & LatAm Markets', description: 'Verified research on US Hispanic and LatAm markets', category: 'research', tags: ['market research'], listing_status: 'live', availability: 'available', available_now: true, funding_paused: false, delivered_jobs: 0, success_rate: null, sla_seconds: 86400, payable_with: ['USDC'], builder: { verification: { level: 'identity_verified' } } }
  ];
  const plan = createProjectPlan({ objective: 'Research the Kenyan fintech market, identify five competitors, analyse positioning and produce a market-entry report', budget: 10, agents: expandedAgents });
  for (const workPackage of plan.workPackages) {
    assert.ok(!workPackage.providerCandidates.some((provider) => ['kinship-research', 'infinito-absoluto'].includes(provider.handle)));
  }
});

test('project plan validation rejects dangling and cyclic dependency edges', () => {
  const plan = createProjectPlan({
    objective: 'Research the Kenyan fintech market, identify five competitors, analyse positioning and produce a report',
    budget: 10,
    agents
  });
  const original = structuredClone(plan);
  plan.workPackages[0].dependsOn = ['package-that-does-not-exist'];
  const missing = validateProjectPlan(plan);
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join(' '), /unknown dependency/);

  const cyclic = structuredClone(original);
  cyclic.workPackages[0].dependsOn = ['synthesis-and-recommendations'];
  const cycleResult = validateProjectPlan(cyclic);
  assert.equal(cycleResult.valid, false);
  assert.match(cycleResult.errors.join(' '), /cycle/);
});
