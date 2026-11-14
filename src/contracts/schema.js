import { createHash } from 'node:crypto';

export const SCHEMA_VERSIONS = Object.freeze({
  jobSpec: 'workrelay.jobspec.v1',
  acceptanceCriteria: 'workrelay.acceptance-criteria.v1',
  evidenceManifest: 'workrelay.evidence-manifest.v1',
  evidenceReview: 'workrelay.evidence-review.v2',
  publisherAuthorityRegistry: 'workrelay.publisher-authority-registry.v2',
  providerQuote: 'workrelay.provider-quote.v1',
  settlementTerms: 'workrelay.settlement-terms.v1',
  eventRecord: 'workrelay.event-record.v1'
});

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(path, message) {
  throw new TypeError(`${path}: ${message}`);
}

function requireRecord(value, path) {
  if (!isRecord(value)) fail(path, 'must be an object');
}

function requireKeys(value, required, allowed, path) {
  requireRecord(value, path);
  for (const key of required) if (!own(value, key)) fail(`${path}.${key}`, 'is required');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, 'is not an allowed field');
}

function stringField(value, path, { nonEmpty = true } = {}) {
  if (typeof value !== 'string') fail(path, 'must be a string');
  const normalized = value.normalize('NFC');
  if (nonEmpty && !normalized.trim()) fail(path, 'must not be empty');
  return normalized;
}

function integerField(value, path, { min = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < min) fail(path, `must be a safe integer >= ${min}`);
  return value;
}

function amountField(value, path) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) fail(path, 'must be a non-negative decimal atomic amount string');
  return value;
}

function isoDateField(value, path) {
  const text = stringField(value, path);
  if (Number.isNaN(Date.parse(text)) || !text.endsWith('Z')) fail(path, 'must be an ISO timestamp ending in Z');
  return text;
}

function identity(value, path) {
  requireKeys(value, ['kind', 'id'], ['kind', 'id'], path);
  return { kind: stringField(value.kind, `${path}.kind`), id: stringField(value.id, `${path}.id`) };
}

function hashField(value, path) {
  const text = stringField(value, path);
  if (!/^[a-f0-9]{64}$/.test(text)) fail(path, 'must be a lowercase SHA-256 hex digest');
  return text;
}

function list(value, path, itemValidator) {
  if (!Array.isArray(value)) fail(path, 'must be an array');
  return value.map((item, index) => itemValidator(item, `${path}[${index}]`));
}

function acceptanceCriteria(value, path = 'acceptanceCriteria') {
  return list(value, path, (item, itemPath) => {
    requireKeys(item, ['id', 'type', 'description', 'required'], ['id', 'type', 'description', 'required'], itemPath);
    if (typeof item.required !== 'boolean') fail(`${itemPath}.required`, 'must be a boolean');
    const type = stringField(item.type, `${itemPath}.type`);
    if (!['source_coverage', 'freshness', 'calculation', 'schema', 'human_review', 'custom'].includes(type)) fail(`${itemPath}.type`, 'has an unsupported criterion type');
    return { id: stringField(item.id, `${itemPath}.id`), type, description: stringField(item.description, `${itemPath}.description`), required: item.required };
  });
}

function verifier(value, path) {
  requireKeys(value, ['name', 'version'], ['name', 'version'], path);
  return { name: stringField(value.name, `${path}.name`), version: stringField(value.version, `${path}.version`) };
}

function workPackage(value, path) {
  requireKeys(value, ['id', 'brief', 'dependsOn', 'handoffInputHashes'], ['id', 'brief', 'dependsOn', 'handoffInputHashes'], path);
  return {
    id: stringField(value.id, `${path}.id`),
    brief: stringField(value.brief, `${path}.brief`),
    dependsOn: list(value.dependsOn, `${path}.dependsOn`, (item, itemPath) => stringField(item, itemPath)),
    handoffInputHashes: list(value.handoffInputHashes, `${path}.handoffInputHashes`, (item, itemPath) => hashField(item, itemPath))
  };
}

function quoteTerms(value, path) {
  requireKeys(value, ['atomicAmount', 'currency', 'asset', 'deadline', 'revisionAllowance'], ['atomicAmount', 'currency', 'asset', 'deadline', 'revisionAllowance'], path);
  return {
    atomicAmount: amountField(value.atomicAmount, `${path}.atomicAmount`),
    currency: stringField(value.currency, `${path}.currency`),
    asset: stringField(value.asset, `${path}.asset`),
    deadline: isoDateField(value.deadline, `${path}.deadline`),
    revisionAllowance: integerField(value.revisionAllowance, `${path}.revisionAllowance`)
  };
}

