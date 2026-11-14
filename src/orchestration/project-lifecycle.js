import { createHash, randomUUID } from 'node:crypto';
import { validateProcurementProposal } from '../procurement/quote-and-procure.js';

const clone = (value) => structuredClone(value);
const nowIso = () => new Date().toISOString();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function procurementFingerprint(packages) {
  return stableHash(packages.map((item) => ({
    packageId: item.packageId ?? item.id,
    brief: item.brief ?? null,
    acceptanceCriteria: item.acceptanceCriteria ?? [],
    provider: item.provider ?? item.recommendation?.provider,
    price: item.price ?? item.recommendation?.price,
    currency: item.currency ?? item.recommendation?.currency,
    paymentTerms: item.paymentTerms ?? item.recommendation?.paymentTerms,
    paymentChallenge: item.paymentChallenge ?? item.recommendation?.paymentChallenge ?? null,
    quoteReceivedAt: item.quoteReceivedAt ?? item.recommendation?.quoteReceivedAt ?? null,
    providerEndpoint: item.providerEndpoint ?? item.recommendation?.providerEndpoint ?? null,
    a2aRequestPayload: item.a2aRequestPayload ?? item.recommendation?.a2aRequestPayload ?? null,
    dependencyHandoff: item.dependencyHandoff ?? null
  })));
}

export function calculateExecutionApprovalFingerprint(execution) {
  return stableHash({
    proposalId: execution.proposalId,
    budget: { amount: execution.budget.amount, currency: execution.budget.currency, recommendedSpend: execution.budget.committed },
    packages: procurementFingerprint(execution.packages)
  });
}

/**
 * Turn an approved procurement proposal into an execution record.
 * Approval must be explicit, proposal-scoped, time-stamped and capped to the
 * exact recommended spend. This function does not hire or transfer funds.
 */
