import { summarizePaymentAudit } from './execution-bridge.js';

const quote = (text) => String(text).split('\n').map((line) => `> ${line}`).join('\n');
const cell = (v) => String(v ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * Consolidated report from REAL provider deliverables with per-section provenance.
 * WorkRelay adds no facts: provider text is quoted verbatim and labelled as an unverified provider
 * assertion. WorkRelay's own contribution is limited to structure, status and audit information.
 */
export function buildProvenanceReport(execution) {
  const audit = summarizePaymentAudit(execution);
  const all = execution.packages;
  const accepted = all.filter((p) => p.acceptance.status === 'accepted');
  const complete = accepted.length === all.length;
  const lines = [];
  lines.push(`# WorkRelay project report — ${complete ? 'all packages accepted' : 'PROVISIONAL (incomplete)'}`, '');
  lines.push(`**Mode:** ${execution.mode === 'live_a2a_x402' ? 'LIVE — real NEAR Agent Market provider tasks' : String(execution.mode ?? 'unspecified')}  `);
  lines.push(`**Execution:** ${execution.executionId} · **Status:** ${execution.status}  `);
  if (execution.objective) lines.push(`**Objective:** ${execution.objective}  `);
  lines.push(`**Approved by:** ${execution.approval?.approvedBy ?? '—'} at ${execution.approval?.approvedAt ?? '—'} (cap ${execution.approval?.maxSpend} ${execution.approval?.currency})`, '');
  lines.push('## Trust statement', '');
  lines.push('- **Verified evidence:** none. WorkRelay performed no independent fact-checking, URL fetching or source validation.');
  lines.push('- **Provider assertions:** everything under "Provider deliverable" below was written by an external agent and is untrusted.');
  lines.push('- **WorkRelay-generated content:** only this structure, the status tables and the audit data. No analysis or conclusions were added.');
  lines.push('- **Structural evaluation** checks that criteria are represented and that sources are cited. It does not check that statements are true.', '');
  lines.push('## Execution summary', '');
  lines.push('| Package | Provider | Task ID | Delivery | Structural check | Human acceptance | Payment audit |', '|---|---|---|---|---|---|---|');
  for (const item of all) {
    const row = audit.rows.find((r) => r.packageId === item.packageId);
    lines.push(`| ${cell(item.title)} | ${cell(item.providerName ?? item.provider)} | ${cell(item.commissioning.taskId)} | ${cell(item.delivery.status)} | ${cell(item.evaluation.status)} | ${cell(item.acceptance.status)} | ${cell(row.state)} |`);
  }
  lines.push('', `**Budget position:** approved ${audit.budget.maxApproved}, committed ${audit.budget.committed}, reserved ${audit.budget.reserved}, available ${audit.budget.available} ${execution.approval?.currency ?? ''}. Confirmed settlements: ${audit.confirmedSettledCount}/${all.length}.`, '');
  for (const item of all) {
    const row = audit.rows.find((r) => r.packageId === item.packageId);
    lines.push(`## ${item.title}`, '');
    lines.push(`- **Provider:** ${item.provider} · **Task:** ${item.commissioning.taskId ?? 'not commissioned'} · **Retrieved:** ${item.delivery.receivedAt ?? '—'}`);
    lines.push(`- **Content hash (SHA-256):** ${item.delivery.contentHash ?? '—'}`);
    for (const artifact of item.delivery.artifacts ?? []) lines.push(`- **Artifact** ${artifact.id} (${artifact.kind}, ${artifact.bytes} bytes, ${artifact.contentHash.slice(0, 12)}…)${artifact.warnings.length ? ` ⚠ ${artifact.warnings.join(', ')}` : ''}`);
    lines.push(`- **Payment audit:** ${row.state} — ${row.note}`);
    if ((item.dependsOn ?? []).length) lines.push(`- **Depends on:** ${item.dependsOn.join(', ')}. The provider was NOT given upstream deliverables: its paid request was fixed at quote time, so this output is independent of them.`);
    lines.push('', '**Acceptance criteria**', '');
    if (item.evaluation.criterionResults.length) {
      for (const r of item.evaluation.criterionResults) lines.push(`- ${r.passed ? '✅' : '❌'} ${r.criterion}${r.passed ? ` — ${r.evidence}` : ` — ${r.reason}`}`);
      if (item.evaluation.limitation) lines.push('', `_${item.evaluation.limitation}_`);
    } else lines.push(...item.acceptanceCriteria.map((c) => `- ⏳ ${c} (not evaluated)`));
    lines.push('', `**Human review:** ${item.acceptance.status === 'accepted' ? `accepted by ${item.acceptance.acceptedBy} at ${item.acceptance.acceptedAt}` : item.acceptance.status}`, '');
    if (item.delivery.content) {
      lines.push('### Provider deliverable (unverified provider assertion)', '', quote(item.delivery.content), '');
    } else lines.push(`_No deliverable is available (${item.delivery.status})._`, '');
  }
  lines.push('## Known limitations', '');
  lines.push('- Settlement is only reported as confirmed where an explicit transaction reference was recorded.');
  lines.push('- x402 payments auto-accept at provider delivery: WorkRelay review happens after that point and cannot hold or reverse payment.');
  if (!complete) lines.push(`- ${all.length - accepted.length} of ${all.length} package(s) are not human-accepted; this report must not be treated as final.`);
  return { markdown: lines.join('\n'), complete, packagesAccepted: accepted.length, packagesTotal: all.length };
}
