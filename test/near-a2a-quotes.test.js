import test from 'node:test';
import assert from 'node:assert/strict';
import { requestProviderQuote, validatePaymentTerms, atomicToUnits } from '../src/market/near-a2a-quotes.js';

const workPackage = { brief: 'Gather evidence and cite source URLs.', acceptanceCriteria: ['Claims have source URLs'] };
const terms = { scheme: 'exact', network: 'near:mainnet', asset: 'usdc.near', maxAmountRequired: '1250000', payTo: 'provider.near', maxTimeoutSeconds: 300 };
const card = (url) => ({
  name: 'Research Agent', description: 'Research agent', version: '1.0.0',
  supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]
});
const fetchWithCardAndQuote = (quoteResponse = new Response(JSON.stringify({ accepts: [terms] }), { status: 402 })) => async (url, options) => {
  if (options.method === 'GET') {
    const host = new URL(url).host;
    return new Response(JSON.stringify(card(`https://${host}/a2a/v1`)), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return quoteResponse;
};

test('discovers the Agent Card endpoint before requesting an unpaid A2A quote', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'GET') return new Response(JSON.stringify(card('https://web-research.market.near.ai/a2a/v1')), { status: 200 });
    return new Response(JSON.stringify({ accepts: [terms] }), { status: 402 });
  };
  const result = await requestProviderQuote({ agent: { handle: 'web-research' }, workPackage, fetchImpl, requestId: 'test-1' });
  assert.equal(requests[0].url, 'https://web-research.market.near.ai/.well-known/agent-card.json');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[1].url, 'https://web-research.market.near.ai/a2a/v1');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.headers['content-type'], 'application/json');
  assert.equal(requests[1].options.headers['X-PAYMENT'], undefined);
  assert.equal(requests[1].options.headers['A2A-Version'], '1.0');
  const body = JSON.parse(requests[1].options.body);
  assert.equal(body.method, 'SendMessage');
  assert.equal(body.params.message.parts[0].text, workPackage.brief);
  assert.equal(result.status, 'quote_received');
  assert.equal(result.quote.alternatives[0].maxAmountRequired, '1250000');
});

test('reads the current PAYMENT-REQUIRED x402 v2 header before falling back to response-body parsing', async () => {
  const headerChallenge = { x402Version: 2, resource: { url: 'https://web-research.market.near.ai/a2a/v1' }, accepts: [{ scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1250000', payTo: '0x1111111111111111111111111111111111111111', maxTimeoutSeconds: 300 }] };
  const encoded = Buffer.from(JSON.stringify(headerChallenge)).toString('base64');
  const result = await requestProviderQuote({
    agent: { handle: 'web-research' }, workPackage,
    fetchImpl: fetchWithCardAndQuote(new Response('{}', { status: 402, headers: { 'PAYMENT-REQUIRED': encoded, 'content-type': 'application/json' } }))
  });
  assert.equal(result.status, 'quote_received');
  assert.equal(result.quote.paymentChallenge.x402Version, 2);
  assert.equal(result.quote.alternatives[0].network, 'eip155:8453');
  assert.equal(result.quote.paymentChallenge.resource.url, headerChallenge.resource.url);
});

test('rejects malformed provider handles before network access', async () => {
  await assert.rejects(() => requestProviderQuote({ agent: { handle: 'https://evil.example' }, workPackage, fetchImpl: async () => { throw new Error('must not call'); } }), /invalid/);
});

test('adapts a known provider schema and refuses unknown required fields', async () => {
  let sent;
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') return new Response(JSON.stringify(card(`https://${new URL(url).host}/a2a/v1`)), { status: 200 });
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ accepts: [terms] }), { status: 402 });
  };
  const good = await requestProviderQuote({
    agent: { handle: 'schema-agent', inputSchema: { type: 'object', properties: { brief: { type: 'string' }, must_include: { type: 'array' } }, required: ['brief'] } },
    workPackage, fetchImpl
  });
  assert.equal(good.status, 'quote_received');
  assert.deepEqual(JSON.parse(sent.params.message.parts[0].text).must_include, workPackage.acceptanceCriteria);
  const bad = await requestProviderQuote({
    agent: { handle: 'schema-agent', inputSchema: { properties: { brief: { type: 'string' }, customer_id: { type: 'string' } }, required: ['customer_id'] } },
    workPackage, fetchImpl
  });
  assert.equal(bad.status, 'schema_unsupported');
});

