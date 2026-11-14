import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSIONS,
  canonicalize,
  commitRecord,
  sha256Canonical,
  validateAcceptanceCriteria,
  validateEventRecord,
  validateJobSpec,
  validateProviderQuote,
  validateSettlementTerms
} from '../src/contracts/schema.js';

const hash = 'a'.repeat(64);
const timestamp = '2026-01-01T00:00:00Z';
const identity = (kind, id) => ({ kind, id });

function jobSpec(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSIONS.jobSpec,
    jobId: 'job-kenya-001',
    buyer: identity('buyer', 'team-1'),
    brief: 'Prepare a source-backed Kenyan fintech market-entry comparison.',
    scope: 'Compare five active fintech competitors and their positioning.',
    exclusions: ['No investment advice'],
    geography: 'Kenya',
    timeWindow: { start: '2025-01-01T00:00:00Z', end: '2026-01-01T00:00:00Z' },
    provider: identity('agent-market-handle', 'cited-research-desk'),
    workPackages: [{ id: 'research', brief: 'Gather cited sources.', dependsOn: [], handoffInputHashes: [] }],
    quote: { atomicAmount: '2000000', currency: 'USDC', asset: 'usdc-test', deadline: timestamp, revisionAllowance: 1 },
    acceptance: { criteria: [{ id: 'sources', type: 'source_coverage', description: 'Material claims have sources.', required: true }], verifier: { name: 'workrelay-deterministic-checks', version: '1.0.0' } },
    dispute: { route: 'manual-review', resolver: identity('resolver', 'reviewer-1'), policy: 'Remain unresolved until named resolver decides.' },
    privacy: { retentionDays: 30, artifactAvailability: 'private-off-chain' },
    ...overrides
  };
}

test('canonical JSON sorts keys, preserves array order, normalizes Unicode and normalizes negative zero', () => {
  assert.equal(canonicalize({ b: -0, a: 'e\u0301', list: [2, 1] }), '{"a":"é","b":0,"list":[2,1]}');
  assert.equal(sha256Canonical({ a: 1, b: 2 }), sha256Canonical({ b: 2, a: 1 }));
  assert.notEqual(sha256Canonical({ a: 1, b: 2 }), sha256Canonical({ a: 1, b: 3 }));
});

test('JobSpec validates and commits canonical bytes with a stable digest', () => {
  const first = commitRecord(jobSpec(), validateJobSpec);
  const reordered = commitRecord({ ...jobSpec(), buyer: { id: 'team-1', kind: 'buyer' } }, validateJobSpec);
  assert.equal(first.schemaVersion, SCHEMA_VERSIONS.jobSpec);
  assert.equal(first.canonicalBytes, reordered.canonicalBytes);
  assert.equal(first.digest, reordered.digest);
  assert.equal(first.record.provider.kind, 'agent-market-handle');
});

test('material JobSpec changes require a new digest', () => {
  const original = commitRecord(jobSpec(), validateJobSpec);
  for (const change of [
    { brief: 'Prepare a source-backed Nigerian fintech market-entry comparison.' },
    { quote: { ...jobSpec().quote, atomicAmount: '2000001' } },
    { acceptance: { ...jobSpec().acceptance, verifier: { name: 'other-verifier', version: '1.0.0' } } },
    { dispute: { ...jobSpec().dispute, policy: 'Buyer decides.' } }
  ]) assert.notEqual(original.digest, commitRecord(jobSpec(change), validateJobSpec).digest);
});

test('validators reject unknown fields, wrong versions, malformed amounts, and ambiguous values', () => {
  assert.throws(() => validateJobSpec({ ...jobSpec(), unexpected: true }), /not an allowed field/);
  assert.throws(() => validateJobSpec({ ...jobSpec(), schemaVersion: 'workrelay.jobspec.v0' }), /schemaVersion/);
  assert.throws(() => validateJobSpec({ ...jobSpec(), quote: { ...jobSpec().quote, atomicAmount: 2 } }), /atomicAmount/);
  assert.throws(() => validateJobSpec({ ...jobSpec(), privacy: { ...jobSpec().privacy, retentionDays: 1.5 } }), /retentionDays/);
  assert.throws(() => canonicalize({ value: undefined }), /undefined is not allowed/);
  assert.throws(() => canonicalize({ value: Infinity }), /finite numbers/);
  assert.throws(() => canonicalize({ e\u0301: 1, é: 2 }), /collide after Unicode normalization/);
});

test('acceptance, quote, settlement and event records are versioned and hashable', () => {
  const acceptance = commitRecord({ schemaVersion: SCHEMA_VERSIONS.acceptanceCriteria, criteria: jobSpec().acceptance.criteria }, validateAcceptanceCriteria);
  const quote = commitRecord({ schemaVersion: SCHEMA_VERSIONS.providerQuote, jobId: 'job-1', packageId: 'research', provider: identity('agent-market-handle', 'desk'), quote: 'Quote only', requestedAt: timestamp, requestFingerprint: hash, terms: jobSpec().quote }, validateProviderQuote);
  const settlement = commitRecord({ schemaVersion: SCHEMA_VERSIONS.settlementTerms, jobId: 'job-1', buyer: identity('buyer', 'team'), provider: identity('agent-market-handle', 'desk'), asset: 'usdc-test', atomicAmount: '100', deadlines: { acceptance: timestamp, providerAcceptance: timestamp, delivery: timestamp, review: timestamp }, acceptance: { revisionAllowance: 1 }, dispute: { route: 'manual', resolver: identity('resolver', 'r'), policy: 'Manual decision.' }, verifier: { name: 'checks', version: '1' } }, validateSettlementTerms);
  const event = commitRecord({ schemaVersion: SCHEMA_VERSIONS.eventRecord, eventId: 'evt-1', jobId: 'job-1', type: 'quote.created', occurredAt: timestamp, actor: identity('system', 'workrelay'), payload: { z: 1, a: 'value' } }, validateEventRecord);
  assert.equal(acceptance.record.schemaVersion, SCHEMA_VERSIONS.acceptanceCriteria);
  assert.equal(quote.record.terms.atomicAmount, '2000000');
  assert.equal(settlement.record.acceptance.revisionAllowance, 1);
  assert.equal(event.record.payload.a, 'value');
  assert.equal(event.digest, sha256Canonical(event.record));
});
