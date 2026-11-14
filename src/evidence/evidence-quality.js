import { createHash } from 'node:crypto';
import { commitRecord, SCHEMA_VERSIONS, validateEvidenceManifest } from '../contracts/schema.js';

export const EVIDENCE_REVIEW_SCHEMA = SCHEMA_VERSIONS.evidenceReview;
export const PUBLISHER_AUTHORITY_REGISTRY_SCHEMA = SCHEMA_VERSIONS.publisherAuthorityRegistry;

export const DEFAULT_EVIDENCE_QUALITY_POLICY = Object.freeze({
  version: 'workrelay.evidence-quality-policy.v3',
  freshness: Object.freeze({
    defaultMaxAgeDays: 180,
    maxAgeDaysByClaimType: Object.freeze({
      financial: 30,
      numeric: 90,
      market: 90,
      regulatory: 365,
      daily_series: 7,
      monthly_series: 60,
      quarterly_series: 150,
      annual_series: 550
    }),
    maxRetrievalAgeDays: 30,
    maxRetrievalAgeDaysByClaimType: Object.freeze({
      financial: 7,
      numeric: 14,
      market: 30,
      regulatory: 90,
      daily_series: 2,
      monthly_series: 14,
      quarterly_series: 30,
      annual_series: 90,
      regulatory_current: 30
    }),
    publicationAgeNotApplicableForClaimTypes: Object.freeze(['regulatory_current']),
    futureSkewMinutes: 5,
    requirePublishedAtForMaterialClaims: true
  }),
  authority: Object.freeze({
    minimumTierByClaimType: Object.freeze({ financial: 'primary', numeric: 'primary', market: 'primary', regulatory: 'regulator', regulatory_current: 'regulator', daily_series: 'primary', monthly_series: 'primary', quarterly_series: 'primary', annual_series: 'primary', default: 'secondary' }),
    requireRegistryMatchForMaterialClaims: true
  }),
  corroboration: Object.freeze({
    minIndependentPublisherGroupsForMaterialClaims: 2,
    requireHumanIndependenceAssessment: true,
    nearDuplicateSimilarityThreshold: 0.82,
    nearDuplicateMinShingles: 8,
    nearDuplicateShingleSize: 5
  }),
  review: Object.freeze({ requireHumanReviewForMaterialClaims: true })
});

const AUTHORITY_TIERS = Object.freeze(['regulator', 'primary', 'academic', 'secondary', 'unknown']);
const TIER_RANK = Object.freeze({ regulator: 0, primary: 1, academic: 1, secondary: 2, unknown: 3 });
const REVIEW_DECISIONS = Object.freeze(['accept', 'request_revision', 'reject']);
const CLAIM_OUTCOMES = Object.freeze(['supported', 'contradicted', 'insufficient', 'mixed']);
const REGISTRY_CLAIM_TYPES = Object.freeze(['financial', 'numeric', 'market', 'regulatory', 'regulatory_current', 'daily_series', 'monthly_series', 'quarterly_series', 'annual_series']);
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const DAY_MS = 24 * 60 * 60 * 1000;

function fail(message) { throw new TypeError(message); }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function nonEmpty(value, name) {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a non-empty string`);
  return value.normalize('NFC');
}
function isoTimestamp(value, name) {
  const text = nonEmpty(value, name);
  if (Number.isNaN(Date.parse(text)) || !text.endsWith('Z')) fail(`${name} must be an ISO timestamp ending in Z`);
  return text;
}
function identity(value, name) {
  if (!isObject(value)) fail(`${name} must be an identity object`);
  return { kind: nonEmpty(value.kind, `${name}.kind`), id: nonEmpty(value.id, `${name}.id`) };
}
function hash(value, name) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`${name} must be a lowercase SHA-256 digest`);
  return value;
}
function uniqueStrings(values, name, min = 0) {
  if (!Array.isArray(values) || values.length < min || values.some((value) => typeof value !== 'string' || !value.trim())) fail(`${name} must be an array of at least ${min} non-empty strings`);
  if (new Set(values).size !== values.length) fail(`${name} must not contain duplicates`);
  return values.map((value) => value.normalize('NFC'));
}

function validateEvidenceReviewRecord(value) {
  const keys = ['schemaVersion', 'packetDigest', 'reviewer', 'decision', 'reviewedAt', 'attestation', 'claimFindings', 'independenceAssessments', 'scopeAssessments'];
  if (!isObject(value) || keys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !keys.includes(key))) fail('evidenceReview must contain exactly the versioned review fields');
  if (value.schemaVersion !== EVIDENCE_REVIEW_SCHEMA) fail(`evidenceReview.schemaVersion must equal ${EVIDENCE_REVIEW_SCHEMA}`);
  const reviewer = identity(value.reviewer, 'evidenceReview.reviewer');
  if (reviewer.kind !== 'human') fail('evidenceReview.reviewer.kind must be human');
  if (!REVIEW_DECISIONS.includes(value.decision)) fail('evidenceReview.decision is unsupported');
  if (!isObject(value.attestation) || value.attestation.confirmed !== true) fail('evidenceReview.attestation.confirmed must be true');
  const attestation = {
    confirmed: true,
    statement: nonEmpty(value.attestation.statement, 'evidenceReview.attestation.statement')
  };
  if (!Array.isArray(value.claimFindings)) fail('evidenceReview.claimFindings must be an array');
  const claimFindings = value.claimFindings.map((finding, index) => {
    if (!isObject(finding)) fail(`evidenceReview.claimFindings[${index}] must be an object`);
    const allowed = ['claimId', 'outcome', 'rationale'];
    if (allowed.some((key) => !Object.hasOwn(finding, key)) || Object.keys(finding).some((key) => !allowed.includes(key))) fail(`evidenceReview.claimFindings[${index}] has invalid fields`);
    if (!CLAIM_OUTCOMES.includes(finding.outcome)) fail(`evidenceReview.claimFindings[${index}].outcome is unsupported`);
    return {
      claimId: nonEmpty(finding.claimId, `evidenceReview.claimFindings[${index}].claimId`),
      outcome: finding.outcome,
      rationale: nonEmpty(finding.rationale, `evidenceReview.claimFindings[${index}].rationale`)
    };
  });
  if (new Set(claimFindings.map((finding) => finding.claimId)).size !== claimFindings.length) fail('evidenceReview.claimFindings must not repeat claim IDs');
  if (!Array.isArray(value.independenceAssessments)) fail('evidenceReview.independenceAssessments must be an array');
  const independenceAssessments = value.independenceAssessments.map((assessment, index) => {
    if (!isObject(assessment) || typeof assessment.independent !== 'boolean') fail(`evidenceReview.independenceAssessments[${index}] is invalid`);
    const allowed = ['claimId', 'sourceIds', 'independent', 'rationale'];
    if (allowed.some((key) => !Object.hasOwn(assessment, key)) || Object.keys(assessment).some((key) => !allowed.includes(key))) fail(`evidenceReview.independenceAssessments[${index}] has invalid fields`);
    return {
      claimId: nonEmpty(assessment.claimId, `evidenceReview.independenceAssessments[${index}].claimId`),
      sourceIds: uniqueStrings(assessment.sourceIds, `evidenceReview.independenceAssessments[${index}].sourceIds`, 2),
      independent: assessment.independent,
      rationale: nonEmpty(assessment.rationale, `evidenceReview.independenceAssessments[${index}].rationale`)
    };
  });
  if (new Set(independenceAssessments.map((assessment) => assessment.claimId)).size !== independenceAssessments.length) fail('evidenceReview.independenceAssessments must not repeat claim IDs');
  if (!Array.isArray(value.scopeAssessments)) fail('evidenceReview.scopeAssessments must be an array');
  const scopeAssessments = value.scopeAssessments.map((assessment, index) => {
    if (!isObject(assessment) || typeof assessment.inScope !== 'boolean') fail(`evidenceReview.scopeAssessments[${index}] is invalid`);
    const allowed = ['claimId', 'sourceId', 'inScope', 'rationale'];
    if (allowed.some((key) => !Object.hasOwn(assessment, key)) || Object.keys(assessment).some((key) => !allowed.includes(key))) fail(`evidenceReview.scopeAssessments[${index}] has invalid fields`);
    return {
      claimId: nonEmpty(assessment.claimId, `evidenceReview.scopeAssessments[${index}].claimId`),
      sourceId: nonEmpty(assessment.sourceId, `evidenceReview.scopeAssessments[${index}].sourceId`),
      inScope: assessment.inScope,
      rationale: nonEmpty(assessment.rationale, `evidenceReview.scopeAssessments[${index}].rationale`)
    };
  });
  const scopeKeys = scopeAssessments.map((assessment) => `${assessment.claimId}\u0000${assessment.sourceId}`);
  if (new Set(scopeKeys).size !== scopeKeys.length) fail('evidenceReview.scopeAssessments must not repeat claim/source pairs');
  return {
    schemaVersion: value.schemaVersion,
    packetDigest: hash(value.packetDigest, 'evidenceReview.packetDigest'),
    reviewer,
    decision: value.decision,
    reviewedAt: isoTimestamp(value.reviewedAt, 'evidenceReview.reviewedAt'),
    attestation,
    claimFindings,
    independenceAssessments,
    scopeAssessments
  };
}

/**
 * Create a hash-committed human review bound to one exact evidence packet.
 * This records a human declaration; it does not authenticate the human identity.
 */
export function recordEvidenceReview({ packetDigest, reviewer, decision, reviewedAt = new Date().toISOString(), attestation, claimFindings = [], independenceAssessments = [], scopeAssessments = [], confirmed = false }) {
  if (confirmed !== true) fail('Explicit human confirmation is required to record an evidence review');
  const record = {
    schemaVersion: EVIDENCE_REVIEW_SCHEMA,
    packetDigest,
    reviewer,
    decision,
    reviewedAt,
    attestation: { confirmed: true, statement: attestation },
    claimFindings,
    independenceAssessments,
    scopeAssessments
  };
  return commitRecord(record, validateEvidenceReviewRecord);
}

function validatePublisherAuthorityRegistryRecord(value) {
  const keys = ['schemaVersion', 'registryId', 'version', 'reviewedAt', 'reviewer', 'reviewStatement', 'entries'];
  if (!isObject(value) || keys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !keys.includes(key))) {
    fail('publisherAuthorityRegistry must contain exactly the versioned registry fields');
  }
  if (value.schemaVersion !== PUBLISHER_AUTHORITY_REGISTRY_SCHEMA) fail(`publisherAuthorityRegistry.schemaVersion must equal ${PUBLISHER_AUTHORITY_REGISTRY_SCHEMA}`);
  if (!Number.isSafeInteger(value.version) || value.version < 1) fail('publisherAuthorityRegistry.version must be a positive integer');
  const reviewer = identity(value.reviewer, 'publisherAuthorityRegistry.reviewer');
  if (reviewer.kind !== 'human') fail('publisherAuthorityRegistry.reviewer.kind must be human');
  const reviewedAt = isoTimestamp(value.reviewedAt, 'publisherAuthorityRegistry.reviewedAt');
  if (!Array.isArray(value.entries) || value.entries.length === 0) fail('publisherAuthorityRegistry.entries must be a non-empty array');
  const entries = value.entries.map((entry, index) => {
    if (!isObject(entry)) fail(`publisherAuthorityRegistry.entries[${index}] must be an object`);
    const allowed = ['hostname', 'publisherGroup', 'authorityTier', 'scope', 'permittedClaimTypes', 'basis', 'validUntil'];
    if (allowed.some((key) => !Object.hasOwn(entry, key)) || Object.keys(entry).some((key) => !allowed.includes(key))) {
      fail(`publisherAuthorityRegistry.entries[${index}] has invalid fields`);
    }
    const hostname = nonEmpty(entry.hostname, `publisherAuthorityRegistry.entries[${index}].hostname`).toLowerCase();
    let parsed;
    try { parsed = new URL(`https://${hostname}`); } catch { fail(`publisherAuthorityRegistry.entries[${index}].hostname must be an exact DNS hostname`); }
    if (parsed.hostname !== hostname || parsed.pathname !== '/' || parsed.port || hostname.includes('*') || hostname.includes(':')) {
      fail(`publisherAuthorityRegistry.entries[${index}].hostname must be an exact DNS hostname without wildcards or ports`);
    }
    if (!AUTHORITY_TIERS.includes(entry.authorityTier)) fail(`publisherAuthorityRegistry.entries[${index}].authorityTier is unsupported`);
    const permittedClaimTypes = uniqueStrings(entry.permittedClaimTypes, `publisherAuthorityRegistry.entries[${index}].permittedClaimTypes`, 1);
    for (const claimType of permittedClaimTypes) if (!REGISTRY_CLAIM_TYPES.includes(claimType)) fail(`publisherAuthorityRegistry.entries[${index}].permittedClaimTypes contains unsupported claim type ${claimType}`);
    const validUntil = isoTimestamp(entry.validUntil, `publisherAuthorityRegistry.entries[${index}].validUntil`);
    if (Date.parse(validUntil) <= Date.parse(reviewedAt)) fail(`publisherAuthorityRegistry.entries[${index}].validUntil must be after reviewedAt`);
    return {
      hostname,
      publisherGroup: nonEmpty(entry.publisherGroup, `publisherAuthorityRegistry.entries[${index}].publisherGroup`),
      authorityTier: entry.authorityTier,
      scope: uniqueStrings(entry.scope, `publisherAuthorityRegistry.entries[${index}].scope`, 1),
      permittedClaimTypes,
      basis: nonEmpty(entry.basis, `publisherAuthorityRegistry.entries[${index}].basis`),
      validUntil
    };
  });
  if (new Set(entries.map((entry) => entry.hostname)).size !== entries.length) fail('publisherAuthorityRegistry.entries must not repeat hostnames');
  return {
    schemaVersion: value.schemaVersion,
    registryId: nonEmpty(value.registryId, 'publisherAuthorityRegistry.registryId'),
    version: value.version,
    reviewedAt,
    reviewer,
    reviewStatement: nonEmpty(value.reviewStatement, 'publisherAuthorityRegistry.reviewStatement'),
    entries
  };
}

