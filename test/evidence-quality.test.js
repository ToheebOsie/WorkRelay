import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createEvidencePacket } from '../src/evidence/evidence-pipeline.js';
import { commitPublisherAuthorityRegistry, evaluateEvidenceQuality, recordEvidenceReview } from '../src/evidence/evidence-quality.js';

const now = '2026-11-14T12:00:00.000Z';
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const registryEntries = [
  { hostname: 'cbn.gov.ng', publisherGroup: 'central-bank-of-nigeria', authorityTier: 'regulator', scope: ['CBN-issued regulation and official monetary, banking and payment-system statistics.'], permittedClaimTypes: ['financial', 'numeric', 'market', 'regulatory', 'regulatory_current', 'daily_series', 'monthly_series', 'quarterly_series', 'annual_series'], basis: 'Official central bank domain confirmed by deployment registry review.', validUntil: '2027-11-01T00:00:00.000Z' },
  { hostname: 'nigerianstat.gov.ng', publisherGroup: 'national-bureau-of-statistics', authorityTier: 'primary', scope: ['NBS-issued official statistics and methodology.'], permittedClaimTypes: ['numeric', 'market', 'monthly_series', 'quarterly_series', 'annual_series'], basis: 'Official national statistics publisher domain confirmed by deployment registry review.', validUntil: '2027-11-01T00:00:00.000Z' },
  { hostname: 'sec.gov.ng', publisherGroup: 'securities-and-exchange-commission', authorityTier: 'regulator', scope: ['SEC-issued capital-market rules, notices and SEC-published market datasets.'], permittedClaimTypes: ['financial', 'numeric', 'market', 'regulatory', 'regulatory_current', 'monthly_series', 'quarterly_series'], basis: 'Official securities regulator domain confirmed by deployment registry review.', validUntil: '2027-11-01T00:00:00.000Z' }
];
function makeRegistry(entries = registryEntries, overrides = {}) {
  return commitPublisherAuthorityRegistry({
    registryId: 'workrelay-research-publishers',
    version: 1,
    reviewedAt: '2026-11-01T00:00:00.000Z',
    reviewer: { kind: 'human', id: 'registry-reviewer-1' },
    reviewStatement: 'Exact-host publisher classifications reviewed for this test deployment.',
    entries,
    confirmed: true,
    ...overrides
  });
}
const publisherRegistry = makeRegistry();

function fixture({ publishedAt = '2026-10-01T00:00:00.000Z', retrievedAt = '2026-11-13T08:00:00.000Z', secondDomain = 'nigerianstat.gov.ng', packetId = 'packet-market-1', claimType = 'market', sourceContents = null, thirdSource = false } = {}) {
  const rawArtifact = 'The cited packet reports a change in the Nigerian fintech market.';
  const contents = sourceContents ?? {
    cbn: 'Central bank source snapshot: market change reported.',
    nbs: 'National statistics source snapshot: market change independently measured.'
  };
  const sources = [
    { id: 'cbn', url: 'https://cbn.gov.ng/report', publisher: 'cbn.gov.ng', publishedAt, retrievedAt, accessStatus: 'ok', contentHash: hash(contents.cbn), excerpt: contents.cbn },
    { id: 'nbs', url: `https://${secondDomain}/report`, publisher: secondDomain, publishedAt, retrievedAt: new Date(Date.parse(retrievedAt) + 5 * 60_000).toISOString(), accessStatus: 'ok', contentHash: hash(contents.nbs), excerpt: contents.nbs }
  ];
  if (thirdSource) sources.push({ id: 'sec', url: 'https://sec.gov.ng/report', publisher: 'sec.gov.ng', publishedAt, retrievedAt: new Date(Date.parse(retrievedAt) + 10 * 60_000).toISOString(), accessStatus: 'ok', contentHash: hash(contents.sec), excerpt: contents.sec });
  const packet = createEvidencePacket({
    jobId: 'job-market-1',
    packetId,
    rawArtifact,
    claims: [{ id: 'claim-market-growth', claim: 'Fintech transaction activity increased in the measured period.', type: claimType, importance: 'material', period: '2026', confidence: 0.6 }],
    sources,
    links: [
      { claimId: 'claim-market-growth', sourceId: 'cbn', relationship: 'supports', rationale: 'The regulator publication contains a relevant reported measure.', attributedTo: { kind: 'provider', id: 'researcher-1' } },
      { claimId: 'claim-market-growth', sourceId: 'nbs', relationship: 'supports', rationale: 'The statistics publication contains a separate relevant measure.', attributedTo: { kind: 'provider', id: 'researcher-1' } },
      ...(thirdSource ? [{ claimId: 'claim-market-growth', sourceId: 'sec', relationship: 'supports', rationale: 'The securities regulator publishes another relevant market source.', attributedTo: { kind: 'provider', id: 'researcher-1' } }] : [])
    ],
    method: 'Collect and compare primary publications.',
    limitations: ['Publisher authority classifications are policy-maintained.'],
    now
  });
  const sourceSnapshots = {
    cbn: { content: contents.cbn, contentHash: hash(contents.cbn), safe: true },
    nbs: { content: contents.nbs, contentHash: hash(contents.nbs), safe: true },
    ...(thirdSource ? { sec: { content: contents.sec, contentHash: hash(contents.sec), safe: true } } : {})
  };
  return { packet, rawArtifact, sourceSnapshots };
}

