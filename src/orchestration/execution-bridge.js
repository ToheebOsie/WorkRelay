import { authorizeProjectExecution, dispatchApprovedProject, recordPackageDeliverable, evaluatePackageDeliverable, acceptPackageDeliverable, calculateExecutionApprovalFingerprint } from './project-lifecycle.js';
import { createHash } from 'node:crypto';
import { validateProcurementProposal } from '../procurement/quote-and-procure.js';
import { selectedRequirementMatches } from '../payments/x402-authorization.js';
import { getProviderTask } from '../market/near-a2a-quotes.js';
import { parseTaskArtifacts } from './artifact-parser.js';
import { createStructuralEvaluator } from './structural-evaluator.js';
import { saveExecution, loadExecution } from '../storage/json-ledger.js';

const nowIso = () => new Date().toISOString();
const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const DEFAULT_MAX_QUOTE_AGE_MS = 15 * 60 * 1000;
export const LIVE_MODE = 'live_a2a_x402';

/**
 * Decide whether a procurement proposal may be commissioned for real. Returns every blocker with a
 * machine-readable code so the UI can explain WHY spending is disabled. Pure; performs no I/O.
 */
export function assessCommissionReadiness(proposal, { paymentAuthorizerConfigured = false, allowedAssets = [], allowedNetworks = [], allowedAssetsByNetwork = null, requireV2PaymentChallenge = true, maxQuoteAgeMs = DEFAULT_MAX_QUOTE_AGE_MS, nowMs = Date.now() } = {}) {
  const blockers = []; const warnings = [];
  const block = (code, message, packageId = null) => blockers.push({ code, message, ...(packageId ? { packageId } : {}) });
  if (!proposal) { block('no_proposal', 'No procurement proposal exists. Request quotes first.'); return finish(); }
  if (proposal.status === 'simulation_only') block('simulation_proposal', 'This proposal contains simulated quotes and can never be commissioned.');
  const validation = validateProcurementProposal(proposal);
  if (!validation.valid) block('proposal_invalid', `Proposal failed validation: ${validation.errors.join('; ')}`);
  if (proposal.recipientAudit?.requiresManualVerification) {
    const shared = (proposal.recipientAudit.sharedRecipients ?? []).map((r) => r.payTo ?? r.recipient ?? r).filter((v) => typeof v === 'string');
    block('shared_recipient_unverified', `Multiple providers returned the same payment recipient${shared.length ? ` (${shared.map((a) => `${a.slice(0, 8)}…${a.slice(-6)}`).join(', ')})` : ''}. Its ownership and settlement routing have not been independently verified, so payment stays blocked.`);
  }
  if (proposal.status !== 'ready_for_user_approval' && proposal.status !== 'simulation_only') block('proposal_not_ready', `Proposal status is "${proposal.status}", not ready_for_user_approval.`);
  let spend = 0;
  for (const item of proposal.packages ?? []) {
    const rec = item.recommendation;
    if (!rec) { block('no_recommendation', 'No affordable, eligible quote for this package.', item.packageId); continue; }
    spend += Number(rec.price);
    if (rec.paymentTerms?.valid !== true) block('invalid_payment_terms', 'Payment terms failed validation.', item.packageId);
    const network = rec.paymentTerms?.network;
    if (!allowedNetworks.includes(network)) block('unsupported_network', `Payment network is not enabled by the server allowlist: ${network ?? 'missing'}.`, item.packageId);
    const networkAssets = allowedAssetsByNetwork && typeof allowedAssetsByNetwork === 'object'
      ? (allowedAssetsByNetwork[network] ?? [])
      : allowedAssets;
    if (!networkAssets.some((asset) => String(asset).toLowerCase() === String(rec.paymentTerms?.asset ?? '').toLowerCase())) block('asset_not_allowlisted', 'Payment asset is not allowlisted for this network.', item.packageId);
    if (requireV2PaymentChallenge && (rec.paymentChallenge?.x402Version !== 2 || !selectedRequirementMatches(rec.paymentChallenge, rec.paymentTerms))) block('x402_v2_challenge_missing_or_mismatched', 'The selected payment terms are not bound to an intact x402 v2 402 challenge.', item.packageId);
    if (!rec.a2aRequestPayload || !rec.providerEndpoint) block('quote_request_not_preserved', 'The exact quoted request or provider endpoint was not preserved.', item.packageId);
    const windowMs = Math.min(maxQuoteAgeMs, Number(rec.paymentTerms?.maxTimeoutSeconds) > 0 ? Number(rec.paymentTerms.maxTimeoutSeconds) * 1000 : maxQuoteAgeMs);
    const quotedAt = Date.parse(rec.quoteReceivedAt ?? proposal.generatedAt ?? '');
    if (!Number.isFinite(quotedAt)) block('quote_age_unknown', 'Quote time is unknown, so validity cannot be confirmed.', item.packageId);
    else if (nowMs - quotedAt > windowMs) block('quote_stale', `Quote is older than the ${Math.round(windowMs / 60000)}-minute validity window; request fresh quotes.`, item.packageId);
  }
  if (Number.isFinite(Number(proposal.budget?.amount)) && spend > Number(proposal.budget.amount) + 1e-9) block('over_budget', 'Recommended spend exceeds the project budget.');
  if (!paymentAuthorizerConfigured) block('payment_authorizer_not_configured', 'No secure payment authorizer is configured on this server. WorkRelay holds no keys and will not sign payments itself.');
  return finish();
  function finish() { return { ready: blockers.length === 0, blockers, warnings, assessedAt: nowIso(), mode: LIVE_MODE }; }
}

