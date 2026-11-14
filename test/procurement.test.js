import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProcurementProposal, validateProcurementProposal } from '../src/procurement/quote-and-procure.js';

const plan = {
  planId: 'wr-test',
  budget: { amount: 10, currency: 'USDC' },
  workPackages: [
    { id: 'research', title: 'Research', brief: 'Research this market.', acceptanceCriteria: ['Cite sources'], budgetCeiling: 6, providerCandidates: [{ handle: 'provider-a', name: 'Provider A' }, { handle: 'provider-b', name: 'Provider B' }] },
    { id: 'synthesis', title: 'Synthesis', brief: 'Analyse the findings.', acceptanceCriteria: ['Explain implications'], budgetCeiling: 4, providerCandidates: [{ handle: 'provider-c', name: 'Provider C' }] }
  ]
};
const option = (amount, overrides = {}) => ({
  scheme: 'exact', network: 'near:mainnet', asset: 'usdc.near', maxAmountRequired: String(amount),
  payTo: 'provider.near', maxTimeoutSeconds: 300, ...overrides
});

test('selects the cheapest eligible quote within each package ceiling', async () => {
  const proposal = await buildProcurementProposal(plan, {
    allowedAssets: ['usdc.near'], allowedNetworks: ['near:mainnet'],
    quoteRequester: async ({ agent }) => ({ status: 'quote_received', quote: { alternatives: [option(({ 'provider-a': 5_000_000, 'provider-b': 4_000_000, 'provider-c': 3_000_000 })[agent.handle], { payTo: `${agent.handle}.near` })] } })
  });
  assert.equal(proposal.packages[0].recommendation.provider, 'provider-b');
  assert.equal(proposal.packages[1].recommendation.price, 3);
  assert.equal(proposal.packages[0].recommendation.status, 'candidate_pending_approval');
  assert.equal(proposal.budget.recommendedSpend, 7);
  assert.equal(proposal.status, 'ready_for_user_approval');
  assert.equal(validateProcurementProposal(proposal).valid, true);
});

test('rejects quotes over package ceilings and leaves no recommendation', async () => {
  const proposal = await buildProcurementProposal(plan, {
    allowedAssets: ['usdc.near'], allowedNetworks: ['near:mainnet'],
    quoteRequester: async () => ({ status: 'quote_received', quote: { alternatives: [option(9_000_000)] } })
  });
  assert.equal(proposal.packages[0].recommendation, null);
  assert.equal(proposal.packages[1].recommendation, null);
  assert.equal(proposal.status, 'incomplete_requires_review');
});

test('uses x402 v2 amount and NEAR USDC asset for procurement evaluation', async () => {
  const asset = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
  const proposal = await buildProcurementProposal(plan, {
    allowedAssets: [asset], allowedNetworks: ['near:mainnet'],
    quoteRequester: async () => ({ status: 'quote_received', quote: { alternatives: [{ scheme: 'exact', network: 'near:mainnet', asset, amount: '2000000', payTo: 'ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc', maxTimeoutSeconds: 4200 }] } })
  });
  assert.equal(proposal.packages[0].recommendation.price, 2);
  assert.equal(proposal.packages[1].recommendation.price, 2);
  assert.equal(proposal.budget.recommendedSpend, 4);
});

test('quotes remain review-only when no asset allowlist is configured', async () => {
  const proposal = await buildProcurementProposal(plan, {
    quoteRequester: async () => ({ status: 'quote_received', quote: { alternatives: [option(1_000_000)] } })
  });
  assert.equal(proposal.packages[0].recommendation, null);
  assert.match(proposal.pricing.note, /no complete network and asset allowlist/);
});

test('never marks hiring, payment or user approval as completed', async () => {
  const proposal = await buildProcurementProposal(plan, {
    allowedAssets: ['usdc.near'], allowedNetworks: ['near:mainnet'],
    quoteRequester: async () => ({ status: 'quote_received', quote: { alternatives: [option(1_000_000)] } })
  });
  assert.deepEqual(proposal.execution, { hiringStarted: false, paymentsAuthorized: false, paymentSent: false });
  assert.deepEqual(proposal.approval, { required: true, status: 'not_requested', approvalToken: null });
  assert.equal(validateProcurementProposal(proposal).valid, true);
});


