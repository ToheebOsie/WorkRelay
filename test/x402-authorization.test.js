import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBoundX402PaymentAuthorizer,
  fingerprint,
  readPaymentRequiredHeader,
  selectedRequirementMatches
} from '../src/payments/x402-authorization.js';

const network = 'eip155:8453';
const asset = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const payTo = '0x1111111111111111111111111111111111111111';
const requirement = { scheme: 'exact', network, asset, amount: '1250000', payTo, maxTimeoutSeconds: 300 };
const challenge = { x402Version: 2, resource: { url: 'https://researcher.market.near.ai/a2a/v1', description: 'Research request' }, accepts: [requirement] };
const terms = { valid: true, scheme: requirement.scheme, network, asset, amountAtomic: requirement.amount, payTo, maxTimeoutSeconds: 300 };
const request = { jsonrpc: '2.0', id: 'quote-1', method: 'SendMessage', params: { message: { role: 'user', messageId: 'quote-1-message', parts: [{ kind: 'text', text: 'Research the Kenyan fintech market.' }] } } };
const approval = { confirmed: true, proposalId: 'proposal-1', proposalFingerprint: 'a'.repeat(64), approvedBy: 'owner', approvedAt: new Date().toISOString(), maxSpend: 2, currency: 'USDC' };
const quoteReceivedAt = new Date(Date.now() - 1000).toISOString();
const bindingInput = () => ({
  paymentTerms: terms, paymentChallenge: challenge, approval, quoteReceivedAt,
  providerEndpoint: 'https://researcher.market.near.ai/a2a/v1', a2aRequestPayload: request,
  executionId: 'wr-exec-1234567890123456', packageId: 'research', idempotencyKey: 'proposal-1:research:researcher',
  price: 1.25, amountAtomic: '1250000'
});

function validSigner() {
  return {
    async createPaymentHeader(input) {
      return {
        paymentHeader: 'signed-header-value',
        challengeFingerprint: input.binding.challengeFingerprint,
        termsFingerprint: input.binding.termsFingerprint,
        requestFingerprint: input.binding.requestFingerprint
      };
    }
  };
}

test('reads x402 v2 PAYMENT-REQUIRED as base64 JSON and retains resource and accepts', () => {
  const encoded = Buffer.from(JSON.stringify(challenge), 'utf8').toString('base64');
  const parsed = readPaymentRequiredHeader(new Headers({ 'PAYMENT-REQUIRED': encoded }));
  assert.deepEqual(parsed, challenge);
});

test('reads JSON-form x402 payment challenge headers and rejects invalid payloads', () => {
  assert.deepEqual(readPaymentRequiredHeader(new Headers({ 'PAYMENT-REQUIRED': JSON.stringify(challenge) })), challenge);
  assert.equal(readPaymentRequiredHeader(new Headers({ 'PAYMENT-REQUIRED': 'not-a-challenge' })), null);
  assert.equal(readPaymentRequiredHeader(null), null);
});

test('selected payment terms must exactly match one challenge requirement, including amount and recipient', () => {
  assert.equal(selectedRequirementMatches(challenge, terms), true);
  assert.equal(selectedRequirementMatches(challenge, { ...terms, amountAtomic: '1250001' }), false);
  assert.equal(selectedRequirementMatches(challenge, { ...terms, payTo: '0x2222222222222222222222222222222222222222' }), false);
  assert.equal(selectedRequirementMatches({ ...challenge, x402Version: 1 }, terms), true, 'the matcher compares requirements; callers separately enforce x402 v2');
});

test('bound authorizer signs only the exact approved challenge, terms and original request', async () => {
  let signerInput;
  const authorizer = createBoundX402PaymentAuthorizer({
    signer: { async createPaymentHeader(input) { signerInput = input; return validSigner().createPaymentHeader(input); } },
    allowedNetworks: [network], allowedAssetsByNetwork: { [network]: [asset] }, maxPaymentUsd: 2
  });
  const result = await authorizer(bindingInput());
  assert.equal(result.paymentHeader, 'signed-header-value');
  assert.equal(signerInput.x402Version, 2);
  assert.equal(signerInput.amountAtomic, '1250000');
  assert.equal(signerInput.binding.requestFingerprint, fingerprint(request));
  assert.equal(signerInput.binding.challengeFingerprint, fingerprint(challenge));
  assert.equal(signerInput.binding.proposalFingerprint, approval.proposalFingerprint);
  assert.equal(signerInput.paymentChallenge.accepts[0].payTo, payTo);
});