function acceptedReview(packet, { sourceIds = ['cbn', 'nbs'], reviewerId = 'reviewer-1', independenceRationale = 'The sources are separately produced by different institutions and are not copies of the same underlying release.', claimRationale = 'Both cited publications support the claim for the stated period.' } = {}) {
  return recordEvidenceReview({
    packetDigest: packet.digest,
    reviewer: { kind: 'human', id: reviewerId },
    decision: 'accept',
    reviewedAt: now,
    confirmed: true,
    attestation: 'I reviewed the cited source records, claim relationships and limitations. I independently assessed the cited publishers and their reporting.',
    claimFindings: [{ claimId: 'claim-market-growth', outcome: 'supported', rationale: claimRationale }],
    independenceAssessments: [{ claimId: 'claim-market-growth', sourceIds, independent: true, rationale: independenceRationale }],
    scopeAssessments: sourceIds.map((sourceId) => ({ claimId: 'claim-market-growth', sourceId, inScope: true, rationale: 'The captured publisher-issued dataset and the claim subject fall within the exact-host registry scope and permitted claim type.' }))
  });
}

test('quality policy requires a packet-bound human review even when automated evidence checks are clear', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture();
  const result = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(result.status, 'needs_human_review');
  assert.equal(result.reviewStatus, 'pending');
  assert.equal(result.policyVersion, 'workrelay.evidence-quality-policy.v3');
  assert.ok(result.checks.some((check) => check.type === 'source_authority_policy' && check.status === 'complete'));
  assert.ok(result.checks.some((check) => check.type === 'source_freshness' && check.status === 'complete'));
  assert.ok(result.checks.some((check) => check.type === 'cross_source_corroboration' && check.status === 'needs_human_review'));
  assert.ok(result.checks.some((check) => check.type === 'human_claim_review' && check.status === 'needs_human_review'));
});

test('accepted human review can close corroboration review for two registered publisher groups', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture();
  const review = acceptedReview(packet);
  const result = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [review], evaluationAt: now });
  assert.equal(result.status, 'complete');
  assert.equal(result.reviewStatus, 'accepted');
  assert.equal(result.reviewDigest, review.digest);
  assert.ok(result.checks.some((check) => check.type === 'cross_source_corroboration' && check.status === 'complete'));
  assert.ok(result.checks.some((check) => check.type === 'human_claim_review' && check.status === 'complete'));
});

test('different URLs or subdomains in one publisher group do not count as independent publishers', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture({ secondDomain: 'data.cbn.gov.ng' });
  const registry = makeRegistry([
    ...registryEntries,
    { hostname: 'data.cbn.gov.ng', publisherGroup: 'central-bank-of-nigeria', authorityTier: 'primary', scope: ['CBN-hosted statistics only.'], permittedClaimTypes: ['financial', 'numeric', 'market'], basis: 'Subdomain confirmed to belong to the central bank publisher group.', validUntil: '2027-11-01T00:00:00.000Z' }
  ]);
  const review = acceptedReview(packet);
  const result = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: registry, reviewRecords: [review], evaluationAt: now });
  assert.equal(result.status, 'needs_human_review');
  assert.equal(result.reviewStatus, 'pending');
  assert.ok(result.checks.some((check) => check.type === 'cross_source_corroboration' && check.status === 'needs_human_review'));
});


test('packet-bound human review can explicitly adjudicate a contradictory claim only with a comparison rationale', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture();
  const contestedPacket = createEvidencePacket({
    jobId: packet.record.jobId,
    packetId: 'packet-market-contradiction',
    rawArtifact,
    claims: packet.record.claims,
    sources: packet.record.sources,
    links: [
      ...packet.record.links,
      { ...packet.record.links[1], relationship: 'contradicts', rationale: 'A second passage appears to conflict and requires adjudication.' }
    ],
    method: packet.record.method,
    limitations: packet.record.limitations,
    now
  });
  const genericReview = acceptedReview(contestedPacket);
  const genericResult = evaluateEvidenceQuality({ manifest: contestedPacket.record, packetDigest: contestedPacket.digest, rawArtifact, sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [genericReview], evaluationAt: now });
  assert.equal(genericResult.reviewStatus, 'pending');
  assert.equal(genericResult.checks.find((check) => check.type === 'claim_conflict_adjudication').status, 'needs_human_review');
  assert.equal(genericResult.claimAssessments[0].conflictAssessment.status, 'review_required');

  const specificReview = acceptedReview(contestedPacket, {
    claimRationale: 'Compared the reporting period, denominator, measurement methodology and coverage scope; the apparent difference is explained by those distinct definitions.'
  });
  const result = evaluateEvidenceQuality({ manifest: contestedPacket.record, packetDigest: contestedPacket.digest, rawArtifact, sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [specificReview], evaluationAt: now });
  assert.equal(result.reviewStatus, 'accepted');
  assert.equal(result.checks.find((check) => check.type === 'claim_contradictions').status, 'complete');
  assert.equal(result.checks.find((check) => check.type === 'claim_conflict_adjudication').status, 'complete');
  assert.equal(result.checks.find((check) => check.type === 'claim_level_provenance').status, 'complete');
  assert.equal(result.claimAssessments[0].conflictAssessment.status, 'adjudicated');
  assert.equal(result.status, 'complete');
});

 test('syndicated wire copy attribution is detected across unrelated publisher groups and requires explicit review', () => {
  const data = fixture({ sourceContents: {
    cbn: 'The annual digital payments summary reported a rise in transaction activity.\nOriginally published by Reuters\nThe report covers the full year and provides context for market participants.',
    nbs: 'A separate publication summarised changes in digital payments over the annual period.\nSource: Reuters\nIts analysis describes transaction activity and implications for market participants.'
  } });
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(result.checks.find((check) => check.type === 'source_attribution_reuse').status, 'needs_human_review');
  assert.equal(result.claimAssessments[0].possibleCommonOriginPairs.length, 1);
  assert.equal(result.claimAssessments[0].possibleCommonOriginPairs[0].attributionLabel, 'reuters');
  assert.ok(result.sourceAssessments.every((source) => source.attributionSignals.length > 0));
});