test('recognizes payment-required task metadata returned in HTTP 200', async () => {
  const result = await requestProviderQuote({
    agent: { handle: 'web-research' }, workPackage,
    fetchImpl: fetchWithCardAndQuote(new Response(JSON.stringify({ result: { status: { state: 'input-required', message: { metadata: { 'x402.payment.required': { accepts: [terms] } } } } } }), { status: 200 }))
  });
  assert.equal(result.status, 'quote_received');
  assert.equal(result.taskState, 'input-required');
});

test('captures 405 Allow header and response body for diagnosis', async () => {
  const result = await requestProviderQuote({
    agent: { handle: 'web-research' }, workPackage,
    fetchImpl: fetchWithCardAndQuote(new Response(JSON.stringify({ error: { message: 'Method not allowed' } }), { status: 405, headers: { allow: 'GET, OPTIONS' } }))
  });
  assert.equal(result.status, 'quote_unavailable');
  assert.equal(result.httpStatus, 405);
  assert.equal(result.allow, 'GET, OPTIONS');
  assert.equal(result.responseBody.error.message, 'Method not allowed');
});

test('does not POST to a guessed root when no Agent Card endpoint is discoverable', async () => {
  const calls = [];
  const result = await requestProviderQuote({
    agent: { handle: 'missing-card' }, workPackage,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method });
      return new Response('not found', { status: 404 });
    }
  });
  assert.equal(result.status, 'endpoint_discovery_failed');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.method === 'GET'));
});

test('refuses cross-host endpoint URLs declared by an Agent Card', async () => {
  let postCount = 0;
  const result = await requestProviderQuote({
    agent: { handle: 'web-research' }, workPackage,
    fetchImpl: async (_url, options) => {
      if (options.method === 'POST') postCount++;
      return new Response(JSON.stringify(card('https://evil.example/a2a')), { status: 200 });
    }
  });
  assert.equal(result.status, 'endpoint_discovery_failed');
  assert.equal(postCount, 0);
});

test('supports legacy A2A cards that publish top-level url', async () => {
  const result = await requestProviderQuote({
    agent: { handle: 'legacy-agent' }, workPackage,
    fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return new Response(JSON.stringify({ name: 'Legacy', url: 'https://legacy-agent.market.near.ai/rpc', preferredTransport: 'JSONRPC' }), { status: 200 });
      return new Response(JSON.stringify({ accepts: [terms] }), { status: 402 });
    }
  });
  assert.equal(result.status, 'quote_received');
  assert.equal(result.endpoint, 'https://legacy-agent.market.near.ai/rpc');
});

