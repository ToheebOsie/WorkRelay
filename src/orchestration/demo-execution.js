import { createHash, randomUUID } from 'node:crypto';
import { buildDependencyBoundRequest } from './dependency-handoff.js';
import { buildDemoEvidencePacket } from '../evidence/evidence-pipeline.js';
import { sha256Canonical } from '../contracts/schema.js';

const now = () => new Date().toISOString();
const clone = (value) => structuredClone(value);
const SIMULATION_LABEL = 'SIMULATED — no provider, wallet, or funds involved';
const MIN_OVERRIDE_REASON = 20;
const MAX_OVERRIDE_REASON = 1000;
// Used only by the scripted "success" branch, which has no human in the loop.
const SUCCESS_BRANCH_OVERRIDE = Object.freeze({
  reviewer: Object.freeze({ kind: 'system', id: 'workrelay-demo-success-branch' }),
  reason: 'Scripted demo branch: the deliberately failing source fixture is overridden so the dependency handoff can be demonstrated. This is not a real review.'
});

/**
 * Evidence gate for acceptance. Acceptance is allowed without an override only
 * when BOTH the deterministic evidence verification and the evidence-quality
 * policy report `complete` for the exact packet attached to the deliverable.
 */
export function assessEvidenceGate(pkg) {
  const packet = pkg?.evidencePacket ?? null;
  const verificationStatus = packet?.verification?.status ?? 'missing';
  const qualityStatus = packet?.qualityEvaluation?.status ?? 'missing';
  return {
    passed: verificationStatus === 'complete' && qualityStatus === 'complete',
    verificationStatus,
    qualityStatus,
    packetDigest: packet?.digest ?? null
  };
}

function normalizeEvidenceOverride(value, gate) {
  const reason = typeof value?.reason === 'string' ? value.reason.trim() : '';
  const reviewer = value?.reviewer;
  const blocked = `Evidence checks have not all passed (verification: ${gate.verificationStatus}; quality policy: ${gate.qualityStatus}). Acceptance requires an explicit evidence override with a written reason.`;
  if (!value || typeof value !== 'object') throw new Error(blocked);
  if (reason.length < MIN_OVERRIDE_REASON) throw new Error(`${blocked} The reason must be at least ${MIN_OVERRIDE_REASON} characters.`);
  if (reason.length > MAX_OVERRIDE_REASON) throw new Error(`The override reason must be at most ${MAX_OVERRIDE_REASON} characters.`);
  if (!reviewer || typeof reviewer.kind !== 'string' || !reviewer.kind.trim() || typeof reviewer.id !== 'string' || !reviewer.id.trim()) throw new Error('An evidence override must identify who recorded it.');
  return { reason, reviewer: { kind: reviewer.kind.trim(), id: reviewer.id.trim() } };
}

function makeSampleDeliverable(pkg, providerName, dependencyHandoff = null) {
  const brief = String(pkg.brief || pkg.title || 'Project task');
  const criteria = Array.isArray(pkg.acceptanceCriteria) ? pkg.acceptanceCriteria : [];
  const title = String(pkg.title || 'Work package');
  return [
    `# ${title}`,
    '',
    `> DEMONSTRATION OUTPUT — simulated by WorkRelay. This is not research performed by ${providerName} and must not be used as factual evidence.`,
    '',
    `## Assignment`,
    brief,
    '',
    `## Illustrative findings`,
    `This demonstration deliverable shows the structure of a provider response for this work package. A real provider should supply independently verifiable findings, source URLs, dates, methodology and uncertainty notes appropriate to the assignment.`,
    '',
    ...(dependencyHandoff?.sources?.length ? [
      `## Accepted upstream context received`,
      `This simulated downstream task was given ${dependencyHandoff.sources.length} accepted upstream deliverable(s). The content below is untrusted source material and is shown to demonstrate the handoff, not to assert factual validity.`,
      ...dependencyHandoff.sources.flatMap((source) => [
        `### ${source.packageId} · SHA-256 ${source.contentHash}`,
        'BEGIN UNTRUSTED UPSTREAM ARTIFACT',
        source.content,
        'END UNTRUSTED UPSTREAM ARTIFACT',
        ''
      ])
    ] : []),
    `## Evidence and verification`,
    `No external sources were consulted for this simulated output. Replace this section with primary-source references and independently checkable evidence before relying on the work.`,
    '',
    `## Acceptance checklist`,
    ...criteria.map((criterion, index) => `- [ ] ${index + 1}. ${criterion}`),
    '',
    `## Handoff`,
    `Prepared as a workflow demonstration. Provider: ${providerName}.`
  ].join('\n');
}