test('press-release republication signals require human origin review even when prose differs', () => {
  const data = fixture({ sourceContents: {
    cbn: 'A report describes the quarterly regulatory programme and its implementation.\nPress release issued by Central Bank of Nigeria\nThe first publisher adds local context and commentary.',
    nbs: 'A different article discusses the quarterly programme and implementation details.\nNews release from Central Bank of Nigeria\nThe second publisher adds a separate summary and additional context.'
  } });
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(result.checks.find((check) => check.type === 'source_attribution_reuse').status, 'needs_human_review');
  assert.equal(result.claimAssessments[0].possibleCommonOriginPairs[0].attributionLabel, 'central bank of nigeria');
});

test('human independence rationale must address repeated attribution before it can clear the origin signal', () => {
  const data = fixture({ sourceContents: {
    cbn: 'The annual digital payments summary reported a rise in transaction activity.\nOriginally published by Reuters\nThe report covers the full year and provides context for market participants.',
    nbs: 'A separate publication summarised changes in digital payments over the annual period.\nSource: Reuters\nIts analysis describes transaction activity and implications for market participants.'
  } });
  const genericReview = acceptedReview(data.packet);
  const genericResult = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [genericReview], evaluationAt: now });
  assert.equal(genericResult.checks.find((check) => check.type === 'source_attribution_reuse').status, 'needs_human_review');
  assert.equal(genericResult.reviewStatus, 'pending');

  const reviewed = acceptedReview(data.packet, { independenceRationale: 'Reviewed the repeated Reuters origin attribution and independently compared the separate publisher reporting, context and analysis.' });
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [reviewed], evaluationAt: now });
  assert.equal(result.checks.find((check) => check.type === 'source_attribution_reuse').status, 'complete');
  assert.equal(result.claimAssessments[0].attributionReview.status, 'adjudicated');
});

test('ordinary article mentions of a wire service are not treated as an attribution line', () => {
  const data = fixture({ sourceContents: {
    cbn: 'The annual report compares market activity and discusses Reuters coverage as part of the sector context. It then presents the local regulator dataset and methodology.',
    nbs: 'The statistics office presents a separate annual dataset and discusses international reporting examples, including Reuters, without attributing this article to that service.'
  } });
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(result.checks.find((check) => check.type === 'source_attribution_reuse').status, 'complete');
  assert.ok(result.sourceAssessments.every((source) => source.attributionSignals.length === 0));
});

test('two different domains assigned to one reviewed ownership group do not become independent through different bylines', () => {
  const data = fixture({ secondDomain: 'data.cbn.gov.ng' });
  const ownershipRegistry = makeRegistry([
    ...registryEntries,
    { hostname: 'data.cbn.gov.ng', publisherGroup: 'central-bank-of-nigeria', authorityTier: 'primary', scope: ['CBN data services only.'], permittedClaimTypes: ['financial', 'numeric', 'market'], basis: 'Ownership confirmed during the deployment registry review.', validUntil: '2027-11-01T00:00:00.000Z' }
  ]);
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: ownershipRegistry, evaluationAt: now });
  assert.equal(result.claimAssessments[0].publisherGroups.length, 1);
  assert.equal(result.checks.find((check) => check.type === 'cross_source_corroboration').status, 'needs_human_review');
});

test('unknown publisher authority remains review-required rather than being inferred from a domain', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture();
  const result = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: {}, evaluationAt: now });
  assert.equal(result.checks.find((check) => check.type === 'source_authority_policy').status, 'needs_human_review');
});

