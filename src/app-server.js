import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { searchAgents } from './market/near-agent-market.js';
import { createProjectPlan } from './contractor/project-planner.js';
import { buildProcurementProposal } from './procurement/quote-and-procure.js';
import { createDemoCreditLedger } from './demo/demo-credit-ledger.js';
import { createSessionStore } from './orchestration/session-store.js';
import { createExecutionBridge, summarizePaymentAudit } from './orchestration/execution-bridge.js';
import { createExecutionRecordStore } from './storage/execution-record-store.js';
import { createPrincipalStore } from './security/principal-store.js';
import { createDemoExecution, runDemoExecution, evaluateDemoDeliverable, reviewDemoDeliverable, buildDemoFinalReport } from './orchestration/demo-execution.js';
import { buildProjectOverview } from './orchestration/project-overview.js';
import { buildDependencyBoundRequest } from './orchestration/dependency-handoff.js';
import { createNearA2ACommissioner } from './market/near-a2a-quotes.js';
import { createBoundX402PaymentAuthorizer } from './payments/x402-authorization.js';
import { reconcileCommissionOutcome } from './orchestration/project-lifecycle.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const DEMO_ASSET = 'demo-usdc';
const DECIMALS = Number(process.env.X402_ASSET_DECIMALS || 6);
const SUPPORTED_X402_BUYER_NETWORKS = new Set(['eip155:8453', 'eip155:137', 'eip155:42161']);
const X402_ALLOWED_NETWORKS = String(process.env.X402_ALLOWED_NETWORKS || '').split(',').map((item) => item.trim()).filter(Boolean);
if (X402_ALLOWED_NETWORKS.some((network) => !SUPPORTED_X402_BUYER_NETWORKS.has(network))) throw new Error('X402_ALLOWED_NETWORKS may contain only the current NEAR Agent Payments buyer networks: eip155:8453 (Base), eip155:137 (Polygon), and eip155:42161 (Arbitrum).');
function parseAssetsByNetwork(raw) {
  let parsed;
  try { parsed = JSON.parse(raw || '{}'); } catch { throw new Error('X402_ALLOWED_ASSETS_JSON must be valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('X402_ALLOWED_ASSETS_JSON must be a JSON object keyed by network.');
  for (const [network, assets] of Object.entries(parsed)) {
    if (!/^eip155:\d+$/.test(network) || !Array.isArray(assets) || !assets.length || assets.some((asset) => typeof asset !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(asset))) {
      throw new Error(`Invalid X402 asset configuration for ${network}; expected EVM networks and 20-byte token addresses.`);
    }
  }
  return parsed;
}
const X402_ALLOWED_ASSETS_BY_NETWORK = parseAssetsByNetwork(process.env.X402_ALLOWED_ASSETS_JSON);
if (Object.keys(X402_ALLOWED_ASSETS_BY_NETWORK).some((network) => !X402_ALLOWED_NETWORKS.includes(network))) throw new Error('Every X402_ALLOWED_ASSETS_JSON network must also be present in X402_ALLOWED_NETWORKS.');
if (X402_ALLOWED_NETWORKS.some((network) => !Object.hasOwn(X402_ALLOWED_ASSETS_BY_NETWORK, network))) throw new Error('Every enabled X402 network must have an explicit asset list in X402_ALLOWED_ASSETS_JSON.');
const X402_ALLOWED_ASSETS = [...new Set(Object.values(X402_ALLOWED_ASSETS_BY_NETWORK).flat())];
const X402_MAX_PAYMENT_USD = Number(process.env.X402_MAX_PAYMENT_USD || 5);
if (!Number.isFinite(DECIMALS) || !Number.isInteger(DECIMALS) || DECIMALS < 0 || DECIMALS > 18) throw new Error('X402_ASSET_DECIMALS must be an integer from 0 to 18.');
if (!Number.isFinite(X402_MAX_PAYMENT_USD) || X402_MAX_PAYMENT_USD <= 0) throw new Error('X402_MAX_PAYMENT_USD must be positive.');

async function loadPaymentCommissioner() {
  const moduleSpec = String(process.env.X402_WALLET_ADAPTER_MODULE || '').trim();
  if (!moduleSpec) return { commissioner: null, status: { configured: false, reason: 'No wallet adapter module is installed.' } };
  if (!X402_ALLOWED_NETWORKS.length || !X402_ALLOWED_ASSETS.length) throw new Error('A wallet adapter cannot be enabled without explicit x402 network and per-network asset allowlists.');
  if (/^https?:/i.test(moduleSpec) || (/^[a-z]+:/i.test(moduleSpec) && !moduleSpec.startsWith('file:'))) {
    throw new Error('X402_WALLET_ADAPTER_MODULE must be a local file URL, local path, or installed package specifier; remote/code URLs are not permitted.');
  }
  const importSpecifier = moduleSpec.startsWith('file:')
    ? moduleSpec
    : moduleSpec.startsWith('.') || isAbsolute(moduleSpec)
      ? pathToFileURL(isAbsolute(moduleSpec) ? moduleSpec : resolve(ROOT, moduleSpec)).href
      : moduleSpec;
  const adapterModule = await import(importSpecifier);
  if (typeof adapterModule.createSigner !== 'function') throw new Error('X402 wallet adapter must export createSigner({ config }).');
  const signer = await adapterModule.createSigner({ config: { allowedNetworks: X402_ALLOWED_NETWORKS, allowedAssetsByNetwork: X402_ALLOWED_ASSETS_BY_NETWORK, maxPaymentUsd: X402_MAX_PAYMENT_USD } });
  const paymentAuthorizer = createBoundX402PaymentAuthorizer({ signer, allowedNetworks: X402_ALLOWED_NETWORKS, allowedAssetsByNetwork: X402_ALLOWED_ASSETS_BY_NETWORK, maxPaymentUsd: X402_MAX_PAYMENT_USD });
  const commissioner = createNearA2ACommissioner({ paymentAuthorizer, allowedNetworks: X402_ALLOWED_NETWORKS, allowedAssets: X402_ALLOWED_ASSETS, allowedAssetsByNetwork: X402_ALLOWED_ASSETS_BY_NETWORK, assetDecimals: DECIMALS, paymentHeaderName: 'X-PAYMENT' });
  return { commissioner, status: { configured: true, adapterType: 'operator-provided server-side module', networks: X402_ALLOWED_NETWORKS, maxPaymentUsd: X402_MAX_PAYMENT_USD } };
}
const paymentRuntime = await loadPaymentCommissioner();
const commissioner = paymentRuntime.commissioner;
const executionRecords = createExecutionRecordStore(process.env.EXECUTION_LEDGER_DIR || join(ROOT, 'data', 'executions'));
const executionBridge = createExecutionBridge({ commissioner, allowedAssets: X402_ALLOWED_ASSETS, allowedNetworks: X402_ALLOWED_NETWORKS, allowedAssetsByNetwork: X402_ALLOWED_ASSETS_BY_NETWORK, requireV2PaymentChallenge: true, persist: (execution) => executionRecords.save(execution) });
const principals = createPrincipalStore({
  ttlMs: Number(process.env.PRINCIPAL_TTL_MS || 30 * 24 * 60 * 60 * 1000),
  maxPrincipals: Number(process.env.PRINCIPAL_MAX || 20_000),
  filePath: process.env.PRINCIPAL_STORE_PATH || join(ROOT, 'data', 'principals.json')
});
const sessions = createSessionStore({
  ttlMs: Number(process.env.SESSION_TTL_MS || 6 * 60 * 60 * 1000),
  maxSessions: Number(process.env.SESSION_MAX || 2000),
  filePath: process.env.SESSION_STORE_PATH || join(ROOT, 'data', 'sessions.json')
});
if (process.env.NODE_ENV === 'production' && !process.env.DEMO_CREDIT_IP_SECRET) throw new Error('Set DEMO_CREDIT_IP_SECRET in production.');
const demoLedger = createDemoCreditLedger({
  filePath: process.env.DEMO_CREDIT_LEDGER_PATH || join(ROOT, 'data', 'demo-credit-ledger.json'),
  secret: process.env.DEMO_CREDIT_IP_SECRET || 'local-development-only-change-this-secret',
  globalPoolUsd: Number(process.env.DEMO_CREDIT_POOL_USD || 1000),
  perIpCapUsd: Number(process.env.DEMO_CREDIT_PER_IP_USD || 10),
  projectCapUsd: Number(process.env.DEMO_CREDIT_PER_PROJECT_USD || 5)
});

function clientIp(req) {
  // Only enable forwarded-IP parsing when a trusted reverse proxy overwrites X-Forwarded-For.
  const raw = process.env.TRUST_PROXY === 'true' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : req.socket.remoteAddress;
  return String(raw || 'unknown').replace(/^::ffff:/i, '');
}

function cookieValue(req, name) {
  const header = String(req.headers.cookie || '');
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) { try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return null; } }
  }
  return null;
}
function requestPrincipal(req) { return principals.resolve(cookieValue(req, 'workrelay_identity')); }
function setIdentityCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('set-cookie', `workrelay_identity=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(Number(process.env.PRINCIPAL_TTL_MS || 30 * 24 * 60 * 60 * 1000) / 1000)}${secure}`);
}
function sameOriginIfPresent(req) {
  const origin = req.headers.origin;
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (!origin) return !fetchSite || fetchSite === 'same-origin';
  try {
    const parsed = new URL(origin);
    const forwardedProto = process.env.TRUST_PROXY === 'true' ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
    const expectedProtocol = req.socket.encrypted || forwardedProto === 'https' ? 'https:' : 'http:';
    return parsed.host.toLowerCase() === String(req.headers.host || '').toLowerCase() && parsed.protocol === expectedProtocol;
  } catch { return false; }
}

