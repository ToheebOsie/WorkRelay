import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoCreditLedger } from '../src/demo/demo-credit-ledger.js';
import { createSessionStore } from '../src/orchestration/session-store.js';
import { createExecutionRecordStore } from '../src/storage/execution-record-store.js';
import { createPrincipalStore } from '../src/security/principal-store.js';

const secret = 'test-secret-that-is-long-enough';
const sessionId = 'session-1234567890abcdef';
const executionId = 'exec-1234567890abcdef';

test('backend exposes owner-scoped execution status and safe restart recovery; live start remains blocked', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workrelay-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = 43000 + Math.floor(Math.random() * 1000);
  const demoLedger = createDemoCreditLedger({ filePath: join(dir, 'credits.json'), secret });
  const principalStorePath = join(dir, 'principals.json');
  const identity = createPrincipalStore({ filePath: principalStorePath }).create();
  const ownerPrincipalId = identity.principal.principalId;
  createSessionStore({ filePath: join(dir, 'sessions.json') }).set(sessionId, { id: sessionId, mode: 'live', ownerPrincipalId, proposal: { status: 'ready_for_user_approval', packages: [], budget: { recommendedSpend: 0, amount: 1 }, approval: { required: true, status: 'not_requested' }, execution: { hiringStarted: false, paymentsAuthorized: false, paymentSent: false } } });
  await createExecutionRecordStore(join(dir, 'executions')).save({
    executionId, ownerPrincipalId, status: 'dispatching', approval: { confirmed: true, maxSpend: 1 },
    packages: [{ packageId: 'p1', provider: 'provider-a', price: 1, currency: 'USDC', commissioning: { status: 'request_in_progress' }, payment: { status: 'unknown' }, delivery: { status: 'awaiting_provider' } }],
    ledger: []
  });
  await createExecutionRecordStore(join(dir, 'executions')).save({ executionId: 'exec-foreign-12345678', ownerPrincipalId: '00000000-0000-4000-8000-000000000000', status: 'work_in_progress', approval: { confirmed: true, maxSpend: 1 }, packages: [], ledger: [] });
  await createExecutionRecordStore(join(dir, 'executions')).save({ executionId: 'exec-legacy-ip-123456', ownerIpHash: demoLedger.identify('127.0.0.1'), status: 'work_in_progress', approval: { confirmed: true, maxSpend: 1 }, packages: [], ledger: [] });
  await createExecutionRecordStore(join(dir, 'executions')).save({
    executionId: 'exec-deliverable-123456', ownerPrincipalId, status: 'deliverables_received_or_under_review', approval: { confirmed: true, maxSpend: 1 },
    packages: [{ packageId: 'research', provider: 'provider-a', price: 1, currency: 'USDC', brief: 'Research findings and source citations', acceptanceCriteria: ['Include research findings and source citations'],
      commissioning: { status: 'commissioned', taskId: 'task-2' },
      delivery: { status: 'delivered_pending_evaluation', content: 'Research findings: this report summarizes the market structure, relevant competitors, customer needs, and key opportunities. The analysis includes source citations and supporting references for the observations, with additional context about limitations and assumptions. Source: https://example.com/research', contentHash: 'a'.repeat(64), receivedAt: new Date().toISOString() },
      evaluation: { status: 'not_evaluated', criterionResults: [], passed: null, evaluatedAt: null },
      acceptance: { status: 'not_requested', acceptedBy: null, acceptedAt: null },
      payment: { status: 'unknown', amount: 1, currency: 'USDC', transactionId: null, settledAt: null }
    }], ledger: []
  });
  const linkedSessionId = 'session-linked-12345678';
  createSessionStore({ filePath: join(dir, 'sessions.json') }).set(linkedSessionId, {
    id: linkedSessionId, mode: 'live', ownerPrincipalId, executionId: 'exec-deliverable-123456',
    plan: { objective: 'A linked approved project record', budget: { amount: 1 }, workPackages: [] },
    proposal: { status: 'ready_for_user_approval', packages: [], budget: { recommendedSpend: 1, amount: 1 } }
  });
  const child = spawn(process.execPath, ['src/app-server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), NODE_ENV: 'test', SESSION_STORE_PATH: join(dir, 'sessions.json'), DEMO_CREDIT_LEDGER_PATH: join(dir, 'credits.json'), DEMO_CREDIT_IP_SECRET: secret, EXECUTION_LEDGER_DIR: join(dir, 'executions'), PRINCIPAL_STORE_PATH: principalStorePath }, stdio: 'ignore' });
  t.after(() => child.kill('SIGTERM'));
  const base = `http://127.0.0.1:${port}`;
  const request = (url, options = {}) => fetch(url, { ...options, headers: { ...(options.headers || {}), cookie: `workrelay_identity=${identity.token}` } });
  let health;
  for (let i = 0; i < 60; i++) {
    try { health = await request(`${base}/api/health`); if (health.ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(health?.status, 200, 'server should become ready');
  const status = await request(`${base}/api/execution/${executionId}`);
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.execution.executionId, executionId);
  assert.equal(statusBody.execution.ownerIpHash, undefined);
  assert.equal(statusBody.paymentAudit.rows[0].state, 'unknown_reconciliation_required');
  assert.equal(statusBody.liveSpendingEnabled, false);
  const linkedProjectResponse = await request(`${base}/api/project/${linkedSessionId}`);
  assert.equal(linkedProjectResponse.status, 200, await linkedProjectResponse.clone().text());
  const linkedProject = await linkedProjectResponse.json();
  assert.equal(linkedProject.liveExecutionRecord.executionId, 'exec-deliverable-123456');
  assert.equal(linkedProject.liveExecutionRecord.ownerPrincipalId, undefined);
  assert.equal(linkedProject.paymentAudit.rows[0].state, 'submitted_unverified');
  const unauthenticated = await fetch(`${base}/api/execution/${executionId}`);
  assert.equal(unauthenticated.status, 401, 'execution access requires a valid browser capability');
  const secondVisitor = await fetch(`${base}/api/auth/session`);
  assert.equal(secondVisitor.status, 200);
  const secondCookie = secondVisitor.headers.get('set-cookie');
  assert.match(secondCookie, /HttpOnly/);
  assert.match(secondCookie, /SameSite=Strict/);
  const secondToken = secondCookie.match(/workrelay_identity=([^;]+)/)[1];
  const secondAccess = await fetch(`${base}/api/execution/${executionId}`, { headers: { cookie: `workrelay_identity=${secondToken}` } });
  assert.equal(secondAccess.status, 403, 'different browser principals cannot read the owner execution');
  const legacyAccess = await request(`${base}/api/execution/exec-legacy-ip-123456`);
  assert.equal(legacyAccess.status, 403, 'legacy IP-only records must fail closed; no IP fallback is allowed');
  const crossOrigin = await request(`${base}/api/execution/${executionId}/recover`, { method: 'POST', headers: { origin: 'https://attacker.example' } });
  assert.equal(crossOrigin.status, 403, 'cross-origin state changes are rejected');
  const crossScheme = await request(`${base}/api/execution/${executionId}/recover`, { method: 'POST', headers: { origin: `https://127.0.0.1:${port}` } });
  assert.equal(crossScheme.status, 403, 'same-host requests from a different origin scheme are rejected');
  const sameSiteSibling = await request(`${base}/api/execution/${executionId}/recover`, { method: 'POST', headers: { 'sec-fetch-site': 'same-site' } });
  assert.equal(sameSiteSibling.status, 403, 'same-site but cross-origin browser requests are rejected when Origin is absent');
  const foreignStatus = await request(`${base}/api/execution/exec-foreign-12345678`);
  assert.equal(foreignStatus.status, 403, 'execution records must remain visitor-scoped');
  const foreignProject = await fetch(`${base}/api/project/${linkedSessionId}`, { headers: { cookie: `workrelay_identity=${secondToken}` } });
  assert.equal(foreignProject.status, 403, 'linked project and execution data must remain principal-scoped');

  for (const [path, body] of [
    ['/api/execution/exec-foreign-12345678/sync', {}],
    ['/api/execution/exec-foreign-12345678/evaluate', { packageId: 'research' }],
    ['/api/execution/exec-foreign-12345678/accept', { packageId: 'research', accepted: true }]
  ]) {
    const denied = await request(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(denied.status, 403, `${path} must enforce execution ownership before lifecycle actions`);
  }

  const recoveredResponse = await request(`${base}/api/execution/${executionId}/recover`, { method: 'POST' });
  assert.equal(recoveredResponse.status, 200);
  const recovered = await recoveredResponse.json();
  assert.deepEqual(recovered.recovered, ['p1']);
  assert.equal(recovered.execution.packages[0].commissioning.status, 'outcome_unknown');
  assert.match(recovered.note, /never retries/);
  const after = await (await request(`${base}/api/execution/${executionId}`)).json();
  assert.equal(after.execution.packages[0].commissioning.status, 'outcome_unknown');

  const foreignReconcile = await request(`${base}/api/execution/exec-foreign-12345678/reconcile`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true, packageId: 'p1', outcome: 'rejected', paymentStatus: 'not_sent', evidenceReference: 'https://market.near.ai/jobs/1' })
  });
  assert.equal(foreignReconcile.status, 403, 'reconciliation must be principal-scoped');
  const crossOriginReconcile = await request(`${base}/api/execution/${executionId}/reconcile`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' },
    body: JSON.stringify({ confirmed: true, packageId: 'p1', outcome: 'rejected', paymentStatus: 'not_sent', evidenceReference: 'https://market.near.ai/jobs/1' })
  });
  assert.equal(crossOriginReconcile.status, 403, 'owner-attested reconciliation must reject cross-origin requests');
  const invalidEvidence = await request(`${base}/api/execution/${executionId}/reconcile`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true, packageId: 'p1', outcome: 'rejected', paymentStatus: 'not_sent', evidenceReference: 'https://example.com/job/1' })
  });
  assert.equal(invalidEvidence.status, 400, 'owner attestation cannot point to an unrelated domain');
  const missingAttestation = await request(`${base}/api/execution/${executionId}/reconcile`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packageId: 'p1', outcome: 'commissioned', taskId: 'job-1', paymentStatus: 'held', evidenceReference: 'https://market.near.ai/jobs/1' })
  });
  assert.equal(missingAttestation.status, 400, 'reconciliation requires explicit confirmation');
  const reconciledResponse = await request(`${base}/api/execution/${executionId}/reconcile`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmed: true, packageId: 'p1', outcome: 'commissioned', taskId: 'job-1', paymentStatus: 'held', evidenceReference: 'https://market.near.ai/jobs/1' })
  });
  assert.equal(reconciledResponse.status, 200, await reconciledResponse.clone().text());
  const reconciled = await reconciledResponse.json();
  assert.equal(reconciled.execution.packages[0].commissioning.status, 'commissioned');
  assert.equal(reconciled.execution.packages[0].commissioning.taskId, 'job-1');
  assert.equal(reconciled.execution.packages[0].payment.status, 'held');
  assert.equal(reconciled.paymentAudit.rows[0].state, 'pending_held');
  assert.match(reconciled.note, /not independently verified/);
  assert.equal(reconciled.execution.ledger.at(-1).details.verification, 'owner_attestation_not_independently_verified');
  const dispatchWithoutAdapter = await request(`${base}/api/execution/${executionId}/dispatch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true, previewFingerprint: 'anything' })
  });
  assert.equal(dispatchWithoutAdapter.status, 409);
  assert.match((await dispatchWithoutAdapter.json()).error, /not configured/);

  const start = await request(`${base}/api/execution/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, approval: { confirmed: true, maxSpend: 1 } }) });
  assert.equal(start.status, 409, await start.clone().text());
  const blocked = await start.json();
  assert.equal(blocked.liveSpendingEnabled, false);
  assert.ok(blocked.readiness.blockers.some((b) => b.code === 'payment_authorizer_not_configured'));

  const liveSimulationAttempt = await request(`${base}/api/execute`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId })
  });
  assert.equal(liveSimulationAttempt.status, 409, 'live quote sessions must never fall back to simulated execution');
  const liveProjectView = await request(`${base}/api/project/${sessionId}`);
  assert.equal(liveProjectView.status, 200);
  const liveProject = await liveProjectView.json();
  assert.equal(liveProject.workflow.mode, 'LIVE_UNPAID_QUOTES');
  assert.equal(liveProject.workflow.steps.find((step) => step.id === 'execution').status, 'blocked');
  assert.equal(liveProject.workflow.safety.paymentSent, false);

  const sync = await request(`${base}/api/execution/exec-deliverable-123456/sync`, { method: 'POST' });
  assert.equal(sync.status, 200);
  const syncBody = await sync.json();
  assert.deepEqual(syncBody.updates, [], 'sync of a received deliverable should not contact a provider task');
  assert.match(syncBody.note, /read-only/);

  const evaluate = await request(`${base}/api/execution/exec-deliverable-123456/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packageId: 'research' }) });
  assert.equal(evaluate.status, 200, await evaluate.clone().text());
  const evaluated = await evaluate.json();
  assert.equal(evaluated.evaluation.kind, 'structural');
  assert.equal(evaluated.evaluation.passed, true);
  assert.equal(evaluated.execution.packages[0].acceptance.status, 'not_requested', 'evaluation must not imply human acceptance');
  assert.equal(evaluated.execution.packages[0].payment.status, 'unknown', 'evaluation must not imply settlement');
  assert.match(evaluated.note, /does not verify factual accuracy/);

  const missingConfirmation = await request(`${base}/api/execution/exec-deliverable-123456/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packageId: 'research' }) });
  assert.equal(missingConfirmation.status, 400, 'acceptance requires explicit confirmation');
  const accept = await request(`${base}/api/execution/exec-deliverable-123456/accept`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packageId: 'research', accepted: true }) });
  assert.equal(accept.status, 200, await accept.clone().text());
  const accepted = await accept.json();
  assert.equal(accepted.acceptance.status, 'accepted');
  assert.equal(accepted.execution.packages[0].payment.status, 'unknown', 'human acceptance must not imply settlement');
  const logout = await request(`${base}/api/auth/logout`, { method: 'POST' });
  assert.equal(logout.status, 200);
  const afterLogout = await request(`${base}/api/execution/${executionId}`);
  assert.equal(afterLogout.status, 401, 'revoked browser capability cannot be reused');
});