test('flags a shared payTo across provider handles and blocks approval readiness', async () => {
  const proposal = await buildProcurementProposal(plan, {
    allowedAssets: ['usdc.near'], allowedNetworks: ['near:mainnet'],
    quoteRequester: async ({ agent }) => ({ status: 'quote_received', quote: { alternatives: [option(1_000_000, { payTo: 'shared-settlement.near' })] } })
  });
  assert.equal(proposal.recipientAudit.status, 'shared_recipient_detected');
  assert.equal(proposal.recipientAudit.requiresManualVerification, true);
  assert.equal(proposal.recipientAudit.severity, 'high_review_priority');
  assert.equal(proposal.packages[0].procurementStatus, 'recipient_verification_required');
  assert.equal(proposal.packages[0].recommendation.status, 'quarantined_pending_recipient_verification');
  assert.equal(proposal.status, 'incomplete_requires_review');
  assert.equal(proposal.nextAction, 'verify_shared_payment_recipient_before_approval');
  assert.equal(validateProcurementProposal(proposal).valid, true);
});

test('quality-adjusted selection can prefer a stronger provider over the cheapest quote', async () => {
  const qualityPlan = {
    planId: 'wr-quality', budget: { amount: 10, currency: 'USDC' },
    workPackages: [{ id: 'research', title: 'Research', brief: 'Research this market.', acceptanceCriteria: ['Cite sources'], budgetCeiling: 6,
      providerCandidates: [
        { handle: 'cheap-weak', name: 'Cheap Weak', score: 50, adjustedSuccessRate: 50, verification: 'none' },
        { handle: 'premium-strong', name: 'Premium Strong', score: 92, adjustedSuccessRate: 91, verification: 'identity_verified' }
      ]
    }]
  };
  const proposal = await buildProcurementProposal(qualityPlan, {
    allowedAssets: ['usdc.near'], allowedNetworks: ['near:mainnet'],
    quoteRequester: async ({ agent }) => ({ status: 'quote_received', quote: { alternatives: [option(agent.handle === 'cheap-weak' ? 100_000 : 500_000, { payTo: `${agent.handle}.near` })] } })
  });
  assert.equal(proposal.packages[0].recommendation.provider, 'premium-strong');
  assert.ok(proposal.packages[0].recommendation.selectionBreakdown.quality > 80);
  assert.equal(proposal.packages[0].recommendation.selectionBreakdown.weights.quality, 0.75);
});

test('live procurement defers dependent packages until upstream work is accepted', async () => {
  const dependentPlan = {
    planId: 'wr-deferred', budget: { amount: 10, currency: 'USDC' },
    workPackages: [
      { id: 'research', title: 'Research', brief: 'Gather evidence.', acceptanceCriteria: ['Cite sources'], budgetCeiling: 6, providerCandidates: [{ handle: 'provider-a', name: 'Provider A' }], dependsOn: [] },
      { id: 'synthesis', title: 'Synthesis', brief: 'Use research to write conclusions.', acceptanceCriteria: ['Explain implications'], budgetCeiling: 4, providerCandidates: [{ handle: 'provider-b', name: 'Provider B' }], dependsOn: ['research'] }
    ]
  };
  const requested = [];
  const proposal = await buildProcurementProposal(dependentPlan, {
    allowedAssets: ['usdc.near'], allowedNetworks: ['near:mainnet'], deferDependentPackages: true,
    quoteRequester: async ({ agent, workPackage }) => {
      requested.push(agent.handle);
      return { status: 'quote_received', requestPayload: { params: { message: { parts: [{ kind: 'text', text: workPackage.brief }] } } }, quote: { alternatives: [option(1_000_000, { payTo: `${agent.handle}.near` })] } };
    }
  });
  assert.deepEqual(requested, ['provider-a'], 'dependent providers receive no premature quote request');
  assert.equal(proposal.packages.length, 1);
  assert.equal(proposal.packages[0].packageId, 'research');
  assert.equal(proposal.deferredPackages.length, 1);
  assert.equal(proposal.deferredPackages[0].packageId, 'synthesis');
  assert.equal(proposal.deferredPackages[0].quoteStatus, 'deferred_until_dependencies_accepted');
  assert.equal(proposal.status, 'ready_for_user_approval');
  assert.equal(validateProcurementProposal(proposal).valid, true);
});