const demoAgents = [
  { handle: 'web-research', name: 'Web Research', category: 'research', tags: ['web research','market research','evidence'], description: 'Broad web research and source gathering.', delivered_jobs: 52, success_rate: 72, median_response_time_seconds: 7, sla_seconds: 180, available_now: true, availability: 'available', listing_status: 'live', funding_paused: false, builder: { verification: { level: 'none' } } },
  { handle: 'cited-research-desk', name: 'Cited Research Desk', category: 'research', tags: ['market research','citations','business research'], description: 'Research briefs with cited evidence and source URLs.', delivered_jobs: 2, success_rate: 100, median_response_time_seconds: 17, sla_seconds: 3600, available_now: true, availability: 'available', listing_status: 'live', funding_paused: false, builder: { verification: { level: 'identity_verified' } } },
  { handle: 'cited-web-research-brief', name: 'Cited Web Research Brief', category: 'research', tags: ['competitor analysis','web research','citations'], description: 'Short cited research and competitor briefs.', delivered_jobs: 15, success_rate: 88, median_response_time_seconds: 1, sla_seconds: 3600, available_now: true, availability: 'available', listing_status: 'live', funding_paused: false, builder: { verification: { level: 'none' } } },
  { handle: 'kaminari-research', name: 'Kaminari Research', category: 'research', tags: ['business analysis','report writing','market analysis'], description: 'Research analysis and business report synthesis.', delivered_jobs: 3, success_rate: 25, median_response_time_seconds: 229, sla_seconds: 3600, available_now: true, availability: 'available', listing_status: 'live', funding_paused: false, builder: { verification: { level: 'none' } } }
];

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function bodyJson(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new Error('Request body too large'); }
  return raw ? JSON.parse(raw) : {};
}
function publicProjectSnapshot(session, liveExecutionRecord = null, paymentAudit = null, liveExecutionRecords = []) {
  const { ownerIpHash, ownerPrincipalId, ...publicSession } = session;
  return {
    ...publicSession,
    sessionId: session.id,
    workflow: buildProjectOverview(session, { commissioningConfigured: Boolean(commissioner) }),
    report: session.execution?.mode === 'simulation_only' ? buildDemoFinalReport(session.execution) : null,
    liveExecutionRecord,
    liveExecutionRecords,
    dispatchPreview: liveExecutionRecord ? executionBridge.previewDispatch(liveExecutionRecord) : null,
    deferredProposals: Object.fromEntries(Object.entries(session.deferredProposals ?? {}).map(([packageId, item]) => [packageId, { proposal: item.proposal, status: item.status, requestFingerprint: item.requestFingerprint, createdAt: item.createdAt }])) ,
    paymentAudit
  };
}

