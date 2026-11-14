import { requestProviderQuote, validatePaymentTerms, atomicToUnits } from '../market/near-a2a-quotes.js';
import { selectedRequirementMatches } from '../payments/x402-authorization.js';

import { createRecipientReviewCase } from './recipient-review.js';
import { verifyA2ARequestContainsBrief, summarizeDependencyHandoff } from '../orchestration/dependency-handoff.js';
import { createHash } from 'node:crypto';

const money = (value) => Math.round((Number(value) + Number.EPSILON) * 1e6) / 1e6;
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, value));
const sha256 = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');

function providerQuality(provider) {
  const matchScore = Number(provider.score);
  const reliability = Number(provider.adjustedSuccessRate);
  const verification = provider.verification === 'identity_verified' || provider.verification === 'verified' ? 100 : 50;
  const capability = provider.capabilityFit === 'mismatch' ? 0 : 100;
  const components = {
    marketplaceMatch: Number.isFinite(matchScore) ? clamp(matchScore) : 60,
    deliveryReliability: Number.isFinite(reliability) ? clamp(reliability) : 60,
    identityVerification: verification,
    capabilityFit: capability
  };
  const score = components.marketplaceMatch * 0.35
    + components.deliveryReliability * 0.35
    + components.identityVerification * 0.10
    + components.capabilityFit * 0.20;
  return { score: Math.round(score * 10) / 10, components };
}

function rankQuotedProviders(providerQuotes) {
  const candidates = providerQuotes.filter((item) => item.recommendedOption);
  if (!candidates.length) return [];
  const prices = candidates.map((item) => item.recommendedOption.amount);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return candidates.map((item) => {
    const quality = providerQuality(item.providerMetadata ?? {});
    const priceValue = max === min ? 100 : 100 - ((item.recommendedOption.amount - min) / (max - min) * 100);
    // Quality is deliberately dominant. Price breaks ties and rewards efficiency,
    // but cannot make a materially weaker provider win on price alone.
    const selectionScore = Math.round((quality.score * 0.75 + priceValue * 0.25) * 10) / 10;
    return { ...item, selectionScore, selectionBreakdown: { quality: quality.score, qualityComponents: quality.components, priceValue: Math.round(priceValue * 10) / 10, weights: { quality: 0.75, price: 0.25 } } };
  }).sort((a, b) => b.selectionScore - a.selectionScore || a.recommendedOption.amount - b.recommendedOption.amount);
}

/**
 * Request quotes from every shortlisted provider, then rank valid quotes by provider
 * quality and price while respecting package ceilings and the remaining project budget.
 * No hiring or payment action exists in this module.
 */