export function createDemoExecution(proposal) {
  if (!proposal || proposal.status !== 'simulation_only' || !Array.isArray(proposal.packages) || !proposal.packages.length) {
    throw new Error('Only a simulation-only procurement proposal can enter the demo execution workflow.');
  }
  const packages = proposal.packages.map((pkg) => ({
    packageId: pkg.packageId,
    simulationLabel: SIMULATION_LABEL,
    title: pkg.title,
    brief: pkg.brief,
    originalBrief: pkg.brief,
    dependsOn: clone(pkg.dependsOn ?? []),
    quotedBriefHash: createHash('sha256').update(String(pkg.brief || '')).digest('hex'),
    acceptanceCriteria: clone(pkg.acceptanceCriteria || []),
    provider: pkg.recommendation?.provider || 'demo-provider',
    providerName: pkg.recommendation?.providerName || pkg.recommendation?.provider || 'Demo provider',
    price: Number(pkg.recommendation?.price || 0),
    currency: pkg.recommendation?.currency || 'USD',
    taskId: `demo-task-${randomUUID()}`,
    status: 'queued',
    deliverable: null,
    contentHash: null,
    evidencePacket: null,
    simulatedDownstreamQuote: null,
    evaluation: { status: 'not_evaluated', results: [], passed: null },
    acceptance: { status: 'not_reviewed', acceptedAt: null }
  }));
  return {
    executionId: `demo-exec-${randomUUID()}`,
    proposalId: proposal.proposalId,
    mode: 'simulation_only',
    warning: 'Every provider task and deliverable in this execution is simulated. No external agent was hired and no payment occurred.',
    simulationLabel: SIMULATION_LABEL,
    sandbox: { scenario: 'default', status: 'not_started', settlement: 'not_applicable_simulation', resettable: true },
    status: 'queued',
    packages,
    createdAt: now(),
    updatedAt: now(),
    ledger: [{ at: now(), event: 'demo_execution_created', details: { packageCount: packages.length } }]
  };
}