export function validateJobSpec(value) {
  requireKeys(value, ['schemaVersion', 'jobId', 'buyer', 'brief', 'scope', 'exclusions', 'geography', 'timeWindow', 'provider', 'workPackages', 'quote', 'acceptance', 'dispute', 'privacy'], ['schemaVersion', 'jobId', 'buyer', 'brief', 'scope', 'exclusions', 'geography', 'timeWindow', 'provider', 'workPackages', 'quote', 'acceptance', 'dispute', 'privacy'], 'jobSpec');
  if (value.schemaVersion !== SCHEMA_VERSIONS.jobSpec) fail('jobSpec.schemaVersion', `must equal ${SCHEMA_VERSIONS.jobSpec}`);
  requireKeys(value.timeWindow, ['start', 'end'], ['start', 'end'], 'jobSpec.timeWindow');
  requireKeys(value.acceptance, ['criteria', 'verifier'], ['criteria', 'verifier'], 'jobSpec.acceptance');
  requireKeys(value.dispute, ['route', 'resolver', 'policy'], ['route', 'resolver', 'policy'], 'jobSpec.dispute');
  requireKeys(value.privacy, ['retentionDays', 'artifactAvailability'], ['retentionDays', 'artifactAvailability'], 'jobSpec.privacy');
  const result = {
    schemaVersion: value.schemaVersion,
    jobId: stringField(value.jobId, 'jobSpec.jobId'),
    buyer: identity(value.buyer, 'jobSpec.buyer'),
    brief: stringField(value.brief, 'jobSpec.brief'),
    scope: stringField(value.scope, 'jobSpec.scope'),
    exclusions: list(value.exclusions, 'jobSpec.exclusions', (item, path) => stringField(item, path)),
    geography: stringField(value.geography, 'jobSpec.geography'),
    timeWindow: { start: isoDateField(value.timeWindow.start, 'jobSpec.timeWindow.start'), end: isoDateField(value.timeWindow.end, 'jobSpec.timeWindow.end') },
    provider: identity(value.provider, 'jobSpec.provider'),
    workPackages: list(value.workPackages, 'jobSpec.workPackages', workPackage),
    quote: quoteTerms(value.quote, 'jobSpec.quote'),
    acceptance: { criteria: acceptanceCriteria(value.acceptance.criteria, 'jobSpec.acceptance.criteria'), verifier: verifier(value.acceptance.verifier, 'jobSpec.acceptance.verifier') },
    dispute: { route: stringField(value.dispute.route, 'jobSpec.dispute.route'), resolver: identity(value.dispute.resolver, 'jobSpec.dispute.resolver'), policy: stringField(value.dispute.policy, 'jobSpec.dispute.policy') },
    privacy: { retentionDays: integerField(value.privacy.retentionDays, 'jobSpec.privacy.retentionDays'), artifactAvailability: stringField(value.privacy.artifactAvailability, 'jobSpec.privacy.artifactAvailability') }
  };
  if (Date.parse(result.timeWindow.end) < Date.parse(result.timeWindow.start)) fail('jobSpec.timeWindow', 'end must not precede start');
  return result;
}

export function validateAcceptanceCriteria(value) {
  requireKeys(value, ['schemaVersion', 'criteria'], ['schemaVersion', 'criteria'], 'acceptanceCriteria');
  if (value.schemaVersion !== SCHEMA_VERSIONS.acceptanceCriteria) fail('acceptanceCriteria.schemaVersion', `must equal ${SCHEMA_VERSIONS.acceptanceCriteria}`);
  return { schemaVersion: value.schemaVersion, criteria: acceptanceCriteria(value.criteria, 'acceptanceCriteria.criteria') };
}