test('execution ledger survives a complete application restart after recovery', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workrelay-restart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = 44000 + Math.floor(Math.random() * 1000);
  const demoLedger = createDemoCreditLedger({ filePath: join(dir, 'credits.json'), secret });
  const principalStorePath = join(dir, 'principals.json');
  const identity = createPrincipalStore({ filePath: principalStorePath }).create();
  const ownerPrincipalId = identity.principal.principalId;
  const records = createExecutionRecordStore(join(dir, 'executions'));
  await records.save({
    executionId: 'exec-restart-12345678', ownerPrincipalId, status: 'dispatching', approval: { confirmed: true, maxSpend: 2 },
    packages: [{ packageId: 'pkg', provider: 'provider-a', price: 2, currency: 'USDC', commissioning: { status: 'request_in_progress' }, payment: { status: 'unknown' }, delivery: { status: 'awaiting_provider' } }],
    ledger: []
  });
  const env = { ...process.env, PORT: String(port), NODE_ENV: 'test', SESSION_STORE_PATH: join(dir, 'sessions.json'), DEMO_CREDIT_LEDGER_PATH: join(dir, 'credits.json'), DEMO_CREDIT_IP_SECRET: secret, EXECUTION_LEDGER_DIR: join(dir, 'executions'), PRINCIPAL_STORE_PATH: principalStorePath };
  const base = `http://127.0.0.1:${port}`;
  const request = (url, options = {}) => fetch(url, { ...options, headers: { ...(options.headers || {}), cookie: `workrelay_identity=${identity.token}` } });
  const startServer = async () => {
    const child = spawn(process.execPath, ['src/app-server.js'], { cwd: new URL('..', import.meta.url), env, stdio: 'ignore' });
    for (let i = 0; i < 80; i++) {
      try { const response = await request(`${base}/api/health`); if (response.ok) return child; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    child.kill('SIGKILL');
    throw new Error('WorkRelay server did not become ready');
  };
  const stopServer = async (child) => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  };

  let child = await startServer();
  const recover = await request(`${base}/api/execution/exec-restart-12345678/recover`, { method: 'POST' });
  assert.equal(recover.status, 200);
  assert.equal((await recover.json()).execution.packages[0].commissioning.status, 'outcome_unknown');
  await stopServer(child);

  child = await startServer();
  t.after(() => child.kill('SIGTERM'));
  const status = await request(`${base}/api/execution/exec-restart-12345678`);
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(body.execution.packages[0].commissioning.status, 'outcome_unknown');
  assert.equal(body.paymentAudit.rows[0].state, 'unknown_reconciliation_required');
  assert.equal(body.liveSpendingEnabled, false);
  await stopServer(child);
});