export async function buildProcurementProposal(plan, {
  quoteRequester = requestProviderQuote,
  allowedAssets = [],
  allowedNetworks = [],
  allowedAssetsByNetwork = null,
  requireV2PaymentChallenge = false,
  assetDecimals = 6,
  expectedCurrency = plan?.budget?.currency ?? 'USDC',
  concurrency = 3,
  deferDependentPackages = false
} = {}) {
  if (!plan || !Array.isArray(plan.workPackages) || !Number.isFinite(Number(plan.budget?.amount))) {
    throw new TypeError('A valid project plan is required');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be a positive integer');

  if (typeof deferDependentPackages !== 'boolean') throw new TypeError('deferDependentPackages must be a boolean');
  const deferredPackages = deferDependentPackages
    ? plan.workPackages.filter((item) => Array.isArray(item.dependsOn) && item.dependsOn.length)
    : [];
  const activePackages = deferDependentPackages
    ? plan.workPackages.filter((item) => !(Array.isArray(item.dependsOn) && item.dependsOn.length))
    : plan.workPackages;
  const tasks = [];
  for (const workPackage of activePackages) {
    for (const provider of workPackage.providerCandidates ?? []) {
      tasks.push({ workPackage, provider });
    }
  }

  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      const { workPackage, provider } = tasks[index];
      let response;
      try {
        response = await quoteRequester({
          agent: provider,
          workPackage,
          requestId: `wr-${plan.planId}-${workPackage.id}-${provider.handle}`
        });
      } catch (error) {
        response = { status: 'request_failed', provider: provider.handle, reason: error.message, quote: null };
      }

      const bindingRequired = Boolean(workPackage.dependencyHandoff);
      const requestBindingVerified = !bindingRequired || verifyA2ARequestContainsBrief(response.requestPayload, workPackage.brief);
      const evaluated = (response.quote?.alternatives ?? []).map((terms) => {
        const validation = validatePaymentTerms(terms, { allowedAssets, allowedNetworks, allowedAssetsByNetwork, expectedCurrency });
        let amount = null;
        if (validation.valid) {
          amount = atomicToUnits(validation.amountAtomic, assetDecimals);
          if (!Number.isFinite(amount)) validation.errors.push('Quote amount could not be converted safely');
        }
        const withinPackageCeiling = validation.valid && amount <= Number(workPackage.budgetCeiling) + 1e-9;
        const challengeBound = response.quote?.paymentChallenge?.x402Version === 2 && selectedRequirementMatches(response.quote.paymentChallenge, terms);
        return {
          terms: validation,
          challengeBound,
          amount,
          withinPackageCeiling,
          eligible: validation.valid && withinPackageCeiling && requestBindingVerified && (!requireV2PaymentChallenge || challengeBound),
          status: !validation.valid ? 'review_required' : requireV2PaymentChallenge && !challengeBound ? 'x402_v2_challenge_required' : !requestBindingVerified ? 'dependency_request_binding_unverified' : withinPackageCeiling ? 'within_ceiling' : 'over_package_ceiling'
        };
      });
      const eligible = evaluated.filter((item) => item.eligible).sort((a, b) => a.amount - b.amount);
      results[index] = {
        packageId: workPackage.id,
        provider: provider.handle,
        providerName: provider.name,
        providerMetadata: provider,
        requestStatus: response.status,
        requestBindingVerified,
        requestBindingError: bindingRequired && !requestBindingVerified ? 'The returned quote cannot be proven to cover the exact dependency-bound brief; it is not eligible for recommendation.' : null,
        providerEndpoint: response.endpoint ?? null,
        a2aRequestPayload: response.requestPayload ?? null,
        paymentChallenge: response.quote?.paymentChallenge ?? null,
        quoteReceivedAt: response.quote?.receivedAt ?? null,
        reason: response.reason ?? null,
        httpStatus: response.httpStatus ?? null,
        quoteOptions: evaluated,
        recommendedOption: eligible[0] ?? null,
        quoteReceived: response.status === 'quote_received'
      };
    }
  });
  await Promise.all(workers);

  // A repeated payTo across different provider handles is not proof of fraud: providers
  // may share a settlement operator. It is, however, a material recipient-control signal.
  // Preserve quotes for comparison but require manual verification before approval.
  const recipientProviders = new Map();
  for (const item of results) {
    for (const option of item.quoteOptions ?? []) {
      const payTo = option.terms?.payTo;
      if (!payTo) continue;
      if (!recipientProviders.has(payTo)) recipientProviders.set(payTo, new Set());
      recipientProviders.get(payTo).add(item.provider);
    }
  }
  const sharedRecipients = [...recipientProviders.entries()]
    .filter(([, providers]) => providers.size > 1)
    .map(([payTo, providers]) => ({ ...createRecipientReviewCase({ payTo, providers: [...providers] }) }));
  const recipientAudit = {
    status: sharedRecipients.length ? 'shared_recipient_detected' : 'no_cross_provider_recipient_reuse_detected',
    severity: sharedRecipients.length ? 'high_review_priority' : 'none_detected',
    requiresManualVerification: sharedRecipients.length > 0,
    sharedRecipients,
    note: sharedRecipients.length
      ? 'Multiple provider handles returned the same payTo address. This may reflect shared settlement infrastructure, but provider ownership and payment routing must be independently verified before any payment approval.'
      : 'No payTo address was reused across different provider handles in the collected quotes.'
  };

  let remainingBudget = Number(plan.budget.amount);
  const packageResults = activePackages.map((workPackage) => {
    const providerQuotes = results.filter((item) => item.packageId === workPackage.id);
    const ranked = rankQuotedProviders(providerQuotes);
    const affordable = ranked.find((item) => item.recommendedOption.amount <= remainingBudget + 1e-9);
    if (affordable) remainingBudget = money(remainingBudget - affordable.recommendedOption.amount);
    return {
      packageId: workPackage.id,
      dependsOn: workPackage.dependsOn ?? [],
      dependencyHandoff: workPackage.dependencyHandoff ? {
        ...summarizeDependencyHandoff({ ...workPackage.dependencyHandoff, external: true }),
        quoteStatus: affordable?.requestBindingVerified ? 'quoted_bound' : 'quote_binding_unverified',
        quoteBindingVerified: affordable?.requestBindingVerified === true
      } : null,
      title: workPackage.title,
      brief: workPackage.brief,
      acceptanceCriteria: workPackage.acceptanceCriteria,
      budgetCeiling: workPackage.budgetCeiling,
      quoteStatus: providerQuotes.some((item) => item.quoteReceived) ? 'quotes_received' : 'no_quote_received',
      providerQuotes: providerQuotes.map(({ providerMetadata, ...quote }) => quote),
      recommendation: affordable ? {
        provider: affordable.provider,
        providerName: affordable.providerName,
        price: affordable.recommendedOption.amount,
        currency: expectedCurrency,
        paymentTerms: affordable.recommendedOption.terms,
        paymentChallenge: affordable.paymentChallenge ?? null,
        quoteReceivedAt: affordable.quoteReceivedAt ?? null,
        providerEndpoint: affordable.providerEndpoint ?? null,
        a2aRequestPayload: affordable.a2aRequestPayload ?? null,
        status: 'candidate_pending_approval',
        selectionScore: affordable.selectionScore,
        selectionBreakdown: affordable.selectionBreakdown
      } : null,
      procurementStatus: !affordable
        ? 'no_eligible_quote'
        : 'recommended_requires_user_approval'
    };
  });

  const selectedSpend = money(packageResults.reduce((sum, item) => sum + (item.recommendation?.price ?? 0), 0));
  const allPackagesCovered = packageResults.every((item) => item.recommendation !== null);
  const recipientVerified = !recipientAudit.requiresManualVerification;
  if (!recipientVerified) {
    for (const item of packageResults) {
      if (item.recommendation) {
        // A price recommendation is not a payment recommendation. Keep the
        // comparison result visible, but quarantine it until routing is checked.
        item.procurementStatus = 'recipient_verification_required';
        item.recommendation.status = 'quarantined_pending_recipient_verification';
      }
    }
  }
  return {
    proposalId: `wr-proc-${plan.planId}`,
    sourcePlanId: plan.planId,
    status: allPackagesCovered && recipientVerified ? 'ready_for_user_approval' : 'incomplete_requires_review',
    budget: {
      amount: Number(plan.budget.amount),
      currency: expectedCurrency,
      recommendedSpend: selectedSpend,
      remainingAfterRecommendations: money(Number(plan.budget.amount) - selectedSpend)
    },
    pricing: {
      status: results.some((item) => item.quoteReceived) ? 'quotes_received' : 'no_quotes_received',
      allowedNetworks: [...allowedNetworks],
      allowedSchemes: ['exact'],
      allowedAssets,
      assetDecimals,
      note: allowedAssets.length && allowedNetworks.length
        ? 'Only exact-scheme quotes on explicitly configured network and per-network asset allowlists are eligible. No payment was sent.'
        : 'Quotes were requested, but no complete network and asset allowlist is configured. Payment terms remain review-only and cannot be recommended for purchase.',
      deferredPackageCount: deferredPackages.length,
      deferredQuotePolicy: deferredPackages.length ? 'Dependent packages are intentionally not quoted until upstream outputs pass evaluation and receive human acceptance. Their downstream brief must be requoted and approved after those outputs are available.' : null
    },
    packages: packageResults,
    deferredPackages: deferredPackages.map((item) => ({
      packageId: item.id, title: item.title, brief: item.brief, acceptanceCriteria: item.acceptanceCriteria,
      dependsOn: item.dependsOn ?? [], budgetCeiling: item.budgetCeiling,
      providerCandidates: item.providerCandidates ?? [], quoteStatus: 'deferred_until_dependencies_accepted',
      procurementStatus: 'fresh_quote_and_approval_required_after_handoff'
    })),
    recipientAudit,
    generatedAt: new Date().toISOString(),
    execution: { hiringStarted: false, paymentsAuthorized: false, paymentSent: false },
    approval: { required: true, status: 'not_requested', approvalToken: null },
    nextAction: !allPackagesCovered ? 'review_quotes_or_find_more_providers' : !recipientVerified ? 'verify_shared_payment_recipient_before_approval' : 'present_for_explicit_user_approval'
  };
}