export function runDemoExecution(execution) {
  if (!execution || execution.mode !== 'simulation_only') throw new Error('Simulation execution not found.');
  const byId = new Map(execution.packages.map((item) => [item.packageId, item]));
  const held = [];
  const executed = [];
  for (const pkg of execution.packages) {
    if (!['queued', 'queued_waiting_for_dependencies', 'queued_waiting_for_downstream_quote', 'queued_waiting_for_downstream_approval'].includes(pkg.status)) continue;
    const unmet = (pkg.dependsOn ?? []).filter((id) => {
      const source = byId.get(id);
      return !source || source.acceptance?.status !== 'accepted' || source.evaluation?.passed !== true;
    });
    if (unmet.length) {
      pkg.status = 'queued_waiting_for_dependencies';
      pkg.waitingOn = unmet;
      held.push({ packageId: pkg.packageId, waitingOn: unmet, reason: 'Upstream packages must pass evaluation and receive explicit human acceptance.' });
      continue;
    }

    if ((pkg.dependsOn ?? []).length && !pkg.simulatedDownstreamQuote) {
      pkg.status = 'queued_waiting_for_downstream_quote';
      pkg.waitingOn = ['fresh_simulated_downstream_quote_and_approval'];
      held.push({ packageId: pkg.packageId, waitingOn: pkg.waitingOn, reason: 'A dependent package requires a fresh simulated quote and separate approval after accepted upstream inputs.' });
      continue;
    }
    if ((pkg.dependsOn ?? []).length && pkg.simulatedDownstreamQuote.status !== 'approved') {
      pkg.status = 'queued_waiting_for_downstream_approval';
      pkg.waitingOn = ['separate_downstream_approval'];
      held.push({ packageId: pkg.packageId, waitingOn: pkg.waitingOn, reason: 'The fresh simulated downstream quote requires separate approval.' });
      continue;
    }

    const dependencyHandoff = (pkg.dependsOn ?? []).length
      ? buildDependencyBoundRequest({ workPackage: pkg, packageRecords: execution.packages })
      : null;
    pkg.dependencyInputs = dependencyHandoff ? dependencyHandoff.sourceManifest.map((source) => ({ ...source })) : [];
    pkg.dependencyHandoff = dependencyHandoff ? {
      inputBundleHash: dependencyHandoff.inputBundleHash,
      requestFingerprint: dependencyHandoff.requestFingerprint,
      sourceManifest: dependencyHandoff.sourceManifest,
      quoteStatus: 'not_applicable_simulation',
      approvalStatus: 'not_applicable_simulation',
      immutable: true
    } : null;
    pkg.executionBrief = dependencyHandoff?.brief ?? pkg.brief;
    pkg.status = 'simulated_provider_work';
    execution.ledger.push({ at: now(), event: 'simulated_provider_started', details: { packageId: pkg.packageId, provider: pkg.provider, dependencyInputs: pkg.dependencyInputs.map((item) => ({ packageId: item.packageId, contentHash: item.contentHash })) } });
    const content = makeSampleDeliverable({ ...pkg, brief: pkg.executionBrief }, pkg.providerName, dependencyHandoff);
    pkg.deliverable = content;
    pkg.contentHash = createHash('sha256').update(content).digest('hex');
    pkg.evidencePacket = buildDemoEvidencePacket({ jobId: execution.executionId, packageId: pkg.packageId, rawArtifact: content, createdAt: now() });
    pkg.status = 'delivered_pending_evaluation';
    pkg.waitingOn = [];
    execution.ledger.push({ at: now(), event: 'simulated_deliverable_received', details: { packageId: pkg.packageId, contentHash: pkg.contentHash, inputBundleHash: dependencyHandoff?.inputBundleHash ?? null } });
    executed.push(pkg.packageId);
  }
  const allAccepted = execution.packages.length > 0 && execution.packages.every((item) => item.status === 'accepted');
  const pendingReview = execution.packages.some((item) => ['delivered_pending_evaluation', 'awaiting_human_review', 'review_required'].includes(item.status));
  const queued = execution.packages.some((item) => ['queued', 'queued_waiting_for_dependencies', 'queued_waiting_for_downstream_quote', 'queued_waiting_for_downstream_approval'].includes(item.status));
  execution.status = allAccepted ? 'all_packages_accepted' : pendingReview ? 'deliverables_ready_for_review' : queued ? 'waiting_on_dependencies' : 'in_progress';
  execution.lastRun = { at: now(), executedPackageIds: executed, held };
  execution.updatedAt = now();
  execution.ledger.push({ at: now(), event: 'dependency_aware_simulation_batch_completed', details: { executedPackageIds: executed, held } });
  return execution;
}

/** Reset the in-memory sandbox to a replayable, no-wallet starting state. */
export function resetDemoExecution(execution) {
  if (!execution || execution.mode !== 'simulation_only') throw new Error('Simulation execution not found.');
  for (const pkg of execution.packages) {
    pkg.taskId = `demo-task-${randomUUID()}`;
    pkg.status = 'queued';
    pkg.waitingOn = [];
    pkg.deliverable = null;
    pkg.contentHash = null;
    pkg.evidencePacket = null;
    pkg.simulatedDownstreamQuote = null;
    pkg.dependencyInputs = [];
    pkg.dependencyHandoff = null;
    pkg.executionBrief = null;
    pkg.evaluation = { status: 'not_evaluated', results: [], passed: null };
    pkg.acceptance = { status: 'not_reviewed', acceptedAt: null };
  }
  execution.status = 'queued';
  execution.sandbox = { scenario: 'default', status: 'reset', settlement: 'not_applicable_simulation', resettable: true };
  execution.lastRun = null;
  execution.updatedAt = now();
  execution.ledger.push({ at: now(), event: 'demo_execution_reset', details: { simulationLabel: SIMULATION_LABEL } });
  return execution;
}