test('dependency-bound quote is ineligible unless exact new brief is proven in request payload', async () => {
  const dependencyHandoff = {
    packageId: 'synthesis', originalBrief: 'Write a report.', brief: 'Write a report.\n\nAccepted source: upstream evidence.',
    sourceManifest: [{ packageId: 'evidence', contentHash: 'a'.repeat(64), bytes: 100, acceptanceStatus: 'accepted', evaluationPassed: true }],
    inputBundleHash: 'b'.repeat(64), requestFingerprint: 'c'.repeat(64), quoteStatus: 'fresh_quote_required',
    approvalStatus: 'fresh_approval_required', immutable: true
  };
  const focused = { planId: 'wr-bound', budget: { amount: 4, currency: 'USDC' }, workPackages: [
    { id: 'synthesis', title: 'Synthesis', brief: dependencyHandoff.brief, originalBrief: dependencyHandoff.originalBrief, acceptanceCriteria: ['Use sources'], budgetCeiling: 4, dependsOn: [], dependencyHandoff, providerCandidates: [{ handle: 'provider-c', name: 'Provider C' }] }
  ] };
  const good = await buildProcurementProposal(focused, {
    allowedAssets: ['usdc.near'], allowedNetworks: ['near:mainnet'],
    quoteRequester: async ({ workPackage }) => ({ status: 'quote_received', requestPayload: { params: { message: { parts: [{ kind: 'text', text: workPackage.brief }] } } }, quote: { alternatives: [option(1_000_000)] } })
  });
  assert.equal(good.packages[0].dependencyHandoff.quoteStatus, 'quoted_bound');
  assert.equal(good.packages[0].dependencyHandoff.quoteBindingVerified, true);
  assert.equal(good.packages[0].recommendation.price, 1);
  const bad = await buildProcurementProposal(focused, {
    allowedAssets: ['usdc.near'], allowedNetworks: ['near:mainnet'],
    quoteRequester: async () => ({ status: 'quote_received', requestPayload: { params: { message: { parts: [{ kind: 'text', text: 'old request' }] } } }, quote: { alternatives: [option(1_000_000)] } })
  });
  assert.equal(bad.packages[0].recommendation, null);
  assert.equal(bad.packages[0].dependencyHandoff.quoteStatus, 'quote_binding_unverified');
  assert.equal(bad.packages[0].providerQuotes[0].quoteOptions[0].eligible, false);
});

test('dependency handoff validation binds the proposal brief hash and exact A2A request', async () => {
  const dependencyHandoff = {
    packageId: 'synthesis', originalBrief: 'Write a report.', brief: 'Write a report.\n\nAccepted source: upstream evidence.',
    sourceManifest: [{ packageId: 'evidence', contentHash: 'a'.repeat(64), bytes: 100, acceptanceStatus: 'accepted', evaluationPassed: true }],
    inputBundleHash: 'b'.repeat(64), requestFingerprint: 'c'.repeat(64), quoteStatus: 'fresh_quote_required',
    approvalStatus: 'fresh_approval_required', immutable: true
  };
  const focused = { planId: 'wr-bound-validate', budget: { amount: 4, currency: 'USDC' }, workPackages: [
    { id: 'synthesis', title: 'Synthesis', brief: dependencyHandoff.brief, originalBrief: dependencyHandoff.originalBrief, acceptanceCriteria: ['Use sources'], budgetCeiling: 4, dependsOn: [], dependencyHandoff, providerCandidates: [{ handle: 'provider-c', name: 'Provider C' }] }
  ] };
  const proposal = await buildProcurementProposal(focused, {
    allowedAssets: ['usdc.near'], allowedNetworks: ['near:mainnet'],
    quoteRequester: async ({ workPackage }) => ({ status: 'quote_received', requestPayload: { params: { message: { parts: [{ kind: 'text', text: workPackage.brief }] } } }, quote: { alternatives: [option(1_000_000)] } })
  });
  assert.equal(validateProcurementProposal(proposal).valid, true);
  const altered = structuredClone(proposal);
  altered.packages[0].brief = 'An earlier brief without the upstream artifact.';
  const validation = validateProcurementProposal(altered);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join(' '), /brief no longer matches/);
  assert.match(validation.errors.join(' '), /does not contain the exact dependency-bound brief/);
});
