import { createExecutionClient } from './execution-client.js';

const $ = (selector) => document.querySelector(selector);
const PROJECT_STORAGE_KEY = 'workrelay:last-project:v1';
const money = (amount, currency = 'USDC') => `${Number(amount || 0).toFixed(2)} ${currency}`;
const esc = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));
const metric = (label, value) => `<div class="metric"><div class="metric-label">${esc(label)}</div><div class="metric-value">${esc(value)}</div></div>`;

let currentSession = null;
let currentMode = 'demo';
let currentDisplayCurrency = 'DEMO USD';
let currentProject = null;

const identityReady = fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' }).then(async (response) => {
  if (!response.ok) throw new Error('Unable to establish browser identity. Reload the page to retry.');
  return response.json();
});

async function apiFetch(input, init = {}) {
  await identityReady;
  return fetch(input, { credentials: 'same-origin', cache: 'no-store', ...init });
}

function rememberProject(projectId) {
  try {
    if (projectId) localStorage.setItem(PROJECT_STORAGE_KEY, projectId);
    else localStorage.removeItem(PROJECT_STORAGE_KEY);
  } catch {
    // Project continuity remains available for this page even when browser storage is blocked.
  }
}

async function refreshCredits() {
  try {
    await identityReady;
    const response = await fetch('/api/demo-balance', { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Balance unavailable');
    $('#ip-balance').textContent = `$${data.balance.perIp.remaining.toFixed(2)} / $${data.balance.perIp.limit.toFixed(2)}`;
    $('#pool-balance').textContent = `$${data.balance.global.remaining.toFixed(2)} / $${data.balance.global.limit.toFixed(2)}`;
    if (currentMode === 'demo') {
      $('#budget').max = Math.min(data.balance.perProjectLimit, data.balance.perIp.remaining);
      if (Number($('#budget').value) > Number($('#budget').max)) $('#budget').value = $('#budget').max;
      $('#budget-note').textContent = `No sign-up or wallet required. Up to $${data.balance.perProjectLimit.toFixed(2)} per project, within your IP allowance. Simulated recommendations consume credits; unused reservation is released.`;
    }
  } catch {
    $('#ip-balance').textContent = 'Unavailable';
    $('#pool-balance').textContent = 'Unavailable';
  }
}

function updateCreditBalance(balance) {
  if (!balance) return;
  $('#ip-balance').textContent = `$${balance.perIp.remaining.toFixed(2)} / $${balance.perIp.limit.toFixed(2)}`;
  $('#pool-balance').textContent = `$${balance.global.remaining.toFixed(2)} / $${balance.global.limit.toFixed(2)}`;
  $('#budget').max = Math.min(balance.perProjectLimit, balance.perIp.remaining);
}

$('#mode').addEventListener('change', () => {
  const selectedMode = $('#mode').value;
  if (!currentSession) currentMode = selectedMode;
  $('#currency-label').textContent = selectedMode === 'demo' ? 'DEMO USD' : 'USDC';
  $('#budget').max = selectedMode === 'demo' ? '5' : '1000000';
  $('#budget').value = selectedMode === 'demo' ? '5' : '10';
  const nextProjectNote = selectedMode === 'demo'
    ? 'Demo credits are free, simulated and IP-capped. They are not money or a payment method.'
    : 'Live mode discovers marketplace agents and requests unpaid quotes only. No provider is commissioned and no funds are spent.';
  $('#budget-note').textContent = currentSession
    ? `This selection applies to your next project. The open project remains ${currentMode === 'demo' ? 'SIMULATED' : 'LIVE · UNPAID QUOTES ONLY'}. ${nextProjectNote}`
    : nextProjectNote;
});

$('#task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter || $('#task-form button[type="submit"]');
  const objective = $('#objective').value.trim();
  button.disabled = true;
  button.textContent = 'Building plan…';
  $('#results').classList.remove('hidden');
  $('#notice').className = 'notice';
  $('#notice').textContent = 'Discovering providers and constructing a budget-constrained work breakdown…';
  $('#proposal').classList.add('hidden');
  $('#readiness').classList.add('hidden');
  $('#execution').classList.add('hidden');
  try {
    const response = await apiFetch('/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objective, budget: $('#budget').value, currency: 'USDC', mode: $('#mode').value })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to create project plan');
    currentSession = data.sessionId;
    currentMode = data.mode || $('#mode').value;
    currentDisplayCurrency = data.displayCurrency || (currentMode === 'demo' ? 'DEMO USD' : 'USDC');
    currentProject = data;
    rememberProject(currentSession);
    hydrateProject(data);
    updateCreditBalance(data.credits?.balance);
    $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    $('#notice').className = 'notice warn';
    $('#notice').textContent = error.message;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Build project plan <span>→</span>';
  }
});

function hydrateProject(project, { restored = false } = {}) {
  currentProject = project;
  currentSession = project.sessionId || project.id;
  currentMode = project.mode || project.discovery?.mode || 'demo';
  currentDisplayCurrency = project.displayCurrency || (currentMode === 'demo' ? 'DEMO USD' : 'USDC');
  if (currentSession) rememberProject(currentSession);
  $('#mode').value = currentMode;
  $('#currency-label').textContent = currentDisplayCurrency;
  $('#budget').max = currentMode === 'demo' ? '5' : '1000000';
  $('#budget-note').textContent = currentMode === 'demo'
    ? 'Demo credits are free, simulated and IP-capped. They are not money or a payment method.'
    : 'Live mode discovers marketplace agents and requests unpaid quotes only. No provider is commissioned and no funds are spent.';
  if (project.plan?.objective) $('#objective').value = project.plan.objective;
  if (project.plan?.budget?.amount) $('#budget').value = project.plan.budget.amount;
  $('#results').classList.remove('hidden');
  renderPlan(project);
  if (project.proposal) {
    renderProposal(project.proposal, currentMode);
    loadReadiness(currentMode);
  } else {
    $('#proposal').classList.add('hidden');
    $('#readiness').classList.add('hidden');
  }
  if (project.execution) {
    renderExecution({ execution: project.execution, report: project.report, workflow: project.workflow });
    $('#execution').classList.remove('hidden');
  } else {
    $('#execution').classList.add('hidden');
  }
  if (project.liveExecutionRecord) {
    currentLifecycleExecutionId = project.liveExecutionRecord.executionId;
    $('#linked-live-execution').classList.remove('hidden');
    renderLifecycleExecution(project.liveExecutionRecord, project.paymentAudit, project.dispatchPreview, $('#linked-lifecycle-record'));
  } else {
    $('#linked-live-execution').classList.add('hidden');
  }
  if (restored) {
    $('#notice').className = 'notice';
    $('#notice').textContent = `Reopened this browser's saved project. ${project.workflow?.safety?.note || 'Project actions remain owner-scoped.'}`;
  }
}

async function restoreSavedProject() {
  let projectId = null;
  try { projectId = localStorage.getItem(PROJECT_STORAGE_KEY); } catch { return; }
  if (!projectId) return;
  try {
    const response = await apiFetch(`/api/project/${encodeURIComponent(projectId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Saved project could not be reopened.');
    hydrateProject(data, { restored: true });
  } catch (error) {
    $('#notice').className = 'notice warn';
    $('#notice').textContent = `Saved project continuity is unavailable: ${error.message} Start a new project to continue.`;
    $('#results').classList.remove('hidden');
  }
}

function renderPlan(project) {
  const plan = project.plan;
  if (!plan) return;
  const discovery = project.discovery || {};
  $('#result-title').textContent = 'Your project blueprint';
  $('#mode-pill').textContent = currentMode === 'demo' ? 'SIMULATED MODE' : 'LIVE · UNPAID QUOTES ONLY';
  $('#notice').className = `notice${currentMode === 'demo' ? ' warn' : ''}`;
  $('#notice').textContent = discovery.warning || (currentMode === 'demo'
    ? 'Demo project: provider records, quote responses and delivery outputs are simulated.'
    : 'Live discovery uses marketplace listing metadata. Provider claims are not independently audited.');
  const packageCount = Array.isArray(plan.workPackages) ? plan.workPackages.length : 0;
  const candidateCount = (plan.workPackages || []).reduce((total, item) => total + (item.providerCandidates?.length || 0), 0);
  $('#plan-summary').innerHTML = metric('PROJECT BUDGET', money(plan.budget.amount, currentDisplayCurrency))
    + metric('WORK PACKAGES', packageCount)
    + metric('PROVIDER CANDIDATES', candidateCount);
  $('#package-count').textContent = `${packageCount} PACKAGES`;
  const packageNames = new Map((plan.workPackages || []).map((item) => [item.id, item.title]));
  $('#packages').innerHTML = (plan.workPackages || []).map((workPackage, index) => {
    const dependencies = (workPackage.dependsOn || []).map((id) => packageNames.get(id) || id);
    const candidateHtml = workPackage.providerCandidates?.length
      ? workPackage.providerCandidates.map((agent) => `<span class="candidate">${esc(agent.name || agent.handle || 'Provider')} · ${Math.round(Number(agent.score) || 0)} pts</span>`).join('')
      : '<span class="candidate">No eligible provider found</span>';
    return `<article class="package">
      <div class="package-top"><div><span class="package-index">WORK PACKAGE ${String(index + 1).padStart(2, '0')}</span><h4>${esc(workPackage.title)}</h4><p>${esc(workPackage.brief)}</p></div><div class="ceiling">≤ ${esc(money(workPackage.budgetCeiling, currentDisplayCurrency))}</div></div>
      ${dependencies.length ? `<div class="dependency-note">Depends on: ${esc(dependencies.join(' · '))}</div>` : '<div class="dependency-note">Can start independently</div>'}
      <div class="candidate-row">${candidateHtml}</div>
      <div class="criteria-preview"><strong>Acceptance criteria</strong><ul>${(workPackage.acceptanceCriteria || []).map((criterion) => `<li>${esc(criterion)}</li>`).join('')}</ul></div>
    </article>`;
  }).join('');
  $('#quote-description').textContent = currentMode === 'demo'
    ? 'Compare illustrative provider prices. No marketplace call, provider hiring or payment occurs in demo mode.'
    : 'WorkRelay will request unpaid quotes from the shortlisted Agent Market providers. No payment credentials are attached.';
  $('#quote-button').disabled = false;
  $('#quote-button').textContent = currentMode === 'demo' ? 'Simulate quote comparison →' : 'Request unpaid quotes →';
  $('#execute-button').classList.add('hidden');
  renderWorkflow(project.workflow);
}

$('#quote-button').addEventListener('click', async () => {
  if (!currentSession) return;
  const button = $('#quote-button');
  button.disabled = true;
  button.textContent = currentMode === 'demo' ? 'Simulating quote comparison…' : 'Requesting unpaid quotes…';
  try {
    const response = await apiFetch('/api/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSession })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Quote request failed');
    currentDisplayCurrency = data.displayCurrency || currentDisplayCurrency;
    currentProject = { ...currentProject, ...data };
    renderProposal(data.proposal, currentMode);
    renderWorkflow(data.workflow);
    await loadReadiness(currentMode);
    updateCreditBalance(data.creditSettlement?.balance);
  } catch (error) {
    $('#proposal').classList.remove('hidden');
    $('#proposal').innerHTML = `<div class="notice warn">${esc(error.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = currentMode === 'demo' ? 'Refresh simulation →' : 'Refresh live quote comparison →';
  }
});

function renderProposal(proposal, mode) {
  const element = $('#proposal');
  element.classList.remove('hidden');
  const cards = (proposal.packages || []).map((workPackage) => {
    const recommendation = workPackage.recommendation;
    const providerLines = (workPackage.providerQuotes || []).map((quote) => {
      const option = quote.recommendedOption;
      const label = option ? money(option.amount, currentDisplayCurrency) : String(quote.requestStatus || 'no quote').replaceAll('_', ' ');
      const detail = option
        ? (option.eligible ? 'within package ceiling' : option.status || 'not eligible')
        : quote.reason || quote.requestStatus || 'No usable quote';
      return `<div class="quote-line"><span>${esc(quote.providerName || quote.provider || 'Provider')}<br><small>${esc(detail)}</small></span><strong>${esc(label)}</strong></div>`;
    }).join('');
    return `<article class="quote-package"><header><span>${esc(workPackage.title || workPackage.packageId)}</span><span>${recommendation ? esc(money(recommendation.price, currentDisplayCurrency)) : 'NO RECOMMENDATION'}</span></header>${providerLines || '<div class="quote-line">No provider quotes were returned.</div>'}</article>`;
  }).join('');
  const status = String(proposal.status || 'unknown').replaceAll('_', ' ');
  const note = mode === 'demo'
    ? 'All prices, quote responses and provider records shown in this run are simulated. Demo credits are an access allowance only—not money, USDC or a payment method.'
    : 'These are live unpaid provider quote responses. A quote is not approval, a commission, or a payment.';
  const recipientNote = proposal.recipientAudit?.note || 'Provider payment routing has not been independently verified.';
  const packageStates = (currentProject?.liveExecutionRecords || []).flatMap((record) => record.packages || []);
  const deferredCards = (proposal.deferredPackages || []).map((pkg) => {
    const dependenciesReady = (pkg.dependsOn || []).every((dependencyId) => packageStates.some((source) => source.packageId === dependencyId && source.acceptance?.status === 'accepted' && source.evaluation?.passed === true && Boolean(source.delivery?.contentHash)));
    const existing = currentProject?.deferredProposals?.[pkg.packageId];
    const followup = existing?.proposal?.packages?.[0];
    const quoteValue = followup?.recommendation ? money(followup.recommendation.price, currentDisplayCurrency) : '';
    const statusText = existing?.status === 'quoted_not_approved'
      ? `Fresh quote received${quoteValue ? ` · ${quoteValue}` : ''}. It requires a separate explicit approval.`
      : existing?.status === 'approved' ? 'A separate approval record exists. Commissioning remains disabled.'
      : dependenciesReady ? 'Upstream deliverables are accepted. You can request a new quote containing those exact inputs.'
      : 'Waiting for upstream packages to pass evaluation and receive human acceptance.';
    return `<article class="quote-package deferred-package"><header><span>${esc(pkg.title || pkg.packageId)} · DEFERRED</span><span>${esc(money(pkg.budgetCeiling, currentDisplayCurrency))} ceiling</span></header><p class="lifecycle-note">Depends on: ${esc((pkg.dependsOn || []).join(', '))}</p><p>${esc(statusText)}</p>${existing?.proposal ? `<div class="notice">New proposal: ${esc(existing.proposal.proposalId)} · ${esc(String(existing.proposal.status || 'unknown').replaceAll('_', ' '))}</div>` : ''}<button class="secondary deferred-quote-button" data-package="${esc(pkg.packageId)}" ${dependenciesReady ? '' : 'disabled'}>Request fresh downstream quote</button></article>`;
  }).join('');
  element.innerHTML = `<div class="proposal-head"><div><div class="eyebrow">03 / QUOTE REVIEW</div><h3>Procurement comparison</h3><div class="proposal-id">${esc(proposal.proposalId || '')}</div></div><span class="status">${esc(status.toUpperCase())}</span></div>
    ${cards}
    ${deferredCards ? `<section class="deferred-work"><div class="eyebrow">DEFERRED DEPENDENT WORK</div><p>These packages are not quoted yet. WorkRelay will wait for the exact upstream outputs to be evaluated and human-accepted, then request a new quote for a brief that includes those outputs. The original quote cannot be reused.</p>${deferredCards}</section>` : ''}
    <div class="totals"><div class="total"><div class="metric-label">RECOMMENDED SPEND</div><b>${esc(money(proposal.budget?.recommendedSpend, currentDisplayCurrency))}</b></div><div class="total"><div class="metric-label">BUDGET REMAINING</div><b>${esc(money(proposal.budget?.remainingAfterRecommendations, currentDisplayCurrency))}</b></div></div>
    <div class="safety"><strong>${mode === 'demo' ? 'Simulation only.' : 'Live quotes received; live execution remains blocked.'}</strong><br>${esc(note)} ${esc(recipientNote)} No hiring, wallet signing, payment authorization or transfer has occurred.</div>`;
  element.querySelectorAll('.deferred-quote-button').forEach((button) => button.addEventListener('click', () => requestDeferredQuote(button.dataset.package, button)));
  const runButton = $('#execute-button');
  runButton.classList.toggle('hidden', mode !== 'demo' || proposal.status !== 'simulation_only');
  runButton.disabled = false;
  runButton.textContent = 'Run next eligible simulated packages →';
}

async function requestDeferredQuote(packageId, button) {
  if (!currentSession || currentMode !== 'live') return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Requesting fresh unpaid quote…';
  try {
    const response = await apiFetch(`/api/project/${encodeURIComponent(currentSession)}/dependencies/${encodeURIComponent(packageId)}/quote`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Fresh downstream quote failed');
    currentProject.deferredProposals ??= {};
    currentProject.deferredProposals[packageId] = { proposal: data.proposal, status: 'quoted_not_approved', requestFingerprint: data.handoff.requestFingerprint, createdAt: new Date().toISOString() };
    renderProposal(currentProject.proposal, currentMode);
  } catch (error) {
    const card = button.closest('.deferred-package');
    let message = card?.querySelector('.deferred-error');
    if (!message && card) { message = document.createElement('p'); message.className = 'notice warn deferred-error'; card.append(message); }
    if (message) message.textContent = error.message;
    button.disabled = false;
    button.textContent = original;
  }
}

$('#execute-button').addEventListener('click', async () => {
  if (!currentSession || currentMode !== 'demo' || !currentProject?.proposal) return;
  const button = $('#execute-button');
  button.disabled = true;
  button.textContent = 'Running next eligible simulated tasks…';
  try {
    const response = await apiFetch('/api/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSession })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Simulation failed');
    currentProject = { ...currentProject, execution: data.execution, report: data.report, workflow: data.workflow };
    renderExecution(data);
    $('#execution').classList.remove('hidden');
    $('#execution').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    $('#execution').classList.remove('hidden');
    $('#execution-warning').textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Run next eligible simulated packages →';
  }
});

async function executionAction(path, packageId, extra = {}) {
  const response = await apiFetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: currentSession, packageId, ...extra })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Action failed');
  currentProject = { ...currentProject, execution: data.execution, report: data.report, workflow: data.workflow };
  renderExecution(data);
}

function renderExecution(data) {
  const execution = data.execution;
  if (!execution) return;
  $('#execution-warning').textContent = execution.warning || 'Execution status loaded.';
  $('#execution-mode-pill').textContent = execution.mode === 'simulation_only' ? 'SIMULATION ONLY' : 'RECORDED EXECUTION';
  $('#execution-packages').innerHTML = (execution.packages || []).map((workPackage) => {
    const evaluation = workPackage.evaluation || { status: 'not_evaluated', results: [] };
    const evaluationHtml = evaluation.status === 'not_evaluated' ? '' : `<div class="evaluation"><strong>Structural evaluation: ${esc(String(evaluation.status).replaceAll('_', ' '))}</strong><p>${esc(evaluation.limitation || 'Structural checks only; factual accuracy and source validity have not been verified.')}</p>${(evaluation.results || []).map((result) => `<div class="check-row"><span>${result.passed ? '✓' : '×'} ${esc(result.criterion)}</span><small>${esc(result.evidence)}</small></div>`).join('')}</div>`;
    const actions = workPackage.status === 'delivered_pending_evaluation'
      ? `<button class="secondary action-evaluate" data-id="${esc(workPackage.packageId)}">Run structural checks</button>`
      : workPackage.status === 'awaiting_human_review'
        ? `<div class="review-actions"><button class="secondary action-review" data-id="${esc(workPackage.packageId)}" data-decision="accept">Accept deliverable</button><button class="ghost action-review" data-id="${esc(workPackage.packageId)}" data-decision="request_revision">Request revision</button></div>`
        : '';
    const waiting = workPackage.status === 'queued_waiting_for_dependencies'
      ? `<div class="notice">Waiting for upstream human acceptance: ${esc((workPackage.waitingOn || workPackage.dependsOn || []).join(', '))}. A dependent package cannot start based on delivery alone.</div>` : '';
    const inputNote = (workPackage.dependencyInputs || []).length
      ? `<div class="lifecycle-note">Accepted upstream inputs consumed: ${(workPackage.dependencyInputs || []).map((source) => `${esc(source.packageId)} · SHA-256 ${esc(source.contentHash)}`).join(' | ')}. New simulated request fingerprint: ${esc(workPackage.dependencyHandoff?.requestFingerprint || 'not recorded')}.</div>` : '';
    return `<article class="execution-card"><header><div><span class="package-index">${esc(workPackage.packageId)}</span><h3>${esc(workPackage.title)}</h3><p>${esc(workPackage.providerName || workPackage.provider || 'Provider')} · ${esc(workPackage.taskId || 'Task ID unavailable')}</p></div><span class="status">${esc(String(workPackage.status || 'unknown').replaceAll('_', ' ').toUpperCase())}</span></header>${waiting}<pre>${esc(workPackage.deliverable || 'Waiting for eligible upstream inputs…')}</pre>${inputNote}${evaluationHtml}${actions}</article>`;
  }).join('');
  renderWorkflow(data.workflow || currentProject?.workflow);
  const report = data.report || currentProject?.report;
  if (report) renderFinalReport(report);
}

function renderWorkflow(workflow) {
  if (!workflow) return;
  $('#project-state').textContent = String(workflow.projectStatus || 'in progress').replaceAll('_', ' ').toUpperCase();
  $('#next-action').textContent = `NEXT: ${workflow.nextAction || 'Review the project workspace.'}`;
  $('#workflow-steps').innerHTML = (workflow.steps || []).map((step, index) => {
    const statusLabel = step.status === 'not_applicable' ? 'N/A' : String(step.status || 'pending').replaceAll('_', ' ');
    return `<li class="workflow-step state-${esc(step.status)}"><span class="workflow-number">${index + 1}</span><div><strong>${esc(step.label)}</strong><span class="workflow-state">${esc(statusLabel)}</span><p>${esc(step.detail)}</p></div></li>`;
  }).join('');
}

function renderFinalReport(report) {
  $('#final-report').classList.remove('hidden');
  $('#final-report').innerHTML = `<div class="proposal-head"><div><div class="eyebrow">05 / CONSOLIDATED HANDOFF</div><h3>${esc(report.title || 'Project report')}</h3><div class="proposal-id">Execution ${esc(report.executionId || '')}</div></div><span class="status">${esc(String(report.status || 'available').replaceAll('_', ' ').toUpperCase())}</span></div>
    <p>${esc(report.disclosure || 'Report disclosure unavailable.')}</p>
    <div class="summary-grid">${metric('HUMAN-ACCEPTED PACKAGES', report.completedPackages ?? 0)}${metric('TOTAL PACKAGES', report.totalPackages ?? 0)}${metric('REAL MONEY SPENT', '$0.00')}</div>
    <div class="report-disclosure">${esc(report.payment?.note || 'No payment settlement is inferred from this simulated workflow.')}</div>
    <button id="download-report" class="secondary" type="button">Download project report (.md)</button>`;
  $('#download-report').addEventListener('click', () => downloadReport(report));
}

function downloadReport(report) {
  const lines = [
    `# ${report.title || 'WorkRelay project report'}`,
    '',
    `> ${report.disclosure || 'Execution disclosure unavailable.'}`,
    '',
    `Execution ID: ${report.executionId || 'unknown'}`,
    `Status: ${report.status || 'unknown'}`,
    `Human-accepted packages: ${report.completedPackages ?? 0}/${report.totalPackages ?? 0}`,
    '',
    ...((report.sections || []).flatMap((section) => [
      `## ${section.title || 'Work package'}`,
      `Provider: ${section.provider || 'unknown'}`,
      `Status: ${section.status || 'unknown'}`,
      `Content SHA-256: ${section.contentHash || 'not recorded'}`,
      `Evaluation: ${section.evaluation?.status || 'not evaluated'}`,
      '',
      section.deliverable || 'No deliverable was recorded.',
      ''
    ])),
    '## Payment and trust status',
    report.payment?.note || 'No real money was spent in the simulation.',
    `Payment status: ${report.payment?.status || 'not independently verified'}`,
    '',
    '## Project event ledger',
    ...((report.ledger || []).map((entry) => `- ${entry.at || ''} — ${entry.event || 'event'} — ${JSON.stringify(entry.details || {})}`)),
    ''
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'workrelay-project-report.md';
  anchor.click();
  URL.revokeObjectURL(url);
}

async function loadReadiness(mode) {
  const element = $('#readiness');
  try {
    const response = await apiFetch('/api/readiness', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: currentSession })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Readiness check failed');
    const readiness = data.readiness;
    element.classList.remove('hidden');
    const blockers = (readiness.blockers || []).map((blocker) => `<div class="notice warn"><strong>${esc(String(blocker.code || 'blocked').replaceAll('_', ' '))}</strong>${blocker.packageId ? ` · ${esc(blocker.packageId)}` : ''}<br>${esc(blocker.message)}</div>`).join('');
    element.innerHTML = `<div class="proposal-head"><div><div class="eyebrow">PROCUREMENT SAFETY GATE</div><h3>${data.mode === 'LIVE' ? 'Live proposal' : 'Simulated proposal'} · ${readiness.ready ? 'checks passed' : 'commissioning blocked'}</h3></div><span class="status">${esc(data.mode)}</span></div>${blockers}<div class="safety"><strong>${esc(data.note)}</strong><br>Readiness is not approval. No provider is hired and no payment is sent by this check.</div>`;
  } catch (error) {
    element.classList.remove('hidden');
    element.innerHTML = `<div class="notice warn">${esc(error.message)}</div>`;
  }
}

// Existing execution-record lifecycle. These operations remain owner-scoped and read-only
// except for explicit structural evaluation and human acceptance of an existing deliverable.
const lifecycleClient = createExecutionClient((...args) => apiFetch(...args));
let currentLifecycleExecutionId = null;
const lifecycleStatus = (message, kind = '', target = $('#lifecycle-status')) => {
  const element = target;
  element.classList.remove('hidden', 'warn');
  element.classList.add('notice');
  if (kind === 'error') element.classList.add('warn');
  element.textContent = message;
};

$('#execution-load-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#execution-load-button');
  const id = $('#execution-id').value.trim();
  button.disabled = true;
  button.textContent = 'Loading…';
  currentLifecycleExecutionId = null;
  $('#lifecycle-record').classList.add('hidden');
  lifecycleStatus('Loading the owner-scoped execution record…');
  try {
    const data = await lifecycleClient.get(id);
    currentLifecycleExecutionId = id;
    renderLifecycleExecution(data.execution, data.paymentAudit, data.dispatchPreview);
    lifecycleStatus('Execution loaded. Operations remain subject to server-side owner checks.');
  } catch (error) {
    lifecycleStatus(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Load execution';
  }
});

async function refreshCurrentProjectSnapshot() {
  if (!currentSession) return;
  try {
    const response = await apiFetch(`/api/project/${encodeURIComponent(currentSession)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Project refresh failed');
    currentProject = { ...currentProject, ...data };
    if (currentProject.proposal) renderProposal(currentProject.proposal, currentMode);
  } catch (error) {
    $('#linked-lifecycle-status').textContent = `Project state refresh failed: ${error.message}`;
  }
}

function renderLifecycleExecution(execution, paymentAudit, dispatchPreview = null, root = $('#lifecycle-record')) {
  if (execution.executionId) currentLifecycleExecutionId = execution.executionId;
  const setStatus = (message, kind = '') => lifecycleStatus(message, kind, root.id === 'linked-lifecycle-record' ? $('#linked-lifecycle-status') : $('#lifecycle-status'));
  root.classList.remove('hidden');
  const paymentRows = (paymentAudit?.rows || []).map((row) => `<div class="check-row"><span>${esc(row.packageId)} · ${esc(row.state)}</span><small>${esc(row.note || 'Payment state is tracked independently.')}</small></div>`).join('');
  const interrupted = (execution.packages || []).some((item) => item.commissioning?.status === 'request_in_progress');
  const recoveryPanel = interrupted ? `<section class="dispatch-panel"><div class="notice warn">One or more commission requests were interrupted while in flight. Their payment outcome may be unknown. Recovering marks them ambiguous; it never retries or resends a payment.</div><button class="secondary" id="lifecycle-recover" type="button">Mark interrupted requests as unknown</button></section>` : '';
  const dispatchPanel = dispatchPreview ? `<section class="dispatch-panel"><div class="lifecycle-note"><strong>Paid dispatch preview</strong><br>${dispatchPreview.ready ? `${dispatchPreview.packages.length} package(s) ready · ${esc(money(dispatchPreview.total, dispatchPreview.currency))}` : 'No packages are currently dispatchable.'} ${dispatchPreview.held?.length ? `${dispatchPreview.held.length} package(s) held for dependencies or review.` : ''}</div>${(dispatchPreview.blockers || []).map((blocker) => `<div class="notice warn">${esc(blocker.message || blocker.code)}</div>`).join('')}${dispatchPreview.ready ? `<div class="check-row">${dispatchPreview.packages.map((item) => `${esc(item.packageId)} · ${esc(item.provider)} · ${esc(money(item.amount, item.currency))}`).join(' | ')}</div><button class="secondary" id="lifecycle-dispatch" type="button">Commission these packages…</button>` : ''}</section>` : '';
  root.innerHTML = `<div class="notice"><strong>${esc(execution.status || 'status unavailable')}</strong><br>Provider completion, structural evaluation, human acceptance and payment settlement are separate states. An explicit dispatch step is required for any paid provider request.</div>${recoveryPanel}${dispatchPanel}
    <div class="lifecycle-note">Payment audit (independent): ${paymentRows || 'Payment state remains separately recorded.'}</div>
    ${(execution.packages || []).map((workPackage) => {
      const evaluation = workPackage.evaluation || {};
      const evaluationBlock = evaluation.status && evaluation.status !== 'not_evaluated'
        ? `<div class="lifecycle-evaluation"><strong>Structural evaluation: ${esc(evaluation.status)}</strong><p>${esc(evaluation.limitation || 'Structural checks only. Factual accuracy and source validity have not been verified.')}</p>${(evaluation.criterionResults || []).map((result) => `<div class="check-row"><span>${result.passed ? 'Pass' : 'Review'} · ${esc(result.criterion || result.name || 'Criterion')}</span><small>${esc(result.evidence || '')}</small></div>`).join('')}</div>`
        : '';
      const canEvaluate = workPackage.delivery?.status === 'delivered_pending_evaluation';
      const canAccept = evaluation.passed === true && workPackage.acceptance?.status !== 'accepted';
      const needsReconciliation = workPackage.commissioning?.status === 'outcome_unknown';
      const reconciliationPanel = needsReconciliation ? `<div class="reconcile-panel" data-package="${esc(workPackage.packageId)}"><strong>Ambiguous commission outcome</strong><p>Check the official marketplace/provider record first. This form records your attestation; WorkRelay cannot independently verify the link or claim.</p><label>What does the marketplace record show?</label><select class="reconcile-outcome"><option value="commissioned">A task/hire was created</option><option value="rejected">No task/hire was created</option></select><label>Official evidence URL</label><input class="reconcile-evidence" type="url" required placeholder="https://market.near.ai/…"><div class="commissioned-fields"><label>Confirmed task ID</label><input class="reconcile-task-id" type="text" maxlength="200" placeholder="Marketplace task ID"><label>Payment state in the marketplace record</label><select class="reconcile-payment-state"><option value="held">Authorization held</option><option value="unknown">Payment state unknown</option></select></div><label class="reconcile-attest"><input class="reconcile-confirm" type="checkbox"> I inspected this official record and attest that the selected outcome and task/payment details are accurate.</label><button class="secondary lifecycle-reconcile" data-package="${esc(workPackage.packageId)}" type="button">Record reconciliation</button></div>` : '';
      return `<article class="lifecycle-package" data-package="${esc(workPackage.packageId)}"><h3>${esc(workPackage.title || workPackage.packageId)}</h3><p>Provider: ${esc(workPackage.provider || '—')} · Task: ${esc(workPackage.commissioning?.taskId || '—')}</p><p>Commission: ${esc(workPackage.commissioning?.status || 'unknown')} · Delivery: ${esc(workPackage.delivery?.status || 'unknown')} · Acceptance: ${esc(workPackage.acceptance?.status || 'not_requested')} · Payment: ${esc(workPackage.payment?.status || 'unknown')}</p><pre class="lifecycle-deliverable">${esc(workPackage.delivery?.content || 'No deliverable has been recorded.')}</pre>${evaluationBlock}${reconciliationPanel}<div class="lifecycle-actions">${canEvaluate ? `<button class="secondary lifecycle-evaluate" data-package="${esc(workPackage.packageId)}">Run structural evaluation</button>` : ''}${canAccept ? `<button class="secondary lifecycle-accept" data-package="${esc(workPackage.packageId)}">Accept deliverable…</button>` : ''}</div></article>`;
    }).join('')}
    <p class="lifecycle-note">Structural evaluation is not factual verification. Acceptance records your human decision only; it does not authorize or confirm payment settlement.</p>
    <button class="secondary" id="lifecycle-sync" type="button">Synchronize provider task status (read-only)</button>`;
  root.querySelector('#lifecycle-dispatch')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const packageSummary = dispatchPreview.packages.map((item) => `${item.packageId} — ${item.provider}: ${money(item.amount, item.currency)}`).join('\n');
    const message = `This will send paid A2A commission requests for the following approved packages:\n\n${packageSummary}\n\nTotal: ${money(dispatchPreview.total, dispatchPreview.currency)}\n\nThe x402 payment authorization may spend these funds. An uncertain result will be quarantined and will not be retried. Proceed?`;
    if (!window.confirm(message)) return;
    button.disabled = true;
    button.textContent = 'Submitting paid requests…';
    setStatus('Submitting only the packages shown in the current server-generated dispatch preview.');
    try {
      const data = await lifecycleClient.dispatch(currentLifecycleExecutionId, dispatchPreview.fingerprint);
      renderLifecycleExecution(data.execution, data.paymentAudit, data.dispatchPreview, root);
      setStatus(`Dispatch request processed. Commissioned: ${(data.dispatched || []).join(', ') || 'none'}. ${data.note}`);
      if (root.id === 'linked-lifecycle-record') await refreshCurrentProjectSnapshot();
    } catch (error) {
      setStatus(error.message, 'error');
      const freshButton = root.querySelector('#lifecycle-dispatch');
      if (freshButton) { freshButton.disabled = false; freshButton.textContent = 'Commission these packages…'; }
    }
  });
  root.querySelector('#lifecycle-recover')?.addEventListener('click', async (event) => {
    if (!window.confirm('Mark interrupted commission requests as outcome unknown? This never retries a request or sends payment.')) return;
    const button = event.currentTarget; button.disabled = true; button.textContent = 'Recovering…';
    try {
      const data = await lifecycleClient.recover(currentLifecycleExecutionId);
      const refreshed = await lifecycleClient.get(currentLifecycleExecutionId);
      renderLifecycleExecution(refreshed.execution, refreshed.paymentAudit, refreshed.dispatchPreview, root);
      setStatus(`Interrupted requests marked unknown: ${(data.recovered || []).join(', ') || 'none'}. No payment was resent.`);
    } catch (error) { setStatus(error.message, 'error'); }
  });
  root.querySelectorAll('.lifecycle-reconcile').forEach((button) => button.addEventListener('click', async () => {
    const panel = button.closest('.reconcile-panel');
    const outcome = panel.querySelector('.reconcile-outcome').value;
    const evidenceReference = panel.querySelector('.reconcile-evidence').value.trim();
    const taskId = panel.querySelector('.reconcile-task-id').value.trim();
    const paymentStatus = panel.querySelector('.reconcile-payment-state').value;
    const confirmed = panel.querySelector('.reconcile-confirm').checked;
    if (!confirmed) { setStatus('Confirm that you inspected the official marketplace record before recording reconciliation.', 'error'); return; }
    if (!evidenceReference || (outcome === 'commissioned' && !taskId)) { setStatus('Provide the official evidence URL and, for a created hire, the confirmed task ID.', 'error'); return; }
    const prompt = outcome === 'commissioned'
      ? `You attest that the marketplace confirms task ${taskId} exists and its payment state is ${paymentStatus}. Record this as an owner attestation?`
      : 'You attest that the marketplace confirms no task/hire was created. Record this as an owner attestation?';
    if (!window.confirm(`${prompt} WorkRelay does not independently verify the evidence.`)) return;
    button.disabled = true; button.textContent = 'Recording…';
    try {
      const data = await lifecycleClient.reconcile(currentLifecycleExecutionId, { packageId: button.dataset.package, outcome, evidenceReference, taskId: outcome === 'commissioned' ? taskId : null, paymentStatus: outcome === 'commissioned' ? paymentStatus : 'not_sent' });
      renderLifecycleExecution(data.execution, data.paymentAudit, data.dispatchPreview, root);
      setStatus(data.note);
      if (root.id === 'linked-lifecycle-record') await refreshCurrentProjectSnapshot();
    } catch (error) {
      button.disabled = false; button.textContent = 'Record reconciliation'; setStatus(error.message, 'error');
    }
  }));
  root.querySelectorAll('.reconcile-outcome').forEach((select) => select.addEventListener('change', () => {
    const fields = select.closest('.reconcile-panel').querySelector('.commissioned-fields');
    fields.classList.toggle('hidden', select.value !== 'commissioned');
  }));
  root.querySelector('#lifecycle-sync').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Synchronizing…';
    setStatus('Checking existing provider task states. No commissioning or retry will occur.');
    try {
      const data = await lifecycleClient.sync(currentLifecycleExecutionId);
      renderLifecycleExecution(data.execution, data.paymentAudit, data.dispatchPreview, root);
      setStatus(`Synchronization finished. ${data.updates.length} update(s) reported. ${data.note}`);
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      const freshButton = root.querySelector('#lifecycle-sync');
      if (freshButton) { freshButton.disabled = false; freshButton.textContent = 'Synchronize provider task status (read-only)'; }
    }
  });
  root.querySelectorAll('.lifecycle-evaluate').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Evaluating…';
    setStatus('Running structural checks only; this does not verify factual claims.');
    try {
      const data = await lifecycleClient.evaluate(currentLifecycleExecutionId, button.dataset.package);
      renderLifecycleExecution(data.execution, data.paymentAudit, data.dispatchPreview, root);
      setStatus(data.note || 'Structural evaluation recorded. No acceptance or payment settlement was inferred.');
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Run structural evaluation';
      setStatus(error.message, 'error');
    }
  }));
  root.querySelectorAll('.lifecycle-accept').forEach((button) => button.addEventListener('click', async () => {
    const confirmed = window.confirm('Accept this deliverable as the project owner? This records human acceptance only. It does NOT mean payment has settled or authorize any payment.');
    if (!confirmed) return;
    button.disabled = true;
    button.textContent = 'Recording acceptance…';
    setStatus('Recording your explicit acceptance. Payment settlement remains separate.');
    try {
      const data = await lifecycleClient.accept(currentLifecycleExecutionId, button.dataset.package);
      renderLifecycleExecution(data.execution, data.paymentAudit, data.dispatchPreview, root);
      setStatus(data.note || 'Human acceptance recorded. No payment settlement is implied.');
      if (root.id === 'linked-lifecycle-record') await refreshCurrentProjectSnapshot();
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Accept deliverable…';
      setStatus(error.message, 'error');
    }
  }));
}

refreshCredits();
restoreSavedProject();
