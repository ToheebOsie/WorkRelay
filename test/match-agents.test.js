import test from 'node:test';
import assert from 'node:assert/strict';
import { rankAgents, summarizeAgentMatch } from '../src/contractor/match-agents.js';

const base = {
  name: 'Research provider',
  description: 'Source-backed market research and competitor analysis',
  category: 'research',
  tags: ['market-research', 'competitor-analysis'],
  listing_status: 'live',
  availability: 'available',
  available_now: true,
  funding_paused: false,
  delivered_jobs: 2,
  success_rate: 100,
  sla_seconds: 3600,
  payable_with: ['USDC'],
  input_schema: { type: 'object' },
  builder: { verification: { level: 'verified' } }
};

test('rankAgents rewards task relevance and operational availability', () => {
  const relevant = { ...base, handle: 'relevant' };
  const unrelated = { ...base, handle: 'unrelated', category: 'translation', tags: ['language'], description: 'Vietnamese translation' };
  const ranked = rankAgents([unrelated, relevant], 'market research competitor analysis');
  assert.equal(ranked[0].agent.handle, 'relevant');
  assert.equal(ranked[0].eligibleForShortlist, true);
  assert.ok(ranked[0].score > ranked[1].score);
});

test('small success-rate samples are shrunk toward the prior', () => {
  const onePerfectJob = { ...base, delivered_jobs: 1, success_rate: 100 };
  const established = { ...base, delivered_jobs: 20, success_rate: 85 };
  const ranked = rankAgents([onePerfectJob, established], 'market research');
  const small = ranked.find((item) => item.agent.delivered_jobs === 1);
  const mature = ranked.find((item) => item.agent.delivered_jobs === 20);
  assert.ok(small.adjustedSuccessRate < 100);
  assert.ok(mature.adjustedSuccessRate > small.adjustedSuccessRate);
});

test('paused, unavailable and non-live agents are not shortlisted', () => {
  const blocked = { ...base, funding_paused: true };
  const ranked = rankAgents([blocked], 'market research');
  assert.equal(ranked[0].eligibleForShortlist, false);
  assert.ok(ranked[0].caveats.includes('Funding is paused'));
});

test('summary exposes a compact, auditable decision record', () => {
  const match = rankAgents([{ ...base, handle: 'sample' }], 'market research')[0];
  const summary = summarizeAgentMatch(match);
  assert.equal(summary.handle, 'sample');
  assert.ok(summary.scoreBreakdown.relevance >= 0);
  assert.ok(Array.isArray(summary.caveats));
});

test('rejects a provider whose explicit specialty conflicts with the task domain', () => {
  const familyHistorian = {
    ...base,
    handle: 'kinship-research',
    name: 'Kinship Research',
    description: 'Evidence-based family history research for the former USSR and Russian Empire',
    tags: ['genealogy', 'archives']
  };
  const ranked = rankAgents([familyHistorian], 'research analysis business recommendations report writing', {
    context: 'Research the Kenyan fintech market, identify competitors and produce a market-entry report'
  });
  assert.equal(ranked[0].capabilityFit, 'mismatch');
  assert.equal(ranked[0].eligibleForShortlist, false);
  assert.ok(ranked[0].caveats.some((item) => item.includes('family-history')));
});

test('rejects a geographically constrained provider for an incompatible market', () => {
  const latamSpecialist = {
    ...base,
    handle: 'latam-specialist',
    name: 'Verified Research — US Hispanic & LatAm Markets',
    description: 'Verified research on US Hispanic and Latin America markets'
  };
  const ranked = rankAgents([latamSpecialist], 'market research data collection', {
    context: 'Research the Kenyan fintech market'
  });
  assert.equal(ranked[0].eligibleForShortlist, false);
});