export function validateProcurementProposal(proposal) {
  const errors = [];
  if (!proposal || !Array.isArray(proposal.packages)) return { valid: false, errors: ['proposal.packages must be an array'] };
  if (proposal.budget.recommendedSpend - proposal.budget.amount > 1e-9) errors.push('Recommended spend exceeds total project budget');
  for (const item of proposal.packages) {
    if (item.recommendation && item.recommendation.price - item.budgetCeiling > 1e-9) errors.push(`Package ${item.packageId} recommendation exceeds its ceiling`);
    if (item.recommendation?.paymentChallenge && (item.recommendation.paymentChallenge.x402Version !== 2 || !selectedRequirementMatches(item.recommendation.paymentChallenge, item.recommendation.paymentTerms))) errors.push(`Package ${item.packageId} payment terms are not bound to its original x402 v2 challenge`);
    if (item.dependencyHandoff) {
      if (item.dependencyHandoff.external !== true || item.dependencyHandoff.immutable !== true) errors.push(`Package ${item.packageId} has an invalid dependency handoff boundary`);
      if (item.dependencyHandoff.packageId !== item.packageId) errors.push(`Package ${item.packageId} dependency handoff identifies a different package`);
      if (item.dependencyHandoff.quoteStatus !== 'quoted_bound' || item.dependencyHandoff.quoteBindingVerified !== true) errors.push(`Package ${item.packageId} dependency handoff does not have a quote bound to its exact request`);
      if (item.dependencyHandoff.briefHash !== sha256(item.brief ?? '')) errors.push(`Package ${item.packageId} downstream brief no longer matches its dependency handoff hash`);
      if (!verifyA2ARequestContainsBrief(item.recommendation?.a2aRequestPayload, item.brief)) errors.push(`Package ${item.packageId} quote request does not contain the exact dependency-bound brief`);
      if (!Array.isArray(item.dependencyHandoff.sourceManifest) || !item.dependencyHandoff.sourceManifest.length || !item.dependencyHandoff.sourceManifest.every((source) => source.acceptanceStatus === 'accepted' && source.evaluationPassed === true && /^[a-f0-9]{64}$/i.test(source.contentHash))) errors.push(`Package ${item.packageId} has an invalid accepted dependency source manifest`);
    }
    for (const providerQuote of item.providerQuotes) {
      for (const option of providerQuote.quoteOptions) {
        if (option.eligible && (!option.terms.valid || !option.withinPackageCeiling)) errors.push(`Package ${item.packageId} contains an incorrectly eligible quote`);
      }
    }
  }
  if (proposal.recipientAudit?.requiresManualVerification && proposal.status === 'ready_for_user_approval') {
    errors.push('Proposal cannot be ready for approval while shared payment recipients remain unverified');
  }
  if (proposal.recipientAudit?.requiresManualVerification) {
    for (const item of proposal.packages) {
      if (item.recommendation && item.procurementStatus !== 'recipient_verification_required') {
        errors.push(`Package ${item.packageId} recommendation is not quarantined despite shared recipient risk`);
      }
      if (item.recommendation && item.recommendation.status !== 'quarantined_pending_recipient_verification') {
        errors.push(`Package ${item.packageId} recommendation status does not reflect recipient quarantine`);
      }
    }
  }
  if (proposal.execution?.hiringStarted !== false || proposal.execution?.paymentsAuthorized !== false || proposal.execution?.paymentSent !== false) {
    errors.push('Procurement proposal must not hire providers or send payment');
  }
  if (proposal.approval?.required !== true || proposal.approval?.status !== 'not_requested') errors.push('Proposal must remain behind explicit user approval');
  const activeIds = new Set(proposal.packages.map((item) => item.packageId));
  for (const deferred of proposal.deferredPackages ?? []) {
    if (!deferred.packageId || !Array.isArray(deferred.dependsOn) || !deferred.dependsOn.length) errors.push('Deferred packages must include an id and at least one dependency');
    if (activeIds.has(deferred.packageId)) errors.push(`Deferred package ${deferred.packageId} must not also appear in the active quote set`);
    if (deferred.quoteStatus !== 'deferred_until_dependencies_accepted') errors.push(`Deferred package ${deferred.packageId} has an invalid quote status`);
  }
  return { valid: errors.length === 0, errors };
}
