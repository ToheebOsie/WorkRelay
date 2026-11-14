import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkRelayTreasuryPolicy, createGrantCredential, createNearAgentApiClient, validateWorkRelayTreasuryPolicy } from '../src/near-intents/agent-api-client.js';

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

test('client requires a server-side API key and HTTPS base URL', () => {
  assert.throws(() => createNearAgentApiClient({ apiKey: '' }), /API_KEY/);
  assert.throws(() => createNearAgentApiClient({ apiKey: 'secret', baseUrl: 'http://localhost' }), /HTTPS/);
});

test('generateIntent sends idempotency key and exact intent body', async () => {
  let captured;
  const client = createNearAgentApiClient({ apiKey: 'secret', fetchImpl: async (url, init) => { captured = { url, init }; return response(200, { correlation_id: 'intent_1' }); } });
  const result = await client.generateIntent({ type: 'agent_create', name: 'WorkRelay', owner: {}, policy: {} }, 'create-1');
  assert.equal(result.correlation_id, 'intent_1');
  assert.equal(captured.url, 'https://api.agentsonintents.com/v1/generate-intent');
  assert.equal(captured.init.headers['Idempotency-Key'], 'create-1');
  assert.equal(JSON.parse(captured.init.body).type, 'agent_create');
});

test('submitIntent refuses unsigned data and posts signed data unchanged', async () => {
  let captured;
  const client = createNearAgentApiClient({ apiKey: 'secret', fetchImpl: async (_url, init) => { captured = init; return response(200, { status: 'PENDING' }); } });
  assert.throws(() => client.submitIntent('agent_create', 'intent_1', null), /signed data/);
  const signed = { signed_delegate: 'opaque-signature' };
  await client.submitIntent('agent_create', 'intent_1', signed);
  assert.deepEqual(JSON.parse(captured.body).signed_data, signed);
});

test('transfer requires a grant and idempotency key', async () => {
  const client = createNearAgentApiClient({ apiKey: 'secret', fetchImpl: async () => response(202, { status: 'QUEUED' }) });
  assert.throws(() => client.transfer('agent-1', { amount: '100' }, {}), /grant token/);
  assert.throws(() => client.transfer('agent-1', { amount: '100' }, { grantToken: 'ngt_test' }), /Idempotency-Key/);
});

test('grant credential contains random token and SHA-256 commitment', () => {
  const credential = createGrantCredential({ randomBytesImpl: (n) => Buffer.alloc(n, 7) });
  assert.match(credential.token, /^ngt_/);
  assert.match(credential.commitment, /^[a-f0-9]{64}$/);
  assert.notEqual(credential.token, credential.commitment);
});

test('treasury policy defaults to single-asset, allowlisted, owner-approved transfers', () => {
  const policy = buildWorkRelayTreasuryPolicy({ assetId: 'asset:usdc', recipientAddresses: ['alice.near'], perTransactionAtomic: '2000000', dailyBudgetUsd: '5' });
  assert.equal(validateWorkRelayTreasuryPolicy(policy).valid, true);
  assert.deepEqual(policy.actions, ['transfer']);
  assert.equal(policy.owner_approval, true);
  assert.equal(policy.destinations.mode, 'only');
  assert.equal(policy.timelock_ms, 60000);
});

test('treasury policy rejects missing recipient allowlist and widened actions', () => {
  assert.throws(() => buildWorkRelayTreasuryPolicy({ assetId: 'asset:usdc', recipientAddresses: [], perTransactionAtomic: '100', dailyBudgetUsd: '1' }), /verified recipient/);
  const policy = buildWorkRelayTreasuryPolicy({ assetId: 'asset:usdc', recipientAddresses: ['alice.near'], perTransactionAtomic: '100', dailyBudgetUsd: '1' });
  policy.actions.push('withdraw');
  assert.equal(validateWorkRelayTreasuryPolicy(policy).valid, false);
});

test('API errors preserve machine-readable code and layer', async () => {
  const client = createNearAgentApiClient({ apiKey: 'secret', fetchImpl: async () => response(403, { code: 'policy_destination_denied', layer: 'policy' }) });
  await assert.rejects(() => client.whoami(), (error) => error.status === 403 && error.code === 'policy_destination_denied' && error.layer === 'policy');
});