/** Independent payment audit state. Never infers settlement from task, artifact or acceptance state. */
export function derivePaymentAudit(item, execution = null) {
  const c = item.commissioning?.status; const p = item.payment ?? {};
  let state; let note;
  if (c === 'failed_definitive') { state = 'failed_rejected'; note = 'The attempt was explicitly rejected before payment transmission, or independently reconciled as unpaid.'; }
  else if (c === 'outcome_unknown' || c === 'request_in_progress') { state = 'unknown_reconciliation_required'; note = 'A payment may have been sent. Reconcile with the provider task record before any retry.'; }
  else if (c === 'commissioned') {
    if (p.status === 'settled' && p.transactionId) { state = 'confirmed_settled'; note = `Settlement reference supplied: ${p.transactionId}`; }
    else if (p.status === 'refunded') { state = 'refunded'; note = 'Refund recorded.'; }
    else if (p.status === 'held') { state = 'pending_held'; note = 'Payment reported as held pending delivery.'; }
    else { state = 'submitted_unverified'; note = 'A paid request was accepted by the provider. Settlement has NOT been independently confirmed.'; }
  } else if (execution?.approval?.confirmed) { state = 'approved_not_sent'; note = 'Approved by the user; no payment has been sent.'; }
  else { state = 'not_authorized'; note = 'No approval exists.'; }
  return { packageId: item.packageId, provider: item.provider, state, note, amount: item.price, currency: item.currency, mode: p.mode, transactionId: p.transactionId ?? null, taskId: item.commissioning?.taskId ?? null };
}

export function summarizePaymentAudit(execution) {
  const rows = execution.packages.map((item) => derivePaymentAudit(item, execution));
  const max = Number(execution.approval?.maxSpend ?? 0);
  const sum = (states) => rows.filter((r) => states.includes(r.state)).reduce((t, r) => t + Number(r.amount), 0);
  const committed = sum(['submitted_unverified', 'pending_held', 'confirmed_settled', 'unknown_reconciliation_required']);
  const reserved = sum(['approved_not_sent', 'failed_rejected']);
  return { rows, budget: { maxApproved: max, committed, reserved, available: Math.max(0, max - committed - reserved) }, confirmedSettledCount: rows.filter((r) => r.state === 'confirmed_settled').length };
}

/** Packages stuck mid-request after a crash may already have been paid: they become unknown, never retried. */
export function recoverExecution(execution) {
  const recovered = [];
  for (const item of execution.packages) {
    if (item.commissioning.status === 'request_in_progress') {
      item.commissioning.status = 'outcome_unknown';
      item.commissioning.lastError = 'Process stopped while a commission request was in flight; payment may have been sent.';
      execution.ledger.push({ id: crypto.randomUUID(), at: nowIso(), event: 'commission_recovered_as_unknown', details: { packageId: item.packageId } });
      recovered.push(item.packageId);
    }
  }
  if (recovered.length) execution.status = 'dispatch_blocked_reconciliation_required';
  execution.updatedAt = nowIso();
  return { execution, recovered };
}