test('missing publication date requires human review and stale publications are incomplete', () => {
  const missing = fixture({ publishedAt: null });
  const missingResult = evaluateEvidenceQuality({ manifest: missing.packet.record, packetDigest: missing.packet.digest, rawArtifact: missing.rawArtifact, sourceSnapshots: missing.sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(missingResult.checks.find((check) => check.type === 'source_freshness').status, 'needs_human_review');

  const stale = fixture({ publishedAt: '2025-01-01T00:00:00.000Z' });
  const staleResult = evaluateEvidenceQuality({ manifest: stale.packet.record, packetDigest: stale.packet.digest, rawArtifact: stale.rawArtifact, sourceSnapshots: stale.sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(staleResult.checks.find((check) => check.type === 'source_freshness').status, 'incomplete');
});

test('dangling claim/source references fail closed', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture();
  const broken = structuredClone(packet.record);
  broken.links[0].sourceId = 'missing-source';
  const result = evaluateEvidenceQuality({ manifest: broken, rawArtifact, sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(result.status, 'check_failed');
  assert.equal(result.checks.find((check) => check.type === 'claim_source_link_integrity').status, 'check_failed');
});

test('human review must be explicit, human-attributed and bound to the exact packet commitment', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture();
  assert.throws(() => recordEvidenceReview({ packetDigest: packet.digest, reviewer: { kind: 'human', id: 'r1' }, decision: 'accept', reviewedAt: now, attestation: 'Reviewed.', confirmed: false }), /Explicit human confirmation/);
  assert.throws(() => recordEvidenceReview({ packetDigest: packet.digest, reviewer: { kind: 'system', id: 'r1' }, decision: 'accept', reviewedAt: now, attestation: 'Reviewed.', confirmed: true }), /reviewer.kind must be human/);

  const review = acceptedReview(packet);
  const other = fixture({ packetId: 'packet-market-2' });
  const result = evaluateEvidenceQuality({ manifest: other.packet.record, packetDigest: other.packet.digest, rawArtifact: other.rawArtifact, sourceSnapshots: other.sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [review], evaluationAt: now });
  assert.equal(result.status, 'check_failed');
  assert.equal(result.checks.find((check) => check.type === 'review_record_integrity').status, 'check_failed');
});

test('source snapshot hash mismatch and future timestamps fail closed', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture();
  const badSnapshots = structuredClone(sourceSnapshots);
  badSnapshots.cbn.contentHash = 'f'.repeat(64);
  const snapshotResult = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots: badSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(snapshotResult.checks.find((check) => check.type === 'source_snapshot_verification').status, 'check_failed');

  const future = fixture({ publishedAt: '2027-01-01T00:00:00.000Z' });
  const futureResult = evaluateEvidenceQuality({ manifest: future.packet.record, packetDigest: future.packet.digest, rawArtifact: future.rawArtifact, sourceSnapshots: future.sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(futureResult.checks.find((check) => check.type === 'source_freshness').status, 'check_failed');
});


test('captured source body is re-hashed and saved excerpts must occur in that body', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture();
  const alteredBody = structuredClone(sourceSnapshots);
  alteredBody.cbn.content = 'Different bytes with a stale, unchanged contentHash.';
  const bodyResult = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots: alteredBody, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(bodyResult.checks.find((check) => check.type === 'source_snapshot_verification').status, 'check_failed');

  const excerptManifest = structuredClone(packet.record);
  excerptManifest.sources[0].excerpt = 'Excerpt text that is not present in the captured source.';
  const excerptResult = evaluateEvidenceQuality({ manifest: excerptManifest, rawArtifact, sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(excerptResult.checks.find((check) => check.type === 'source_excerpt_match').status, 'check_failed');
});

test('unsafe HTTP source URL fails even when a caller supplies a safe-looking snapshot', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture();
  const unsafeManifest = structuredClone(packet.record);
  unsafeManifest.sources[0].url = 'http://cbn.gov.ng/report';
  const result = evaluateEvidenceQuality({ manifest: unsafeManifest, rawArtifact, sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(result.checks.find((check) => check.type === 'source_snapshot_verification').status, 'check_failed');
});

test('unrecognized required claim identifiers fail closed', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture();
  const result = evaluateEvidenceQuality({ manifest: packet.record, rawArtifact, sourceSnapshots, requiredClaimIds: ['does-not-exist'], authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(result.checks.find((check) => check.type === 'required_claim_declaration').status, 'check_failed');
});


test('freshness retrieval windows are calibrated by material claim type', () => {
  const financial = fixture({ claimType: 'financial', publishedAt: '2026-11-10T00:00:00.000Z', retrievedAt: '2026-11-04T08:00:00.000Z' });
  const financialResult = evaluateEvidenceQuality({ manifest: financial.packet.record, packetDigest: financial.packet.digest, rawArtifact: financial.rawArtifact, sourceSnapshots: financial.sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(financialResult.checks.find((check) => check.type === 'source_freshness').status, 'incomplete');
  assert.equal(financialResult.sourceAssessments.find((source) => source.sourceId === 'cbn').maxRetrievalAgeDays, 7);
  assert.match(financialResult.checks.find((check) => check.type === 'source_freshness').detail, /7-day retrieval policy/);

  const market = fixture({ claimType: 'market', publishedAt: '2026-11-10T00:00:00.000Z', retrievedAt: '2026-11-04T08:00:00.000Z' });
  const marketResult = evaluateEvidenceQuality({ manifest: market.packet.record, packetDigest: market.packet.digest, rawArtifact: market.rawArtifact, sourceSnapshots: market.sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(marketResult.checks.find((check) => check.type === 'source_freshness').status, 'complete');
});

test('cadence-specific freshness profiles apply separate publication and retrieval windows', () => {
  const cases = [
    { type: 'daily_series', publishedAt: '2026-11-10T00:00:00.000Z', retrievedAt: '2026-11-13T08:00:00.000Z', publicationLimit: 7, retrievalLimit: 2 },
    { type: 'monthly_series', publishedAt: '2026-10-01T00:00:00.000Z', retrievedAt: '2026-11-10T08:00:00.000Z', publicationLimit: 60, retrievalLimit: 14 },
    { type: 'quarterly_series', publishedAt: '2026-08-01T00:00:00.000Z', retrievedAt: '2026-11-01T08:00:00.000Z', publicationLimit: 150, retrievalLimit: 30 },
    { type: 'annual_series', publishedAt: '2025-12-01T00:00:00.000Z', retrievedAt: '2026-10-01T08:00:00.000Z', publicationLimit: 550, retrievalLimit: 90 }
  ];

  for (const item of cases) {
    const { packet, rawArtifact, sourceSnapshots } = fixture({ claimType: item.type, publishedAt: item.publishedAt, retrievedAt: item.retrievedAt });
    const result = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
    assert.ok(result.sourceAssessments.every((source) => source.maxPublicationAgeDays === item.publicationLimit), `${item.type} publication limit`);
    assert.ok(result.sourceAssessments.every((source) => source.maxRetrievalAgeDays === item.retrievalLimit), `${item.type} retrieval limit`);
    assert.equal(result.checks.find((check) => check.type === 'source_freshness').status, 'complete', `${item.type} within cadence window`);
  }
});

test('daily-series evidence outside its publication cadence is incomplete', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture({
    claimType: 'daily_series',
    publishedAt: '2026-11-06T00:00:00.000Z',
    retrievedAt: '2026-11-13T08:00:00.000Z'
  });
  const result = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(result.checks.find((check) => check.type === 'source_freshness').status, 'incomplete');
});

test('current-regulatory claims require packet-bound in-force and amendment-status attestation', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture({ claimType: 'regulatory_current', publishedAt: '2015-11-14T00:00:00.000Z' });
  const unreviewed = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(unreviewed.checks.find((check) => check.type === 'regulatory_current_status').status, 'needs_human_review');
  assert.equal(unreviewed.checks.find((check) => check.type === 'source_freshness').status, 'complete');
  assert.ok(unreviewed.sourceAssessments.every((source) => source.maxPublicationAgeDays === null));

  const generic = acceptedReview(packet);
  const genericResult = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [generic], evaluationAt: now });
  assert.equal(genericResult.reviewStatus, 'pending');
  assert.equal(genericResult.checks.find((check) => check.type === 'regulatory_current_status').status, 'needs_human_review');

  const specific = recordEvidenceReview({
    packetDigest: packet.digest,
    reviewer: { kind: 'human', id: 'regulatory-reviewer-1' },
    decision: 'accept',
    reviewedAt: now,
    confirmed: true,
    attestation: 'I reviewed the exact source, its issuing authority and the current legal status.',
    claimFindings: [{
      claimId: 'claim-market-growth',
      outcome: 'supported',
      rationale: 'I checked the current consolidated version and relevant amendments and repeals; the cited instrument remains in force and has not been superseded as of this review.'
    }],
    independenceAssessments: [{
      claimId: 'claim-market-growth',
      sourceIds: ['cbn', 'nbs'],
      independent: true,
      rationale: 'The institutions publish separate records and the underlying reporting is not repeated.'
    }],
    scopeAssessments: ['cbn', 'nbs'].map((sourceId) => ({ claimId: 'claim-market-growth', sourceId, inScope: true, rationale: 'The reviewer checked the source against the registry scope and recorded the scope basis.' }))
  });
  const reviewedResult = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [specific], evaluationAt: now });
  assert.equal(reviewedResult.checks.find((check) => check.type === 'regulatory_current_status').status, 'complete');
  assert.equal(reviewedResult.claimAssessments[0].regulatoryCurrentStatus.status, 'attested');
  assert.equal(reviewedResult.claimAssessments[0].regulatoryCurrentStatus.reviewerId, 'regulatory-reviewer-1');
});

test('publisher authority registry requires explicit subject scope and permitted claim types', () => {
  assert.throws(() => commitPublisherAuthorityRegistry({
    registryId: 'missing-scope', version: 1, reviewedAt: now,
    reviewer: { kind: 'human', id: 'reviewer' }, reviewStatement: 'Reviewed.',
    entries: [{ hostname: 'example.gov', publisherGroup: 'example', authorityTier: 'primary', basis: 'Official publisher.', validUntil: '2027-01-01T00:00:00.000Z' }],
    confirmed: true
  }), /invalid fields/);
  assert.throws(() => commitPublisherAuthorityRegistry({
    registryId: 'invalid-claim-type', version: 1, reviewedAt: now,
    reviewer: { kind: 'human', id: 'reviewer' }, reviewStatement: 'Reviewed.',
    entries: [{ hostname: 'example.gov', publisherGroup: 'example', authorityTier: 'primary', scope: 'Official statistics.', permittedClaimTypes: ['medical_diagnosis'], basis: 'Official publisher.', validUntil: '2027-01-01T00:00:00.000Z' }],
    confirmed: true
  }), /unsupported claim type/);
});

test('publisher authority registry blocks a registered host used outside its permitted claim types', () => {
  const data = fixture({ claimType: 'regulatory_current' });
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(result.checks.find((check) => check.type === 'source_authority_policy').status, 'check_failed');
  const nbs = result.sourceAssessments.find((source) => source.sourceId === 'nbs');
  assert.equal(nbs.permittedClaimTypes.includes('regulatory_current'), false);
  assert.match(nbs.authorityScope.join(' '), /NBS-issued official statistics/);
});

test('regulatory-current claims require regulator-tier authority even when a host permits the claim type', () => {
  const data = fixture({ claimType: 'regulatory_current' });
  const entries = registryEntries.map((entry) => entry.hostname === 'nigerianstat.gov.ng'
    ? { ...entry, authorityTier: 'secondary', permittedClaimTypes: [...entry.permittedClaimTypes, 'regulatory_current'] }
    : entry);
  const registry = makeRegistry(entries);
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: registry, evaluationAt: now });
  assert.equal(result.checks.find((check) => check.type === 'source_authority_policy').status, 'check_failed');
  const nbs = result.sourceAssessments.find((source) => source.sourceId === 'nbs');
  assert.equal(nbs.authorityTier, 'secondary');
  assert.equal(nbs.permittedClaimTypes.includes('regulatory_current'), true);
});

test('material claim review requires a scope attestation for every supporting source', () => {
  const data = fixture();
  const review = recordEvidenceReview({
    packetDigest: data.packet.digest,
    reviewer: { kind: 'human', id: 'scope-reviewer' },
    decision: 'accept', reviewedAt: now, confirmed: true,
    attestation: 'I reviewed the claim and sources.',
    claimFindings: [{ claimId: 'claim-market-growth', outcome: 'supported', rationale: 'Both records support the market claim.' }],
    independenceAssessments: [{ claimId: 'claim-market-growth', sourceIds: ['cbn', 'nbs'], independent: true, rationale: 'Distinct official publishers and separately prepared records.' }],
    scopeAssessments: [{ claimId: 'claim-market-growth', sourceId: 'cbn', inScope: true, rationale: 'CBN source is within its registry scope.' }]
  });
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [review], evaluationAt: now });
  assert.equal(result.reviewStatus, 'pending');
  assert.equal(result.checks.find((check) => check.type === 'publisher_scope_review').status, 'needs_human_review');
  assert.match(result.checks.find((check) => check.type === 'publisher_scope_review').detail, /1 material claim\/source pair/);
});

test('publisher scope review rejects extra claim/source assessments that are not in the packet', () => {
  const data = fixture();
  const review = recordEvidenceReview({
    packetDigest: data.packet.digest,
    reviewer: { kind: 'human', id: 'scope-reviewer' },
    decision: 'accept', reviewedAt: now, confirmed: true,
    attestation: 'I reviewed the claim and sources.',
    claimFindings: [{ claimId: 'claim-market-growth', outcome: 'supported', rationale: 'Both records support the market claim.' }],
    independenceAssessments: [{ claimId: 'claim-market-growth', sourceIds: ['cbn', 'nbs'], independent: true, rationale: 'Distinct official publishers and separately prepared records.' }],
    scopeAssessments: [
      { claimId: 'claim-market-growth', sourceId: 'cbn', inScope: true, rationale: 'The CBN record is within scope.' },
      { claimId: 'claim-market-growth', sourceId: 'nbs', inScope: true, rationale: 'The NBS record is within scope.' },
      { claimId: 'claim-market-growth', sourceId: 'sec', inScope: true, rationale: 'An unrelated source was added to the review.' }
    ]
  });
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [review], evaluationAt: now });
  assert.equal(result.reviewStatus, 'pending');
  assert.equal(result.checks.find((check) => check.type === 'publisher_scope_review').status, 'needs_human_review');
  assert.equal(result.checks.find((check) => check.type === 'human_claim_review').status, 'needs_human_review');
});