/**
 * Commit a human-reviewed exact-host publisher registry. Reviewer identity is
 * declared, not authenticated; account authentication is a Step 8 concern.
 */
export function commitPublisherAuthorityRegistry({
  registryId,
  version,
  reviewedAt = new Date().toISOString(),
  reviewer,
  reviewStatement,
  entries,
  confirmed = false
}) {
  if (confirmed !== true) fail('Explicit human confirmation is required to commit a publisher authority registry');
  return commitRecord({
    schemaVersion: PUBLISHER_AUTHORITY_REGISTRY_SCHEMA,
    registryId,
    version,
    reviewedAt,
    reviewer,
    reviewStatement,
    entries
  }, validatePublisherAuthorityRegistryRecord);
}

function normalizePolicy(policy = {}) {
  const merged = {
    version: policy.version ?? DEFAULT_EVIDENCE_QUALITY_POLICY.version,
    freshness: { ...DEFAULT_EVIDENCE_QUALITY_POLICY.freshness, ...(policy.freshness ?? {}) },
    authority: { ...DEFAULT_EVIDENCE_QUALITY_POLICY.authority, ...(policy.authority ?? {}) },
    corroboration: { ...DEFAULT_EVIDENCE_QUALITY_POLICY.corroboration, ...(policy.corroboration ?? {}) },
    review: { ...DEFAULT_EVIDENCE_QUALITY_POLICY.review, ...(policy.review ?? {}) }
  };
  merged.freshness.maxAgeDaysByClaimType = { ...DEFAULT_EVIDENCE_QUALITY_POLICY.freshness.maxAgeDaysByClaimType, ...(policy.freshness?.maxAgeDaysByClaimType ?? {}) };
  merged.freshness.maxRetrievalAgeDaysByClaimType = { ...DEFAULT_EVIDENCE_QUALITY_POLICY.freshness.maxRetrievalAgeDaysByClaimType, ...(policy.freshness?.maxRetrievalAgeDaysByClaimType ?? {}) };
  const publicationAgeExemptTypes = policy.freshness?.publicationAgeNotApplicableForClaimTypes ?? DEFAULT_EVIDENCE_QUALITY_POLICY.freshness.publicationAgeNotApplicableForClaimTypes;
  if (!Array.isArray(publicationAgeExemptTypes)) fail('policy.freshness.publicationAgeNotApplicableForClaimTypes must be an array of non-empty claim types');
  merged.freshness.publicationAgeNotApplicableForClaimTypes = [...new Set(publicationAgeExemptTypes)];
  merged.authority.minimumTierByClaimType = { ...DEFAULT_EVIDENCE_QUALITY_POLICY.authority.minimumTierByClaimType, ...(policy.authority?.minimumTierByClaimType ?? {}) };
  nonEmpty(merged.version, 'policy.version');
  for (const [key, value] of Object.entries(merged.freshness.maxAgeDaysByClaimType)) {
    if (!Number.isSafeInteger(value) || value < 1) fail(`policy.freshness.maxAgeDaysByClaimType.${key} must be a positive integer`);
  }
  for (const [key, value] of Object.entries(merged.freshness.maxRetrievalAgeDaysByClaimType)) {
    if (!Number.isSafeInteger(value) || value < 1) fail(`policy.freshness.maxRetrievalAgeDaysByClaimType.${key} must be a positive integer`);
  }
  if (merged.freshness.publicationAgeNotApplicableForClaimTypes.some((value) => typeof value !== 'string' || !value.trim())) {
    fail('policy.freshness.publicationAgeNotApplicableForClaimTypes must be an array of non-empty claim types');
  }
  for (const [key, value] of Object.entries(merged.authority.minimumTierByClaimType)) {
    if (!AUTHORITY_TIERS.includes(value)) fail(`policy.authority.minimumTierByClaimType.${key} is unsupported`);
  }
  for (const [key, value] of Object.entries({
    defaultMaxAgeDays: merged.freshness.defaultMaxAgeDays,
    maxRetrievalAgeDays: merged.freshness.maxRetrievalAgeDays,
    futureSkewMinutes: merged.freshness.futureSkewMinutes,
    minIndependentPublisherGroupsForMaterialClaims: merged.corroboration.minIndependentPublisherGroupsForMaterialClaims,
    nearDuplicateMinShingles: merged.corroboration.nearDuplicateMinShingles,
    nearDuplicateShingleSize: merged.corroboration.nearDuplicateShingleSize
  })) {
    if (!Number.isSafeInteger(value) || value < 0) fail(`policy.${key} must be a non-negative integer`);
  }
  for (const key of ['requirePublishedAtForMaterialClaims']) if (typeof merged.freshness[key] !== 'boolean') fail(`policy.freshness.${key} must be boolean`);
  for (const key of ['requireRegistryMatchForMaterialClaims']) if (typeof merged.authority[key] !== 'boolean') fail(`policy.authority.${key} must be boolean`);
  for (const key of ['requireHumanIndependenceAssessment']) if (typeof merged.corroboration[key] !== 'boolean') fail(`policy.corroboration.${key} must be boolean`);
  if (typeof merged.corroboration.nearDuplicateSimilarityThreshold !== 'number' || !Number.isFinite(merged.corroboration.nearDuplicateSimilarityThreshold) || merged.corroboration.nearDuplicateSimilarityThreshold < 0.5 || merged.corroboration.nearDuplicateSimilarityThreshold > 1) fail('policy.corroboration.nearDuplicateSimilarityThreshold must be between 0.5 and 1');
  for (const key of ['requireHumanReviewForMaterialClaims']) if (typeof merged.review[key] !== 'boolean') fail(`policy.review.${key} must be boolean`);
  return merged;
}

