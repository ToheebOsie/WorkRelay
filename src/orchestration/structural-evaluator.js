const STOP = new Set(['are','is','the','and','with','that','this','from','have','has','their','them','not','for','all','any','into','used','uses','using','than','when','were','was','been','being','also','such','they','its','our','your','who']);
const URL_RE = /https?:\/\/[^\s)>\]"']+/gi;
const stem = (word) => word.slice(0, 5);
const tokens = (text) => [...new Set((text.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? []).filter((w) => !STOP.has(w)).map(stem))];

/**
 * Deterministic STRUCTURAL evaluator. It checks that each acceptance criterion is represented in
 * the deliverable (term coverage) and that criteria asking for sources are backed by URLs.
 * It does NOT verify that any claim is true, that URLs resolve, or that sources support the text.
 */
export function createStructuralEvaluator({ minCoverage = 0.6, minChars = 200 } = {}) {
  return async function evaluate({ acceptanceCriteria = [], deliverable = '' }) {
    const text = String(deliverable);
    const lower = text.toLowerCase();
    const urls = [...new Set(text.match(URL_RE) ?? [])];
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const criterionResults = acceptanceCriteria.map((criterion) => {
      const wanted = tokens(criterion);
      const hits = wanted.filter((t) => lower.includes(t));
      const coverage = wanted.length ? hits.length / wanted.length : 0;
      const needsSources = /\b(source|sources|url|urls|cite|cited|citation|citations|reference|references|traceable)\b/i.test(criterion);
      const reasons = [];
      if (text.trim().length < minChars) reasons.push(`Deliverable is shorter than ${minChars} characters`);
      if (coverage < minCoverage) reasons.push(`Only ${hits.length}/${wanted.length} key terms of the criterion appear in the deliverable`);
      if (needsSources && urls.length === 0) reasons.push('Criterion asks for sources but no URLs were supplied');
      const passed = reasons.length === 0;
      const bestLine = lines.map((line) => ({ line, score: hits.filter((t) => line.toLowerCase().includes(t)).length })).sort((a, b) => b.score - a.score)[0];
      const evidence = passed
        ? `Terms present (${hits.length}/${wanted.length})${needsSources ? `; ${urls.length} URL(s) supplied (not fetched or verified)` : ''}${bestLine?.score ? `; closest passage: "${bestLine.line.slice(0, 160)}"` : ''}`
        : (hits.length ? `Partial coverage (${hits.length}/${wanted.length} terms)` : '');
      return { criterion, passed, evidence, reason: passed ? '' : reasons.join('; ') };
    });
    return {
      criterionResults,
      limitation: 'Structural check only: term coverage and URL presence. No factual accuracy, source validity or reasoning quality was verified.',
      signals: { characters: text.length, urlCount: urls.length, urlsSupplied: urls.slice(0, 50) }
    };
  };
}