export function requestDemoDownstreamQuote(execution, packageId) {
  if (!execution || execution.mode !== 'simulation_only') throw new Error('Simulation execution not found.');
  const pkg = execution.packages.find((item) => item.packageId === packageId);
  if (!pkg) throw new Error('Unknown work package.');
  if (!(pkg.dependsOn ?? []).length) throw new Error('Only dependent packages require a downstream quote.');
  const ready = (pkg.dependsOn ?? []).every((id) => {
    const source = execution.packages.find((item) => item.packageId === id);
    return source?.acceptance?.status === 'accepted' && source?.evaluation?.passed === true;
  });
  if (!ready) throw new Error('Accepted upstream work is required before requesting a downstream quote.');
  const handoff = buildDependencyBoundRequest({ workPackage: pkg, packageRecords: execution.packages });
  const quote = {
    status: 'quoted_not_approved',
    simulationLabel: SIMULATION_LABEL,
    packageId,
    provider: pkg.provider,
    price: pkg.price,
    currency: pkg.currency,
    inputBundleHash: handoff.inputBundleHash,
    requestFingerprint: handoff.requestFingerprint,
    quotedAt: now(),
    freshQuote: true,
    paymentStatus: 'not_applicable_simulation'
  };
  pkg.simulatedDownstreamQuote = quote;
  pkg.status = 'queued_waiting_for_downstream_approval';
  pkg.waitingOn = ['separate_downstream_approval'];
  execution.ledger.push({ at: now(), event: 'simulated_downstream_quote_created', details: { packageId, inputBundleHash: quote.inputBundleHash, requestFingerprint: quote.requestFingerprint, simulationLabel: SIMULATION_LABEL } });
  execution.updatedAt = now();
  return quote;
}

export function approveDemoDownstreamQuote(execution, packageId) {
  if (!execution || execution.mode !== 'simulation_only') throw new Error('Simulation execution not found.');
  const pkg = execution.packages.find((item) => item.packageId === packageId);
  if (!pkg) throw new Error('Unknown work package.');
  const quote = pkg.simulatedDownstreamQuote;
  if (!quote || quote.status !== 'quoted_not_approved') throw new Error('A fresh simulated downstream quote is required before approval.');
  const handoff = buildDependencyBoundRequest({ workPackage: pkg, packageRecords: execution.packages });
  if (quote.inputBundleHash !== handoff.inputBundleHash || quote.requestFingerprint !== handoff.requestFingerprint) throw new Error('Accepted upstream inputs changed; request a fresh downstream quote.');
  quote.status = 'approved';
  quote.approvedAt = now();
  quote.approval = { confirmed: true, approvalType: 'separate_simulated_downstream_approval', proposalFingerprint: sha256Canonical({ packageId, inputBundleHash: quote.inputBundleHash, requestFingerprint: quote.requestFingerprint, price: quote.price, currency: quote.currency }) };
  pkg.status = 'queued';
  pkg.waitingOn = [];
  execution.ledger.push({ at: now(), event: 'simulated_downstream_quote_approved', details: { packageId, inputBundleHash: quote.inputBundleHash, requestFingerprint: quote.requestFingerprint, simulationLabel: SIMULATION_LABEL } });
  execution.updatedAt = now();
  return quote;
}