test('a reviewer declaration that a material source is outside publisher scope blocks acceptance', () => {
  const data = fixture();
  const review = recordEvidenceReview({
    packetDigest: data.packet.digest,
    reviewer: { kind: 'human', id: 'scope-reviewer' },
    decision: 'accept', reviewedAt: now, confirmed: true,
    attestation: 'I reviewed the claim and sources.',
    claimFindings: [{ claimId: 'claim-market-growth', outcome: 'supported', rationale: 'The claim has support from one eligible source.' }],
    independenceAssessments: [{ claimId: 'claim-market-growth', sourceIds: ['cbn', 'nbs'], independent: true, rationale: 'Distinct official publishers and separately prepared records.' }],
    scopeAssessments: [
      { claimId: 'claim-market-growth', sourceId: 'cbn', inScope: true, rationale: 'The CBN record is within scope.' },
      { claimId: 'claim-market-growth', sourceId: 'nbs', inScope: false, rationale: 'This NBS record does not cover the claimed topic.' }
    ]
  });
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [review], evaluationAt: now });
  assert.equal(result.reviewStatus, 'pending');
  assert.equal(result.checks.find((check) => check.type === 'publisher_scope_review').status, 'check_failed');
  assert.equal(result.checks.find((check) => check.type === 'human_claim_review').status, 'check_failed');
});