export function validateEvidenceManifest(value) {
  requireKeys(value, ['schemaVersion', 'jobId', 'packetId', 'claims', 'sources', 'links', 'method', 'limitations', 'reviews', 'rawArtifactHash'], ['schemaVersion', 'jobId', 'packetId', 'claims', 'sources', 'links', 'method', 'limitations', 'reviews', 'rawArtifactHash'], 'evidenceManifest');
  if (value.schemaVersion !== SCHEMA_VERSIONS.evidenceManifest) fail('evidenceManifest.schemaVersion', `must equal ${SCHEMA_VERSIONS.evidenceManifest}`);
  const claims = list(value.claims, 'evidenceManifest.claims', (item, path) => {
    requireKeys(item, ['id', 'claim', 'type', 'importance', 'period', 'confidence'], ['id', 'claim', 'type', 'importance', 'period', 'confidence'], path);
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) fail(`${path}.confidence`, 'must be a number from 0 to 1');
    return { id: stringField(item.id, `${path}.id`), claim: stringField(item.claim, `${path}.claim`), type: stringField(item.type, `${path}.type`), importance: stringField(item.importance, `${path}.importance`), period: stringField(item.period, `${path}.period`), confidence: Object.is(item.confidence, -0) ? 0 : item.confidence };
  });
  const sources = list(value.sources, 'evidenceManifest.sources', (item, path) => {
    requireKeys(item, ['id', 'url', 'publisher', 'publishedAt', 'retrievedAt', 'accessStatus', 'contentHash', 'excerpt'], ['id', 'url', 'publisher', 'publishedAt', 'retrievedAt', 'accessStatus', 'contentHash', 'excerpt'], path);
    return { id: stringField(item.id, `${path}.id`), url: stringField(item.url, `${path}.url`), publisher: stringField(item.publisher, `${path}.publisher`), publishedAt: item.publishedAt === null ? null : isoDateField(item.publishedAt, `${path}.publishedAt`), retrievedAt: isoDateField(item.retrievedAt, `${path}.retrievedAt`), accessStatus: stringField(item.accessStatus, `${path}.accessStatus`), contentHash: hashField(item.contentHash, `${path}.contentHash`), excerpt: stringField(item.excerpt, `${path}.excerpt`, { nonEmpty: false }) };
  });
  const links = list(value.links, 'evidenceManifest.links', (item, path) => {
    requireKeys(item, ['claimId', 'sourceId', 'relationship', 'rationale', 'attributedTo'], ['claimId', 'sourceId', 'relationship', 'rationale', 'attributedTo'], path);
    return { claimId: stringField(item.claimId, `${path}.claimId`), sourceId: stringField(item.sourceId, `${path}.sourceId`), relationship: stringField(item.relationship, `${path}.relationship`), rationale: stringField(item.rationale, `${path}.rationale`), attributedTo: identity(item.attributedTo, `${path}.attributedTo`) };
  });
  const reviews = list(value.reviews, 'evidenceManifest.reviews', (item, path) => {
    requireKeys(item, ['criterion', 'result', 'evidence', 'reviewer', 'reviewedAt', 'humanJudgmentRequired'], ['criterion', 'result', 'evidence', 'reviewer', 'reviewedAt', 'humanJudgmentRequired'], path);
    if (typeof item.humanJudgmentRequired !== 'boolean') fail(`${path}.humanJudgmentRequired`, 'must be a boolean');
    return { criterion: stringField(item.criterion, `${path}.criterion`), result: stringField(item.result, `${path}.result`), evidence: stringField(item.evidence, `${path}.evidence`, { nonEmpty: false }), reviewer: identity(item.reviewer, `${path}.reviewer`), reviewedAt: isoDateField(item.reviewedAt, `${path}.reviewedAt`), humanJudgmentRequired: item.humanJudgmentRequired };
  });
  return { schemaVersion: value.schemaVersion, jobId: stringField(value.jobId, 'evidenceManifest.jobId'), packetId: stringField(value.packetId, 'evidenceManifest.packetId'), claims, sources, links, method: stringField(value.method, 'evidenceManifest.method'), limitations: list(value.limitations, 'evidenceManifest.limitations', (item, path) => stringField(item, path)), reviews, rawArtifactHash: hashField(value.rawArtifactHash, 'evidenceManifest.rawArtifactHash') };
}

export function validateProviderQuote(value) {
  requireKeys(value, ['schemaVersion', 'jobId', 'packageId', 'provider', 'quote', 'requestedAt', 'requestFingerprint', 'terms'], ['schemaVersion', 'jobId', 'packageId', 'provider', 'quote', 'requestedAt', 'requestFingerprint', 'terms'], 'providerQuote');
  if (value.schemaVersion !== SCHEMA_VERSIONS.providerQuote) fail('providerQuote.schemaVersion', `must equal ${SCHEMA_VERSIONS.providerQuote}`);
  return { schemaVersion: value.schemaVersion, jobId: stringField(value.jobId, 'providerQuote.jobId'), packageId: stringField(value.packageId, 'providerQuote.packageId'), provider: identity(value.provider, 'providerQuote.provider'), quote: stringField(value.quote, 'providerQuote.quote'), requestedAt: isoDateField(value.requestedAt, 'providerQuote.requestedAt'), requestFingerprint: hashField(value.requestFingerprint, 'providerQuote.requestFingerprint'), terms: quoteTerms(value.terms, 'providerQuote.terms') };
}