test('bound authorizer refuses unsupported network, asset, recipient, stale quote, and excessive payment before signing', async (t) => {
  const cases = [
    ['unsupported network', { paymentTerms: { ...terms, network: 'eip155:1' }, paymentChallenge: { ...challenge, accepts: [{ ...requirement, network: 'eip155:1' }] } }, /network is not allowlisted/],
    ['unsupported asset', { paymentTerms: { ...terms, asset: '0x2222222222222222222222222222222222222222' }, paymentChallenge: { ...challenge, accepts: [{ ...requirement, asset: '0x2222222222222222222222222222222222222222' }] } }, /asset is not allowlisted/],
    ['invalid recipient', { paymentTerms: { ...terms, payTo: 'not-an-address' }, paymentChallenge: { ...challenge, accepts: [{ ...requirement, payTo: 'not-an-address' }] } }, /EVM payTo/],
    ['stale quote', { quoteReceivedAt: new Date(Date.now() - 60_000).toISOString() }, /stale/],
    ['payment cap', { price: 2.01 }, /per-payment USD cap/],
    ['altered request', { a2aRequestPayload: { ...request, id: 'changed-request' } }, /not bound to the exact quote/]
  ];
  for (const [name, overrides, expected] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const authorizer = createBoundX402PaymentAuthorizer({
        signer: { async createPaymentHeader(input) { calls++; if (name === 'altered request') { const result = await validSigner().createPaymentHeader(input); result.requestFingerprint = fingerprint(request); return result; } return validSigner().createPaymentHeader(input); } },
        allowedNetworks: [network], allowedAssetsByNetwork: { [network]: [asset] }, maxPaymentUsd: 2, maxQuoteAgeMs: 10_000
      });
      await assert.rejects(() => authorizer({ ...bindingInput(), ...overrides }), expected);
      if (name !== 'altered request') assert.equal(calls, 0, 'unsafe input must fail before signing');
      else assert.equal(calls, 1, 'the adapter must prove it signed the request actually passed to it');
    });
  }
});

test('authorizer rejects incomplete approval, legacy challenge and signer proof not bound to the request', async () => {
  const authorizer = createBoundX402PaymentAuthorizer({
    signer: { async createPaymentHeader(input) { return { paymentHeader: 'header', challengeFingerprint: input.binding.challengeFingerprint, termsFingerprint: input.binding.termsFingerprint, requestFingerprint: '0'.repeat(64) }; } },
    allowedNetworks: [network], allowedAssetsByNetwork: { [network]: [asset] }
  });
  await assert.rejects(() => authorizer({ ...bindingInput(), approval: { ...approval, proposalFingerprint: undefined } }), /proposal-scoped approval fingerprint/);
  await assert.rejects(() => authorizer({ ...bindingInput(), paymentChallenge: { ...challenge, x402Version: 1 } }), /x402 v2/);
  await assert.rejects(() => authorizer(bindingInput()), /not bound to the exact quote/);
});


test('authorizer rejects an x402 v2 challenge without its required resource URL before signing', async () => {
  let calls = 0;
  const authorizer = createBoundX402PaymentAuthorizer({
    signer: { async createPaymentHeader(input) { calls++; return validSigner().createPaymentHeader(input); } },
    allowedNetworks: [network], allowedAssetsByNetwork: { [network]: [asset] }
  });
  await assert.rejects(() => authorizer({ ...bindingInput(), paymentChallenge: { x402Version: 2, accepts: [requirement] } }), /resource URL is required/);
  assert.equal(calls, 0);
});