/** Run one judge-visible sandbox branch. Every branch remains simulated and non-settling. */
export function runDemoScenario(execution, scenario) {
  if (execution?.mode !== 'simulation_only') throw new Error('Simulation execution not found.');
  if (!['success', 'revision', 'refund_before_submission', 'unresolved_dispute'].includes(scenario)) throw new Error('Unsupported simulation scenario.');
  resetDemoExecution(execution);
  execution.sandbox.scenario = scenario;
  if (scenario === 'refund_before_submission') {
    for (const pkg of execution.packages) pkg.status = 'refund_available_before_submission';
    execution.status = 'refunded_before_submission';
    execution.sandbox.status = 'completed';
    execution.ledger.push({ at: now(), event: 'demo_refund_before_submission', details: { simulationLabel: SIMULATION_LABEL, paymentStatus: 'not_applicable_simulation' } });
    return execution;
  }

  if (scenario === 'revision') {
    runDemoExecution(execution);
    const first = execution.packages.find((pkg) => pkg.status === 'delivered_pending_evaluation');
    if (first) { evaluateDemoDeliverable(execution, first.packageId); if (first.status === 'awaiting_human_review') reviewDemoDeliverable(execution, first.packageId, 'request_revision'); }
    execution.status = 'revision_required';
    execution.sandbox.status = 'completed';
    execution.ledger.push({ at: now(), event: 'demo_revision_branch_completed', details: { simulationLabel: SIMULATION_LABEL } });
    return execution;
  }

  if (scenario === 'unresolved_dispute') {
    runDemoExecution(execution);
    const first = execution.packages.find((pkg) => pkg.status === 'delivered_pending_evaluation');
    if (first) {
      evaluateDemoDeliverable(execution, first.packageId);
      if (first.status === 'awaiting_human_review') {
        first.acceptance = { status: 'dispute_open', acceptedAt: null };
        first.status = 'disputed_unresolved';
        execution.ledger.push({ at: now(), event: 'demo_dispute_opened', details: { packageId: first.packageId, resolver: 'manual-review', simulationLabel: SIMULATION_LABEL } });
      }
    }
    execution.status = 'unresolved_dispute';
    execution.sandbox.status = 'completed';
    return execution;
  }

  let progress = true;
  let rounds = 0;
  while (progress && rounds++ <= execution.packages.length + 1) {
    progress = false;
    runDemoExecution(execution);
    for (const pkg of execution.packages) {
      if (pkg.status === 'queued_waiting_for_downstream_quote') {
        requestDemoDownstreamQuote(execution, pkg.packageId);
        approveDemoDownstreamQuote(execution, pkg.packageId);
        progress = true;
      }
    }
    for (const pkg of execution.packages) {
      if (pkg.status === 'delivered_pending_evaluation') { evaluateDemoDeliverable(execution, pkg.packageId); progress = true; }
      if (pkg.status === 'awaiting_human_review') {
        reviewDemoDeliverable(execution, pkg.packageId, 'accept', assessEvidenceGate(pkg).passed ? {} : { evidenceOverride: SUCCESS_BRANCH_OVERRIDE });
        progress = true;
      }
    }
  }
  const overrides = execution.packages.filter((pkg) => pkg.acceptance?.evidenceGate?.status === 'overridden').length;
  if (execution.packages.every((pkg) => pkg.status === 'accepted')) execution.status = overrides ? 'success_with_evidence_overrides' : 'success_all_packages_accepted';
  execution.sandbox.status = 'completed';
  execution.sandbox.evidenceOverrides = overrides;
  execution.ledger.push({ at: now(), event: 'demo_success_branch_completed', details: { simulationLabel: SIMULATION_LABEL, paymentStatus: 'not_applicable_simulation', evidenceOverrides: overrides } });
  return execution;
}


function refreshDemoExecutionStatus(execution) {
  const allAccepted = execution.packages.length > 0 && execution.packages.every((item) => item.status === 'accepted');
  const pendingReview = execution.packages.some((item) => ['delivered_pending_evaluation', 'awaiting_human_review', 'review_required'].includes(item.status));
  const queued = execution.packages.some((item) => ['queued', 'queued_waiting_for_dependencies', 'queued_waiting_for_downstream_quote', 'queued_waiting_for_downstream_approval'].includes(item.status));
  execution.status = allAccepted ? 'all_packages_accepted' : pendingReview ? 'deliverables_ready_for_review' : queued ? 'waiting_on_dependencies' : 'in_progress';
  execution.updatedAt = now();
}

export function evaluateDemoDeliverable(execution, packageId) {
  if (execution?.mode !== 'simulation_only') throw new Error('Simulation execution not found.');
  const pkg = execution.packages.find((item) => item.packageId === packageId);
  if (!pkg) throw new Error('Unknown work package.');
  if (pkg.status !== 'delivered_pending_evaluation') throw new Error('Package is not awaiting evaluation.');
  // The simulation checks structural completeness only. It deliberately does not
  // claim factual accuracy, source validity or substantive quality.
  const results = [
    { criterion: 'Deliverable is present', passed: Boolean(pkg.deliverable && pkg.deliverable.length >= 100), evidence: `${pkg.deliverable?.length || 0} characters returned` },
    { criterion: 'Simulation disclosure is present', passed: pkg.deliverable.includes('DEMONSTRATION OUTPUT'), evidence: 'Disclosure marker inspected' },
    { criterion: 'Acceptance criteria are represented', passed: pkg.acceptanceCriteria.every((criterion) => pkg.deliverable.includes(criterion)), evidence: `${pkg.acceptanceCriteria.length} acceptance criteria included in checklist` }
  ];
  pkg.evaluation = { status: results.every((r) => r.passed) ? 'structural_checks_passed' : 'review_required', results, passed: results.every((r) => r.passed), evaluatedAt: now(), limitation: 'Structural checks only; no factual accuracy or source verification was performed.' };
  pkg.status = pkg.evaluation.passed ? 'awaiting_human_review' : 'review_required';
  execution.ledger.push({ at: now(), event: 'demo_structural_evaluation_completed', details: { packageId, passed: pkg.evaluation.passed } });
  refreshDemoExecutionStatus(execution);
  return execution;
}