export function validateSettlementTerms(value) {
  requireKeys(value, ['schemaVersion', 'jobId', 'buyer', 'provider', 'asset', 'atomicAmount', 'deadlines', 'acceptance', 'dispute', 'verifier'], ['schemaVersion', 'jobId', 'buyer', 'provider', 'asset', 'atomicAmount', 'deadlines', 'acceptance', 'dispute', 'verifier'], 'settlementTerms');
  if (value.schemaVersion !== SCHEMA_VERSIONS.settlementTerms) fail('settlementTerms.schemaVersion', `must equal ${SCHEMA_VERSIONS.settlementTerms}`);
  requireKeys(value.deadlines, ['acceptance', 'providerAcceptance', 'delivery', 'review'], ['acceptance', 'providerAcceptance', 'delivery', 'review'], 'settlementTerms.deadlines');
  requireKeys(value.acceptance, ['revisionAllowance'], ['revisionAllowance'], 'settlementTerms.acceptance');
  requireKeys(value.dispute, ['route', 'resolver', 'policy'], ['route', 'resolver', 'policy'], 'settlementTerms.dispute');
  return { schemaVersion: value.schemaVersion, jobId: stringField(value.jobId, 'settlementTerms.jobId'), buyer: identity(value.buyer, 'settlementTerms.buyer'), provider: identity(value.provider, 'settlementTerms.provider'), asset: stringField(value.asset, 'settlementTerms.asset'), atomicAmount: amountField(value.atomicAmount, 'settlementTerms.atomicAmount'), deadlines: Object.fromEntries(Object.entries(value.deadlines).map(([key, item]) => [key, isoDateField(item, `settlementTerms.deadlines.${key}`)])), acceptance: { revisionAllowance: integerField(value.acceptance.revisionAllowance, 'settlementTerms.acceptance.revisionAllowance') }, dispute: { route: stringField(value.dispute.route, 'settlementTerms.dispute.route'), resolver: identity(value.dispute.resolver, 'settlementTerms.dispute.resolver'), policy: stringField(value.dispute.policy, 'settlementTerms.dispute.policy') }, verifier: verifier(value.verifier, 'settlementTerms.verifier') };
}

export function validateEventRecord(value) {
  requireKeys(value, ['schemaVersion', 'eventId', 'jobId', 'type', 'occurredAt', 'actor', 'payload'], ['schemaVersion', 'eventId', 'jobId', 'type', 'occurredAt', 'actor', 'payload'], 'eventRecord');
  if (value.schemaVersion !== SCHEMA_VERSIONS.eventRecord) fail('eventRecord.schemaVersion', `must equal ${SCHEMA_VERSIONS.eventRecord}`);
  requireRecord(value.payload, 'eventRecord.payload');
  return { schemaVersion: value.schemaVersion, eventId: stringField(value.eventId, 'eventRecord.eventId'), jobId: stringField(value.jobId, 'eventRecord.jobId'), type: stringField(value.type, 'eventRecord.type'), occurredAt: isoDateField(value.occurredAt, 'eventRecord.occurredAt'), actor: identity(value.actor, 'eventRecord.actor'), payload: canonicalValue(value.payload, 'eventRecord.payload') };
}

function canonicalValue(value, path = 'value') {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return typeof value === 'string' ? value.normalize('NFC') : value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must contain only finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${path}[${index}]`));
  if (isRecord(value)) {
    const entries = Object.keys(value).sort().map((key) => {
      const normalizedKey = key.normalize('NFC');
      if (value[key] === undefined) fail(`${path}.${key}`, 'undefined is not allowed');
      return [normalizedKey, canonicalValue(value[key], `${path}.${key}`)];
    });
    if (new Set(entries.map(([key]) => key)).size !== entries.length) fail(path, 'contains object keys that collide after Unicode normalization');
    return Object.fromEntries(entries);
  }
  fail(path, 'contains an unsupported value');
}

export function canonicalize(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

export function commitRecord(value, validator) {
  const normalized = validator(value);
  const canonicalBytes = canonicalize(normalized);
  return Object.freeze({ schemaVersion: normalized.schemaVersion, record: normalized, canonicalBytes, digest: createHash('sha256').update(canonicalBytes, 'utf8').digest('hex') });
}