test('publisher authority registry requires explicit reviewed versioned exact-host entries', () => {
  assert.throws(() => commitPublisherAuthorityRegistry({
    registryId: 'unconfirmed', version: 1, reviewedAt: now,
    reviewer: { kind: 'human', id: 'reviewer' }, reviewStatement: 'Reviewed.',
    entries: [{ hostname: '*.example.com', publisherGroup: 'example', authorityTier: 'primary', scope: 'Example official data.', permittedClaimTypes: ['numeric'], basis: 'Looks official.', validUntil: '2027-01-01T00:00:00.000Z' }],
    confirmed: true
  }), /exact DNS hostname/);
  assert.throws(() => commitPublisherAuthorityRegistry({
    registryId: 'unconfirmed', version: 1, reviewedAt: now,
    reviewer: { kind: 'human', id: 'reviewer' }, reviewStatement: 'Reviewed.', entries: registryEntries
  }), /Explicit human confirmation/);

  const { packet, rawArtifact, sourceSnapshots } = fixture();
  const legacyRegistry = {
    'cbn.gov.ng': { publisherGroup: 'central-bank-of-nigeria', authorityTier: 'regulator' },
    'nigerianstat.gov.ng': { publisherGroup: 'national-bureau-of-statistics', authorityTier: 'primary' }
  };
  const legacyResult = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: legacyRegistry, evaluationAt: now });
  assert.equal(legacyResult.checks.find((check) => check.type === 'source_authority_policy').status, 'needs_human_review');

  const expiredRegistry = makeRegistry(registryEntries.map((entry) => ({ ...entry, validUntil: '2026-11-10T00:00:00.000Z' })));
  const expiredResult = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: expiredRegistry, evaluationAt: now });
  assert.equal(expiredResult.checks.find((check) => check.type === 'source_authority_policy').status, 'needs_human_review');
  assert.ok(expiredResult.sourceAssessments.every((source) => source.authorityRegistryStatus === 'expired'));

  const tamperedRegistry = { ...publisherRegistry, digest: 'f'.repeat(64) };
  const tamperedResult = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: tamperedRegistry, evaluationAt: now });
  assert.equal(tamperedResult.status, 'check_failed');

  const futureRegistry = makeRegistry(registryEntries, { reviewedAt: '2027-01-01T00:00:00.000Z' });
  const futureResult = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: futureRegistry, evaluationAt: now });
  assert.equal(futureResult.status, 'check_failed');
});