test('one project journey can plan, quote, simulate, review, report and resume after restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workrelay-project-journey-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = 44500 + Math.floor(Math.random() * 1000);
  const principalStorePath = join(dir, 'principals.json');
  const identity = createPrincipalStore({ filePath: principalStorePath }).create();
  const env = {
    ...process.env,
    PORT: String(port), NODE_ENV: 'test',
    SESSION_STORE_PATH: join(dir, 'sessions.json'),
    DEMO_CREDIT_LEDGER_PATH: join(dir, 'credits.json'),
    DEMO_CREDIT_IP_SECRET: secret,
    EXECUTION_LEDGER_DIR: join(dir, 'executions'),
    PRINCIPAL_STORE_PATH: principalStorePath
  };
  const base = `http://127.0.0.1:${port}`;
  const request = (url, options = {}) => fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), cookie: `workrelay_identity=${identity.token}` }
  });
  const startServer = async () => {
    const child = spawn(process.execPath, ['src/app-server.js'], { cwd: new URL('..', import.meta.url), env, stdio: 'ignore' });
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        const response = await request(`${base}/api/health`);
        if (response.ok) return child;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    child.kill('SIGKILL');
    throw new Error('WorkRelay project server did not become ready');
  };
  const stopServer = async (child) => {
    if (child.exitCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  };

  let child = await startServer();
  const create = await request(`${base}/api/plan`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      objective: 'Research the Kenyan fintech market, identify competitors, analyse their positioning and produce a market-entry report.',
      budget: 5, currency: 'USDC', mode: 'demo'
    })
  });
  assert.equal(create.status, 200, await create.clone().text());
  const created = await create.json();
  assert.ok(created.sessionId);
  assert.equal(created.workflow.projectStatus, 'plan_ready');
  assert.equal(created.workflow.safety.liveSpendingEnabled, false);
  assert.ok(created.plan.workPackages.length >= 2);

  const quote = await request(`${base}/api/quote`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: created.sessionId })
  });
  assert.equal(quote.status, 200, await quote.clone().text());
  const quoted = await quote.json();
  assert.equal(quoted.proposal.status, 'simulation_only');
  assert.equal(quoted.workflow.projectStatus, 'simulation_ready');
  assert.equal(quoted.safety.paymentAuthorized, false);

  let projectResponse = await request(`${base}/api/project/${created.sessionId}`);
  assert.equal(projectResponse.status, 200);
  let project = await projectResponse.json();
  assert.equal(project.sessionId, created.sessionId);
  assert.equal(project.proposal.status, 'simulation_only');
  assert.equal(project.ownerPrincipalId, undefined);
  assert.equal(project.workflow.steps.find((step) => step.id === 'execution').status, 'current');

  const run = await request(`${base}/api/execute`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: created.sessionId })
  });
  assert.equal(run.status, 200, await run.clone().text());
  let runData = await run.json();
  assert.equal(runData.simulationOnly, true);
  const roots = runData.execution.packages.filter((item) => !item.dependsOn?.length);
  const dependent = runData.execution.packages.filter((item) => item.dependsOn?.length);
  assert.equal(roots.length, 2);
  assert.equal(dependent.length, 1);
  assert.ok(roots.every((item) => item.deliverable.includes('DEMONSTRATION OUTPUT')));
  assert.equal(dependent[0].status, 'queued_waiting_for_dependencies');
  assert.equal(dependent[0].deliverable, null);

  const reviewPackages = async (packageIds) => {
    for (const packageId of packageIds) {
      const evaluate = await request(`${base}/api/evaluate`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: created.sessionId, packageId })
      });
      assert.equal(evaluate.status, 200, await evaluate.clone().text());
      const evaluated = await evaluate.json();
      assert.equal(evaluated.execution.packages.find((pkg) => pkg.packageId === packageId).evaluation.passed, true);
      const review = await request(`${base}/api/review`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: created.sessionId, packageId, decision: 'accept' })
      });
      assert.equal(review.status, 200, await review.clone().text());
      runData = await review.json();
    }
  };
  await reviewPackages(roots.map((item) => item.packageId));
  assert.equal(runData.workflow.projectStatus, 'waiting_on_dependencies');

  const downstreamRun = await request(`${base}/api/execute`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: created.sessionId })
  });
  assert.equal(downstreamRun.status, 200, await downstreamRun.clone().text());
  runData = await downstreamRun.json();
  const synthesis = runData.execution.packages.find((item) => item.packageId === dependent[0].packageId);
  assert.equal(synthesis.status, 'delivered_pending_evaluation');
  assert.equal(synthesis.dependencyInputs.length, 2);
  assert.ok(synthesis.dependencyInputs.every((source) => source.contentHash.length === 64));
  assert.ok(synthesis.dependencyInputs.some((source) => source.packageId === roots[0].packageId));
  assert.match(synthesis.deliverable, /Accepted upstream context received/);
  await reviewPackages([synthesis.packageId]);
  assert.equal(runData.workflow.projectStatus, 'all_deliverables_accepted');
  assert.equal(runData.workflow.safety.paymentSent, false);
  assert.equal(runData.report.completedPackages, runData.report.totalPackages);

  await stopServer(child);
  child = await startServer();
  t.after(() => child.kill('SIGTERM'));
  projectResponse = await request(`${base}/api/project/${created.sessionId}`);
  assert.equal(projectResponse.status, 200, await projectResponse.clone().text());
  project = await projectResponse.json();
  assert.equal(project.workflow.projectStatus, 'all_deliverables_accepted');
  assert.equal(project.execution.packages.length, runData.execution.packages.length);
  assert.equal(project.report.completedPackages, project.report.totalPackages);
  assert.equal(project.report.payment.amountSpent, 0);
  assert.equal(project.ownerPrincipalId, undefined);

  const otherVisitor = await fetch(`${base}/api/auth/session`);
  const otherToken = otherVisitor.headers.get('set-cookie').match(/workrelay_identity=([^;]+)/)[1];
  const foreignAccess = await fetch(`${base}/api/project/${created.sessionId}`, { headers: { cookie: `workrelay_identity=${otherToken}` } });
  assert.equal(foreignAccess.status, 403, 'project resume must remain owner-scoped');
  await stopServer(child);
});
