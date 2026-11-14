import { createHash } from 'node:crypto';

const sha256 = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
export const fingerprint = (value) => sha256(canonical(value));

function decodePaymentRequired(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const candidate = value.trim();
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* standard x402 headers are base64 encoded */ }
  if (candidate.length > 128_000) return null;
  try {
    const decoded = Buffer.from(candidate.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function amountOf(item) {
  return String(item?.amount ?? item?.maxAmountRequired ?? item?.amountAtomic ?? '');
}

export function selectedRequirementMatches(challenge, selected) {
  if (!challenge || !Array.isArray(challenge.accepts) || !selected) return false;
  const expected = {
    scheme: selected.scheme,
    network: selected.network,
    asset: selected.asset,
    payTo: selected.payTo,
    amount: amountOf(selected),
    maxTimeoutSeconds: Number(selected.maxTimeoutSeconds)
  };
  return challenge.accepts.some((candidate) =>
    candidate?.scheme === expected.scheme
    && candidate?.network === expected.network
    && String(candidate?.asset ?? '') === String(expected.asset ?? '')
    && String(candidate?.payTo ?? '') === String(expected.payTo ?? '')
    && amountOf(candidate) === expected.amount
    && Number(candidate?.maxTimeoutSeconds) === expected.maxTimeoutSeconds
  );
}

function isEvmNetwork(network) {
  return typeof network === 'string' && /^eip155:\d+$/.test(network);
}

function validatePayTo(network, payTo) {
  if (typeof payTo !== 'string' || !payTo.trim()) return 'Payment recipient is missing';
  if (isEvmNetwork(network) && !/^0x[a-fA-F0-9]{40}$/.test(payTo)) return 'EVM payTo must be a 20-byte hexadecimal address';
  if (network === 'near:mainnet' && !/^(?:[a-z0-9_-]+\.)*[a-z0-9_-]+$/.test(payTo)) return 'NEAR payTo must be a valid account identifier';
  return null;
}

/**
 * Create a strict authorization boundary around an operator-installed wallet adapter.
 * The adapter is trusted code and must use an audited x402 client implementation; this
 * module does not hold keys, derive signatures, or invent payment payloads.
 */
export function createBoundX402PaymentAuthorizer({
  signer,
  allowedNetworks = [],
  allowedAssetsByNetwork = {},
  maxPaymentUsd = 5,
  maxQuoteAgeMs = 15 * 60 * 1000,
  now = () => Date.now()
} = {}) {
  if (!signer || typeof signer.createPaymentHeader !== 'function') {
    throw new TypeError('A reviewed wallet adapter exposing createPaymentHeader() is required');
  }
  if (!Array.isArray(allowedNetworks) || !allowedNetworks.length) throw new TypeError('An explicit x402 network allowlist is required');
  if (!allowedAssetsByNetwork || typeof allowedAssetsByNetwork !== 'object' || !Object.keys(allowedAssetsByNetwork).length) {
    throw new TypeError('An explicit per-network x402 asset allowlist is required');
  }
  if (!Number.isFinite(maxPaymentUsd) || maxPaymentUsd <= 0) throw new TypeError('maxPaymentUsd must be positive');
  if (!Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs <= 0) throw new TypeError('maxQuoteAgeMs must be positive');

  return async function authorizeX402Payment(input) {
    const { paymentTerms, paymentChallenge, approval, quoteReceivedAt, providerEndpoint, a2aRequestPayload } = input ?? {};
    if (approval?.confirmed !== true || !approval.proposalId || !approval.proposalFingerprint || !approval.approvedBy) {
      throw new Error('A proposal-scoped approval fingerprint and authenticated approver are required');
    }
    if (typeof input.packageId !== 'string' || !input.packageId || typeof input.executionId !== 'string' || !input.executionId) {
      throw new Error('Execution and package identity are required for payment authorization');
    }
    if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 8) throw new Error('A stable per-package idempotency key is required');
    if (paymentChallenge?.x402Version !== 2 || !Array.isArray(paymentChallenge.accepts)) {
      throw new Error('Only an intact x402 v2 payment challenge can be authorized');
    }
    if (!selectedRequirementMatches(paymentChallenge, paymentTerms)) throw new Error('Selected payment terms do not match an accepted option in the original 402 challenge');
    if (paymentTerms?.scheme !== 'exact') throw new Error('Only exact-amount x402 payments are permitted');
    if (!allowedNetworks.includes(paymentTerms.network)) throw new Error(`x402 network is not allowlisted: ${paymentTerms.network}`);
    const configuredAssets = (allowedAssetsByNetwork[paymentTerms.network] ?? []).map((value) => String(value).toLowerCase());
    if (!configuredAssets.includes(String(paymentTerms.asset ?? '').toLowerCase())) throw new Error(`x402 asset is not allowlisted for ${paymentTerms.network}`);
    const recipientError = validatePayTo(paymentTerms.network, paymentTerms.payTo);
    if (recipientError) throw new Error(recipientError);
    const amountAtomic = amountOf(paymentTerms);
    if (!/^\d+$/.test(amountAtomic) || BigInt(amountAtomic) <= 0n) throw new Error('Payment amount must be a positive atomic integer');
    const timeout = Number(paymentTerms.maxTimeoutSeconds);
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86_400) throw new Error('Payment timeout must be between 1 second and 24 hours');
    if (!Number.isFinite(Number(input.price)) || Number(input.price) <= 0 || Number(input.price) > maxPaymentUsd + 1e-9) {
      throw new Error('Payment exceeds the configured per-payment USD cap');
    }
    const quotedAt = Date.parse(quoteReceivedAt ?? '');
    if (!Number.isFinite(quotedAt) || now() - quotedAt > Math.min(maxQuoteAgeMs, timeout * 1000) || quotedAt > now() + 30_000) {
      throw new Error('The original payment challenge is stale; obtain a fresh quote and approval');
    }
    if (typeof providerEndpoint !== 'string' || !providerEndpoint.startsWith('https://')) throw new Error('The quoted HTTPS provider endpoint is required');
    const endpoint = new URL(providerEndpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash || !endpoint.hostname.endsWith('.market.near.ai')) throw new Error('Payment is restricted to a credential-free HTTPS NEAR Agent Market provider endpoint');
    if (a2aRequestPayload?.method !== 'SendMessage' || a2aRequestPayload?.jsonrpc !== '2.0') throw new Error('The exact original A2A SendMessage request is required');
    const resourceUrl = paymentChallenge.resource?.url;
    if (typeof resourceUrl !== 'string' || !resourceUrl.trim()) throw new Error('The x402 v2 resource URL is required');
    let resource;
    try { resource = new URL(resourceUrl); } catch { throw new Error('The x402 resource URL is invalid'); }
    if (resource.protocol !== 'https:' || resource.username || resource.password || resource.hostname !== endpoint.hostname || resource.hash) {
      throw new Error('The x402 resource is not bound to the quoted HTTPS provider host');
    }

    const selected = paymentChallenge.accepts.find((candidate) =>
      candidate?.scheme === paymentTerms.scheme
      && candidate?.network === paymentTerms.network
      && String(candidate?.asset ?? '').toLowerCase() === String(paymentTerms.asset).toLowerCase()
      && candidate?.payTo === paymentTerms.payTo
      && amountOf(candidate) === amountAtomic
      && Number(candidate?.maxTimeoutSeconds) === timeout
    );
    if (!selected) throw new Error('Selected payment requirement could not be recovered from the original challenge');

    const binding = {
      executionId: input.executionId,
      packageId: input.packageId,
      proposalId: approval.proposalId,
      proposalFingerprint: approval.proposalFingerprint,
      idempotencyKey: input.idempotencyKey,
      providerEndpoint,
      requestFingerprint: fingerprint(a2aRequestPayload),
      challengeFingerprint: fingerprint(paymentChallenge.raw ?? paymentChallenge),
      termsFingerprint: fingerprint(selected),
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      maxSpend: approval.maxSpend,
      currency: approval.currency
    };
    const signed = await signer.createPaymentHeader({
      x402Version: 2,
      resource: structuredClone(paymentChallenge.resource ?? null),
      paymentRequirements: structuredClone(selected),
      paymentChallenge: structuredClone(paymentChallenge.raw ?? paymentChallenge),
      binding: structuredClone(binding),
      amountAtomic,
      purpose: 'WorkRelay approved NEAR Agent Market A2A commission'
    });
    if (!signed || typeof signed.paymentHeader !== 'string' || !signed.paymentHeader.trim()) {
      throw new Error('Wallet adapter did not return a signed x402 payment header');
    }
    if (signed.challengeFingerprint !== binding.challengeFingerprint || signed.termsFingerprint !== binding.termsFingerprint || signed.requestFingerprint !== binding.requestFingerprint) {
      throw new Error('Wallet adapter payment proof is not bound to the exact quote, payment terms and A2A request');
    }
    return { paymentHeader: signed.paymentHeader, authorizationId: signed.authorizationId ?? null };
  };
}

export function readPaymentRequiredHeader(headers) {
  if (!headers?.get) return null;
  return decodePaymentRequired(headers.get('PAYMENT-REQUIRED') ?? headers.get('X-PAYMENT-REQUIRED'));
}