function normalizeAuthorityRegistry(registry = {}, asOf = Date.now(), futureSkewMinutes = 5) {
  if (!isObject(registry)) fail('authorityRegistry must be an object keyed by exact hostname or a committed registry record');
  const normalized = new Map();
  const registryRecord = registry.record ?? registry;
  if (isObject(registryRecord) && Object.hasOwn(registryRecord, 'schemaVersion') && registryRecord.schemaVersion !== PUBLISHER_AUTHORITY_REGISTRY_SCHEMA) {
    fail(`authorityRegistry.schemaVersion ${registryRecord.schemaVersion} is unsupported; expected ${PUBLISHER_AUTHORITY_REGISTRY_SCHEMA}`);
  }
  if (registryRecord?.schemaVersion === PUBLISHER_AUTHORITY_REGISTRY_SCHEMA) {
    const committed = commitRecord(registryRecord, validatePublisherAuthorityRegistryRecord);
    if (registry.digest && registry.digest !== committed.digest) fail('authorityRegistry digest does not match its canonical record');
    if (Date.parse(committed.record.reviewedAt) > asOf + futureSkewMinutes * 60_000) fail('authorityRegistry reviewedAt is implausibly in the future');
    for (const entry of committed.record.entries) {
      normalized.set(entry.hostname, {
        publisherGroup: entry.publisherGroup,
        authorityTier: entry.authorityTier,
        scope: entry.scope,
        permittedClaimTypes: entry.permittedClaimTypes,
        registryStatus: Date.parse(entry.validUntil) > asOf ? 'current' : 'expired',
        registryId: committed.record.registryId,
        registryVersion: committed.record.version,
        registryDigest: committed.digest,
        registryReviewedAt: committed.record.reviewedAt,
        registryReviewer: committed.record.reviewer.id,
        registryReviewBasis: entry.basis,
        registryValidUntil: entry.validUntil
      });
    }
    return normalized;
  }
  // Legacy exact-host maps remain readable for migration, but do not satisfy
  // the reviewed-registry requirement for material-claim authority checks.
  for (const [host, entry] of Object.entries(registry)) {
    const hostname = host.trim().toLowerCase();
    if (!hostname || hostname.includes('/') || hostname.includes('*')) fail(`authorityRegistry key ${host} must be an exact hostname`);
    if (!isObject(entry)) fail(`authorityRegistry.${host} must be an object`);
    if (!AUTHORITY_TIERS.includes(entry.authorityTier)) fail(`authorityRegistry.${host}.authorityTier is unsupported`);
    normalized.set(hostname, {
      publisherGroup: nonEmpty(entry.publisherGroup, `authorityRegistry.${host}.publisherGroup`),
      authorityTier: entry.authorityTier,
      scope: null,
      permittedClaimTypes: [],
      registryStatus: 'unversioned_legacy'
    });
  }
  return normalized;
}

function wordShingles(content, size) {
  const tokens = String(content ?? '').normalize('NFKC').toLocaleLowerCase('und').match(/[\p{L}\p{N}]+/gu) ?? [];
  const shingles = new Set();
  for (let index = 0; index <= tokens.length - size; index += 1) shingles.add(tokens.slice(index, index + size).join(' '));
  return shingles;
}

function normalizeAttributionLabel(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/https?:\/\//g, '')
    .replace(/\b(the|a|an)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 100);
}

/**
 * Extract explicit attribution cues from captured text. These are indicators
 * for reviewer attention, not proof of syndication, common ownership or origin.
 */
