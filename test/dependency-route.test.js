import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPrincipalStore } from '../src/security/principal-store.js';
import { createSessionStore } from '../src/orchestration/session-store.js';
import { createExecutionRecordStore } from '../src/storage/execution-record-store.js';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const asset = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const payTo = '0x1111111111111111111111111111111111111111';

test('live downstream quote route uses accepted upstream artifacts, creates a new unpaid quote, and rechecks source immutability at approval', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workrelay-dependency-route-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const port = 45000 + Math.floor(Math.random() * 1000);
  const principalStorePath = join(dir, 'principals.json');
  const identity = createPrincipalStore({ filePath: principalStorePath }).create();
  const ownerPrincipalId = identity.principal.principalId;
  const sessionId = 'session-dependency-123456';
  const executionId = 'exec-upstream-dependency-123456';
  const upstreamContent = 'Accepted upstream research findings with source citation https://example.com/market-data';
  const upstreamRecord = {
    executionId, ownerPrincipalId, status: 'deliverables_received_or_under_review',
    budget: { amount: 5, committed: 1, reserved: 0, remaining: 4 },
    packages: [{
      packageId: 'research', title: 'Research', provider: 'provider-research', providerName: 'Research Agent',
      commissioning: { status: 'commissioned', taskId: 'task-research-123' },
      delivery: { status: 'delivered_pending_evaluation', content: upstreamContent, contentHash: sha256(upstreamContent), receivedAt: '2026-11-14T00:00:00.000Z' },
      evaluation: { status: 'evaluation_passed', passed: true, evaluatedAt: '2026-11-14T00:10:00.000Z' },
      acceptance: { status: 'accepted', acceptedBy: 'reviewer', acceptedAt: '2026-11-14T00:15:00.000Z' },
      payment: { status: 'unknown', amount: 1, currency: 'USDC' }
    }], ledger: []
  };
  const recordStore = createExecutionRecordStore(join(dir, 'executions'));
  await recordStore.save(upstreamRecord);
  createSessionStore({ filePath: join(dir, 'sessions.json') }).set(sessionId, {
    id: sessionId, mode: 'live', ownerPrincipalId, executionId, executionIds: [executionId],
    plan: {
      planId: 'plan-dependency-route', objective: 'Create a final report from accepted research.',
      budget: { amount: 5, currency: 'USDC' },
      workPackages: [{
        id: 'synthesis', title: 'Synthesis', brief: 'Use the accepted research to write conclusions.',
        acceptanceCriteria: ['Use the accepted research', 'Keep source references'], dependsOn: ['research'],
        budgetCeiling: 3,
        providerCandidates: [{ handle: 'provider-synthesis', name: 'Synthesis Provider', score: 90, adjustedSuccessRate: 85, verification: 'identity_verified' }]
      }, {
        id: 'recommendations', title: 'Recommendations', brief: 'Use the accepted research to recommend entry options.',
        acceptanceCriteria: ['Tie recommendations to evidence'], dependsOn: ['research'], budgetCeiling: 2,
        providerCandidates: [{ handle: 'provider-recommendations', name: 'Recommendations Provider', score: 88, adjustedSuccessRate: 80, verification: 'identity_verified' }]
      }]
    },
    proposal: { deferredPackages: [
      { packageId: 'synthesis', dependsOn: ['research'], quoteStatus: 'deferred_until_dependencies_accepted' },
      { packageId: 'recommendations', dependsOn: ['research'], quoteStatus: 'deferred_until_dependencies_accepted' }
    ], budget: { amount: 5, recommendedSpend: 1 } },
    deferredProposals: {}, createdAt: '2026-11-14T00:00:00.000Z'
  });

  const mockFetchPath = join(dir, 'mock-market-fetch.mjs');
  await writeFile(mockFetchPath, `
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (!url.hostname.endsWith('.market.near.ai')) return nativeFetch(input, init);
  if (url.pathname.startsWith('/.well-known/')) {
    return new Response(JSON.stringify({ supportedInterfaces: [{ protocolBinding: 'JSONRPC', protocolVersion: '0.3', url: 'https://' + url.hostname + '/a2a/v1' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.pathname === '/a2a/v1' && init.method === 'POST') {
    return new Response(JSON.stringify({ x402Version: 2, resource: { url: 'https://' + url.hostname + '/a2a/v1' }, accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: '${asset}', amount: '1500000', maxTimeoutSeconds: 600, payTo: '${payTo}' }] }), { status: 402, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'unexpected mocked market request' }), { status: 404, headers: { 'content-type': 'application/json' } });
};
`);

  const env = {
    ...process.env, PORT: String(port), NODE_ENV: 'test',
    SESSION_STORE_PATH: join(dir, 'sessions.json'),
    DEMO_CREDIT_LEDGER_PATH: join(dir, 'credits.json'),
    DEMO_CREDIT_IP_SECRET: 'route-test-secret-long-enough',
    EXECUTION_LEDGER_DIR: join(dir, 'executions'),
    PRINCIPAL_STORE_PATH: principalStorePath,
    X402_ALLOWED_NETWORKS: 'eip155:8453',
    X402_ALLOWED_ASSETS_JSON: JSON.stringify({ 'eip155:8453': [asset] }),
    X402_ASSET_DECIMALS: '6'
  };
  const child = spawn(process.execPath, ['--import', mockFetchPath, 'src/app-server.js'], {
    cwd: new URL('..', import.meta.url), env, stdio: 'ignore'
  });
  t.after(() => child.kill('SIGTERM'));
  const base = `http://127.0.0.1:${port}`;
  const request = (url, options = {}) => fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), cookie: `workrelay_identity=${identity.token}` }
  });
  let health;
  for (let i = 0; i < 80; i++) {
    try { health = await request(`${base}/api/health`); if (health.ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(health?.status, 200, 'server should become ready');
  for (const path of ['/', '/app.js', '/execution-client.js', '/styles.css']) {
    const assetResponse = await request(`${base}${path}`);
    assert.equal(assetResponse.status, 200, `${path} should be served successfully`);
  }

  const quoteResponse = await request(`${base}/api/project/${sessionId}/dependencies/synthesis/quote`, { method: 'POST' });
  assert.equal(quoteResponse.status, 200, await quoteResponse.clone().text());
  const quote = await quoteResponse.json();
  assert.equal(quote.packageId, 'synthesis');
  assert.equal(quote.safety.newQuoteRequired, true);
  assert.equal(quote.safety.newApprovalRequired, true);
  assert.equal(quote.safety.paymentSent, false);
  assert.equal(quote.budget.committedAndReserved, 1);
  assert.equal(quote.budget.remainingBeforeQuote, 4);
  assert.equal(quote.budget.packageCeiling, 3);
  assert.equal(quote.proposal.budget.recommendedSpend, 1.5);
  assert.equal(quote.proposal.packages[0].dependencyHandoff.quoteStatus, 'quoted_bound');
  assert.equal(quote.proposal.packages[0].dependencyHandoff.quoteBindingVerified, true);
  assert.equal(quote.proposal.packages[0].dependencyHandoff.sourceManifest[0].contentHash, sha256(upstreamContent));
  assert.match(quote.proposal.packages[0].brief, /Accepted upstream research findings/);
  assert.match(quote.proposal.packages[0].brief, /BEGIN UNTRUSTED UPSTREAM ARTIFACT/);

  const secondQuoteResponse = await request(`${base}/api/project/${sessionId}/dependencies/recommendations/quote`, { method: 'POST' });
  assert.equal(secondQuoteResponse.status, 200, await secondQuoteResponse.clone().text());
  const secondQuote = await secondQuoteResponse.json();
  assert.equal(secondQuote.packageId, 'recommendations');
  const projectView = await (await request(`${base}/api/project/${sessionId}`)).json();
  assert.equal(projectView.deferredProposals.synthesis.status, 'quoted_not_approved', 'requesting a different downstream quote must not supersede the first package quote');
  assert.equal(projectView.deferredProposals.recommendations.status, 'quoted_not_approved');
  assert.equal(projectView.paymentAudit.rows[0].state, 'submitted_unverified', 'unknown upstream payment state must not be represented as settled');

  // A changed upstream artifact invalidates the handoff before approval can be recorded.
  const tampered = structuredClone(upstreamRecord);
  tampered.packages[0].delivery.content += '\nTampered after quote.';
  await recordStore.save(tampered);
  const approval = await request(`${base}/api/execution/start`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId, proposalId: quote.proposal.proposalId,
      approval: { confirmed: true, proposalId: quote.proposal.proposalId, approvedBy: 'test-reviewer', approvedAt: '2026-11-14T01:00:00.000Z', maxSpend: 1.5, currency: 'USDC' }
    })
  });
  assert.equal(approval.status, 409);
  const approvalBody = await approval.json();
  assert.match(approvalBody.error, /integrity check/);
  assert.equal(approvalBody.liveSpendingEnabled, undefined);
  const projectAfter = await (await request(`${base}/api/project/${sessionId}`)).json();
  assert.equal(projectAfter.deferredProposals.synthesis.status, 'quoted_not_approved');
});
