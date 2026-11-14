import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoEvidencePacket, captureSource, createEvidencePacket, createPinnedHttpsFetcher, isPublicAddress, verifyEvidencePacket } from '../src/evidence/evidence-pipeline.js';
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

test('isPublicAddress rejects every private, local, reserved and embedded-IPv4 range and fails closed', () => {
  const blocked = [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fe90::1', 'fea0::1', 'febf::1', 'fec0::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '2001::1',
    'not-an-ip', '', undefined, '1.2.3', '300.1.1.1'
  ];
  for (const address of blocked) assert.equal(isPublicAddress(address), false, `${address} must not be treated as public`);
  for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e']) assert.equal(isPublicAddress(address), true, `${address} should be public`);
});

test('captureSource blocks link-local IPv6 answers such as fe90::1 and IP-literal URLs', async () => {
  for (const address of ['fe90::1', 'fe80::1', 'febf::1', '::ffff:10.0.0.1']) {
    await assert.rejects(() => captureSource('https://internal.example/a', { resolveHostname: async () => [{ address, family: 6 }], fetcher: async () => { throw new Error('must not fetch'); } }), /private or local/);
  }
  await assert.rejects(() => captureSource('https://[fe90::1]/a', { fetcher: async () => { throw new Error('must not fetch'); } }), /private or local/);
  await assert.rejects(() => captureSource('https://127.0.0.1/a', { fetcher: async () => { throw new Error('must not fetch'); } }), /private or local/);
  await assert.rejects(() => captureSource('https://source.example/a', { resolveHostname: async () => [{ address: '93.184.216.34' }, { address: '10.0.0.5' }], fetcher: async () => { throw new Error('must not fetch'); } }), /private or local/);
});

test('captureSource connects only to the address it validated, so a later DNS answer cannot rebind it', async () => {
  const answers = [[{ address: '93.184.216.34', family: 4 }], [{ address: '10.0.0.5', family: 4 }]];
  let resolves = 0;
  const fetched = [];
  const source = await captureSource('https://source.example/a', {
    resolveHostname: async () => answers[Math.min(resolves++, answers.length - 1)],
    fetcher: async (href, options) => { fetched.push({ href, address: options.address }); return { status: 200, headers: { 'content-type': 'text/plain' }, text: async () => 'ok' }; }
  });
  assert.equal(source.safe, true);
  assert.equal(resolves, 1, 'the hostname is resolved once per hop');
  assert.deepEqual(fetched, [{ href: 'https://source.example/a', address: '93.184.216.34' }]);
});

test('the default fetcher pins the socket lookup to the validated address and keeps SNI for the hostname', async () => {
  let captured;
  const fakeRequest = (options, onResponse) => {
    captured = options;
    const handlers = {};
    const req = { on: (name, fn) => { handlers[name] = fn; return req; }, destroy() {}, end() {
      const res = { statusCode: 200, headers: { 'content-type': 'text/plain' }, on: (name, fn) => { handlers[`res:${name}`] = fn; return res; } };
      onResponse(res);
      handlers['res:data'](Buffer.from('pinned body'));
      handlers['res:end']();
    } };
    return req;
  };
  const fetcher = createPinnedHttpsFetcher({ request: fakeRequest });
  const response = await fetcher('https://source.example/path?q=1', { address: '93.184.216.34', family: 4, signal: new AbortController().signal });
  assert.equal(await response.text(), 'pinned body');
  assert.equal(captured.servername, 'source.example');
  assert.equal(captured.path, '/path?q=1');
  assert.equal(captured.agent, false);
  assert.deepEqual(await new Promise((resolve) => captured.lookup('anything.example', { all: true }, (error, list) => resolve(list))), [{ address: '93.184.216.34', family: 4 }]);
  assert.deepEqual(await new Promise((resolve) => captured.lookup('anything.example', {}, (error, address, family) => resolve({ address, family }))), { address: '93.184.216.34', family: 4 });
  await assert.rejects(() => fetcher('https://source.example/', { address: '127.0.0.1', family: 4 }), /validated public address/);
});

test('captureSource enforces a hard overall deadline even when the fetcher or DNS never answers', async () => {
  await assert.rejects(() => captureSource('https://slow.example/a', { timeoutMs: 40, resolveHostname: async () => [{ address: '93.184.216.34' }], fetcher: () => new Promise(() => {}) }), /timed out/);
  await assert.rejects(() => captureSource('https://slow.example/a', { timeoutMs: 40, resolveHostname: () => new Promise(() => {}), fetcher: async () => { throw new Error('unreachable'); } }), /timed out/);
  await assert.rejects(() => captureSource('https://slow.example/a', { timeoutMs: 40, resolveHostname: async () => [{ address: '93.184.216.34' }], fetcher: async () => ({ status: 200, headers: { 'content-type': 'text/plain' }, text: () => new Promise(() => {}) }) }), /timed out/);
  await assert.rejects(() => captureSource('https://slow.example/a', { timeoutMs: 0 }), /timeoutMs/);
  await assert.rejects(() => captureSource('https://slow.example/a', { timeoutMs: 31_000 }), /timeoutMs/);
});

test('a source with no captured snapshot is incomplete, never a pass', () => {
  const rawArtifact = 'raw report';
  const committed = createEvidencePacket({ jobId: 'job-1', packetId: 'packet-1', rawArtifact, claims: manifest().claims, sources: manifest().sources, links: manifest().links, method: 'fixture', now });
  const result = verifyEvidencePacket({ manifest: committed.record, rawArtifact, sourceSnapshots: {}, freshnessWindow: { start: '2025-01-01T00:00:00Z' } });
  const capture = result.checks.find((check) => check.type === 'safe_source_capture');
  const excerpt = result.checks.find((check) => check.type === 'excerpt_matches_snapshot');
  assert.equal(capture.status, 'incomplete');
  assert.match(capture.detail, /source-1/);
  assert.equal(excerpt.status, 'incomplete');
  assert.notEqual(result.status, 'complete');
  // A present-but-unsafe snapshot still outranks "missing" as a hard failure.
  const unsafe = verifyEvidencePacket({ manifest: committed.record, rawArtifact, sourceSnapshots: { 'source-1': { content: 'x', contentHash: hash, safe: false } } });
  assert.equal(unsafe.checks.find((check) => check.type === 'safe_source_capture').status, 'check_failed');
});

test('a missing raw artifact cannot satisfy the hash-integrity check', () => {
  const committed = createEvidencePacket({ jobId: 'job-1', packetId: 'packet-1', rawArtifact: 'raw report', claims: manifest().claims, sources: manifest().sources, links: manifest().links, method: 'fixture', now });
  const result = verifyEvidencePacket({ manifest: committed.record, sourceSnapshots: { 'source-1': { content: 'Market activity increased.', contentHash: hash, safe: true } } });
  assert.equal(result.checks.find((check) => check.type === 'hash_integrity').status, 'incomplete');
});