test('normalizes x402 v2 amount into the internal atomic amount field', () => {
  const v2 = { scheme: 'exact', network: 'near:mainnet', asset: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', amount: '2000000', payTo: 'ea667f5f496e60033bf8075cce4793efdeba28d74d116ef95848324347f539fc', maxTimeoutSeconds: 4200 };
  const result = validatePaymentTerms(v2, { allowedNetworks: ['near:mainnet'], allowedAssetsByNetwork: { 'near:mainnet': [v2.asset] } });
  assert.equal(result.valid, true);
  assert.equal(result.amountAtomic, '2000000');
  assert.equal(atomicToUnits(result.amountAtomic, 6), 2);
});

test('validates exact NEAR mainnet USDC terms only against explicit allowlist', () => {
  assert.equal(validatePaymentTerms(terms, { allowedNetworks: ['near:mainnet'], allowedAssetsByNetwork: { 'near:mainnet': ['usdc.near'] } }).valid, true);
  const wrongNetwork = validatePaymentTerms({ ...terms, network: 'near:testnet' }, { allowedNetworks: ['near:mainnet'], allowedAssetsByNetwork: { 'near:mainnet': ['usdc.near'] } });
  assert.equal(wrongNetwork.valid, false);
  const noAllowlist = validatePaymentTerms(terms);
  assert.equal(noAllowlist.valid, false);
  assert.match(noAllowlist.errors.join(' '), /not allowlisted/);
});

test('converts atomic USDC units', () => {
  assert.equal(atomicToUnits('1250000', 6), 1.25);
  assert.equal(atomicToUnits('1000000', 6), 1);
});

test('returns quote_unavailable for ordinary provider responses without payment terms', async () => {
  const result = await requestProviderQuote({
    agent: { handle: 'web-research' }, workPackage,
    fetchImpl: fetchWithCardAndQuote(new Response(JSON.stringify({ result: { status: { state: 'completed' } } }), { status: 200 }))
  });
  assert.equal(result.status, 'quote_unavailable');
});

test('retrieves A2A task state and text artifacts without payment headers', async () => {
  const { getProviderTask } = await import('../src/market/near-a2a-quotes.js');
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'GET') return new Response(JSON.stringify({ supportedInterfaces: [{ protocolBinding: 'JSONRPC', url: 'https://provider-a.market.near.ai/a2a/v1', protocolVersion: '0.3' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ result: { id: 'task-123', status: { state: 'completed', timestamp: '2026-11-14T04:00:00Z' }, artifacts: [{ artifactId: 'report', name: 'Research report', parts: [{ kind: 'text', text: 'Evidence and conclusions.' }] }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await getProviderTask({ agent: { handle: 'provider-a' }, taskId: 'task-123', fetchImpl });
  assert.equal(result.status, 'task_retrieved');
  assert.equal(result.taskStatus, 'completed');
  assert.equal(result.artifacts[0].text, 'Evidence and conclusions.');
  assert.equal(calls[1].options.headers['X-PAYMENT'], undefined);
  assert.equal(JSON.parse(calls[1].options.body).method, 'GetTask');
});

const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_RECIPIENT = '0x1111111111111111111111111111111111111111';
const x402Terms = (amount = '2000000') => ({ scheme: 'exact', network: 'eip155:8453', asset: BASE_USDC, amount, payTo: BASE_RECIPIENT, maxTimeoutSeconds: 600 });
const x402Challenge = (provider = 'web-research', amount = '2000000') => ({
  x402Version: 2,
  resource: { url: `https://${provider}.market.near.ai/a2a/v1` },
  accepts: [x402Terms(amount)]
});
const commissionerTerms = (amount = '2000000') => ({ valid: true, ...x402Terms(amount), amountAtomic: amount });
const commissionerApproval = () => ({ confirmed: true, proposalId: 'proposal', proposalFingerprint: 'a'.repeat(64), approvedBy: 'user', approvedAt: new Date().toISOString(), maxSpend: 5, currency: 'USDC' });
const commissionerRequest = () => ({ jsonrpc: '2.0', id: 'quote-123', method: 'SendMessage', params: { message: { role: 'user', messageId: 'quote-123-message', parts: [{ kind: 'text', text: 'Do the research.' }] } } });

test('paid A2A commissioner reuses the exact quote-bound request and sends X-PAYMENT only after approval', async () => {
  const { createNearA2ACommissioner } = await import('../src/market/near-a2a-quotes.js');
  const calls = [];
  const requestPayload = commissionerRequest();
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'GET') return new Response(JSON.stringify(card(`https://${new URL(url).host}/a2a/v1`)), { status: 200 });
    return new Response(JSON.stringify({ result: { id: 'task-paid-1', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'report', parts: [{ kind: 'text', text: 'A completed research deliverable with adequate evidence and source references.' }] }] } }), { status: 200 });
  };
  let authorizationInput;
  const commissioner = createNearA2ACommissioner({
    allowedAssets: [BASE_USDC], allowedNetworks: ['eip155:8453'], allowedAssetsByNetwork: { 'eip155:8453': [BASE_USDC] }, fetchImpl,
    paymentAuthorizer: async (input) => { authorizationInput = input; return { paymentHeader: 'signed-proof-secret' }; }
  });
  const result = await commissioner.commission({
    provider: 'web-research', brief: 'Do the research.', acceptanceCriteria: ['Cite sources'], price: 2, currency: 'USDC',
    paymentTerms: commissionerTerms(), paymentChallenge: x402Challenge(), quoteReceivedAt: new Date().toISOString(),
    idempotencyKey: 'proposal:research:web-research', a2aRequestPayload: requestPayload,
    providerEndpoint: 'https://web-research.market.near.ai/a2a/v1', executionId: 'exec-1234567890123456', packageId: 'research', approval: commissionerApproval()
  });
  assert.equal(result.status, 'commissioned');
  assert.equal(result.taskId, 'task-paid-1');
  assert.equal(result.providerTaskState, 'TASK_STATE_COMPLETED');
  assert.match(result.artifacts[0].text, /completed research deliverable/);
  assert.equal(result.paymentMode, 'x402_delivery_escrow');
  assert.equal(authorizationInput.amountAtomic, '2000000');
  assert.equal(authorizationInput.price, 2);
  assert.equal(calls[1].options.headers['X-PAYMENT'], 'signed-proof-secret');
  assert.deepEqual(JSON.parse(calls[1].options.body), requestPayload);
});

test('paid A2A commissioner rejects a price mismatch before requesting a signature', async () => {
  const { createNearA2ACommissioner } = await import('../src/market/near-a2a-quotes.js');
  let signerCalled = false;
  const commissioner = createNearA2ACommissioner({ allowedAssets: [BASE_USDC], allowedNetworks: ['eip155:8453'], paymentAuthorizer: async () => { signerCalled = true; return { paymentHeader: 'x' }; } });
  const result = await commissioner.commission({
    provider: 'web-research', brief: 'Task', acceptanceCriteria: [], price: 2.01, currency: 'USDC',
    paymentTerms: commissionerTerms(), paymentChallenge: x402Challenge(), quoteReceivedAt: new Date().toISOString(),
    idempotencyKey: 'idempotency-key', a2aRequestPayload: commissionerRequest(), providerEndpoint: 'https://web-research.market.near.ai/a2a/v1',
    executionId: 'exec-1234567890123456', packageId: 'research', approval: commissionerApproval()
  });
  assert.equal(result.status, 'rejected_before_payment');
  assert.match(result.reason, /does not exactly match/);
  assert.equal(result.paymentMayHaveBeenSent, false);
  assert.equal(signerCalled, false);
});

test('paid A2A commissioner refuses a changed endpoint before asking the signer', async () => {
  const { createNearA2ACommissioner } = await import('../src/market/near-a2a-quotes.js');
  let signerCalled = false;
  const commissioner = createNearA2ACommissioner({
    allowedAssets: [BASE_USDC], allowedNetworks: ['eip155:8453'],
    paymentAuthorizer: async () => { signerCalled = true; return { paymentHeader: 'proof' }; },
    fetchImpl: async (url, options) => options.method === 'GET'
      ? new Response(JSON.stringify(card(`https://${new URL(url).host}/new-endpoint`)), { status: 200 })
      : new Response('{}', { status: 200 })
  });
  const result = await commissioner.commission({
    provider: 'web-research', brief: 'Task', acceptanceCriteria: [], price: 2, currency: 'USDC',
    paymentTerms: commissionerTerms(), paymentChallenge: x402Challenge(), quoteReceivedAt: new Date().toISOString(),
    idempotencyKey: 'idempotency-key', providerEndpoint: 'https://web-research.market.near.ai/old-endpoint',
    a2aRequestPayload: commissionerRequest(), executionId: 'exec-1234567890123456', packageId: 'research', approval: commissionerApproval()
  });
  assert.equal(result.status, 'rejected_before_payment');
  assert.match(result.reason, /endpoint changed/);
  assert.equal(result.paymentMayHaveBeenSent, false);
  assert.equal(signerCalled, false);
});


test('commissioner never falls back to another network asset list', async () => {
  const { createNearA2ACommissioner } = await import('../src/market/near-a2a-quotes.js');
  let signerCalled = false;
  const commissioner = createNearA2ACommissioner({
    allowedAssets: [BASE_USDC], allowedNetworks: ['eip155:8453'],
    allowedAssetsByNetwork: { 'eip155:137': ['0x0000000000000000000000000000000000000001'] },
    paymentAuthorizer: async () => { signerCalled = true; return { paymentHeader: 'proof' }; }
  });
  const result = await commissioner.commission({
    provider: 'web-research', brief: 'Task', acceptanceCriteria: [], price: 2, currency: 'USDC',
    paymentTerms: commissionerTerms(), paymentChallenge: x402Challenge(), quoteReceivedAt: new Date().toISOString(),
    idempotencyKey: 'idempotency-key', a2aRequestPayload: commissionerRequest(), providerEndpoint: 'https://web-research.market.near.ai/a2a/v1',
    executionId: 'exec-1234567890123456', packageId: 'research', approval: commissionerApproval()
  });
  assert.equal(result.status, 'rejected_before_payment');
  assert.match(result.reason, /per-network x402 allowlist/);
  assert.equal(signerCalled, false);
});

test('payment authorizer failures are definitive before the paid request crosses the network boundary', async () => {
  const { createNearA2ACommissioner } = await import('../src/market/near-a2a-quotes.js');
  const calls = [];
  const commissioner = createNearA2ACommissioner({
    allowedAssets: [BASE_USDC], allowedNetworks: ['eip155:8453'],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(card(`https://${new URL(url).host}/a2a/v1`)), { status: 200 });
    },
    paymentAuthorizer: async () => { throw new Error('wallet adapter policy denied this challenge'); }
  });
  const result = await commissioner.commission({
    provider: 'web-research', brief: 'Task', acceptanceCriteria: [], price: 2, currency: 'USDC',
    paymentTerms: commissionerTerms(), paymentChallenge: x402Challenge(), quoteReceivedAt: new Date().toISOString(),
    idempotencyKey: 'idempotency-key', a2aRequestPayload: commissionerRequest(), providerEndpoint: 'https://web-research.market.near.ai/a2a/v1',
    executionId: 'exec-1234567890123456', packageId: 'research', approval: commissionerApproval()
  });
  assert.equal(result.status, 'rejected_before_payment');
  assert.equal(result.paymentMayHaveBeenSent, false);
  assert.match(result.reason, /policy denied/);
  assert.equal(calls.length, 1, 'only the unpaid Agent Card GET may occur');
});

test('a transport error after the paid A2A POST begins remains ambiguous', async () => {
  const { createNearA2ACommissioner } = await import('../src/market/near-a2a-quotes.js');
  const calls = [];
  const commissioner = createNearA2ACommissioner({
    allowedAssets: [BASE_USDC], allowedNetworks: ['eip155:8453'],
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'GET') return new Response(JSON.stringify(card(`https://${new URL(url).host}/a2a/v1`)), { status: 200 });
      throw new Error('socket closed after request write');
    },
    paymentAuthorizer: async () => ({ paymentHeader: 'signed-proof' })
  });
  await assert.rejects(() => commissioner.commission({
    provider: 'web-research', brief: 'Task', acceptanceCriteria: [], price: 2, currency: 'USDC',
    paymentTerms: commissionerTerms(), paymentChallenge: x402Challenge(), quoteReceivedAt: new Date().toISOString(),
    idempotencyKey: 'idempotency-key', a2aRequestPayload: commissionerRequest(), providerEndpoint: 'https://web-research.market.near.ai/a2a/v1',
    executionId: 'exec-1234567890123456', packageId: 'research', approval: commissionerApproval()
  }), /socket closed/);
  assert.equal(calls.length, 2, 'the paid A2A POST started and must be reconciled, never blindly retried');
});