export const createFilePersist = (filePath) => async (execution) => { await saveExecution(filePath, execution); };
export async function loadAndRecover(filePath, persist = createFilePersist(filePath)) {
  const { execution, recovered } = recoverExecution(await loadExecution(filePath));
  if (recovered.length) await persist(execution);
  return { execution, recovered };
}

const normalizeState = (state) => String(state ?? '').toLowerCase().replace(/^task_state_/, '').replace(/_/g, '-');
const AWAITING = ['awaiting_provider', 'completed_without_artifact'];

export function createExecutionBridge({ commissioner = null, taskReader = getProviderTask, persist = null, evaluator = createStructuralEvaluator(), dependencyGate = 'accepted', maxQuoteAgeMs = DEFAULT_MAX_QUOTE_AGE_MS, allowedAssets = [], allowedNetworks = [], allowedAssetsByNetwork = null, requireV2PaymentChallenge = true, now = () => Date.now() } = {}) {
  if (!['accepted', 'evaluated'].includes(dependencyGate)) throw new TypeError('dependencyGate must be "accepted" or "evaluated"');
  const save = async (execution, reason, packageId) => { if (persist) await persist(execution, reason, packageId); };

  function dependenciesMet(execution, item) {
    if (item.dependencyHandoff?.external === true) {
      const sources = item.dependencyHandoff.sourceManifest;
      return item.dependencyHandoff.quoteStatus === 'quoted_bound'
        && item.dependencyHandoff.quoteBindingVerified === true
        && Array.isArray(sources) && sources.length > 0
        && sources.every((source) => source.acceptanceStatus === 'accepted' && source.evaluationPassed === true && /^[a-f0-9]{64}$/i.test(source.contentHash));
    }
    return (item.dependsOn ?? []).every((id) => {
      const dep = execution.packages.find((p) => p.packageId === id);
      if (!dep) return false;
      return dependencyGate === 'accepted' ? dep.acceptance.status === 'accepted' : dep.evaluation.passed === true;
    });
  }

  return {
    previewDispatch(execution) {
      const blockers = []; const readyPackages = []; const held = [];
      const addBlocker = (code, message) => blockers.push({ code, message });
      if (!commissioner) addBlocker('wallet_adapter_not_configured', 'No payment-capable wallet adapter is configured.');
      if (execution?.approval?.confirmed !== true) addBlocker('approval_missing', 'A recorded proposal-scoped approval is required.');
      if (!execution || !Array.isArray(execution.packages)) addBlocker('execution_missing', 'Execution record is malformed.');
      else {
        try {
          if (calculateExecutionApprovalFingerprint(execution) !== execution.approval?.proposalFingerprint) addBlocker('approval_fingerprint_mismatch', 'Execution scope or payment terms changed after approval.');
        } catch { addBlocker('execution_invalid', 'Execution approval fingerprint could not be verified.'); }
        if (execution.packages.some((item) => ['request_in_progress', 'outcome_unknown'].includes(item.commissioning?.status))) {
          addBlocker('reconciliation_required', 'A previous commission outcome is unknown or still marked in progress. Reconcile before any further dispatch.');
        }
        for (const item of execution.packages) {
          if (item.commissioning?.status === 'commissioned') continue;
          if (!['not_started'].includes(item.commissioning?.status)) {
            held.push({ packageId: item.packageId, reason: `commissioning_${item.commissioning?.status ?? 'unknown'}` });
            continue;
          }
          if (!dependenciesMet(execution, item)) {
            held.push({ packageId: item.packageId, reason: 'dependencies_not_yet_accepted' });
            continue;
          }
          const quoteTime = Date.parse(item.quoteReceivedAt ?? item.quotedAt ?? '');
          const maxAge = Math.min(maxQuoteAgeMs, Number(item.paymentTerms?.maxTimeoutSeconds) > 0 ? Number(item.paymentTerms.maxTimeoutSeconds) * 1000 : maxQuoteAgeMs);
          if (!Number.isFinite(quoteTime) || now() - quoteTime > maxAge || quoteTime > now() + 30_000) {
            held.push({ packageId: item.packageId, reason: 'quote_stale_or_missing' });
            continue;
          }
          if (requireV2PaymentChallenge && (item.paymentChallenge?.x402Version !== 2 || !selectedRequirementMatches(item.paymentChallenge, item.paymentTerms))) {
            held.push({ packageId: item.packageId, reason: 'x402_challenge_missing_or_mismatched' });
            continue;
          }
          readyPackages.push(item);
        }
      }
      const total = readyPackages.reduce((sum, item) => sum + Number(item.price || 0), 0);
      if (execution && total > Number(execution.approval?.maxSpend ?? 0) + 1e-9) addBlocker('approved_spend_exceeded', 'Ready package spend exceeds the recorded approval cap.');
      const fingerprint = sha256({
        executionId: execution?.executionId,
        proposalFingerprint: execution?.approval?.proposalFingerprint,
        packages: readyPackages.map((item) => ({ packageId: item.packageId, provider: item.provider, price: item.price, currency: item.currency, paymentTerms: item.paymentTerms, paymentChallenge: item.paymentChallenge, quoteReceivedAt: item.quoteReceivedAt, a2aRequestPayload: item.a2aRequestPayload }))
      });
      return { ready: blockers.length === 0 && readyPackages.length > 0, blockers, packages: readyPackages.map((item) => ({ packageId: item.packageId, provider: item.provider, amount: item.price, currency: item.currency })), held, total, currency: execution?.budget?.currency ?? 'USDC', fingerprint };
    },
    assessReadiness: (proposal) => assessCommissionReadiness(proposal, { paymentAuthorizerConfigured: Boolean(commissioner), allowedAssets, allowedNetworks, allowedAssetsByNetwork, requireV2PaymentChallenge, maxQuoteAgeMs, nowMs: now() }),

    async start(proposal, approval, { ownerPrincipalId = null } = {}) {
      const readiness = this.assessReadiness(proposal);
      if (!readiness.ready) throw Object.assign(new Error(`Live commissioning is blocked: ${readiness.blockers.map((b) => b.code).join(', ')}`), { code: 'commission_blocked', readiness });
      const execution = authorizeProjectExecution(proposal, approval);
      execution.mode = LIVE_MODE;
      if (ownerPrincipalId) execution.ownerPrincipalId = ownerPrincipalId;
      await save(execution, 'approved');
      return execution;
    },

    /** Spend is dispatched serially (one authorization at a time); provider work then proceeds in parallel. */
    async dispatchReady(execution) {
      if (!commissioner) throw new Error('No payment-capable commissioner is configured; refusing to simulate hiring.');
      if (execution.packages.some((p) => ['request_in_progress', 'outcome_unknown'].includes(p.commissioning.status))) throw new Error('A commission outcome is unknown or in progress; reconcile before dispatching any package.');
      const limit = Math.min(maxQuoteAgeMs, ...execution.packages.map((p) => Number(p.paymentTerms?.maxTimeoutSeconds) > 0 ? Number(p.paymentTerms.maxTimeoutSeconds) * 1000 : maxQuoteAgeMs));
      const held = []; const ready = [];
      for (const item of execution.packages) {
        if (item.commissioning.status !== 'not_started') continue;
        if (!dependenciesMet(execution, item)) { held.push({ packageId: item.packageId, waitingOn: item.dependsOn.filter((id) => !dependenciesMet(execution, { dependsOn: [id] })) }); continue; }
        const quotedAt = Date.parse(item.quoteReceivedAt ?? item.quotedAt ?? '');
        if (!Number.isFinite(quotedAt) || now() - quotedAt > limit) throw Object.assign(new Error(`Quote for ${item.packageId} is stale or has no timestamp; request fresh quotes and obtain fresh approval.`), { code: 'quote_stale' });
        ready.push(item.packageId);
      }
      if (!ready.length) return { execution, dispatched: [], held };
      await dispatchApprovedProject(execution, { commissioner, onlyPackageIds: ready, onChange: save });
      await save(execution, 'dispatch_complete');
      return { execution, dispatched: ready.filter((id) => execution.packages.find((p) => p.packageId === id).commissioning.status === 'commissioned'), held };
    },

    /** Read-only refresh. Never resends a paid request. */
    async sync(execution) {
      const updates = [];
      for (const item of execution.packages) {
        if (item.commissioning.status !== 'commissioned' || !AWAITING.includes(item.delivery.status)) continue;
        const result = await taskReader({ agent: { handle: item.provider }, taskId: item.commissioning.taskId }).catch((error) => ({ status: 'request_failed', reason: error.message }));
        if (result?.status !== 'task_retrieved') {
          item.commissioning.lastSyncError = { at: nowIso(), status: result?.status ?? 'lookup_failed', reason: String(result?.reason ?? '').slice(0, 300) };
          updates.push({ packageId: item.packageId, status: result?.status ?? 'lookup_failed' });
          continue;
        }
        item.commissioning.lastSyncError = null;
        const state = normalizeState(result.taskStatus);
        const history = (item.commissioning.stateHistory ??= []);
        if (history.at(-1)?.state !== state) { history.push({ state, at: nowIso() }); execution.ledger.push({ at: nowIso(), event: 'provider_task_state_changed', details: { packageId: item.packageId, taskId: item.commissioning.taskId, state } }); }
        item.commissioning.providerTaskState = result.taskStatus;
        if (['failed', 'canceled', 'cancelled', 'rejected'].includes(state)) {
          item.delivery.status = 'provider_task_failed';
          updates.push({ packageId: item.packageId, status: 'provider_task_failed', taskState: state });
        } else if (['input-required', 'auth-required'].includes(state)) {
          updates.push({ packageId: item.packageId, status: 'provider_requests_input', taskState: state }); // payload is fixed by the quote; surfaced to a human
        } else if (state !== 'completed') {
          updates.push({ packageId: item.packageId, status: 'still_in_progress', taskState: state });
        } else {
          const retrievedAt = nowIso();
          const meta = { provider: item.provider, taskId: item.commissioning.taskId, retrievedAt };
          let parsed = parseTaskArtifacts(result.rawTask?.artifacts, meta);
          if (parsed.missing) parsed = parseTaskArtifacts(result.artifacts, meta);
          if (parsed.missing || parsed.combinedText.length < 20) {
            item.delivery.status = 'completed_without_artifact';
            execution.ledger.push({ at: nowIso(), event: 'task_completed_without_usable_artifact', details: { packageId: item.packageId, warnings: parsed.warnings } });
            updates.push({ packageId: item.packageId, status: 'completed_without_artifact', warnings: parsed.warnings });
          } else {
            recordPackageDeliverable(execution, { packageId: item.packageId, taskId: item.commissioning.taskId, content: parsed.combinedText, receivedAt: retrievedAt });
            item.delivery.untrusted = true;
            item.delivery.warnings = parsed.warnings;
            item.delivery.artifacts = parsed.artifacts.map(({ content, ...rest }) => rest);
            updates.push({ packageId: item.packageId, status: 'deliverable_recorded', contentHash: item.delivery.contentHash, warnings: parsed.warnings });
          }
        }
        await save(execution, 'sync', item.packageId);
      }
      if (execution.packages.some((p) => ['provider_task_failed', 'completed_without_artifact'].includes(p.delivery.status))) execution.status = 'attention_required';
      execution.updatedAt = nowIso();
      await save(execution, 'sync_complete');
      return { execution, updates };
    },

    async runSyncLoop(execution, { intervalMs = 10_000, maxIterations = 60, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
      let iterations = 0;
      while (iterations < maxIterations) {
        iterations += 1;
        await this.sync(execution);
        const outstanding = execution.packages.filter((p) => p.commissioning.status === 'commissioned' && p.delivery.status === 'awaiting_provider');
        if (!outstanding.length) return { execution, iterations, outstanding: [] };
        await sleep(intervalMs);
      }
      return { execution, iterations, outstanding: execution.packages.filter((p) => p.delivery.status === 'awaiting_provider' && p.commissioning.status === 'commissioned').map((p) => p.packageId) };
    },

    async evaluate(execution, packageId) {
      let extra = null;
      await evaluatePackageDeliverable(execution, { packageId, evaluator: async (args) => { const r = await evaluator(args); extra = { limitation: r.limitation, signals: r.signals }; return r; } });
      const item = execution.packages.find((p) => p.packageId === packageId);
      if (extra) Object.assign(item.evaluation, extra, { kind: 'structural' });
      await save(execution, 'evaluated', packageId);
      return execution;
    },
    async evaluateAll(execution) {
      for (const item of execution.packages) if (item.delivery.status === 'delivered_pending_evaluation') await this.evaluate(execution, item.packageId);
      return execution;
    },
    async accept(execution, { packageId, acceptedBy }) {
      acceptPackageDeliverable(execution, { packageId, acceptedBy });
      await save(execution, 'accepted', packageId);
      return execution;
    },
    recover: recoverExecution
  };
}
