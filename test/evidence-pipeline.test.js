import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoEvidencePacket, captureSource, createEvidencePacket, verifyEvidencePacket } from '../src/evidence/evidence-pipeline.js';
import { SCHEMA_VERSIONS } from '../src/contracts/schema.js';

const now = '2026-01-10T00:00:00Z';
const hash = 'b'.repeat(64);
const identity = { kind: 'reviewer', id: 'human-1' };

function manifest(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSIONS.evidenceManifest,
    jobId: 'job-1', packetId: 'packet-1',
    claims: [{ id: 'claim-1', claim: 'Market activity increased.', type: 'numeric', importance: 'material', period: '2025', confidence: 0.5 }],
    sources: [{ id: 'source-1', url: 'https://source.example/report', publisher: 'source.example', publishedAt: '2025-12-01T00:00:00Z', retrievedAt: now, accessStatus: 'ok', contentHash: hash, excerpt: 'Market activity increased.' }],
    links: [{ claimId: 'claim-1', sourceId: 'source-1', relationship: 'supports', rationale: 'The excerpt states the claim.', attributedTo: identity }],
    method: 'Select primary sources and record excerpts.', limitations: [], reviews: [], rawArtifactHash: hash,
    ...overrides
  };
}

test('captureSource rejects unsafe schemes, private destinations, bad redirects and oversized responses', async () => {
  await assert.rejects(() => captureSource('http://source.example/a', { resolveHostname: async () => [{ address: '93.184.216.34' }] }), /HTTPS/);
  await assert.rejects(() => captureSource('https://internal.example/a', { resolveHostname: async () => [{ address: '127.0.0.1' }] }), /private or local/);
  await assert.rejects(() => captureSource('https://source.example/a', { resolveHostname: async () => [{ address: '93.184.216.34' }], fetcher: async () => ({ status: 302, headers: { location: 'http://127.0.0.1/private' } }) }), /HTTPS/);
  await assert.rejects(() => captureSource('https://source.example/a', { maxBytes: 10, resolveHostname: async () => [{ address: '93.184.216.34' }], fetcher: async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, text: async () => '01234567890' }) }), /exceeds/);
});

test('captureSource bounds content type and revalidates safe redirects', async () => {
  const calls = [];
  const source = await captureSource('https://source.example/start', {
    resolveHostname: async (hostname) => {
      calls.push(hostname);
      return [{ address: '93.184.216.34' }];
    },
    fetcher: async (url) => url.endsWith('/start')
      ? { status: 302, headers: { location: '/final' } }
      : { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' }, text: async () => 'A bounded source snapshot.' }
  });
  assert.equal(source.accessStatus, 'ok');
  assert.equal(source.safe, true);
  assert.equal(source.publisher, 'source.example');
  assert.deepEqual(calls, ['source.example', 'source.example']);
});

test('verification returns typed outcomes and does not collapse them into truth', () => {
  const rawArtifact = 'raw report';
  const committed = createEvidencePacket({ jobId: 'job-1', packetId: 'packet-1', rawArtifact, claims: manifest().claims, sources: manifest().sources, links: manifest().links, method: 'fixture', now });
  const result = verifyEvidencePacket({ manifest: committed.record, rawArtifact, sourceSnapshots: { 'source-1': { content: 'Market activity increased.', contentHash: hash, safe: true } }, freshnessWindow: { start: '2025-01-01T00:00:00Z' }, calculations: [{ expected: 2, actual: 2 }] });
  assert.equal(result.status, 'needs_human_review');
  assert.ok(result.checks.some((check) => check.type === 'independent_sources' && check.status === 'needs_human_review'));
  assert.match(result.limitation, /do not prove factual truth/);
});

test('adversarial evidence fixtures are visible as failures or review states', () => {
  const rawArtifact = 'raw report';
  const base = manifest({ rawArtifactHash: 'c'.repeat(64), sources: [
    { id: 'dead', url: 'http://dead.example', publisher: 'dead.example', publishedAt: null, retrievedAt: now, accessStatus: 'http_404', contentHash: hash, excerpt: 'missing' },
    { id: 'copy', url: 'https://copy.example', publisher: 'copy.example', publishedAt: '2020-01-01T00:00:00Z', retrievedAt: now, accessStatus: 'ok', contentHash: hash, excerpt: 'copy' }
  ], links: [{ claimId: 'claim-1', sourceId: 'dead', relationship: 'contradicts', rationale: 'Contradictory fixture.', attributedTo: identity }] });
  const result = verifyEvidencePacket({ manifest: base, rawArtifact, sourceSnapshots: { dead: { content: 'different', contentHash: hash, safe: false }, copy: { content: 'copy', contentHash: hash, safe: true } }, freshnessWindow: { start: '2024-01-01T00:00:00Z' }, calculations: [{ expected: 3, actual: 4 }] });
  assert.equal(result.status, 'check_failed');
  assert.ok(result.checks.some((check) => check.type === 'hash_integrity' && check.status === 'check_failed'));
  assert.ok(result.checks.some((check) => check.type === 'safe_source_capture' && check.status === 'check_failed'));
  assert.ok(result.checks.some((check) => check.type === 'reproducible_arithmetic' && check.status === 'check_failed'));
});

test('demo packet is schema-committed and deliberately flags its bad source', () => {
  const packet = buildDemoEvidencePacket({ jobId: 'demo-1', packageId: 'research', rawArtifact: 'simulated artifact', createdAt: now });
  assert.equal(packet.record.schemaVersion, SCHEMA_VERSIONS.evidenceManifest);
  assert.equal(packet.digest.length, 64);
  assert.equal(packet.verification.status, 'check_failed');
  assert.ok(packet.verification.checks.some((check) => check.type === 'safe_source_capture' && check.status === 'check_failed'));
  assert.equal(packet.qualityEvaluation.status, 'check_failed');
  assert.ok(packet.qualityEvaluation.checks.some((check) => check.type === 'source_snapshot_verification' && check.status === 'check_failed'));
});