test('legacy committed publisher registry v1 is rejected rather than treated as an exact-host map', () => {
  const data = fixture();
  const oldRegistry = structuredClone(publisherRegistry.record);
  oldRegistry.schemaVersion = 'workrelay.publisher-authority-registry.v1';
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: oldRegistry, evaluationAt: now });
  assert.equal(result.status, 'check_failed');
  assert.equal(result.checks.find((check) => check.type === 'quality_policy_configuration').status, 'check_failed');
  assert.match(result.checks.find((check) => check.type === 'quality_policy_configuration').detail, /schemaVersion .* is unsupported/);
});

test('legacy evidence review v1 cannot satisfy the active v2 review contract', () => {
  const data = fixture();
  const oldReview = structuredClone(acceptedReview(data.packet));
  oldReview.record.schemaVersion = 'workrelay.evidence-review.v1';
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [oldReview], evaluationAt: now });
  assert.equal(result.checks.find((check) => check.type === 'review_record_integrity').status, 'check_failed');
  assert.equal(result.reviewStatus, 'pending');
});

test('near-duplicate source text across publisher groups is flagged as possible derivative reporting', () => {
  const common = 'The regulator published the quarterly transaction statistics showing total electronic payment volume increased across registered service providers during the measured reporting period. The report includes the same underlying figures and explanatory language for the national market. These values describe activity measured during the quarter and should be interpreted with the stated methodology.';
  const derivative = `${common} A short editorial introduction was added by the second publisher.`;
  const data = fixture({ sourceContents: { cbn: common, nbs: derivative } });
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  const claim = result.claimAssessments[0];
  assert.equal(result.checks.find((check) => check.type === 'source_derivation_similarity').status, 'needs_human_review');
  assert.equal(claim.possibleDerivativePairs.length, 1);
  assert.ok(claim.possibleDerivativePairs[0].similarity >= 0.82);
  assert.match(claim.possibleDerivativePairs[0].interpretation, /possible_shared_or_derivative/);
});