function demoQuoteRequester({ agent, workPackage }) {
  const prices = { 'web-research': 0.5, 'cited-research-desk': 2, 'cited-web-research-brief': 0.15, 'kaminari-research': 0.25 };
  const amount = prices[agent.handle] ?? 0.75;
  const recipient = `demo-recipient-${agent.handle}`;
  return Promise.resolve({ status: 'quote_received', provider: agent.handle, endpoint: `https://${agent.handle}.market.near.ai/a2a/v1`, quote: { alternatives: [{ scheme: 'exact', network: 'near:mainnet', asset: DEMO_ASSET, amount: String(Math.round(amount * 1e6)), maxTimeoutSeconds: 3600, payTo: recipient }] }, simulation: true });
}

async function loadProjectExecutionRecords(session, ownerPrincipalId) {
  const ids = [...new Set([...(session.executionIds ?? []), ...(session.executionId ? [session.executionId] : [])])];
  const records = [];
  for (const id of ids) {
    const record = await executionRecords.load(id);
    if (record.ownerPrincipalId !== ownerPrincipalId) throw Object.assign(new Error('The linked execution belongs to a different principal.'), { statusCode: 403 });
    records.push(record);
  }
  return records;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, name: 'WorkRelay', mode: 'procurement and approval-gated execution', commissioningConfigured: Boolean(commissioner), paymentNetworks: X402_ALLOWED_NETWORKS });
    if (req.method === 'GET' && url.pathname === '/api/auth/session') {
      let principal = requestPrincipal(req);
      if (!principal) { const issued = principals.create(); principal = issued.principal; setIdentityCookie(res, issued.token); }
      return json(res, 200, { principalId: principal.principalId, identityMode: 'anonymous-capability', accountAuthentication: false, note: 'This browser has a revocable server-side identity capability. It is not a verified account identity.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
      if (!sameOriginIfPresent(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      const token = cookieValue(req, 'workrelay_identity');
      if (token) principals.revoke(token);
      const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      res.setHeader('set-cookie', `workrelay_identity=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
      return json(res, 200, { revoked: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/demo-balance') {
      const balance = await demoLedger.balance(clientIp(req));
      return json(res, 200, { balance, signupRequired: false, walletRequired: false, simulationOnly: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/plan') {
      if (!sameOriginIfPresent(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      const principal = requestPrincipal(req);
      if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
      const input = await bodyJson(req);
      const objective = String(input.objective || '').trim();
      const budget = Number(input.budget);
      const currency = String(input.currency || 'USDC').toUpperCase();
      const mode = input.mode === 'demo' ? 'demo' : 'live';
      if (objective.length < 20 || objective.length > 3000) return json(res, 400, { error: 'Describe the task in 20–3,000 characters.' });
      if (!Number.isFinite(budget) || budget <= 0 || budget > 1_000_000) return json(res, 400, { error: 'Enter a valid positive budget.' });
      if (currency !== 'USDC') return json(res, 400, { error: 'Only USDC is currently supported. Live network and token eligibility is controlled by the server-side x402 allowlists.' });
      let agents; let discovery;
      if (mode === 'demo') { agents = demoAgents; discovery = { mode, source: 'built-in illustrative fixtures', warning: 'Demo data only. Provider records and prices are simulated; no marketplace calls or payments occur.' }; }
      else {
        let result;
        try { result = await searchAgents({ query: 'research' }); }
        catch (error) { throw Object.assign(new Error(`Live Agent Market discovery failed (${error.message}). No fallback data was substituted. Retry later or switch to the simulated demo mode.`), { statusCode: 502 }); }
        agents = result.data?.agents ?? result.data?.data?.agents;
        if (!Array.isArray(agents)) throw Object.assign(new Error('Live Agent Market returned an unexpected response (no agents array). No fallback data was substituted.'), { statusCode: 502 });
        discovery = { mode, source: result.url, warning: 'Live discovery. Marketplace listing metadata is provider-reported and not independently audited.' };
      }
      const plan = createProjectPlan({ objective, budget, currency, agents });
      const id = crypto.randomUUID();
      let credits = null;
      if (mode === 'demo') credits = await demoLedger.reserve({ ip: clientIp(req), projectId: id, amountUsd: budget });
      const session = { id, mode, discovery, plan, proposal: null, execution: null, executionId: null, executionIds: [], deferredProposals: {}, credits, ownerPrincipalId: principal.principalId, createdAt: new Date().toISOString() };
      sessions.set(id, session);
      return json(res, 200, { sessionId: id, mode, discovery, plan, proposal: null, execution: null, credits, workflow: buildProjectOverview(session, { commissioningConfigured: Boolean(commissioner) }), displayCurrency: mode === 'demo' ? 'DEMO USD' : 'USDC' });
    }
    if (req.method === 'POST' && url.pathname === '/api/quote') {
      if (!sameOriginIfPresent(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      const input = await bodyJson(req); const session = sessions.get(String(input.sessionId || ''));
      if (!session) return json(res, 404, { error: 'Project session not found. Create a new plan.' });
      const principal = requestPrincipal(req);
      if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
      if (session.ownerPrincipalId !== principal.principalId) return json(res, 403, { error: 'This project session belongs to a different principal.' });
      let proposal;
      try {
        proposal = await buildProcurementProposal(session.plan, {
          allowedAssets: session.mode === 'demo' ? [DEMO_ASSET] : X402_ALLOWED_ASSETS,
          allowedNetworks: session.mode === 'demo' ? ['near:mainnet'] : X402_ALLOWED_NETWORKS,
          allowedAssetsByNetwork: session.mode === 'demo' ? { 'near:mainnet': [DEMO_ASSET] } : X402_ALLOWED_ASSETS_BY_NETWORK,
          requireV2PaymentChallenge: session.mode === 'live', assetDecimals: DECIMALS,
          quoteRequester: session.mode === 'demo' ? demoQuoteRequester : undefined,
          deferDependentPackages: session.mode === 'live'
        });
      } catch (error) {
        if (session.mode === 'demo' && session.credits?.reservation) {
          await demoLedger.release({ ip: clientIp(req), projectId: session.id });
          session.credits = null;
        }
        throw error;
      }
      if (session.mode === 'demo') {
        proposal.status = 'simulation_only';
        for (const item of proposal.packages) if (item.recommendation) item.recommendation.status = 'simulation_only';
        proposal.pricing.note = 'Illustrative simulated prices only. These are not marketplace quotes and cannot authorize hiring or payment.';
      }
      session.proposal = proposal;
      session.deferredProposals = {};
      let creditSettlement = null;
      if (session.mode === 'demo' && session.credits?.reservation) {
        creditSettlement = await demoLedger.settle({ ip: clientIp(req), projectId: session.id, actualSpendUsd: Number(proposal.budget.recommendedSpend || 0) });
        session.credits = { settlement: creditSettlement };
      }
      sessions.set(session.id, session);
      return json(res, 200, { sessionId: session.id, mode: session.mode, discovery: session.discovery, plan: session.plan, proposal, execution: session.execution || null, credits: session.credits, creditSettlement, workflow: buildProjectOverview(session, { commissioningConfigured: Boolean(commissioner) }), displayCurrency: session.mode === 'demo' ? 'DEMO USD' : 'USDC', safety: { hiringStarted: false, paymentAuthorized: false, paymentSent: false, dispatchEnabled: false } });
    }
    if (req.method === 'POST' && url.pathname === '/api/execution/start') {
      if (!sameOriginIfPresent(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      const input = await bodyJson(req);
      const session = sessions.get(String(input.sessionId || ''));
      if (!session) return json(res, 404, { error: 'Project session not found.' });
      const principal = requestPrincipal(req);
      if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
      if (session.ownerPrincipalId !== principal.principalId) return json(res, 403, { error: 'This project belongs to a different principal.' });
      const deferredEntry = input.proposalId
        ? Object.entries(session.deferredProposals ?? {}).find(([, item]) => item.proposal?.proposalId === input.proposalId)
        : null;
      const proposal = input.proposalId
        ? (session.proposal?.proposalId === input.proposalId ? session.proposal : deferredEntry?.[1]?.proposal)
        : session.proposal;
      if (!proposal) return json(res, 409, { error: 'The selected quote proposal is unavailable or has been superseded. Request a fresh quote.' });
      const existingRecords = await loadProjectExecutionRecords(session, session.ownerPrincipalId);
      const committedAndReserved = existingRecords.reduce((sum, record) => sum + Number(record.budget?.committed || 0) + Number(record.budget?.reserved || 0), 0);
      const projectBudget = Number(session.plan?.budget?.amount ?? session.proposal?.budget?.amount ?? 0);
      const remainingBudget = Math.max(0, projectBudget - committedAndReserved);
      if (Number(proposal.budget?.recommendedSpend || 0) > remainingBudget + 1e-9 || Number(input.approval?.maxSpend || 0) > remainingBudget + 1e-9) {
        return json(res, 409, { error: 'Project budget changed after this quote was prepared. The proposal is stale; request a fresh quote within the remaining budget.', remainingBudget, committedAndReserved });
      }
      if (deferredEntry) {
        const [packageId, stored] = deferredEntry;
        const packageSpec = session.plan.workPackages.find((item) => item.id === packageId);
        try {
          const currentHandoff = buildDependencyBoundRequest({ workPackage: packageSpec, packageRecords: existingRecords.flatMap((record) => record.packages) });
          if (currentHandoff.requestFingerprint !== stored.requestFingerprint) return json(res, 409, { error: 'Accepted upstream inputs changed after this quote. A fresh downstream quote and approval are required.' });
        } catch (error) {
          return json(res, 409, { error: `Downstream package is no longer ready for this quote: ${error.message}` });
        }
        if (stored.status !== 'quoted_not_approved') return json(res, 409, { error: 'This deferred quote is no longer awaiting approval.' });
      }
      try {
        const execution = await executionBridge.start(proposal, input.approval, { ownerPrincipalId: session.ownerPrincipalId });
        session.executionId = execution.executionId;
        session.executionIds = [...new Set([...(session.executionIds ?? []), execution.executionId])];
        if (deferredEntry) { deferredEntry[1].status = 'approved'; deferredEntry[1].executionId = execution.executionId; }
        sessions.set(session.id, session);
        const { ownerIpHash, ownerPrincipalId, ...publicExecution } = execution;
        return json(res, 201, { executionId: execution.executionId, execution: publicExecution, proposalId: proposal.proposalId, liveSpendingEnabled: Boolean(commissioner), dispatchRequiresSeparateConfirmation: true, note: commissioner ? 'Approval is recorded. Provider commissioning remains a separate paid action requiring an explicit dispatch confirmation.' : 'Approval is recorded, but commissioning remains disabled because no reviewed wallet adapter is installed.' });
      } catch (error) {
        if (error.code === 'commission_blocked') return json(res, 409, { error: 'Live execution cannot be started. No execution or payment was created.', readiness: error.readiness, liveSpendingEnabled: false, simulationOnly: proposal.status === 'simulation_only' });
        throw error;
      }
    }
    const executionStatusRoute = url.pathname.match(/^\/api\/execution\/([a-z0-9-]{16,80})$/i);
    if (req.method === 'GET' && executionStatusRoute) {
      const executionId = executionStatusRoute[1];
      try {
        const execution = await executionRecords.load(executionId);
        const principal = requestPrincipal(req);
        if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
        if (execution.ownerPrincipalId !== principal.principalId) return json(res, 403, { error: 'This execution belongs to a different principal.' });
        const { ownerIpHash, ownerPrincipalId, ...publicExecution } = execution;
        return json(res, 200, { execution: publicExecution, paymentAudit: summarizePaymentAudit(execution), liveSpendingEnabled: Boolean(commissioner), dispatchPreview: executionBridge.previewDispatch(execution) });
      } catch (error) {
        if (error.code === 'ENOENT') return json(res, 404, { error: 'Execution record not found.' });
        throw error;
      }
    }
    const executionRecoveryRoute = url.pathname.match(/^\/api\/execution\/([a-z0-9-]{16,80})\/recover$/i);
    if (req.method === 'POST' && executionRecoveryRoute) {
      if (!sameOriginIfPresent(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      const executionId = executionRecoveryRoute[1];
      try {
        const execution = await executionRecords.load(executionId);
        const principal = requestPrincipal(req);
        if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
        if (execution.ownerPrincipalId !== principal.principalId) return json(res, 403, { error: 'This execution belongs to a different principal.' });
        const result = executionBridge.recover(execution);
        if (result.recovered.length) await executionRecords.save(execution);
        const { ownerIpHash, ownerPrincipalId, ...publicExecution } = execution;
        return json(res, 200, { execution: publicExecution, recovered: result.recovered, liveSpendingEnabled: Boolean(commissioner), note: 'Recovery is local state reconciliation only. It never retries a commission or sends payment.' });
      } catch (error) {
        if (error.code === 'ENOENT') return json(res, 404, { error: 'Execution record not found.' });
        throw error;
      }
    }
    const executionReconcileRoute = url.pathname.match(/^\/api\/execution\/([a-z0-9-]{16,80})\/reconcile$/i);
    if (req.method === 'POST' && executionReconcileRoute) {
      if (!sameOriginIfPresent(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      const executionId = executionReconcileRoute[1];
      const input = await bodyJson(req);
      const principal = requestPrincipal(req);
      if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
      let execution;
      try { execution = await executionRecords.load(executionId); }
      catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: 'Execution record not found.' }); throw error; }
      if (execution.ownerPrincipalId !== principal.principalId) return json(res, 403, { error: 'This execution belongs to a different principal.' });
      if (input.confirmed !== true) return json(res, 400, { error: 'Explicit owner attestation is required before reconciliation.' });
      if (typeof input.evidenceReference !== 'string' || input.evidenceReference.length > 2048) return json(res, 400, { error: 'A marketplace evidence URL is required.' });
      let evidenceUrl;
      try { evidenceUrl = new URL(input.evidenceReference); } catch { return json(res, 400, { error: 'Evidence reference must be a valid HTTPS marketplace URL.' }); }
      if (evidenceUrl.protocol !== 'https:' || evidenceUrl.username || evidenceUrl.password || evidenceUrl.search || evidenceUrl.hash || !(evidenceUrl.hostname === 'market.near.ai' || evidenceUrl.hostname.endsWith('.market.near.ai'))) {
        return json(res, 400, { error: 'Evidence must be a credential-free HTTPS URL on market.near.ai or an official provider subdomain.' });
      }
      try {
        reconcileCommissionOutcome(execution, {
          packageId: String(input.packageId || ''), outcome: input.outcome,
          taskId: input.taskId == null ? null : String(input.taskId),
          paymentStatus: input.paymentStatus ?? 'unknown',
          paymentMode: input.paymentMode ?? 'x402_delivery_escrow',
          evidenceReference: evidenceUrl.toString(), reconciledBy: principal.principalId
        });
      } catch (error) { return json(res, 409, { error: error.message }); }
      await executionRecords.save(execution);
      const { ownerIpHash, ownerPrincipalId, ...publicExecution } = execution;
      return json(res, 200, {
        execution: publicExecution, paymentAudit: summarizePaymentAudit(execution),
        dispatchPreview: executionBridge.previewDispatch(execution),
        note: 'Owner-attested reconciliation recorded. WorkRelay has not independently verified the linked marketplace evidence. No commission or payment was sent by this reconciliation action.'
      });
    }
    const executionDispatchRoute = url.pathname.match(/^\/api\/execution\/([a-z0-9-]{16,80})\/dispatch$/i);
    if (req.method === 'POST' && executionDispatchRoute) {
      if (!sameOriginIfPresent(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      const executionId = executionDispatchRoute[1];
      const input = await bodyJson(req);
      let execution;
      try { execution = await executionRecords.load(executionId); }
      catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: 'Execution record not found.' }); throw error; }
      const principal = requestPrincipal(req);
      if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
      if (execution.ownerPrincipalId !== principal.principalId) return json(res, 403, { error: 'This execution belongs to a different principal.' });
      if (input.confirmed !== true) return json(res, 400, { error: 'Explicit confirmed: true dispatch confirmation is required.' });
      if (!commissioner) return json(res, 409, { error: 'Paid commissioning is not configured. No payment was sent.', dispatchPreview: { ready: false, blockers: ['wallet_adapter_not_configured'] } });
      const preview = executionBridge.previewDispatch(execution);
      if (!preview.ready) return json(res, 409, { error: 'No packages are currently safe to dispatch. No payment was sent.', dispatchPreview: preview });
      if (input.previewFingerprint !== preview.fingerprint) return json(res, 409, { error: 'The dispatch preview changed. Reload the execution and confirm the current package list and spend again.', dispatchPreview: preview });
      const result = await executionBridge.dispatchReady(execution);
      const { ownerIpHash, ownerPrincipalId, ...publicExecution } = execution;
      return json(res, 200, { execution: publicExecution, dispatched: result.dispatched, held: result.held, paymentAudit: summarizePaymentAudit(execution), dispatchPreview: executionBridge.previewDispatch(execution), note: 'Dispatch request submitted. Provider tasks and payment settlement are tracked independently. An unknown outcome requires reconciliation; do not retry it.' });
    }
    const executionAction = url.pathname.match(/^\/api\/execution\/([a-z0-9-]{16,80})\/(sync|evaluate|accept)$/i);
    if (req.method === 'POST' && executionAction) {
      if (!sameOriginIfPresent(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      const [, executionId, rawAction] = executionAction;
      const action = rawAction.toLowerCase();
      const input = await bodyJson(req);
      let execution;
      try { execution = await executionRecords.load(executionId); }
      catch (error) {
        if (error.code === 'ENOENT') return json(res, 404, { error: 'Execution record not found.' });
        throw error;
      }
      const principal = requestPrincipal(req);
        if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
        if (execution.ownerPrincipalId !== principal.principalId) return json(res, 403, { error: 'This execution belongs to a different principal.' });

      if (action === 'sync') {
        const result = await executionBridge.sync(execution);
        const { ownerIpHash, ownerPrincipalId, ...publicExecution } = execution;
        return json(res, 200, {
          execution: publicExecution,
          updates: result.updates,
          paymentAudit: summarizePaymentAudit(execution),
          dispatchPreview: executionBridge.previewDispatch(execution),
          liveSpendingEnabled: Boolean(commissioner),
          note: 'Provider synchronization is read-only. It never commissions, retries, accepts deliverables, or infers payment settlement.'
        });
      }
      const packageId = String(input.packageId || '');
      if (!packageId) return json(res, 400, { error: 'packageId is required.' });
      if (action === 'evaluate') {
        await executionBridge.evaluate(execution, packageId);
        const item = execution.packages.find((entry) => entry.packageId === packageId);
        const { ownerIpHash, ownerPrincipalId, ...publicExecution } = execution;
        return json(res, 200, {
          execution: publicExecution,
          evaluation: item.evaluation,
          paymentAudit: summarizePaymentAudit(execution),
          dispatchPreview: executionBridge.previewDispatch(execution),
          liveSpendingEnabled: Boolean(commissioner),
          note: 'Structural evaluation checks criterion representation and URL presence only. It does not verify factual accuracy, sources, or claims, and does not accept the deliverable.'
        });
      }
      if (input.accepted !== true) return json(res, 400, { error: 'Explicit accepted: true confirmation is required.' });
      await executionBridge.accept(execution, { packageId, acceptedBy: 'project owner' });
      const { ownerIpHash, ownerPrincipalId, ...publicExecution } = execution;
      return json(res, 200, {
        execution: publicExecution,
        acceptance: execution.packages.find((entry) => entry.packageId === packageId).acceptance,
        paymentAudit: summarizePaymentAudit(execution),
        dispatchPreview: executionBridge.previewDispatch(execution),
        liveSpendingEnabled: Boolean(commissioner),
        note: 'Human acceptance is recorded separately from provider completion and payment settlement.'
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/readiness') {
      if (!sameOriginIfPresent(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      const input = await bodyJson(req); const session = sessions.get(String(input.sessionId || ''));
      if (!session) return json(res, 404, { error: 'Project session not found.' });
      const principal = requestPrincipal(req);
      if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
      if (session.ownerPrincipalId !== principal.principalId) return json(res, 403, { error: 'This project belongs to a different principal.' });
      if (!session.proposal) return json(res, 409, { error: 'Request quotes before checking commissioning readiness.' });
      const readiness = executionBridge.assessReadiness(session.proposal);
      return json(res, 200, { mode: session.mode === 'demo' ? 'SIMULATED' : 'LIVE', readiness, liveSpendingEnabled: Boolean(commissioner), paymentConfiguration: paymentRuntime.status, note: commissioner ? 'A server-side payment adapter is installed, but dispatch still requires valid quotes, cleared recipient review, explicit approval, and separate dispatch confirmation.' : 'Live spending remains disabled because no reviewed payment adapter is installed.' });
    }
    if (req.method === 'POST' && url.pathname === '/api/execute') {
      if (!sameOriginIfPresent(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      const input = await bodyJson(req);
      const session = sessions.get(String(input.sessionId || ''));
      if (!session) return json(res, 404, { error: 'Project session not found.' });
      const principal = requestPrincipal(req);
      if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
      if (session.ownerPrincipalId !== principal.principalId) return json(res, 403, { error: 'This project belongs to a different principal.' });
      if (session.mode !== 'demo' || session.proposal?.status !== 'simulation_only') return json(res, 409, { error: 'Execution is available only for simulation-only demo proposals. Live provider hiring is not enabled.' });
      if (!session.execution) session.execution = createDemoExecution(session.proposal);
      runDemoExecution(session.execution);
      sessions.set(session.id, session);
      return json(res, 200, { execution: session.execution, report: buildDemoFinalReport(session.execution), workflow: buildProjectOverview(session, { commissioningConfigured: Boolean(commissioner) }), simulationOnly: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/evaluate') {
      if (!sameOriginIfPresent(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      const input = await bodyJson(req);
      const session = sessions.get(String(input.sessionId || ''));
      if (!session?.execution) return json(res, 404, { error: 'Start the demo execution before evaluating deliverables.' });
      const principal = requestPrincipal(req);
      if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
      if (session.ownerPrincipalId !== principal.principalId) return json(res, 403, { error: 'This project belongs to a different principal.' });
      if (session.mode !== 'demo') return json(res, 409, { error: 'Automated evaluation is disabled for live projects.' });
      evaluateDemoDeliverable(session.execution, String(input.packageId || ''));
      sessions.set(session.id, session);
      return json(res, 200, { execution: session.execution, report: buildDemoFinalReport(session.execution), workflow: buildProjectOverview(session, { commissioningConfigured: Boolean(commissioner) }), simulationOnly: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/review') {
      if (!sameOriginIfPresent(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      const input = await bodyJson(req);
      const session = sessions.get(String(input.sessionId || ''));
      if (!session?.execution) return json(res, 404, { error: 'Start the demo execution before reviewing deliverables.' });
      const principal = requestPrincipal(req);
      if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
      if (session.ownerPrincipalId !== principal.principalId) return json(res, 403, { error: 'This project belongs to a different principal.' });
      if (session.mode !== 'demo') return json(res, 409, { error: 'Human review simulation is disabled for live projects.' });
      reviewDemoDeliverable(session.execution, String(input.packageId || ''), String(input.decision || ''));
      sessions.set(session.id, session);
      return json(res, 200, { execution: session.execution, report: buildDemoFinalReport(session.execution), workflow: buildProjectOverview(session, { commissioningConfigured: Boolean(commissioner) }), simulationOnly: true });
    }
    const deferredQuoteRoute = url.pathname.match(/^\/api\/project\/([a-z0-9-]{16,80})\/dependencies\/([a-z0-9-]{1,80})\/quote$/i);
    if (req.method === 'POST' && deferredQuoteRoute) {
      if (!sameOriginIfPresent(req)) return json(res, 403, { error: 'Cross-origin request rejected.' });
      const [, sessionId, packageId] = deferredQuoteRoute;
      const session = sessions.get(sessionId);
      if (!session) return json(res, 404, { error: 'Project not found or the session has expired.' });
      const principal = requestPrincipal(req);
      if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
      if (session.ownerPrincipalId !== principal.principalId) return json(res, 403, { error: 'This project belongs to a different principal.' });
      if (session.mode !== 'live') return json(res, 409, { error: 'Deferred marketplace quotes are available only in live mode. Demo work uses labelled simulated handoffs.' });
      const deferredSpec = session.proposal?.deferredPackages?.find((item) => item.packageId === packageId);
      const workPackage = session.plan.workPackages.find((item) => item.id === packageId);
      if (!deferredSpec || !workPackage) return json(res, 404, { error: 'This package is not in the deferred downstream quote set.' });
      if (deferredSpec.dependsOn?.length === 0) return json(res, 409, { error: 'This package has no dependencies and should have been quoted in the initial round.' });
      const records = await loadProjectExecutionRecords(session, principal.principalId);
      if (!records.length) return json(res, 409, { error: 'No owner-scoped upstream execution record is linked to this project yet.' });
      let handoff;
      try {
        handoff = buildDependencyBoundRequest({ workPackage, packageRecords: records.flatMap((record) => record.packages) });
      } catch (error) {
        return json(res, 409, { error: `Downstream quote is blocked: ${error.message}` });
      }
      const committedAndReserved = records.reduce((sum, record) => sum + Number(record.budget?.committed || 0) + Number(record.budget?.reserved || 0), 0);
      const projectBudget = Number(session.plan?.budget?.amount ?? session.proposal?.budget?.amount ?? 0);
      const remainingBudget = Math.max(0, projectBudget - committedAndReserved);
      const packageCeiling = Math.min(Number(workPackage.budgetCeiling), remainingBudget);
      if (!Number.isFinite(packageCeiling) || packageCeiling <= 0) return json(res, 409, { error: 'No uncommitted project budget remains for this downstream package.', remainingBudget });
      if (!Array.isArray(workPackage.providerCandidates) || !workPackage.providerCandidates.length) return json(res, 409, { error: 'No shortlisted provider candidates are available for this downstream package. Rebuild the project plan to refresh discovery.' });
      const scopedPackage = {
        id: packageId, title: workPackage.title, originalBrief: workPackage.brief, brief: handoff.brief,
        acceptanceCriteria: workPackage.acceptanceCriteria, budgetCeiling: packageCeiling,
        dependsOn: [], dependencyHandoff: handoff, providerCandidates: workPackage.providerCandidates
      };
      const focusedPlan = {
        planId: `${session.plan.planId}-handoff-${packageId}-${handoff.requestFingerprint.slice(0, 10)}`,
        status: 'draft_requires_user_approval', objective: session.plan.objective,
        budget: { amount: remainingBudget, currency: session.plan.budget.currency, allocatedCeilings: packageCeiling, unallocated: Math.max(0, remainingBudget - packageCeiling) },
        workPackages: [scopedPackage], execution: { hiringStarted: false, paymentsAuthorized: false }
      };
      let proposal;
      try {
        proposal = await buildProcurementProposal(focusedPlan, { allowedAssets: X402_ALLOWED_ASSETS, allowedNetworks: X402_ALLOWED_NETWORKS, allowedAssetsByNetwork: X402_ALLOWED_ASSETS_BY_NETWORK, requireV2PaymentChallenge: true, assetDecimals: DECIMALS });
      } catch (error) {
        return json(res, 502, { error: `Fresh downstream quote request failed: ${error.message}. No payment was sent.` });
      }
      session.deferredProposals ??= {};
      const priorQuote = session.deferredProposals[packageId];
      if (priorQuote?.status === 'quoted_not_approved') priorQuote.status = 'superseded';
      session.deferredProposals[packageId] = {
        proposal, requestFingerprint: handoff.requestFingerprint, inputBundleHash: handoff.inputBundleHash,
        status: 'quoted_not_approved', createdAt: new Date().toISOString(),
        dependencySources: handoff.sourceManifest
      };
      sessions.set(session.id, session);
      return json(res, 200, {
        sessionId: session.id, packageId, proposal,
        handoff: { packageId, inputBundleHash: handoff.inputBundleHash, requestFingerprint: handoff.requestFingerprint, sources: handoff.sourceManifest, requestBytes: handoff.requestBytes },
        budget: { projectBudget: session.plan.budget.amount, committedAndReserved, remainingBeforeQuote: remainingBudget, packageCeiling },
        safety: { newQuoteRequired: true, newApprovalRequired: true, hiringStarted: false, paymentAuthorized: false, paymentSent: false },
        note: 'This is a new unpaid quote for the downstream brief containing the accepted upstream outputs. It does not reuse or modify the earlier quote, and it requires separate explicit approval.'
      });
    }

    const projectRoute = url.pathname.match(/^\/api\/project\/([a-z0-9-]{16,80})$/i);
    if (req.method === 'GET' && projectRoute) {
      const session = sessions.get(projectRoute[1]);
      if (!session) return json(res, 404, { error: 'Project not found or the session has expired.' });
      const principal = requestPrincipal(req);
      if (!principal) return json(res, 401, { error: 'Browser identity is missing or expired. Reload the application.' });
      if (session.ownerPrincipalId !== principal.principalId) return json(res, 403, { error: 'This project belongs to a different principal.' });
      let liveExecutionRecords = [];
      try {
        liveExecutionRecords = await loadProjectExecutionRecords(session, principal.principalId);
      } catch (error) {
        if (error.code === 'ENOENT') return json(res, 409, { error: 'The project references an execution record that is not available.' });
        throw error;
      }
      const latest = liveExecutionRecords.at(-1) ?? null;
      const { ownerIpHash, ownerPrincipalId, ...liveExecutionRecord } = latest ?? {};
      return json(res, 200, publicProjectSnapshot(session, latest ? liveExecutionRecord : null, latest ? summarizePaymentAudit(latest) : null, liveExecutionRecords.map((record) => {
        const { ownerIpHash: _ip, ownerPrincipalId: _principal, ...publicRecord } = record;
        return publicRecord;
      })));
    }
    if (req.method === 'GET') {
      const requested = url.pathname === '/' ? 'index.html' : normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
      const path = join(ROOT, 'public', requested);
      if (!path.startsWith(join(ROOT, 'public'))) return json(res, 403, { error: 'Forbidden' });
      try {
        const content = await readFile(path);
        const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
        res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' }); res.end(content); return;
      } catch { return json(res, 404, { error: 'Not found' }); }
    }
    return json(res, 405, { error: 'Method not allowed' });
  } catch (error) { return json(res, error.statusCode || 500, { error: error.message || 'Unexpected server error', balance: error.balance }); }
});

server.listen(PORT, '0.0.0.0', () => console.log(`WorkRelay running at http://localhost:${PORT}`));