/**
 * Record a human decision. Acceptance is gated on the evidence checks: if either
 * evidence layer is not `complete`, acceptance is refused unless the caller supplies
 * `options.evidenceOverride = { reason, reviewer }`. The override is bound to the
 * exact packet digest and is stored on the acceptance record and in the ledger.
 */
export function reviewDemoDeliverable(execution, packageId, decision, options = {}) {
  if (execution?.mode !== 'simulation_only') throw new Error('Simulation execution not found.');
  const pkg = execution.packages.find((item) => item.packageId === packageId);
  if (!pkg) throw new Error('Unknown work package.');
  if (pkg.status !== 'awaiting_human_review') throw new Error('Run the structural evaluation successfully before human review.');
  if (!['accept', 'request_revision'].includes(decision)) throw new Error('Decision must be accept or request_revision.');
  if (decision === 'request_revision') {
    pkg.acceptance = { status: 'revision_requested', acceptedAt: null };
    pkg.status = 'review_required';
    execution.ledger.push({ at: now(), event: 'demo_revision_requested', details: { packageId } });
    refreshDemoExecutionStatus(execution);
    return execution;
  }

  const gate = assessEvidenceGate(pkg);
  const acceptedAt = now();
  let evidenceGate = { status: 'passed', verificationStatus: gate.verificationStatus, qualityStatus: gate.qualityStatus, packetDigest: gate.packetDigest, override: null };
  if (!gate.passed) {
    const override = normalizeEvidenceOverride(options?.evidenceOverride, gate);
    evidenceGate = { ...evidenceGate, status: 'overridden', override: { ...override, overriddenAt: acceptedAt, packetDigest: gate.packetDigest } };
    execution.ledger.push({ at: acceptedAt, event: 'demo_evidence_gate_overridden', details: { packageId, verificationStatus: gate.verificationStatus, qualityStatus: gate.qualityStatus, packetDigest: gate.packetDigest, reviewer: override.reviewer, reason: override.reason } });
  }
  pkg.acceptance = { status: 'accepted', acceptedAt, evidenceGate };
  pkg.status = 'accepted';
  execution.ledger.push({ at: acceptedAt, event: 'demo_deliverable_accepted', details: { packageId, evidenceGate: evidenceGate.status, verificationStatus: gate.verificationStatus, qualityStatus: gate.qualityStatus } });
  refreshDemoExecutionStatus(execution);
  return execution;
}

export function buildDemoFinalReport(execution) {
  if (execution?.mode !== 'simulation_only') throw new Error('Simulation execution not found.');
  const accepted = execution.packages.filter((pkg) => pkg.status === 'accepted');
  return {
    executionId: execution.executionId,
    status: execution.status,
    title: 'WorkRelay simulated project report',
    disclosure: execution.warning,
    completedPackages: accepted.length,
    evidenceOverrides: accepted.filter((pkg) => pkg.acceptance?.evidenceGate?.status === 'overridden').length,
    totalPackages: execution.packages.length,
    sections: execution.packages.map((pkg) => ({
      title: pkg.title,
      provider: pkg.providerName,
      status: pkg.status,
      deliverable: pkg.deliverable,
      contentHash: pkg.contentHash,
      evidencePacket: clone(pkg.evidencePacket),
      evaluation: pkg.evaluation,
      evidenceGate: assessEvidenceGate(pkg),
      acceptance: clone(pkg.acceptance),
      dependencyInputs: clone(pkg.dependencyInputs ?? []),
      dependencyHandoff: clone(pkg.dependencyHandoff ?? null)
    })),
    payment: { status: 'not_applicable_simulation', amountSpent: 0, note: 'No real provider was hired and no real money or USDC was spent.' },
    sandbox: clone(execution.sandbox),
    ledger: clone(execution.ledger)
  };
}
