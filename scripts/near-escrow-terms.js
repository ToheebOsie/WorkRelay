import { createHash } from 'node:crypto';

export const TERMS_SCHEMA = 'workrelay.testnet-escrow-terms.v1';

const FIELD_ORDER = [
  'schema',
  'jobId',
  'buyerAccountId',
  'providerAccountId',
  'agentMarketHandle',
  'briefHash',
  'acceptanceCriteriaHash',
  'verifierName',
  'verifierVersion',
  'ftContractId',
  'tokenDecimals',
  'atomicAmount',
  'providerAcceptanceDeadlineNs',
  'deliveryDeadlineNs',
  'buyerReviewDeadlineNs',
  'revisionLimit',
  'resolverAccountId',
  'disputePolicyVersion',
];

/**
 * WorkRelay testnet terms v1 commitment. The property order is deliberately
 * fixed and mirrors EscrowTerms field declaration order in the Rust contract.
 * Unknown input fields are rejected rather than silently omitted.
 */
export function canonicalEscrowTerms(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('terms must be an object');
  }
  const allowed = new Set(FIELD_ORDER);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new TypeError(`unknown terms field: ${key}`);
  }
  const canonical = {};
  for (const field of FIELD_ORDER) {
    if (field === 'agentMarketHandle') {
      canonical[field] = input[field] ?? null;
    } else {
      if (!(field in input)) throw new TypeError(`missing terms field: ${field}`);
      canonical[field] = input[field];
    }
  }
  if (canonical.schema !== TERMS_SCHEMA) throw new TypeError('unsupported terms schema');
  const stringFields = [
    'jobId', 'buyerAccountId', 'providerAccountId', 'briefHash',
    'acceptanceCriteriaHash', 'verifierName', 'verifierVersion', 'ftContractId',
    'atomicAmount', 'providerAcceptanceDeadlineNs', 'deliveryDeadlineNs',
    'buyerReviewDeadlineNs', 'resolverAccountId', 'disputePolicyVersion',
  ];
  for (const field of stringFields) {
    if (typeof canonical[field] !== 'string') throw new TypeError(`${field} must be a string`);
  }
  if (canonical.agentMarketHandle !== null && typeof canonical.agentMarketHandle !== 'string') {
    throw new TypeError('agentMarketHandle must be a string or null');
  }
  if (canonical.tokenDecimals !== 6) throw new TypeError('WRT escrow v1 requires exactly 6 token decimals');
  if (!Number.isInteger(canonical.revisionLimit) || canonical.revisionLimit < 0 || canonical.revisionLimit > 1) {
    throw new TypeError('revisionLimit must be the integer 0 or 1');
  }
  if (typeof canonical.atomicAmount !== 'string' || !/^[1-9][0-9]*$/.test(canonical.atomicAmount)) {
    throw new TypeError('atomicAmount must be a positive canonical decimal string');
  }
  for (const field of [
    'providerAcceptanceDeadlineNs',
    'deliveryDeadlineNs',
    'buyerReviewDeadlineNs',
  ]) {
    if (typeof canonical[field] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(canonical[field])) {
      throw new TypeError(`${field} must be a canonical decimal string`);
    }
  }
  for (const field of ['briefHash', 'acceptanceCriteriaHash']) {
    if (typeof canonical[field] !== 'string' || !/^[0-9a-f]{64}$/.test(canonical[field])) {
      throw new TypeError(`${field} must be lowercase SHA-256 hex`);
    }
  }
  return canonical;
}

export function canonicalEscrowTermsBytes(input) {
  return Buffer.from(JSON.stringify(canonicalEscrowTerms(input)), 'utf8');
}

export function previewEscrowTermsHash(input) {
  return createHash('sha256').update(canonicalEscrowTermsBytes(input)).digest('hex');
}