test('paid A2A HTTP rejection after X-PAYMENT is ambiguous and never a definitive rejection', async () => {
  const { createNearA2ACommissioner } = await import('../src/market/near-a2a-quotes.js');
  let paymentHeaderSent = false;
  const commissioner = createNearA2ACommissioner({
    allowedAssets: [BASE_USDC], allowedNetworks: ['eip155:8453'],
    paymentAuthorizer: async () => ({ paymentHeader: 'signed-payment-proof' }),
    fetchImpl: async (url, options) => {
      if (options.method === 'GET') return new Response(JSON.stringify(card(`https://${new URL(url).host}/a2a/v1`)), { status: 200 });
      paymentHeaderSent = options.headers['X-PAYMENT'] === 'signed-payment-proof';
      return new Response(JSON.stringify({ error: { message: 'Payment not accepted' } }), { status: 402 });
    }
  });
  const result = await commissioner.commission({
    provider: 'web-research', brief: 'Task', acceptanceCriteria: [], price: 2, currency: 'USDC',
    paymentTerms: commissionerTerms(), paymentChallenge: x402Challenge(), quoteReceivedAt: new Date().toISOString(),
    idempotencyKey: 'idempotency-key', a2aRequestPayload: commissionerRequest(), providerEndpoint: 'https://web-research.market.near.ai/a2a/v1',
    executionId: 'exec-1234567890123456', packageId: 'research', approval: commissionerApproval()
  });
  assert.equal(paymentHeaderSent, true);
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.paymentMayHaveBeenSent, true);
  assert.equal(result.httpStatus, 402);
});
