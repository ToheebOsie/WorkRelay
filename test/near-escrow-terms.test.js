import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { canonicalEscrowTermsBytes, previewEscrowTermsHash } from '../scripts/near-escrow-terms.js';

const vector = JSON.parse(await readFile(new URL('../contracts/test-vectors/terms-v1.json', import.meta.url), 'utf8'));

test('NEAR escrow terms v1 JS commitment matches the shared golden vector', () => {
  assert.equal(canonicalEscrowTermsBytes(vector.terms).toString('utf8'), vector.canonicalJson);
  assert.equal(previewEscrowTermsHash(vector.terms), vector.sha256);
});

test('NEAR escrow terms v1 rejects unknown keys and noncanonical atomic amounts', () => {
  assert.throws(() => previewEscrowTermsHash({ ...vector.terms, extra: true }), /unknown terms field/);
  assert.throws(() => previewEscrowTermsHash({ ...vector.terms, atomicAmount: '00125' }), /canonical decimal/);
});

test('NEAR escrow terms v1 binds WRT decimals and a single optional revision', () => {
  assert.throws(() => previewEscrowTermsHash({ ...vector.terms, tokenDecimals: 18 }), /6 token decimals/);
  assert.throws(() => previewEscrowTermsHash({ ...vector.terms, revisionLimit: 2 }), /integer 0 or 1/);
  assert.doesNotThrow(() => previewEscrowTermsHash({ ...vector.terms, revisionLimit: 0 }));
});

test('NEAR escrow terms v1 rejects non-string identity and handle fields', () => {
  assert.throws(() => previewEscrowTermsHash({ ...vector.terms, buyerAccountId: 17 }), /buyerAccountId must be a string/);
  assert.throws(() => previewEscrowTermsHash({ ...vector.terms, agentMarketHandle: 17 }), /agentMarketHandle must be a string or null/);
});
