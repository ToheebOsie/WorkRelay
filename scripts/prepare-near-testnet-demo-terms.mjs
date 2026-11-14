import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalEscrowTerms, previewEscrowTermsHash, TERMS_SCHEMA } from './near-escrow-terms.js';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before preparing testnet demo terms`);
  if (!value.endsWith('.testnet')) throw new Error(`${name} must be a .testnet account`);
  return value;
}

const buyerAccountId = required('WORKRELAY_BUYER_ACCOUNT');
const providerAccountId = required('WORKRELAY_PROVIDER_ACCOUNT');
const resolverAccountId = required('WORKRELAY_RESOLVER_ACCOUNT');
const ftContractId = required('WORKRELAY_WRT_ACCOUNT');
if (new Set([buyerAccountId, providerAccountId, resolverAccountId]).size !== 3) {
  throw new Error('Buyer, provider and resolver must be distinct accounts');
}

const nowNs = BigInt(Date.now()) * 1_000_000n;
const minutes = 60n * 1_000_000_000n;
const jobId = process.env.WORKRELAY_JOB_ID?.trim() || `wr-hackathon-${Date.now()}`;
const amount = process.env.WORKRELAY_ATOMIC_AMOUNT?.trim() || '1000000'; // 1 WRT at 6 decimals
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const terms = canonicalEscrowTerms({
  schema: TERMS_SCHEMA,
  jobId,
  buyerAccountId,
  providerAccountId,
  agentMarketHandle: null,
  briefHash: sha('WORKRELAY TESTNET DEMO ONLY: illustrative research brief; not factual research.'),
  acceptanceCriteriaHash: sha('WORKRELAY TESTNET DEMO ONLY: provider submits one artifact digest; buyer explicitly accepts.'),
  verifierName: 'WorkRelayDemoStructuralVerifier',
  verifierVersion: '1.0.0',
  ftContractId,
  tokenDecimals: 6,
  atomicAmount: amount,
  providerAcceptanceDeadlineNs: String(nowNs + 30n * minutes),
  deliveryDeadlineNs: String(nowNs + 60n * minutes),
  buyerReviewDeadlineNs: String(nowNs + 90n * minutes),
  revisionLimit: 0,
  resolverAccountId,
  disputePolicyVersion: 'manual-review.v1',
});

const outputPath = resolve(process.env.WORKRELAY_TESTNET_TERMS_FILE || 'artifacts/near/testnet-demo-terms.json');
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(terms, null, 2)}\n`, { mode: 0o600 });
console.log(`Demo terms written: ${outputPath}`);
console.log(`Job ID: ${jobId}`);
console.log(`WRT amount: ${Number(amount) / 1_000_000} WRT (${amount} atomic units)`);
console.log(`Local canonical terms SHA-256: ${previewEscrowTermsHash(terms)}`);
console.log('DEMO ONLY: the committed brief/criteria hashes describe illustrative fixture text, not researched facts.');
