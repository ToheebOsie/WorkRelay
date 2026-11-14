const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'get', 'i', 'in', 'into', 'is', 'it', 'me', 'of', 'on', 'or', 'our', 'please', 'the', 'to', 'we', 'with', 'you', 'your']);

function tokens(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9+#.-]+/g, ' ')
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1 && !STOP_WORDS.has(part));
}

function unique(values) {
  return [...new Set(values)];
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function textRelevance(agent, query) {
  const queryTokens = unique(tokens(query));
  if (!queryTokens.length) return { score: 0, matched: [] };

  const name = tokens(agent.name).join(' ');
  const category = tokens(agent.category).join(' ');
  const tags = tokens((agent.tags ?? []).join(' ')).join(' ');
  const description = tokens(`${agent.description ?? ''} ${agent.bio_markdown ?? ''}`).join(' ');
  const searchable = `${name} ${category} ${tags} ${description}`;
  const matched = queryTokens.filter((term) => searchable.includes(term));

  // Category and tags are stronger evidence than incidental bio mentions.
  const weightedMatches = queryTokens.reduce((total, term) => {
    if (` ${category} `.includes(` ${term} `)) return total + 2.5;
    if (` ${tags} `.includes(` ${term} `)) return total + 2;
    if (` ${name} `.includes(` ${term} `)) return total + 1.5;
    if (` ${description} `.includes(` ${term} `)) return total + 1;
    return total;
  }, 0);

  return { score: clamp(weightedMatches / (queryTokens.length * 2)), matched };
}

function specializationFit(agent, query, context = '') {
  const profile = `${agent.name ?? ''} ${agent.description ?? ''} ${(agent.tags ?? []).join(' ')} ${agent.bio_markdown ?? ''}`.toLowerCase();
  const task = `${query} ${context}`.toLowerCase();
  const exclusions = [
    { label: 'family-history specialization does not match commercial research', pattern: /family history|genealog|ancestry|archive research/, taskPattern: /fintech|market entry|competitor|business|commercial|industry/ },
    { label: 'regional specialization does not match the requested market', pattern: /us hispanic|latin america|latam|vietnamese market|japanese market|indian market/, taskPattern: /kenya|kenyan|east africa|africa/ }
  ];
  const mismatch = exclusions.find((rule) => rule.pattern.test(profile) && rule.taskPattern.test(task));
  if (mismatch) return { score: 0, eligible: false, reason: mismatch.label };
  return { score: 1, eligible: true, reason: null };
}

function reliability(agent) {
  const jobs = Math.max(0, Number(agent.delivered_jobs) || 0);
  const rawRate = Number(agent.success_rate);
  if (!Number.isFinite(rawRate)) return { score: 0.5, known: false, adjustedRate: null };

  // Shrink tiny samples toward a neutral 70% prior. This prevents 1/1 or 2/2
  // from outranking providers with a meaningful track record automatically.
  const priorJobs = 3;
  const adjustedRate = ((clamp(rawRate / 100) * jobs) + (0.7 * priorJobs)) / (jobs + priorJobs);
  return { score: adjustedRate, known: true, adjustedRate };
}

function slaScore(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return 0.5;
  if (value <= 900) return 1;
  if (value <= 3600) return 0.9;
  if (value <= 21600) return 0.75;
  if (value <= 86400) return 0.6;
  return 0.35;
}

/**
 * Rank live marketplace providers for a task. Scores are decision support,
 * not a guarantee of quality; each result includes reasons and caveats.
 */
export function rankAgents(agents, query, { limit = 10, context = '' } = {}) {
  if (!Array.isArray(agents)) throw new TypeError('agents must be an array');
  if (typeof query !== 'string' || !query.trim()) throw new TypeError('query must be a non-empty string');

  return agents.map((agent) => {
    const relevance = textRelevance(agent, query);
    const specialization = specializationFit(agent, query, context);
    const reliabilityResult = reliability(agent);
    const live = agent.listing_status === 'live';
    const availableNow = agent.available_now === true;
    const available = agent.availability === 'available';
    const funded = agent.funding_paused !== true;
    const verified = ['verified', 'identity_verified'].includes(agent.builder?.verification?.level);

    const components = {
      relevance: relevance.score * 30,
      specializationFit: specialization.score * 10,
      liveListing: live ? 8 : 0,
      availableNow: availableNow ? 8 : 0,
      availability: available ? 4 : 0,
      funding: funded ? 7 : 0,
      reliability: reliabilityResult.score * 15,
      experience: Math.min(1, Math.log1p(Math.max(0, Number(agent.delivered_jobs) || 0)) / Math.log(21)) * 5,
      verification: verified ? 8 : 0,
      sla: slaScore(agent.sla_seconds) * 5
    };
    const score = Math.round(Object.values(components).reduce((sum, value) => sum + value, 0) * 10) / 10;

    const reasons = [];
    const caveats = [];
    if (relevance.matched.length) reasons.push(`Capability match: ${relevance.matched.join(', ')}`);
    if (specialization.reason) caveats.push(specialization.reason);
    if (availableNow) reasons.push('Marked available now by the marketplace');
    if (verified) reasons.push(`Builder verification: ${agent.builder.verification.level}`);
    if (Number(agent.delivered_jobs) > 0) reasons.push(`${agent.delivered_jobs} delivered jobs recorded`);
    if (!live) caveats.push('Listing is not marked live');
    if (!availableNow) caveats.push('Not marked available now');
    if (!funded) caveats.push('Funding is paused');
    if (!Number(agent.delivered_jobs)) caveats.push('No completed-job history recorded');
    if (!reliabilityResult.known) caveats.push('No success-rate history recorded');
    if (!verified) caveats.push('Builder is not marked identity-verified/verified');
    if (agent.input_schema == null) caveats.push('No input schema published; task brief may need manual adaptation');

    return {
      agent,
      score,
      components: Object.fromEntries(Object.entries(components).map(([key, value]) => [key, Math.round(value * 10) / 10])),
      matchedTerms: relevance.matched,
      adjustedSuccessRate: reliabilityResult.adjustedRate == null ? null : Math.round(reliabilityResult.adjustedRate * 1000) / 10,
      reasons,
      caveats,
      capabilityFit: specialization.eligible ? 'compatible' : 'mismatch',
      eligibleForShortlist: live && available && funded && relevance.score >= 0.12 && specialization.eligible
    };
  })
    .sort((a, b) => Number(b.eligibleForShortlist) - Number(a.eligibleForShortlist) || b.score - a.score)
    .slice(0, limit);
}

export function summarizeAgentMatch(match) {
  const agent = match.agent;
  return {
    handle: agent.handle,
    name: agent.name,
    category: agent.category,
    description: agent.description,
    score: match.score,
    capabilityFit: match.capabilityFit,
    availableNow: agent.available_now === true,
    availability: agent.availability,
    deliveredJobs: agent.delivered_jobs,
    reportedSuccessRate: agent.success_rate,
    adjustedSuccessRate: match.adjustedSuccessRate,
    slaSeconds: agent.sla_seconds,
    paymentMethods: agent.payable_with ?? [],
    verification: agent.builder?.verification?.level ?? 'unknown',
    inputSchema: agent.input_schema,
    outputSchema: agent.output_schema,
    eligibleForShortlist: match.eligibleForShortlist,
    reasons: match.reasons,
    caveats: match.caveats,
    scoreBreakdown: match.components
  };
}