export function authorizeProjectExecution(proposal, approval) {
  const validation = validateProcurementProposal(proposal);
  assert(validation.valid, `Procurement proposal is invalid: ${validation.errors.join('; ')}`);
  assert(proposal.status === 'ready_for_user_approval', 'Proposal is not ready for approval; resolve quote, budget and recipient reviews first');
  assert(approval?.confirmed === true, 'Explicit user confirmation is required');
  assert(approval.proposalId === proposal.proposalId, 'Approval does not match this proposal');
  assert(typeof approval.approvedBy === 'string' && approval.approvedBy.trim(), 'Approver identity is required');
  assert(typeof approval.approvedAt === 'string' && Number.isFinite(Date.parse(approval.approvedAt)), 'A valid approval timestamp is required');

  const spend = Number(proposal.budget?.recommendedSpend);
  const cap = Number(approval.maxSpend);
  assert(Number.isFinite(spend) && spend > 0, 'Proposal has no positive recommended spend');
  assert(Number.isFinite(cap) && cap >= spend, 'Approval spend cap is below the recommended spend');
  assert(approval.currency === proposal.budget.currency, 'Approval currency does not match proposal currency');
  assert(cap <= Number(proposal.budget.amount), 'Approval cap exceeds the project budget');
  assert(Array.isArray(proposal.packages) && proposal.packages.length > 0, 'Proposal contains no packages');
  for (const item of proposal.packages) {
    assert(item.recommendation?.status === 'candidate_pending_approval', `Package ${item.packageId} is not eligible for execution`);
    assert(item.recommendation.paymentTerms?.valid === true, `Package ${item.packageId} has invalid payment terms`);
  }

  const approvalRecord = {
    confirmed: true,
    proposalId: proposal.proposalId,
    approvedBy: approval.approvedBy.trim(),
    approvedAt: approval.approvedAt,
    maxSpend: cap,
    currency: approval.currency,
    proposalFingerprint: stableHash({
      proposalId: proposal.proposalId,
      budget: { amount: Number(proposal.budget.amount), currency: proposal.budget.currency, recommendedSpend: spend },
      packages: procurementFingerprint(proposal.packages)
    })
  };

  return {
    executionId: `wr-exec-${randomUUID()}`,
    proposalId: proposal.proposalId,
    objective: proposal.objective ?? null,
    status: 'approved_pending_dispatch',
    budget: {
      amount: Number(proposal.budget.amount),
      currency: proposal.budget.currency,
      committed: spend,
      reserved: 0,
      remaining: Number(proposal.budget.amount) - spend
    },
    approval: approvalRecord,
    packages: proposal.packages.map((item) => ({
      packageId: item.packageId,
      title: item.title,
      dependsOn: clone(item.dependsOn ?? []),
      quotedAt: item.recommendation.quoteReceivedAt ?? proposal.generatedAt ?? null,
      brief: item.brief ?? null,
      acceptanceCriteria: clone(item.acceptanceCriteria ?? []),
      provider: item.recommendation.provider,
      providerName: item.recommendation.providerName,
      price: item.recommendation.price,
      currency: item.recommendation.currency,
      paymentTerms: clone(item.recommendation.paymentTerms),
      paymentChallenge: clone(item.recommendation.paymentChallenge ?? null),
      quoteReceivedAt: item.recommendation.quoteReceivedAt ?? null,
      providerEndpoint: item.recommendation.providerEndpoint ?? null,
      a2aRequestPayload: clone(item.recommendation.a2aRequestPayload ?? null),
      dependencyHandoff: clone(item.dependencyHandoff ?? null),
      idempotencyKey: `${proposal.proposalId}:${item.packageId}:${item.recommendation.provider}`,
      commissioning: { status: 'not_started', attempts: 0, taskId: null, lastError: null },
      delivery: { status: 'awaiting_provider', content: null, contentHash: null, receivedAt: null },
      evaluation: { status: 'not_evaluated', criterionResults: [], passed: null, evaluatedAt: null },
      acceptance: { status: 'not_requested', acceptedBy: null, acceptedAt: null },
      payment: { mode: 'x402_delivery_escrow', status: 'not_sent', amount: item.recommendation.price, currency: item.recommendation.currency, transactionId: null, settledAt: null, evidence: null }
    })),
    ledger: [{ id: randomUUID(), at: nowIso(), event: 'user_approved_proposal', details: { approvedBy: approvalRecord.approvedBy, maxSpend: cap, currency: approvalRecord.currency } }],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
}

/**
 * Commission approved work through an injected marketplace adapter.
 * Adapter contract: commission({provider, brief, acceptanceCriteria, price,
 * currency, paymentTerms, idempotencyKey}) -> {status:'commissioned', taskId,
 * paymentStatus:'held'|'not_sent'|'unknown'}. The default path is fail-closed.
 */
export async function dispatchApprovedProject(execution, { commissioner, onChange, onlyPackageIds = null } = {}) {
  assert(['approved_pending_dispatch', 'dispatch_in_progress', 'dispatch_partially_failed', 'dispatch_blocked_reconciliation_required', 'dispatch_staged'].includes(execution?.status), 'Execution is not approved for dispatch');
  assert(execution.approval?.confirmed === true, 'Execution has no valid approval record');
  const currentFingerprint = calculateExecutionApprovalFingerprint(execution);
  assert(currentFingerprint === execution.approval.proposalFingerprint, 'Execution scope or payment terms changed after approval; a fresh approval is required');
  const totalPackageSpend = execution.packages.reduce((sum, item) => sum + Number(item.price), 0);
  assert(totalPackageSpend <= execution.approval.maxSpend + 1e-9 && totalPackageSpend <= execution.budget.amount + 1e-9, 'Execution spend exceeds the approved or project budget');
  assert(commissioner && typeof commissioner.commission === 'function', 'No marketplace commissioner is configured; refusing to simulate hiring');

  execution.status = 'dispatch_in_progress';
  execution.updatedAt = nowIso();
  for (const item of execution.packages) {
    if (item.commissioning.status === 'commissioned') continue;
    if (Array.isArray(onlyPackageIds) && !onlyPackageIds.includes(item.packageId) && item.commissioning.status !== 'outcome_unknown') continue;
    if (item.commissioning.status === 'outcome_unknown') {
      execution.status = 'dispatch_blocked_reconciliation_required';
      execution.ledger.push({ id: randomUUID(), at: nowIso(), event: 'dispatch_blocked', details: { packageId: item.packageId, reason: 'Previous commission outcome is unknown; reconcile before retrying' } });
      execution.updatedAt = nowIso();
      return execution;
    }
    if (item.dependencyHandoff) {
      assert(item.dependencyHandoff.external === true, `Package ${item.packageId} has an invalid external dependency handoff`);
      assert(item.dependencyHandoff.quoteStatus === 'quoted_bound' && item.dependencyHandoff.quoteBindingVerified === true, `Package ${item.packageId} requires a fresh quote bound to its accepted upstream inputs`);
      assert(Array.isArray(item.dependencyHandoff.sourceManifest) && item.dependencyHandoff.sourceManifest.length > 0, `Package ${item.packageId} has no dependency source manifest`);
      assert(item.dependencyHandoff.sourceManifest.every((source) => source.acceptanceStatus === 'accepted' && source.evaluationPassed === true && /^[a-f0-9]{64}$/i.test(source.contentHash)), `Package ${item.packageId} has an unaccepted or unverifiable dependency source`);
    }
    assert(item.commissioning.status === 'not_started', `Package ${item.packageId} is not dispatchable; a definitive rejection requires a fresh quote and approval`);
    item.commissioning.status = 'request_in_progress';
    item.commissioning.attempts += 1;
    execution.ledger.push({ id: randomUUID(), at: nowIso(), event: 'commission_request_started', details: { packageId: item.packageId, provider: item.provider, idempotencyKey: item.idempotencyKey } });
    let persistError = null;
    // Write-ahead: the in-progress marker must be durable BEFORE any payment can be authorized.
    // If it cannot be persisted, abort without spending.
    if (typeof onChange === 'function') {
      try { await onChange(execution, 'before_commission', item.packageId); }
      catch (error) {
        item.commissioning.status = 'not_started'; item.commissioning.attempts -= 1;
        execution.ledger.push({ id: randomUUID(), at: nowIso(), event: 'dispatch_aborted_persistence_failed', details: { packageId: item.packageId } });
        throw new Error(`Could not persist the commissioning intent; no payment was attempted: ${error.message}`);
      }
    }
    try {
      const result = await commissioner.commission({
        provider: item.provider,
        brief: item.brief,
        acceptanceCriteria: clone(item.acceptanceCriteria),
        price: item.price,
        currency: item.currency,
        paymentTerms: clone(item.paymentTerms),
        paymentChallenge: clone(item.paymentChallenge),
        quoteReceivedAt: item.quoteReceivedAt ?? item.quotedAt,
        providerEndpoint: item.providerEndpoint,
        a2aRequestPayload: clone(item.a2aRequestPayload),
        idempotencyKey: item.idempotencyKey,
        executionId: execution.executionId,
        packageId: item.packageId,
        approval: { confirmed: execution.approval.confirmed, proposalId: execution.approval.proposalId, proposalFingerprint: execution.approval.proposalFingerprint, approvedBy: execution.approval.approvedBy, approvedAt: execution.approval.approvedAt, maxSpend: execution.approval.maxSpend, currency: execution.approval.currency }
      });
      if (result?.status !== 'commissioned' || typeof result.taskId !== 'string' || !result.taskId.trim()) {
        item.commissioning.status = result?.status === 'rejected_before_payment' ? 'failed_definitive' : 'outcome_unknown';
        item.commissioning.lastError = result?.reason ?? 'Commissioner returned an ambiguous result';
        execution.ledger.push({ id: randomUUID(), at: nowIso(), event: 'commission_result_ambiguous_or_pre_payment_rejection', details: { packageId: item.packageId, status: result?.status ?? 'missing', reason: item.commissioning.lastError } });
        execution.status = item.commissioning.status === 'outcome_unknown' ? 'dispatch_blocked_reconciliation_required' : 'dispatch_partially_failed';
        execution.updatedAt = nowIso();
        return execution;
      }
      item.commissioning.status = 'commissioned';
      item.commissioning.taskId = result.taskId;
      item.commissioning.lastError = null;
      item.payment.status = ['held', 'not_sent', 'unknown', 'settled'].includes(result.paymentStatus) ? result.paymentStatus : 'unknown';
      item.payment.mode = result.paymentMode ?? item.payment.mode;
      item.payment.evidence = result.paymentEvidence ?? null;
      execution.ledger.push({ id: randomUUID(), at: nowIso(), event: 'provider_commissioned', details: { packageId: item.packageId, provider: item.provider, taskId: result.taskId, paymentStatus: item.payment.status, paymentMode: item.payment.mode } });
      const immediateContent = (result.artifacts ?? []).map((artifact) => artifact.text).filter((value) => typeof value === 'string' && value.trim()).join('\n\n');
      if (immediateContent.trim().length >= 20) recordPackageDeliverable(execution, { packageId: item.packageId, taskId: result.taskId, content: immediateContent });
      if (typeof onChange === 'function') { try { await onChange(execution, 'after_commission', item.packageId); } catch (persistFailure) { persistError = persistFailure; } }
    } catch (error) {
      // Network timeouts can occur after a marketplace accepted the request.
      // Treat thrown errors as ambiguous and do not automatically retry.
      item.commissioning.status = 'outcome_unknown';
      item.commissioning.lastError = error.message;
      execution.ledger.push({ id: randomUUID(), at: nowIso(), event: 'commission_outcome_unknown', details: { packageId: item.packageId, error: error.message } });
      execution.status = 'dispatch_blocked_reconciliation_required';
      execution.updatedAt = nowIso();
      return execution;
    }
    if (persistError) {
      execution.ledger.push({ id: randomUUID(), at: nowIso(), event: 'persist_failed_after_commission', details: { packageId: item.packageId, taskId: item.commissioning.taskId } });
      throw new Error(`Package ${item.packageId} WAS commissioned (task ${item.commissioning.taskId}) but the record could not be persisted: ${persistError.message}. Do not re-dispatch; persist this execution manually.`);
    }
  }
  if (execution.packages.every((entry) => entry.commissioning.status === 'commissioned')) {
    execution.status = 'work_in_progress';
    execution.ledger.push({ id: randomUUID(), at: nowIso(), event: 'all_packages_commissioned', details: { packageCount: execution.packages.length } });
  } else {
    execution.status = 'dispatch_staged'; // some packages are intentionally held back (dependency gating)
  }
  execution.updatedAt = nowIso();
  return execution;
}

/** Resolve an ambiguous commission only after checking the marketplace job record. */
export function reconcileCommissionOutcome(execution, { packageId, outcome, taskId = null, paymentStatus = 'unknown', paymentMode = 'x402_delivery_escrow', evidenceReference, reconciledBy }) {
  const item = execution?.packages?.find((entry) => entry.packageId === packageId);
  assert(item, `Unknown package: ${packageId}`);
  assert(item.commissioning.status === 'outcome_unknown', 'Package has no ambiguous commission to reconcile');
  assert(typeof evidenceReference === 'string' && evidenceReference.trim(), 'Marketplace reconciliation evidence is required');
  let evidenceUrl;
  try { evidenceUrl = new URL(evidenceReference); } catch { throw new Error('Marketplace reconciliation evidence must be a valid official HTTPS URL'); }
  assert(evidenceUrl.protocol === 'https:' && !evidenceUrl.username && !evidenceUrl.password && !evidenceUrl.search && !evidenceUrl.hash && (evidenceUrl.hostname === 'market.near.ai' || evidenceUrl.hostname.endsWith('.market.near.ai')), 'Marketplace reconciliation evidence must be a credential-free official HTTPS marketplace URL');
  assert(typeof reconciledBy === 'string' && reconciledBy.trim(), 'Authenticated owner attestation is required');
  assert(['commissioned', 'rejected'].includes(outcome), 'Reconciliation outcome must be commissioned or rejected');
  if (outcome === 'commissioned') {
    assert(typeof taskId === 'string' && taskId.trim(), 'A confirmed marketplace task ID is required');
    assert(['held', 'not_sent', 'unknown'].includes(paymentStatus), 'Unsupported reconciled payment status');
    assert(['x402_delivery_escrow', 'marketplace_escrow'].includes(paymentMode), 'Unsupported reconciled payment mode');
    item.commissioning.status = 'commissioned';
    item.commissioning.taskId = taskId;
    item.payment.status = paymentStatus;
    item.payment.mode = paymentMode;
  } else {
    assert(paymentStatus === 'not_sent', 'A rejected commission requires positive evidence that payment was not sent; otherwise its outcome remains unknown');
    item.commissioning.status = 'failed_definitive';
    item.commissioning.taskId = null;
    item.payment.status = paymentStatus;
  }
  item.commissioning.lastError = null;
  execution.ledger.push({ id: randomUUID(), at: nowIso(), event: 'commission_outcome_reconciled', details: { packageId, outcome, taskId, evidenceReference, reconciledBy, verification: 'owner_attestation_not_independently_verified' } });
  execution.status = execution.packages.every((entry) => entry.commissioning.status === 'commissioned')
    ? 'work_in_progress'
    : 'dispatch_partially_failed';
  execution.updatedAt = nowIso();
  return execution;
}

/** Record provider output without implying that it has passed review or been paid. */
export function recordPackageDeliverable(execution, { packageId, taskId, content, receivedAt = nowIso() }) {
  const item = execution?.packages?.find((entry) => entry.packageId === packageId);
  assert(item, `Unknown package: ${packageId}`);
  assert(item.commissioning.status === 'commissioned', 'Cannot record a deliverable before confirmed commissioning');
  assert(item.commissioning.taskId === taskId, 'Task ID does not match the commissioned marketplace task');
  assert(typeof content === 'string' && content.trim().length >= 20, 'Deliverable must contain at least 20 non-whitespace characters');
  assert(Number.isFinite(Date.parse(receivedAt)), 'receivedAt must be a valid timestamp');
  item.delivery = { status: 'delivered_pending_evaluation', content, contentHash: createHash('sha256').update(content).digest('hex'), receivedAt };
  item.evaluation = { status: 'not_evaluated', criterionResults: [], passed: null, evaluatedAt: null };
  execution.ledger.push({ id: randomUUID(), at: nowIso(), event: 'deliverable_received', details: { packageId, taskId, contentHash: item.delivery.contentHash } });
  execution.updatedAt = nowIso();
  updateProjectStatus(execution);
  return execution;
}

/**
 * Evaluator must return one explicit result per acceptance criterion.
 * A pass only makes the package eligible for human acceptance; it never accepts
 * the marketplace job or releases funds.
 */
export async function evaluatePackageDeliverable(execution, { packageId, evaluator }) {
  const item = execution?.packages?.find((entry) => entry.packageId === packageId);
  assert(item, `Unknown package: ${packageId}`);
  assert(item.delivery.status === 'delivered_pending_evaluation', 'Package has no unreviewed deliverable');
  assert(typeof evaluator === 'function', 'A deliverable evaluator is required');
  const raw = await evaluator({
    brief: item.brief,
    acceptanceCriteria: clone(item.acceptanceCriteria),
    deliverable: item.delivery.content
  });
  assert(Array.isArray(raw?.criterionResults), 'Evaluator must return criterionResults');
  const expected = item.acceptanceCriteria;
  const normalized = raw.criterionResults.map((result) => ({
    criterion: result?.criterion,
    passed: result?.passed === true,
    evidence: typeof result?.evidence === 'string' ? result.evidence : '',
    reason: typeof result?.reason === 'string' ? result.reason : ''
  }));
  const seen = new Set(normalized.map((result) => result.criterion));
  assert(normalized.length === expected.length && expected.every((criterion) => seen.has(criterion)), 'Evaluator must assess every acceptance criterion exactly once');
  assert(new Set(normalized.map((result) => result.criterion)).size === expected.length, 'Evaluator returned duplicate criteria');
  const passed = normalized.every((result) => result.passed && result.evidence.trim());
  item.evaluation = { status: passed ? 'passed_pending_human_acceptance' : 'revision_required', criterionResults: normalized, passed, evaluatedAt: nowIso() };
  item.delivery.status = passed ? 'evaluation_passed' : 'revision_required';
  execution.ledger.push({ id: randomUUID(), at: nowIso(), event: 'deliverable_evaluated', details: { packageId, passed, criterionResults: normalized } });
  execution.updatedAt = nowIso();
  updateProjectStatus(execution);
  return execution;
}

/** Human acceptance is a separate action after evidence-backed evaluation. */
export function acceptPackageDeliverable(execution, { packageId, acceptedBy, acceptedAt = nowIso() }) {
  const item = execution?.packages?.find((entry) => entry.packageId === packageId);
  assert(item, `Unknown package: ${packageId}`);
  assert(item.evaluation.status === 'passed_pending_human_acceptance' && item.evaluation.passed === true, 'Deliverable has not passed evaluation');
  assert(typeof acceptedBy === 'string' && acceptedBy.trim(), 'Human acceptor identity is required');
  assert(Number.isFinite(Date.parse(acceptedAt)), 'acceptedAt must be a valid timestamp');
  item.acceptance = { status: 'accepted', acceptedBy: acceptedBy.trim(), acceptedAt };
  execution.ledger.push({ id: randomUUID(), at: nowIso(), event: 'deliverable_accepted_by_user', details: { packageId, acceptedBy: acceptedBy.trim() } });
  execution.updatedAt = nowIso();
  updateProjectStatus(execution);
  return execution;
}

/** Settlement is only updated from an independently confirmed marketplace receipt. */
export function recordPaymentSettlement(execution, { packageId, status, transactionId, settledAt = nowIso() }) {
  const item = execution?.packages?.find((entry) => entry.packageId === packageId);
  assert(item, `Unknown package: ${packageId}`);
  assert(['held', 'settled', 'refunded', 'unknown'].includes(status), 'Unsupported payment settlement status');
  if (status === 'settled') {
    if (item.payment.mode === 'marketplace_escrow') {
      assert(item.acceptance.status === 'accepted', 'Cannot release escrow settlement before human acceptance');
    } else if (item.payment.mode === 'x402_delivery_escrow') {
      assert(typeof item.delivery.contentHash === 'string' && item.delivery.contentHash.length === 64, 'Cannot settle an A2A x402 payment before a deliverable is recorded');
    } else {
      assert(false, 'Unknown payment mode; refusing to infer settlement rules');
    }
    assert(typeof transactionId === 'string' && transactionId.trim(), 'A confirmed transaction or settlement reference is required');
    assert(Number.isFinite(Date.parse(settledAt)), 'settledAt must be a valid timestamp');
  }
  item.payment = { ...item.payment, status, transactionId: transactionId ?? item.payment.transactionId, settledAt: status === 'settled' ? settledAt : null };
  execution.ledger.push({ id: randomUUID(), at: nowIso(), event: 'payment_status_updated', details: { packageId, status, transactionId: transactionId ?? null } });
  execution.updatedAt = nowIso();
  updateProjectStatus(execution);
  return execution;
}

function updateProjectStatus(execution) {
  if (execution.packages.every((item) => item.acceptance.status === 'accepted')) {
    execution.status = execution.packages.every((item) => item.payment.status === 'settled') ? 'completed_and_settled' : 'accepted_awaiting_settlement';
  } else if (execution.packages.some((item) => ['provider_task_failed', 'completed_without_artifact'].includes(item.delivery.status))) {
    execution.status = 'attention_required';
  } else if (execution.packages.some((item) => item.delivery.status === 'revision_required')) {
    execution.status = 'revision_required';
  } else if (execution.packages.every((item) => item.delivery.status === 'evaluation_passed' || item.acceptance.status === 'accepted')) {
    execution.status = 'awaiting_human_acceptance';
  } else if (execution.packages.every((item) => ['delivered_pending_evaluation', 'evaluation_passed', 'revision_required'].includes(item.delivery.status) || item.acceptance.status === 'accepted')) {
    execution.status = 'deliverables_received_or_under_review';
  }
}

export function summarizeExecution(execution) {
  return {
    executionId: execution.executionId,
    proposalId: execution.proposalId,
    status: execution.status,
    budget: clone(execution.budget),
    packages: execution.packages.map((item) => ({
      packageId: item.packageId,
      provider: item.provider,
      commissioning: item.commissioning.status,
      delivery: item.delivery.status,
      evaluation: item.evaluation.status,
      acceptance: item.acceptance.status,
      payment: item.payment.status
    })),
    ledgerEvents: execution.ledger.length
  };
}
