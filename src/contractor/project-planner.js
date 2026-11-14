import { rankAgents, summarizeAgentMatch } from './match-agents.js';
import { validateDependencyGraph } from '../orchestration/dependency-handoff.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const roundMoney = (value) => Math.round(value * 100) / 100;

/**
 * Produce an explainable work breakdown for common research/report requests.
 * This is deliberately deterministic: it does not pretend an LLM has inferred
 * requirements that are not present in the user's brief.
 */
export function decomposeObjective(objective) {
  if (typeof objective !== 'string' || !objective.trim()) {
    throw new TypeError('objective must be a non-empty string');
  }

  const text = objective.toLowerCase();
  const packages = [];
  const marketResearch = /market|industry|sector|demand|customer|entry/.test(text);
  const competitor = /competitor|competition|competitive|rival|positioning/.test(text);
  const analysis = /analys|evaluate|compare|assessment|opportunit|recommend/.test(text);
  const report = /report|memo|brief|document|strategy|recommendation/.test(text);

  if (marketResearch || competitor) {
    packages.push({
      id: 'evidence-gathering',
      title: 'Evidence gathering',
      brief: `Gather current, source-backed evidence relevant to this objective: ${objective.trim()}. Prioritise primary sources, record source URLs, and distinguish verified facts from estimates.`,
      capabilityQuery: marketResearch ? 'market research data collection' : 'web research evidence gathering',
      weight: 0.4,
      acceptanceCriteria: ['Relevant evidence is organised by theme', 'Factual claims have traceable source URLs', 'Evidence gaps and estimates are explicitly labelled']
    });
  }

  if (competitor) {
    packages.push({
      id: 'competitor-mapping',
      title: 'Competitor mapping',
      brief: `Identify and compare relevant competitors for this objective: ${objective.trim()}. Capture positioning, products, target customers and differentiators, with sources.`,
      capabilityQuery: 'competitor analysis competitive positioning',
      weight: 0.3,
      acceptanceCriteria: ['Competitors are named with supporting sources', 'Comparison uses consistent dimensions', 'Unknown or unverified details are not presented as facts']
    });
  }

  if (analysis || report || packages.length === 0) {
    packages.push({
      id: 'synthesis-and-recommendations',
      title: report ? 'Analysis and report synthesis' : 'Analysis and recommendations',
      brief: `Analyse the findings needed to fulfil this objective: ${objective.trim()}. Explain implications, assumptions, limitations and practical recommendations. Do not invent evidence.`,
      capabilityQuery: 'research analysis business recommendations report writing',
      weight: packages.length ? 0.3 : 1,
      dependsOn: packages.map((item) => item.id),
      acceptanceCriteria: ['Conclusions are supported by supplied evidence', 'Assumptions and limitations are explicit', 'Output directly addresses the original objective']
    });
  }

  // Normalize weights to exactly 1, including for combinations not anticipated above.
  const total = packages.reduce((sum, item) => sum + item.weight, 0);
  return packages.map((item) => ({ ...item, weight: item.weight / total }));
}

/**
 * Create a proposed project plan. Budget allocations are ceilings, not quotes.
 * Provider prices are intentionally left unquoted until a marketplace quote is
 * retrieved for the exact package brief.
 */
export function createProjectPlan({ objective, budget, currency = 'USDC', agents = [], maxProvidersPerPackage = 3 }) {
  if (typeof objective !== 'string' || !objective.trim()) throw new TypeError('objective must be a non-empty string');
  const amount = Number(budget);
  if (!Number.isFinite(amount) || amount <= 0) throw new RangeError('budget must be a positive number');
  if (!Array.isArray(agents)) throw new TypeError('agents must be an array');

  const workPackages = decomposeObjective(objective).map((workPackage) => {
    const matches = rankAgents(agents, workPackage.capabilityQuery, { limit: maxProvidersPerPackage, context: objective });
    const eligible = matches.filter((match) => match.eligibleForShortlist);
    const cap = roundMoney(amount * workPackage.weight);
    return {
      ...workPackage,
      dependsOn: workPackage.dependsOn ?? [],
      budgetCeiling: cap,
      quoteStatus: 'not_requested',
      quotedPrice: null,
      providerCandidates: eligible.map(summarizeAgentMatch),
      providerSelectionStatus: eligible.length ? 'requires_quote_and_user_approval' : 'no_eligible_provider_found'
    };
  });

  const allocated = roundMoney(workPackages.reduce((sum, item) => sum + item.budgetCeiling, 0));
  // Correct floating-point/rounding residue on the final package so allocations
  // never exceed the user's budget.
  const residue = roundMoney(amount - allocated);
  if (workPackages.length) workPackages[workPackages.length - 1].budgetCeiling = roundMoney(workPackages.at(-1).budgetCeiling + residue);

  const packagesWithCandidates = workPackages.filter((item) => item.providerCandidates.length).length;
  return {
    planId: `wr-${Date.now().toString(36)}`,
    status: 'draft_requires_user_approval',
    objective: objective.trim(),
    budget: { amount: roundMoney(amount), currency, allocatedCeilings: roundMoney(amount), unallocated: 0 },
    pricing: { status: 'unquoted', note: 'Provider discovery does not expose a confirmed price. Budget ceilings are not quotes; obtain exact quotes before asking for approval to hire.' },
    execution: { hiringStarted: false, paymentsAuthorized: false },
    workPackages,
    coverage: { totalPackages: workPackages.length, packagesWithCandidates, packagesWithoutCandidates: workPackages.length - packagesWithCandidates },
    nextAction: 'request_provider_quotes'
  };
}

export function validateProjectPlan(plan) {
  const errors = [];
  if (!plan || !Array.isArray(plan.workPackages)) return { valid: false, errors: ['plan.workPackages must be an array'] };
  const budget = Number(plan.budget?.amount);
  const allocated = plan.workPackages.reduce((sum, item) => sum + Number(item.budgetCeiling || 0), 0);
  if (!Number.isFinite(budget) || budget <= 0) errors.push('Project budget must be positive');
  if (allocated - budget > 0.000001) errors.push('Work-package ceilings exceed the project budget');
  for (const item of plan.workPackages) {
    if (!item.id || !item.brief || !Array.isArray(item.acceptanceCriteria)) errors.push(`Work package ${item.id ?? '(unknown)'} is missing required planning fields`);
    if (item.quotedPrice !== null) errors.push(`Work package ${item.id} must not contain an unverified quoted price`);
  }
  errors.push(...validateDependencyGraph(plan.workPackages).errors);
  if (plan.execution?.hiringStarted !== false || plan.execution?.paymentsAuthorized !== false) errors.push('Draft plan must not start hiring or authorize payments');
  return { valid: errors.length === 0, errors, allocatedBudget: roundMoney(allocated), remainingBudget: roundMoney(budget - allocated) };
}
