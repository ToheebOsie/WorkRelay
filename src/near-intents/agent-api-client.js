import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://api.agentsonintents.com';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeBaseUrl(value) {
  const parsed = new URL(value || DEFAULT_BASE_URL);
  assert(parsed.protocol === 'https:', 'NEAR Agent API base URL must use HTTPS');
  assert(!parsed.username && !parsed.password && !parsed.hash, 'NEAR Agent API base URL must not contain credentials or a fragment');
  return parsed.toString().replace(/\/$/, '');
}

function parseResponse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Minimal server-side client for the official NEAR Intents Agent API.
 * Keep the API key and grant tokens on the backend. This client deliberately
 * does not implement wallet signing or silently submit unsigned intents.
 */
export function createNearAgentApiClient({ apiKey, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, timeoutMs = 20000 }) {
  assert(typeof apiKey === 'string' && apiKey.trim(), 'NEAR_INTENTS_AGENT_API_KEY is required');
  assert(typeof fetchImpl === 'function', 'fetchImpl must be a function');
  const base = safeBaseUrl(baseUrl);

  async function request(path, { method = 'GET', body, idempotencyKey, grantToken, signal } = {}) {
    const headers = { accept: 'application/json', 'X-API-Key': apiKey.trim() };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (grantToken) headers['X-Grant-Token'] = grantToken;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const relayAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', relayAbort, { once: true });
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const payload = parseResponse(await response.text());
      if (!response.ok) {
        const error = new Error(`NEAR Agent API request failed (${response.status})`);
        error.status = response.status;
        error.code = payload?.code ?? payload?.error?.code ?? null;
        error.layer = payload?.layer ?? null;
        error.details = payload;
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', relayAbort);
    }
  }

  return Object.freeze({
    baseUrl: base,
    whoami: () => request('/v1/whoami'),
    getNetwork: () => request('/v1/network'),
    getQuota: () => request('/v1/quotas'),
    getTokens: () => request('/v1/tokens'),
    generateIntent: (intent, idempotencyKey) => {
      assert(intent && ['agent_create', 'grant_issue', 'grant_revoke', 'agent_freeze', 'agent_unfreeze', 'policy_update'].includes(intent.type), 'Unsupported owner intent type');
      assert(typeof idempotencyKey === 'string' && idempotencyKey.trim(), 'An Idempotency-Key is required');
      return request('/v1/generate-intent', { method: 'POST', body: intent, idempotencyKey });
    },
    submitIntent: (type, correlationId, signedData) => {
      assert(typeof type === 'string' && typeof correlationId === 'string' && correlationId, 'Intent type and correlationId are required');
      assert(signedData && typeof signedData === 'object', 'Wallet-signed data is required; unsigned intents cannot be submitted');
      return request('/v1/submit-intent', { method: 'POST', body: { type, correlation_id: correlationId, signed_data: signedData } });
    },
    getStatus: (correlationId, waitMs = 0) => {
      assert(typeof correlationId === 'string' && correlationId.trim(), 'correlationId is required');
      assert(Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= 30000, 'waitMs must be an integer from 0 to 30000');
      const query = new URLSearchParams({ correlation_id: correlationId, wait_ms: String(waitMs) });
      return request(`/v1/status?${query}`);
    },
    getAgent: (agentId) => request(`/v1/agents/${encodeURIComponent(agentId)}`),
    getPolicy: (agentId) => request(`/v1/agents/${encodeURIComponent(agentId)}/policy`),
    listGrants: (agentId) => request(`/v1/agents/${encodeURIComponent(agentId)}/grants`),
    getBalances: (agentId) => request(`/v1/agents/${encodeURIComponent(agentId)}/balances`),
    transfer: (agentId, transfer, { grantToken, idempotencyKey } = {}) => {
      assert(typeof grantToken === 'string' && grantToken.startsWith('ngt_'), 'A valid grant token is required');
      assert(typeof idempotencyKey === 'string' && idempotencyKey.trim(), 'An Idempotency-Key is required for transfers');
      return request(`/v1/agents/${encodeURIComponent(agentId)}/transfer`, { method: 'POST', body: transfer, grantToken, idempotencyKey });
    }
  });
}