test('human reviewer must explicitly cover every supporting source when adjudicating possible derivatives', () => {
  const common = 'The regulator published the quarterly transaction statistics showing total electronic payment volume increased across registered service providers during the measured reporting period. The report includes the same underlying figures and explanatory language for the national market. These values describe activity measured during the quarter and should be interpreted with the stated methodology.';
  const derivative = `${common} A short editorial introduction was added by the second publisher.`;
  const data = fixture({ thirdSource: true, sourceContents: { cbn: common, nbs: derivative, sec: 'The securities regulator publishes a different dataset and methodology for this reporting period.' } });
  const partialReview = recordEvidenceReview({
    packetDigest: data.packet.digest,
    reviewer: { kind: 'human', id: 'reviewer-partial' },
    decision: 'accept', reviewedAt: now, confirmed: true,
    attestation: 'I reviewed this packet and all supplied evidence.',
    claimFindings: [{ claimId: 'claim-market-growth', outcome: 'supported', rationale: 'The claim is supported for the specified period.' }],
    independenceAssessments: [{ claimId: 'claim-market-growth', sourceIds: ['cbn', 'nbs'], independent: true, rationale: 'Only the first two source records were considered.' }],
    scopeAssessments: ['cbn', 'nbs'].map((sourceId) => ({ claimId: 'claim-market-growth', sourceId, inScope: true, rationale: 'The reviewer checked the source scope for this pair.' }))
  });
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [partialReview], evaluationAt: now });
  assert.equal(result.reviewStatus, 'pending');
  assert.equal(result.checks.find((check) => check.type === 'source_derivation_similarity').status, 'needs_human_review');
  assert.equal(result.checks.find((check) => check.type === 'cross_source_corroboration').status, 'needs_human_review');
});

test('packet-bound human independence assessment can adjudicate a flagged text-similarity pair', () => {
  const common = 'The regulator published the quarterly transaction statistics showing total electronic payment volume increased across registered service providers during the measured reporting period. The report includes the same underlying figures and explanatory language for the national market. These values describe activity measured during the quarter and should be interpreted with the stated methodology.';
  const derivative = `${common} A short editorial introduction was added by the second publisher.`;
  const data = fixture({ sourceContents: { cbn: common, nbs: derivative } });
  const review = acceptedReview(data.packet);
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [review], evaluationAt: now });
  assert.equal(result.reviewStatus, 'accepted');
  assert.equal(result.checks.find((check) => check.type === 'source_derivation_similarity').status, 'complete');
  assert.match(result.checks.find((check) => check.type === 'source_derivation_similarity').detail, /explicitly considered all high-overlap source pairs/);
});

test('short source bodies do not trigger the text-similarity heuristic without enough shingles', () => {
  const data = fixture({ sourceContents: { cbn: 'Short market data source text.', nbs: 'Short market data source text with a change.' } });
  const result = evaluateEvidenceQuality({ manifest: data.packet.record, packetDigest: data.packet.digest, rawArtifact: data.rawArtifact, sourceSnapshots: data.sourceSnapshots, authorityRegistry: publisherRegistry, evaluationAt: now });
  assert.equal(result.checks.find((check) => check.type === 'source_derivation_similarity').status, 'complete');
  assert.equal(result.claimAssessments[0].possibleDerivativePairs.length, 0);
});


test('future-dated human review declarations fail closed', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture();
  const futureReview = acceptedReview(packet);
  const changedRecord = { ...futureReview.record, reviewedAt: '2027-01-01T00:00:00.000Z' };
  const committedFuture = recordEvidenceReview({
    packetDigest: packet.digest,
    reviewer: changedRecord.reviewer,
    decision: changedRecord.decision,
    reviewedAt: changedRecord.reviewedAt,
    attestation: changedRecord.attestation.statement,
    claimFindings: changedRecord.claimFindings,
    independenceAssessments: changedRecord.independenceAssessments,
    scopeAssessments: changedRecord.scopeAssessments,
    confirmed: true
  });
  const result = evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, authorityRegistry: publisherRegistry, reviewRecords: [committedFuture], evaluationAt: now });
  assert.equal(result.status, 'check_failed');
  assert.equal(result.checks.find((check) => check.type === 'review_record_integrity').status, 'check_failed');
});

test('freshness policy rejects a malformed publication-age exemption list', () => {
  const { packet, rawArtifact, sourceSnapshots } = fixture();
  const result = evaluateEvidenceQuality({
    manifest: packet.record,
    packetDigest: packet.digest,
    rawArtifact,
    sourceSnapshots,
    authorityRegistry: publisherRegistry,
    policy: { freshness: { publicationAgeNotApplicableForClaimTypes: 'regulatory_current' } },
    evaluationAt: now
  });
  assert.equal(result.status, 'check_failed');
  assert.equal(result.checks[0].type, 'quality_policy_configuration');
});