function extractAttributionSignals(content) {
  const text = String(content ?? '').normalize('NFKC');
  const patterns = [
    { type: 'source_line', regex: /^\s*(?:source|via|courtesy of|distributed by|reprinted from|originally published by|syndicated from)\s*[:\-]?\s*([^\n.;]{2,100})/gim },
    { type: 'byline', regex: /^\s*by\s+([^\n.;]{2,80})/gim },
    { type: 'press_release_issuer', regex: /\b(?:press|news|media) release\s+(?:from|by|issued by)\s+([^\n.;]{2,100})/gi }
  ];
  const signals = [];
  const seen = new Set();
  for (const { type, regex } of patterns) {
    for (const match of text.matchAll(regex)) {
      const excerpt = match[0].trim().replace(/\s+/g, ' ').slice(0, 180);
      const label = normalizeAttributionLabel(match[1]);
      if (!label) continue;
      const key = `${type}\u0000${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push({ type, label, excerpt });
      if (signals.length >= 12) return signals;
    }
  }
  return signals;
}

function rationaleAddressesAttribution(value) {
  return /\b(attribution|origin|syndicat(?:ed|ion)|press release|news release|media release|byline|source line|republication)\b/i.test(String(value ?? ''));
}

function rationaleAddressesConflict(value) {
  const text = String(value ?? '');
  const dimensions = [
    /\b(period|time window|reporting period)\b/i,
    /\b(unit|denominator|base|population)\b/i,
    /\b(method|methodology|definition|calculation)\b/i,
    /\b(scope|coverage|dataset|inclusion)\b/i
  ];
  const comparedDimensions = dimensions.filter((pattern) => pattern.test(text)).length;
  return text.trim().length >= 30 && comparedDimensions >= 2;
}

function rationaleAddressesRegulatoryCurrentStatus(value) {
  const text = String(value ?? '');
  const currentStatus = /\b(in force|currently effective|still effective|not repealed|not superseded|current (?:consolidated )?version|remains effective)\b/i.test(text);
  const amendmentCheck = /\b(amendments?|repeals?|supersed(?:ed|ing)|consolidat(?:ed|ion)|gazette|official register|current rules|current acts)\b/i.test(text);
  return text.trim().length >= 40 && currentStatus && amendmentCheck;
}

function overlapCoefficient(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  for (const item of smaller) if (larger.has(item)) shared += 1;
  return shared / smaller.size;
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function domainOf(source) {
  try { return new URL(source.url).hostname.toLowerCase(); } catch { return null; }
}
function pickStatus(statuses) {
  if (statuses.includes('check_failed')) return 'check_failed';
  if (statuses.includes('incomplete')) return 'incomplete';
  if (statuses.includes('needs_human_review')) return 'needs_human_review';
  return 'complete';
}
function pushCheck(checks, type, status, detail) { checks.push({ type, status, detail }); }

/**
 * Evaluate source quality, temporal fitness, publisher-policy metadata,
 * claim-level traceability and human review. No result is a factual truth score.
 */
export function evaluateEvidenceQuality({
  manifest,
  packetDigest,
  sourceSnapshots = {},
  rawArtifact = null,
  requiredClaimIds = [],
  authorityRegistry = {},
  policy = {},
  reviewRecords = [],
  evaluationAt = new Date().toISOString()
}) {
  const checks = [];
  if (!isObject(sourceSnapshots) || !Array.isArray(requiredClaimIds) || !Array.isArray(reviewRecords)) {
    pushCheck(checks, 'quality_input_shape', 'check_failed', 'sourceSnapshots must be an object and requiredClaimIds/reviewRecords must be arrays.');
    return { status: 'check_failed', checks, claimAssessments: [], sourceAssessments: [], reviewStatus: 'blocked', limitation: 'Malformed quality-evaluation inputs are not processed.' };
  }
  let normalized;
  try {
    normalized = validateEvidenceManifest(manifest);
  } catch (error) {
    pushCheck(checks, 'schema_completeness', 'check_failed', error.message);
    return { status: 'check_failed', checks, claimAssessments: [], sourceAssessments: [], reviewStatus: 'blocked', limitation: 'Invalid evidence manifests cannot enter the evidence-quality policy.' };
  }

  let policyValue;
  let registry;
  let asOf;
  try {
    policyValue = normalizePolicy(policy);
    asOf = Date.parse(isoTimestamp(evaluationAt, 'evaluationAt'));
    registry = normalizeAuthorityRegistry(authorityRegistry, asOf, policyValue.freshness.futureSkewMinutes);
  } catch (error) {
    pushCheck(checks, 'quality_policy_configuration', 'check_failed', error.message);
    return { status: 'check_failed', checks, claimAssessments: [], sourceAssessments: [], reviewStatus: 'blocked', limitation: 'The quality policy or authority registry is invalid.' };
  }

  const committedPacket = commitRecord(normalized, validateEvidenceManifest);
  const expectedPacketDigest = committedPacket.digest;
  if (packetDigest !== undefined && packetDigest !== null && packetDigest !== expectedPacketDigest) pushCheck(checks, 'packet_commitment', 'check_failed', 'Supplied packet digest does not match the canonical evidence manifest.');
  else pushCheck(checks, 'packet_commitment', 'complete', 'Evidence manifest matches its canonical packet commitment.');

  if (rawArtifact !== null && sha256(String(rawArtifact)) !== normalized.rawArtifactHash) pushCheck(checks, 'raw_artifact_integrity', 'check_failed', 'Raw artifact bytes do not match the manifest SHA-256 commitment.');
  else pushCheck(checks, 'raw_artifact_integrity', rawArtifact === null ? 'needs_human_review' : 'complete', rawArtifact === null ? 'Raw artifact bytes were not supplied for re-hashing.' : 'Raw artifact bytes match the manifest commitment.');

  const claimIds = normalized.claims.map((claim) => claim.id);
  const sourceIds = normalized.sources.map((source) => source.id);
  const duplicateClaimIds = claimIds.filter((id, index) => claimIds.indexOf(id) !== index);
  const duplicateSourceIds = sourceIds.filter((id, index) => sourceIds.indexOf(id) !== index);
  if (duplicateClaimIds.length || duplicateSourceIds.length) pushCheck(checks, 'record_identifier_uniqueness', 'check_failed', `Duplicate claim IDs: ${[...new Set(duplicateClaimIds)].join(', ') || 'none'}; duplicate source IDs: ${[...new Set(duplicateSourceIds)].join(', ') || 'none'}.`);
  else pushCheck(checks, 'record_identifier_uniqueness', 'complete', 'Claim and source identifiers are unique within the packet.');
  const claimsById = new Map(normalized.claims.map((claim) => [claim.id, claim]));
  const sourcesById = new Map(normalized.sources.map((source) => [source.id, source]));
  const validLinks = [];
  const danglingLinks = [];
  const duplicateLinkKeys = new Set();
  const duplicateLinks = [];
  const unsupportedRelationshipLinks = normalized.links.filter((link) => !['supports', 'contradicts', 'contextualizes', 'unsupported'].includes(link.relationship));
  if (unsupportedRelationshipLinks.length) pushCheck(checks, 'claim_relationship_types', 'check_failed', `${unsupportedRelationshipLinks.length} link(s) use an unsupported relationship type.`);
  else pushCheck(checks, 'claim_relationship_types', 'complete', 'All claim/source relationships use a recognized relationship type.');
  for (const link of normalized.links) {
    if (!claimsById.has(link.claimId) || !sourcesById.has(link.sourceId) || !['supports', 'contradicts', 'contextualizes', 'unsupported'].includes(link.relationship)) {
      danglingLinks.push(link);
      continue;
    }
    const key = `${link.claimId}\u0000${link.sourceId}\u0000${link.relationship}`;
    if (duplicateLinkKeys.has(key)) duplicateLinks.push(link);
    duplicateLinkKeys.add(key);
    validLinks.push(link);
  }
  if (danglingLinks.length) pushCheck(checks, 'claim_source_link_integrity', 'check_failed', `${danglingLinks.length} link(s) refer to an unknown claim or source.`);
  else pushCheck(checks, 'claim_source_link_integrity', 'complete', 'Every claim/source link resolves to a declared record.');
  if (duplicateLinks.length) pushCheck(checks, 'duplicate_claim_source_links', 'incomplete', `${duplicateLinks.length} duplicate claim/source relationship(s) were found.`);
  else pushCheck(checks, 'duplicate_claim_source_links', 'complete', 'No duplicate claim/source relationships were found.');
  const orphanSources = normalized.sources.filter((source) => !validLinks.some((link) => link.sourceId === source.id));
  if (orphanSources.length) pushCheck(checks, 'unattributed_sources', 'incomplete', `${orphanSources.length} source record(s) are not linked to any claim.`);
  else pushCheck(checks, 'unattributed_sources', 'complete', 'Every source record is linked to at least one claim.');

  const unknownRequiredClaimIds = requiredClaimIds.filter((id) => !claimsById.has(id));
  if (unknownRequiredClaimIds.length) pushCheck(checks, 'required_claim_declaration', 'check_failed', `Required claim IDs are not present in the manifest: ${unknownRequiredClaimIds.join(', ')}.`);
  else pushCheck(checks, 'required_claim_declaration', 'complete', 'All externally required claim IDs exist in the evidence manifest.');

  const materialClaimIds = new Set([
    ...normalized.claims.filter((claim) => claim.importance === 'material').map((claim) => claim.id),
    ...requiredClaimIds
  ]);
  const claimAssessments = [];
  const sourceAssessments = [];
  const sourceShingles = new Map();
  const sourceAttribution = new Map();
  const sourceStatus = new Map();
  const sourceAuthority = new Map();

  for (const source of normalized.sources) {
    const domain = domainOf(source);
    const authority = domain ? registry.get(domain) : null;
    sourceAuthority.set(source.id, authority ?? null);
    const snapshot = sourceSnapshots[source.id];
    let captureStatus = 'complete';
    let captureDetail = 'Capture metadata is present.';
    let parsedUrl = null;
    try { parsedUrl = new URL(source.url); } catch { /* handled below */ }
    if (!parsedUrl || parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || parsedUrl.hash || (parsedUrl.port && parsedUrl.port !== '443')) {
      captureStatus = 'check_failed';
      captureDetail = 'Source URL is invalid or violates the HTTPS-only source policy.';
    } else if (source.accessStatus !== 'ok') {
      captureStatus = 'check_failed';
      captureDetail = `Source access status is ${source.accessStatus}, not ok.`;
    } else if (!snapshot) {
      captureStatus = 'needs_human_review';
      captureDetail = 'Captured source bytes/snapshot were not supplied for verification.';
    } else if (snapshot.safe !== true || snapshot.contentHash !== source.contentHash
      || typeof snapshot.content !== 'string' || sha256(snapshot.content) !== source.contentHash) {
      captureStatus = 'check_failed';
      captureDetail = 'Source snapshot is unsafe, missing its captured body, or its bytes/hash do not match the manifest.';
    }
    sourceStatus.set(source.id, captureStatus);
    const attributionSignals = captureStatus === 'complete' && typeof snapshot?.content === 'string'
      ? extractAttributionSignals(snapshot.content)
      : [];
    sourceAttribution.set(source.id, attributionSignals);
    if (captureStatus === 'complete' && typeof snapshot?.content === 'string') {
      sourceShingles.set(source.id, wordShingles(snapshot.content, policyValue.corroboration.nearDuplicateShingleSize));
    }
    sourceAssessments.push({
      sourceId: source.id,
      domain,
      publisher: source.publisher,
      authorityTier: authority?.authorityTier ?? 'unknown',
      publisherGroup: authority?.publisherGroup ?? null,
      authorityScope: authority?.scope ?? null,
      permittedClaimTypes: authority?.permittedClaimTypes ?? [],
      authorityRegistryStatus: authority?.registryStatus ?? 'unregistered',
      authorityRegistryVersion: authority?.registryVersion ?? null,
      authorityRegistryReviewedAt: authority?.registryReviewedAt ?? null,
      authorityRegistryValidUntil: authority?.registryValidUntil ?? null,
      attributionSignals,
      captureStatus,
      captureDetail
    });
  }
  const captureStatuses = [...sourceStatus.values()];
  pushCheck(checks, 'source_snapshot_verification', pickStatus(captureStatuses), captureStatuses.includes('check_failed')
    ? 'One or more source snapshots failed access or hash verification.'
    : captureStatuses.includes('needs_human_review')
      ? 'At least one source snapshot is missing; capture metadata alone is not treated as source verification.'
      : 'All supplied source snapshots are safe and match their committed hashes.');

  const linkedSourceIds = new Set(validLinks.map((link) => link.sourceId));
  const emptyExcerpts = normalized.sources.filter((source) => linkedSourceIds.has(source.id) && !source.excerpt.trim());
  const excerptMismatches = normalized.sources.filter((source) => {
    const snapshot = sourceSnapshots[source.id];
    return snapshot && typeof snapshot.content === 'string' && source.excerpt && !snapshot.content.includes(source.excerpt);
  });
  const excerptStatus = excerptMismatches.length ? 'check_failed' : emptyExcerpts.length ? 'incomplete' : 'complete';
  pushCheck(checks, 'source_excerpt_match', excerptStatus, excerptMismatches.length
    ? `${excerptMismatches.length} saved excerpt(s) do not occur in their captured source body.`
    : emptyExcerpts.length
      ? `${emptyExcerpts.length} linked source record(s) have no excerpt.`
      : 'Saved source excerpts occur in the supplied captured source bodies.');

  const freshnessStatuses = [];
  const freshnessBySource = new Map();
  const authorityStatuses = [];
  for (const source of normalized.sources) {
    const authority = sourceAuthority.get(source.id);
    const linkedClaims = validLinks.filter((link) => link.sourceId === source.id).map((link) => claimsById.get(link.claimId)).filter(Boolean);
    const relevantMaterialClaims = linkedClaims.filter((claim) => materialClaimIds.has(claim.id));
    const publicationAgeApplicableClaims = relevantMaterialClaims.filter((claim) => !policyValue.freshness.publicationAgeNotApplicableForClaimTypes.includes(claim.type));
    const strictMaxAge = relevantMaterialClaims.length
      ? (publicationAgeApplicableClaims.length
        ? Math.min(...publicationAgeApplicableClaims.map((claim) => policyValue.freshness.maxAgeDaysByClaimType[claim.type] ?? policyValue.freshness.defaultMaxAgeDays))
        : null)
      : policyValue.freshness.defaultMaxAgeDays;
    const strictMaxRetrievalAge = relevantMaterialClaims.length
      ? Math.min(...relevantMaterialClaims.map((claim) => policyValue.freshness.maxRetrievalAgeDaysByClaimType[claim.type] ?? policyValue.freshness.maxRetrievalAgeDays))
      : policyValue.freshness.maxRetrievalAgeDays;
    const publishedAt = source.publishedAt === null ? null : Date.parse(source.publishedAt);
    const retrievedAt = Date.parse(source.retrievedAt);
    const futureTolerance = policyValue.freshness.futureSkewMinutes * 60_000;
    let freshnessStatus = 'complete';
    let freshnessDetail = strictMaxAge === null
      ? `Publication age is not used as a proxy for legal status; retrieval age must be within ${strictMaxRetrievalAge} days and a separate current-status review is required.`
      : `Publication age is within ${strictMaxAge} days and retrieval age is within ${strictMaxRetrievalAge} days for the linked claim type(s).`;
    if (publishedAt === null && relevantMaterialClaims.length && policyValue.freshness.requirePublishedAtForMaterialClaims) {
      freshnessStatus = 'needs_human_review';
      freshnessDetail = 'Publication date is missing for a source linked to a material claim.';
    } else if (publishedAt !== null && publishedAt > asOf + futureTolerance) {
      freshnessStatus = 'check_failed';
      freshnessDetail = 'Publication timestamp is implausibly in the future.';
    } else if (publishedAt !== null && strictMaxAge !== null && asOf - publishedAt > strictMaxAge * DAY_MS) {
      freshnessStatus = 'incomplete';
      freshnessDetail = `Publication date exceeds the ${strictMaxAge}-day freshness policy.`;
    } else if (retrievedAt > asOf + futureTolerance) {
      freshnessStatus = 'check_failed';
      freshnessDetail = 'Retrieval timestamp is implausibly in the future.';
    } else if (asOf - retrievedAt > strictMaxRetrievalAge * DAY_MS) {
      freshnessStatus = 'incomplete';
      freshnessDetail = `Source capture is older than the ${strictMaxRetrievalAge}-day retrieval policy for the linked claim type(s).`;
    }
    freshnessStatuses.push(freshnessStatus);
    freshnessBySource.set(source.id, {
      freshnessStatus,
      freshnessDetail,
      maxPublicationAgeDays: strictMaxAge,
      maxRetrievalAgeDays: strictMaxRetrievalAge
    });

    if (relevantMaterialClaims.length) {
      const tiers = relevantMaterialClaims.map((claim) => {
        const requiredTier = policyValue.authority.minimumTierByClaimType[claim.type] ?? policyValue.authority.minimumTierByClaimType.default;
        if (!authority || authority.registryStatus !== 'current') return { claimId: claim.id, status: policyValue.authority.requireRegistryMatchForMaterialClaims ? 'needs_human_review' : 'complete', requiredTier, actualTier: authority?.authorityTier ?? 'unknown', registryStatus: authority?.registryStatus ?? 'unregistered' };
        const permittedByScope = authority.permittedClaimTypes?.includes(claim.type) === true;
        const tierCompliant = TIER_RANK[authority.authorityTier] <= TIER_RANK[requiredTier];
        const compliant = permittedByScope && tierCompliant;
        return {
          claimId: claim.id,
          status: compliant ? 'complete' : 'check_failed',
          requiredTier,
          actualTier: authority.authorityTier,
          registryStatus: authority.registryStatus,
          permittedByScope,
          scope: authority.scope
        };
      });
      for (const tier of tiers) authorityStatuses.push(tier.status);
    }
  }
  for (const sourceAssessment of sourceAssessments) {
    Object.assign(sourceAssessment, freshnessBySource.get(sourceAssessment.sourceId) ?? {});
  }
  const freshnessExceptions = sourceAssessments
    .filter((source) => source.freshnessStatus && source.freshnessStatus !== 'complete')
    .map((source) => `${source.sourceId}: ${source.freshnessStatus} (${source.freshnessDetail})`);
  pushCheck(checks, 'source_freshness', pickStatus(freshnessStatuses), freshnessStatuses.includes('check_failed')
    ? `At least one source has an implausible timestamp. ${freshnessExceptions.join(' ')}`
    : freshnessStatuses.includes('incomplete')
      ? `At least one source falls outside its claim-type publication or retrieval window. ${freshnessExceptions.join(' ')}`
      : freshnessStatuses.includes('needs_human_review')
        ? `At least one material source has no publication date; a reviewer must assess its time relevance. ${freshnessExceptions.join(' ')}`
        : 'Source publication and retrieval dates meet the configured claim-type freshness policy.');
  pushCheck(checks, 'source_authority_policy', pickStatus(authorityStatuses), authorityStatuses.includes('check_failed')
    ? 'At least one material source is outside its registry-permitted claim types or does not meet the configured minimum authority tier.'
    : authorityStatuses.includes('needs_human_review')
      ? 'At least one material source is not mapped to a current, reviewed publisher registry entry.'
      : 'All material sources meet the configured, claim-type-scoped publisher authority policy.');

  const provenanceStatuses = [];
  const corroborationStatuses = [];
  for (const claim of normalized.claims) {
    const links = validLinks.filter((link) => link.claimId === claim.id);
    const supportLinks = links.filter((link) => link.relationship === 'supports');
    const contradictionLinks = links.filter((link) => link.relationship === 'contradicts');
    const relevant = materialClaimIds.has(claim.id);
    let provenanceStatus = 'complete';
    let provenanceDetail = 'Claim has a source-attributed relationship.';
    if (!links.length && relevant) {
      provenanceStatus = 'incomplete';
      provenanceDetail = 'Material or required claim has no source link.';
    } else if (!supportLinks.length && relevant) {
      provenanceStatus = 'incomplete';
      provenanceDetail = 'Material or required claim has no source explicitly marked as supporting it.';
    } else if (supportLinks.some((link) => !link.rationale.trim())) {
      provenanceStatus = 'incomplete';
      provenanceDetail = 'At least one supporting source link has no rationale.';
    } else if (contradictionLinks.length) {
      provenanceStatus = 'needs_human_review';
      provenanceDetail = `${contradictionLinks.length} contradictory source relationship(s) require adjudication.`;
    }
    provenanceStatuses.push(provenanceStatus);

    const candidateSources = supportLinks
      .map((link) => sourcesById.get(link.sourceId))
      .filter((source) => source && sourceStatus.get(source.id) === 'complete' && sourceAuthority.get(source.id)?.registryStatus === 'current');
    const distinctGroups = new Set(candidateSources.map((source) => sourceAuthority.get(source.id).publisherGroup));
    const distinctHashes = new Set(candidateSources.map((source) => source.contentHash));
    const possibleDerivativePairs = [];
    const possibleCommonOriginPairs = [];
    for (let leftIndex = 0; leftIndex < candidateSources.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < candidateSources.length; rightIndex += 1) {
        const leftSource = candidateSources[leftIndex];
        const rightSource = candidateSources[rightIndex];
        const leftAuthority = sourceAuthority.get(leftSource.id);
        const rightAuthority = sourceAuthority.get(rightSource.id);
        const leftOrigins = sourceAttribution.get(leftSource.id) ?? [];
        const rightOrigins = sourceAttribution.get(rightSource.id) ?? [];
        if (leftAuthority?.publisherGroup !== rightAuthority?.publisherGroup) {
          for (const leftSignal of leftOrigins) {
            for (const rightSignal of rightOrigins) {
              if (leftSignal.label === rightSignal.label) {
                possibleCommonOriginPairs.push({
                  sourceIds: [leftSource.id, rightSource.id],
                  publisherGroups: [leftAuthority.publisherGroup, rightAuthority.publisherGroup],
                  attributionLabel: leftSignal.label,
                  signalTypes: [...new Set([leftSignal.type, rightSignal.type])],
                  interpretation: 'matching_explicit_attribution_requires_human_origin_review'
                });
              }
            }
          }
        }
        const leftShingles = sourceShingles.get(leftSource.id);
        const rightShingles = sourceShingles.get(rightSource.id);
        if (!leftShingles || !rightShingles
          || leftShingles.size < policyValue.corroboration.nearDuplicateMinShingles
          || rightShingles.size < policyValue.corroboration.nearDuplicateMinShingles) continue;
        const similarity = overlapCoefficient(leftShingles, rightShingles);
        if (similarity >= policyValue.corroboration.nearDuplicateSimilarityThreshold) {
          possibleDerivativePairs.push({
            sourceIds: [leftSource.id, rightSource.id],
            publisherGroups: [sourceAuthority.get(leftSource.id).publisherGroup, sourceAuthority.get(rightSource.id).publisherGroup],
            similarity: Number(similarity.toFixed(4)),
            interpretation: 'possible_shared_or_derivative_text_requires_human_review'
          });
        }
      }
    }
    const uniqueCommonOriginPairs = [...new Map(possibleCommonOriginPairs.map((pair) => [
      [...pair.sourceIds].sort().join('\u0000') + `\u0000${pair.attributionLabel}`,
      pair
    ])).values()];
    let corroborationStatus = 'complete';
    let corroborationDetail = 'This claim is not material or required; no corroboration threshold is applied.';
    if (relevant) {
      const requiredGroups = policyValue.corroboration.minIndependentPublisherGroupsForMaterialClaims;
      corroborationStatus = 'needs_human_review';
      corroborationDetail = `Found ${distinctGroups.size} registered publisher group(s); ${requiredGroups} are required as corroboration candidates. Distinct groups do not prove independent reporting.`;
      if (distinctGroups.size >= requiredGroups && distinctHashes.size >= requiredGroups) {
        corroborationDetail = `${distinctGroups.size} distinct registered publisher groups and content hashes are candidates; a human must still attest that the sources are independent and not merely repeating one another.`;
      }
      if (possibleDerivativePairs.length) {
        corroborationDetail += ` ${possibleDerivativePairs.length} possible copied/shared-text pair(s) were flagged; similarity is a review signal, not proof of copying.`;
      }
      if (uniqueCommonOriginPairs.length) {
        corroborationDetail += ` ${uniqueCommonOriginPairs.length} pair(s) repeat the same explicit attribution label across publisher groups and require origin review.`;
      }
    }
    corroborationStatuses.push(corroborationStatus);
    claimAssessments.push({
      claimId: claim.id,
      importance: claim.importance,
      required: requiredClaimIds.includes(claim.id),
      sourceIds: [...new Set(links.map((link) => link.sourceId))],
      supportingSourceIds: [...new Set(supportLinks.map((link) => link.sourceId))],
      contradictingSourceIds: [...new Set(contradictionLinks.map((link) => link.sourceId))],
      publisherGroups: [...distinctGroups],
      possibleDerivativePairs,
      possibleCommonOriginPairs: uniqueCommonOriginPairs,
      conflictAssessment: contradictionLinks.length ? {
        status: 'review_required',
        contradictingSourceIds: [...new Set(contradictionLinks.map((link) => link.sourceId))],
        rationale: 'Conflicting source relationships are explicitly marked and require packet-bound human adjudication.'
      } : { status: 'none', contradictingSourceIds: [], rationale: 'No contradictory source relationship was recorded.' },
      regulatoryCurrentStatus: claim.type === 'regulatory_current'
        ? { status: 'review_required', reviewerId: null, reviewDigest: null, rationale: 'A reviewer must check the issuing authority’s current consolidated instrument and intervening amendments, repeals or superseding notices.' }
        : { status: 'not_applicable', reviewerId: null, reviewDigest: null, rationale: 'This claim is not marked as a current-regulatory-status claim.' },
      provenanceStatus,
      provenanceDetail,
      corroborationStatus,
      corroborationDetail
    });
  }
  pushCheck(checks, 'claim_level_provenance', pickStatus(provenanceStatuses), provenanceStatuses.includes('incomplete')
    ? 'At least one material claim lacks an explicit supporting source relationship and rationale.'
    : provenanceStatuses.includes('needs_human_review')
      ? 'Contradictory source links require claim-level human adjudication.'
      : 'Material claims have explicit, resolvable supporting source relationships.');
  const claimContradictions = claimAssessments.filter((claim) => claim.contradictingSourceIds.length);
  pushCheck(checks, 'claim_contradictions', claimContradictions.length ? 'needs_human_review' : 'complete', claimContradictions.length
    ? `${claimContradictions.length} claim(s) have contradictory source relationships that require human adjudication.`
    : 'No claim-level contradiction links were recorded.');
  pushCheck(checks, 'claim_conflict_adjudication', claimContradictions.length ? 'needs_human_review' : 'complete', claimContradictions.length
    ? 'Conflicting datasets or passages must be explicitly compared by claim, period, unit, methodology and scope. A generic acceptance is not conflict resolution.'
    : 'No contradictory source relationships were recorded for adjudication.');
  const claimsWithPossibleDerivatives = claimAssessments.filter((claim) => claim.possibleDerivativePairs.length);
  const possibleDerivativePairCount = claimsWithPossibleDerivatives.reduce((sum, claim) => sum + claim.possibleDerivativePairs.length, 0);
  pushCheck(checks, 'source_derivation_similarity', possibleDerivativePairCount ? 'needs_human_review' : 'complete', possibleDerivativePairCount
    ? `${possibleDerivativePairCount} source pair(s) have high captured-text overlap. This deterministic heuristic flags possible copying, shared releases or derivative reporting; it does not establish plagiarism or common ownership.`
    : 'No supporting source pairs exceeded the configured captured-text similarity threshold.');
  const claimsWithCommonOrigins = claimAssessments.filter((claim) => claim.possibleCommonOriginPairs.length);
  const commonOriginPairCount = claimsWithCommonOrigins.reduce((sum, claim) => sum + claim.possibleCommonOriginPairs.length, 0);
  pushCheck(checks, 'source_attribution_reuse', commonOriginPairCount ? 'needs_human_review' : 'complete', commonOriginPairCount
    ? `${commonOriginPairCount} pair(s) repeat an explicit attribution label across distinct publisher groups. This may indicate syndication, press-release republication or a shared source; it requires reviewer assessment and is not proof of common origin.`
    : 'No repeated explicit attribution labels were detected across distinct publisher groups. This does not rule out unattributed or paraphrased derivatives.');
  pushCheck(checks, 'cross_source_corroboration', pickStatus(corroborationStatuses), corroborationStatuses.includes('needs_human_review')
    ? 'Corroboration candidates are reported per claim; distinct domains or publisher groups are not treated as proof of independence.'
    : 'No corroboration threshold applies to the current claims.');

  const validReviewRecords = [];
  const invalidReviews = [];
  for (const supplied of reviewRecords) {
    try {
      const record = supplied?.record ?? supplied;
      const committed = commitRecord(record, validateEvidenceReviewRecord);
      if (Date.parse(committed.record.reviewedAt) > asOf + policyValue.freshness.futureSkewMinutes * 60_000) throw new TypeError('review timestamp is implausibly in the future');
      if (supplied?.digest && supplied.digest !== committed.digest) throw new TypeError('review digest does not match its canonical record');
      if (committed.record.packetDigest !== expectedPacketDigest) throw new TypeError('review is bound to a different evidence packet');
      validReviewRecords.push({ record: committed.record, digest: committed.digest });
    } catch (error) {
      invalidReviews.push(error.message);
    }
  }
  if (invalidReviews.length) pushCheck(checks, 'review_record_integrity', 'check_failed', invalidReviews.join('; '));
  else pushCheck(checks, 'review_record_integrity', 'complete', 'All supplied human review records are committed and bound to this exact packet.');

  const latestReview = validReviewRecords
    .map((item) => item.record)
    .sort((a, b) => Date.parse(b.reviewedAt) - Date.parse(a.reviewedAt))[0] ?? null;
  let reviewStatus = latestReview?.decision ?? 'pending';
  const materialClaims = normalized.claims.filter((claim) => materialClaimIds.has(claim.id));
  const contradictionClaimIds = new Set(claimContradictions.map((claim) => claim.claimId));
  const claimsRequiringHumanReview = normalized.claims.filter((claim) => materialClaimIds.has(claim.id) || contradictionClaimIds.has(claim.id));
  const regulatoryCurrentClaims = normalized.claims.filter((claim) => materialClaimIds.has(claim.id) && claim.type === 'regulatory_current');
  const requiredScopePairs = [...new Map(validLinks
    .filter((link) => materialClaimIds.has(link.claimId) && ['supports', 'contradicts'].includes(link.relationship))
    .map((link) => [`${link.claimId}\u0000${link.sourceId}`, { claimId: link.claimId, sourceId: link.sourceId }])).values()];
  const scopeAssessmentsByPair = new Map((latestReview?.scopeAssessments ?? []).map((assessment) => [`${assessment.claimId}\u0000${assessment.sourceId}`, assessment]));
  const missingScopeAssessments = requiredScopePairs.filter((pair) => !scopeAssessmentsByPair.has(`${pair.claimId}\u0000${pair.sourceId}`));
  const outOfScopeAssessments = requiredScopePairs.filter((pair) => scopeAssessmentsByPair.get(`${pair.claimId}\u0000${pair.sourceId}`)?.inScope === false);
  const scopeAssessmentMismatch = (latestReview?.scopeAssessments ?? []).filter((assessment) => !requiredScopePairs.some((pair) => pair.claimId === assessment.claimId && pair.sourceId === assessment.sourceId));
  if (requiredScopePairs.length) {
    pushCheck(checks, 'publisher_scope_review', outOfScopeAssessments.length ? 'check_failed' : missingScopeAssessments.length || scopeAssessmentMismatch.length ? 'needs_human_review' : 'complete',
      outOfScopeAssessments.length
        ? `${outOfScopeAssessments.length} material claim/source pair(s) were explicitly declared outside the publisher's registered scope.`
        : missingScopeAssessments.length
          ? `${missingScopeAssessments.length} material claim/source pair(s) still require packet-bound human scope assessment.`
          : scopeAssessmentMismatch.length
            ? `${scopeAssessmentMismatch.length} scope assessment(s) do not match a supporting or contradicting material claim/source pair.`
            : 'A packet-bound human reviewer assessed every supporting/contradicting material claim/source pair against the registered publisher scope.');
  } else {
    pushCheck(checks, 'publisher_scope_review', 'complete', 'No supporting or contradicting material claim/source pairs require publisher-scope review.');
  }
  if (policyValue.review.requireHumanReviewForMaterialClaims && claimsRequiringHumanReview.length) {
    if (!latestReview) {
      pushCheck(checks, 'human_claim_review', 'needs_human_review', 'No packet-bound human review is recorded for material or contradictory claims.');
      reviewStatus = 'pending';
    } else {
      const findings = new Map(latestReview.claimFindings.map((finding) => [finding.claimId, finding]));
      const missingFindings = claimsRequiringHumanReview.filter((claim) => !findings.has(claim.id));
      const adverseFindings = claimsRequiringHumanReview.filter((claim) => findings.has(claim.id) && findings.get(claim.id).outcome !== 'supported');
      const missingConflictRationale = claimContradictions.filter((claim) => {
        const finding = findings.get(claim.claimId);
        return finding?.outcome === 'supported' && !rationaleAddressesConflict(finding.rationale);
      });
      const missingRegulatoryStatusFindings = regulatoryCurrentClaims.filter((claim) => {
        const finding = findings.get(claim.id);
        return finding?.outcome !== 'supported' || !rationaleAddressesRegulatoryCurrentStatus(finding?.rationale);
      });
      const independence = new Map(latestReview.independenceAssessments.map((assessment) => [assessment.claimId, assessment]));
      const missingIndependence = materialClaims.filter((claim) => {
        if (!policyValue.corroboration.requireHumanIndependenceAssessment) return false;
        const assessment = independence.get(claim.id);
        if (!assessment || !assessment.independent) return true;
        const expectedSourceIds = [...new Set(validLinks.filter((link) => link.claimId === claim.id && link.relationship === 'supports').map((link) => link.sourceId))];
        const validSources = assessment.sourceIds.filter((id) => sourcesById.has(id) && sourceAuthority.get(id)?.registryStatus === 'current' && validLinks.some((link) => link.claimId === claim.id && link.sourceId === id && link.relationship === 'supports'));
        const groups = new Set(validSources.map((id) => sourceAuthority.get(id)?.publisherGroup).filter(Boolean));
        const hasCommonOriginSignal = claimAssessments.find((item) => item.claimId === claim.id)?.possibleCommonOriginPairs.length > 0;
        const originRationaleMissing = hasCommonOriginSignal && !rationaleAddressesAttribution(assessment?.rationale);
        return !sameStringSet(validSources, expectedSourceIds)
          || validSources.length < policyValue.corroboration.minIndependentPublisherGroupsForMaterialClaims
          || groups.size < policyValue.corroboration.minIndependentPublisherGroupsForMaterialClaims
          || originRationaleMissing;
      });
      if (latestReview.decision !== 'accept') {
        const status = latestReview.decision === 'reject' ? 'incomplete' : 'needs_human_review';
        pushCheck(checks, 'human_claim_review', status, `Latest human review decision is ${latestReview.decision}.`);
      } else if (missingFindings.length || adverseFindings.length || missingIndependence.length || missingConflictRationale.length || missingRegulatoryStatusFindings.length || missingScopeAssessments.length || outOfScopeAssessments.length || scopeAssessmentMismatch.length) {
        pushCheck(checks, 'human_claim_review', outOfScopeAssessments.length ? 'check_failed' : 'needs_human_review', `Review is incomplete: ${missingFindings.length} missing claim finding(s), ${adverseFindings.length} non-supporting finding(s), ${missingIndependence.length} missing or insufficient independence attestation(s), ${missingConflictRationale.length} conflict finding(s) without a period/unit/methodology/scope comparison rationale, ${missingRegulatoryStatusFindings.length} current-regulatory-status finding(s) without an in-force and amendment/repeal check, ${missingScopeAssessments.length} missing publisher-scope assessment(s), ${outOfScopeAssessments.length} out-of-scope source(s), ${scopeAssessmentMismatch.length} mismatched scope assessment(s).`);
        reviewStatus = 'pending';
      } else {
        pushCheck(checks, 'human_claim_review', 'complete', `Reviewer ${latestReview.reviewer.id} accepted all material/contradictory claim findings, assessed publisher scope and attested to source independence for this packet.`);
        reviewStatus = 'accepted';
      }
    }
  } else {
    pushCheck(checks, 'human_claim_review', 'complete', 'No material claims require a human review under the configured policy.');
    reviewStatus = 'not_required';
  }

  if (regulatoryCurrentClaims.length) {
    const findings = new Map((latestReview?.claimFindings ?? []).map((finding) => [finding.claimId, finding]));
    const missingStatusReview = regulatoryCurrentClaims.filter((claim) => {
      const finding = findings.get(claim.id);
      return latestReview?.decision !== 'accept'
        || finding?.outcome !== 'supported'
        || !rationaleAddressesRegulatoryCurrentStatus(finding?.rationale);
    });
    pushCheck(checks, 'regulatory_current_status', missingStatusReview.length ? 'needs_human_review' : 'complete', missingStatusReview.length
      ? `${missingStatusReview.length} current-regulatory claim(s) still require a packet-bound reviewer to confirm current in-force status and check relevant amendments, repeals or superseding instruments. Publication age alone is not a legal-status test.`
      : 'A packet-bound reviewer declared that each current-regulatory claim was checked for in-force status and relevant amendments, repeals or superseding instruments. This declaration is not authenticated legal advice.');
    if (!missingStatusReview.length) {
      const reviewDigest = validReviewRecords.find((item) => item.record === latestReview)?.digest ?? null;
      for (const claim of claimAssessments.filter((item) => regulatoryCurrentClaims.some((currentClaim) => currentClaim.id === item.claimId))) {
        const finding = findings.get(claim.claimId);
        claim.regulatoryCurrentStatus = {
          status: 'attested',
          reviewerId: latestReview.reviewer.id,
          reviewDigest,
          rationale: finding.rationale
        };
      }
    }
  } else {
    pushCheck(checks, 'regulatory_current_status', 'complete', 'No claims are marked as requiring current-regulatory-status review.');
  }

  // A packet-bound accepted review can adjudicate contradictions, but it
  // cannot fill a missing supporting source relationship. The record must
  // explicitly find each contradictory claim supported and explain why.
  if (latestReview?.decision === 'accept' && reviewStatus === 'accepted' && claimContradictions.length) {
    const findingsByClaim = new Map(latestReview.claimFindings.map((finding) => [finding.claimId, finding]));
    const adjudicated = claimContradictions.every((claim) => {
      const finding = findingsByClaim.get(claim.claimId);
      return finding?.outcome === 'supported' && rationaleAddressesConflict(finding.rationale);
    });
    if (adjudicated) {
      for (const assessment of claimAssessments) {
        if (assessment.contradictingSourceIds.length) {
          const finding = findingsByClaim.get(assessment.claimId);
          if (assessment.provenanceStatus === 'needs_human_review') {
            assessment.provenanceStatus = 'complete';
            assessment.provenanceDetail = 'Contradictory source relationships were explicitly adjudicated by the packet-bound human reviewer.';
          }
          assessment.conflictAssessment = {
            status: 'adjudicated',
            contradictingSourceIds: assessment.contradictingSourceIds,
            reviewerId: latestReview.reviewer.id,
            reviewDigest: validReviewRecords.find((item) => item.record === latestReview)?.digest ?? null,
            rationale: finding.rationale
          };
        }
      }
      const provenanceCheck = checks.find((check) => check.type === 'claim_level_provenance');
      if (provenanceCheck?.status === 'needs_human_review') {
        provenanceCheck.status = pickStatus(claimAssessments.map((claim) => claim.provenanceStatus));
        provenanceCheck.detail = provenanceCheck.status === 'complete'
          ? 'Material claims have resolvable supporting sources and recorded human adjudication for contradictions.'
          : 'At least one claim still lacks a required supporting source relationship.';
      }
      const contradictionCheck = checks.find((check) => check.type === 'claim_contradictions');
      if (contradictionCheck) {
        contradictionCheck.status = 'complete';
        contradictionCheck.detail = 'All recorded claim contradictions were explicitly adjudicated by the packet-bound human reviewer.';
      }
      const conflictCheck = checks.find((check) => check.type === 'claim_conflict_adjudication');
      if (conflictCheck) {
        conflictCheck.status = 'complete';
        conflictCheck.detail = 'Each declared contradiction has a packet-bound supported finding and a substantive reviewer rationale; this is an attestation, not automated resolution of the underlying facts.';
      }
    }
  }

  // A second-source count is only a candidate signal. It becomes complete
  // only after an accepted, packet-bound human reviewer attests independence
  // for the exact supporting source records used by each material claim.
  const corroborationCheck = checks.find((check) => check.type === 'cross_source_corroboration');
  if (corroborationCheck && latestReview?.decision === 'accept' && materialClaims.length) {
    const independenceByClaim = new Map(latestReview.independenceAssessments.map((assessment) => [assessment.claimId, assessment]));
    const allAttested = materialClaims.every((claim) => {
      const assessment = independenceByClaim.get(claim.id);
      if (!assessment?.independent) return false;
      const expectedSourceIds = [...new Set(validLinks.filter((link) => link.claimId === claim.id && link.relationship === 'supports').map((link) => link.sourceId))];
      const validSourceIds = assessment.sourceIds.filter((id) => sourcesById.has(id)
        && sourceAuthority.get(id)?.registryStatus === 'current'
        && validLinks.some((link) => link.claimId === claim.id && link.sourceId === id && link.relationship === 'supports'));
      const publisherGroups = new Set(validSourceIds.map((id) => sourceAuthority.get(id)?.publisherGroup).filter(Boolean));
      const hasCommonOriginSignal = claimAssessments.find((item) => item.claimId === claim.id)?.possibleCommonOriginPairs.length > 0;
      const originRationaleMissing = hasCommonOriginSignal && !rationaleAddressesAttribution(assessment.rationale);
      return sameStringSet(validSourceIds, expectedSourceIds)
        && validSourceIds.length >= policyValue.corroboration.minIndependentPublisherGroupsForMaterialClaims
        && publisherGroups.size >= policyValue.corroboration.minIndependentPublisherGroupsForMaterialClaims
        && !originRationaleMissing;
    });
    if (allAttested) {
      corroborationCheck.status = 'complete';
      corroborationCheck.detail = 'A packet-bound human reviewer attested that the registered supporting sources are independent. This remains an attestation, not automated proof.';
      const attributionCheck = checks.find((check) => check.type === 'source_attribution_reuse');
      if (attributionCheck?.status === 'needs_human_review' && allAttested) {
        attributionCheck.status = 'complete';
        attributionCheck.detail = 'A packet-bound reviewer explicitly considered the repeated attribution labels and attested to the independence of the exact supporting source records. This remains a human declaration.';
        for (const assessment of claimAssessments) {
          if (assessment.possibleCommonOriginPairs.length) {
            assessment.attributionReview = {
              status: 'adjudicated',
              reviewerId: latestReview.reviewer.id,
              reviewDigest: validReviewRecords.find((item) => item.record === latestReview)?.digest ?? null,
              rationale: independenceByClaim.get(assessment.claimId)?.rationale ?? ''
            };
          }
        }
      }
      const similarityCheck = checks.find((check) => check.type === 'source_derivation_similarity');
      if (similarityCheck?.status === 'needs_human_review') {
        const reviewedEveryPair = claimsWithPossibleDerivatives.every((claim) => {
          const assessment = independenceByClaim.get(claim.claimId);
          return assessment?.independent === true && claim.possibleDerivativePairs.every((pair) => pair.sourceIds.every((id) => assessment.sourceIds.includes(id)));
        });
        if (reviewedEveryPair) {
          similarityCheck.status = 'complete';
          similarityCheck.detail = 'A packet-bound human reviewer explicitly considered all high-overlap source pairs and attested that the exact supporting records are independent. Similarity remains a heuristic signal, not an automated originality finding.';
        }
      }
      for (const assessment of claimAssessments) {
        if (materialClaimIds.has(assessment.claimId)) {
          assessment.corroborationStatus = 'complete';
          assessment.corroborationDetail = 'Independence was explicitly attested by the packet-bound human reviewer.';
        }
      }
    }
  }

  const status = pickStatus(checks.map((check) => check.status));
  return {
    policyVersion: policyValue.version,
    packetDigest: expectedPacketDigest,
    evaluatedAt: new Date(asOf).toISOString(),
    status,
    checks,
    sourceAssessments,
    claimAssessments,
    reviewStatus,
    reviewDigest: latestReview ? validReviewRecords.find((item) => item.record === latestReview)?.digest ?? null : null,
    limitation: 'This policy evaluates source metadata, capture integrity, configured publisher classifications, dates, claim provenance, corroboration candidates and human declarations. It does not establish factual truth, source authenticity, legal authority, authorship or actual independence. Reviewer identity is a declared identity unless authenticated by an external identity system.'
  };
}