/** Generate a grant secret locally. Store token encrypted before displaying or using it. */
export function createGrantCredential({ randomBytesImpl = randomBytes } = {}) {
  const token = `ngt_${randomBytesImpl(32).toString('base64url')}`;
  const commitment = createHash('sha256').update(token, 'utf8').digest('hex');
  return { token, commitment };
}

/** Conservative policy template: only listed transfer recipients, one asset, human approval and a delay. */
export function buildWorkRelayTreasuryPolicy({ assetId, recipientAddresses, perTransactionAtomic, dailyBudgetUsd, timelockMs = 60000 }) {
  assert(typeof assetId === 'string' && assetId.trim(), 'An exact assetId is required');
  assert(Array.isArray(recipientAddresses) && recipientAddresses.length > 0, 'At least one independently verified recipient is required');
  assert(recipientAddresses.every((value) => typeof value === 'string' && value.trim()), 'Recipient addresses must be non-empty strings');
  assert(new Set(recipientAddresses).size === recipientAddresses.length, 'Recipient addresses must be unique');
  assert(typeof perTransactionAtomic === 'string' && /^\d+$/.test(perTransactionAtomic) && BigInt(perTransactionAtomic) > 0n, 'perTransactionAtomic must be a positive integer string');
  assert(typeof dailyBudgetUsd === 'string' && /^\d+(?:\.\d{1,2})?$/.test(dailyBudgetUsd) && Number(dailyBudgetUsd) > 0, 'dailyBudgetUsd must be a positive USD decimal string');
  assert(Number.isInteger(timelockMs) && timelockMs >= 0 && timelockMs <= 30 * 24 * 60 * 60 * 1000, 'timelockMs must be between 0 and 30 days');

  return {
    frozen: false,
    actions: ['transfer'],
    confidential: true,
    owner_approval: true,
    assets: [assetId],
    limits: { per_transaction: { [assetId]: perTransactionAtomic } },
    max_actions_per_hour: 10,
    destinations: {
      mode: 'only',
      list: recipientAddresses.map((address) => ({ action: 'transfer', address, confidential: true }))
    },
    budget: { daily_usd: dailyBudgetUsd, weekly_usd: null, monthly_usd: null },
    timelock_ms: timelockMs
  };
}

/** Do not accept a policy that quietly widens the WorkRelay payment boundary. */
export function validateWorkRelayTreasuryPolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object') return { valid: false, errors: ['Policy must be an object'] };
  if (policy.frozen !== false) errors.push('Policy must explicitly start unfrozen');
  if (JSON.stringify(policy.actions) !== JSON.stringify(['transfer'])) errors.push('Only transfer is permitted in the initial WorkRelay treasury policy');
  if (policy.confidential !== true) errors.push('Confidential balance is required');
  if (policy.owner_approval !== true) errors.push('Owner approval must be enabled for every money action');
  if (!Array.isArray(policy.assets) || policy.assets.length !== 1 || !policy.assets[0]) errors.push('Exactly one explicit asset must be allowlisted');
  if (policy.destinations?.mode !== 'only' || !Array.isArray(policy.destinations?.list) || !policy.destinations.list.length) errors.push('A non-empty explicit recipient allowlist is required');
  if (policy.destinations?.list?.some((entry) => entry.action !== 'transfer' || entry.confidential !== true || typeof entry.address !== 'string' || !entry.address)) errors.push('Every destination must be a confidential transfer recipient');
  if (!policy.limits?.per_transaction || Object.keys(policy.limits.per_transaction).length !== 1) errors.push('A per-transaction asset cap is required');
  if (!policy.budget?.daily_usd || Number(policy.budget.daily_usd) <= 0) errors.push('A positive daily USD budget is required');
  if (!Number.isInteger(policy.timelock_ms) || policy.timelock_ms < 0) errors.push('A valid timelock is required');
  if (policy.native) errors.push('Native signing methods are not permitted');
  return { valid: errors.length === 0, errors };
}
