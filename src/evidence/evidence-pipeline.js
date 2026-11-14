import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { commitRecord, SCHEMA_VERSIONS, validateEvidenceManifest } from '../contracts/schema.js';
import { evaluateEvidenceQuality } from './evidence-quality.js';

const MAX_SOURCE_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const ALLOWED_CONTENT_TYPES = new Set(['text/plain', 'text/html', 'text/markdown', 'application/json']);
const PRIVATE_IPV4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/;
const PRIVATE_IPV6 = /^(::1|fc|fd|fe8[0-9a-f]:)/i;
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

function fail(message) { throw new TypeError(message); }
function timestamp(value) { return value ?? new Date().toISOString(); }

function validateHttpUrl(raw, path = 'url') {
  let url;
  try { url = new URL(raw); } catch { fail(`${path}: invalid URL`); }
  if (url.protocol !== 'https:') fail(`${path}: only HTTPS URLs are allowed`);
  if (url.username || url.password || url.hash) fail(`${path}: credentials and fragments are not allowed`);
  if (url.port && !['443', ''].includes(url.port)) fail(`${path}: non-default ports are not allowed`);
  return url;
}

async function assertPublicHostname(url, resolveHostname = lookup) {
  const addresses = await resolveHostname(url.hostname, { all: true, verbatim: true });
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (!list.length) fail(`source ${url.hostname}: hostname did not resolve`);
  for (const item of list) {
    const address = String(item.address ?? item);
    if (PRIVATE_IPV4.test(address) || PRIVATE_IPV6.test(address) || address === '0.0.0.0' || address === '::') fail(`source ${url.hostname}: private or local address is not allowed`);
  }
}

async function readBoundedBody(response, maxBytes) {
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); fail(`source response exceeds ${maxBytes} bytes`); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const body = typeof response.text === 'function' ? await response.text() : String(response.body ?? '');
  if (Buffer.byteLength(body, 'utf8') > maxBytes) fail(`source response exceeds ${maxBytes} bytes`);
  return body;
}

function header(response, name) {
  if (response.headers?.get) return response.headers.get(name);
  const headers = response.headers ?? {};
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

/** Fetch one source with scheme, DNS, redirect, content-type and byte limits. */
export async function captureSource(rawUrl, { fetcher = fetch, resolveHostname = lookup, retrievedAt, maxBytes = MAX_SOURCE_BYTES } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SOURCE_BYTES) fail('maxBytes must be a positive bounded integer');
  let current = validateHttpUrl(rawUrl);
  let redirects = 0;
  let response;
  while (true) {
    await assertPublicHostname(current, resolveHostname);
    response = await fetcher(current.href, { redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (++redirects > MAX_REDIRECTS) fail('source exceeded redirect limit');
    const location = header(response, 'location');
    if (!location) fail('source redirect is missing Location');
    current = validateHttpUrl(new URL(location, current).href, 'redirect location');
  }
  const contentType = String(header(response, 'content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  const body = await readBoundedBody(response, maxBytes);
  const status = Number(response.status);
  return {
    url: current.href,
    publisher: current.hostname,
    publishedAt: null,
    retrievedAt: timestamp(retrievedAt),
    accessStatus: status >= 200 && status < 300 ? 'ok' : `http_${status}`,
    contentHash: sha256(body),
    excerpt: body.slice(0, 500),
    contentType,
    content: body,
    safe: ALLOWED_CONTENT_TYPES.has(contentType) && status >= 200 && status < 300,
    warnings: [
      ...(ALLOWED_CONTENT_TYPES.has(contentType) ? [] : ['unsupported_content_type']),
      ...(status >= 200 && status < 300 ? [] : ['source_not_successful'])
    ]
  };
}

function sourceDomain(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

function result(type, status, detail) { return { type, status, detail }; }

/**
 * Run narrow deterministic checks. These checks describe representation and
 * provenance quality; they never establish that a claim is true.
 */
export function verifyEvidencePacket({ manifest, sourceSnapshots = {}, rawArtifact = null, requiredClaimIds = [], freshnessWindow = null, calculations = [] }) {
  const checks = [];
  let normalized;
  try {
    normalized = validateEvidenceManifest(manifest);
    checks.push(result('schema_completeness', 'complete', 'Evidence manifest matches its versioned schema.'));
  } catch (error) {
    checks.push(result('schema_completeness', 'check_failed', error.message));
    return { status: 'check_failed', checks, limitation: 'A failed schema check prevents interpretation of downstream checks.' };
  }

  if (rawArtifact !== null && sha256(rawArtifact) !== normalized.rawArtifactHash) checks.push(result('hash_integrity', 'check_failed', 'Raw artifact hash does not match the manifest.'));
  else checks.push(result('hash_integrity', 'complete', 'Raw artifact hash matches the committed manifest or was independently supplied.'));

  const unsafeSources = normalized.sources.filter((source) => {
    try { validateHttpUrl(source.url); } catch { return true; }
    const snapshot = sourceSnapshots[source.id];
    return Boolean(snapshot && (!snapshot.safe || snapshot.contentHash !== source.contentHash));
  });
  checks.push(unsafeSources.length ? result('safe_source_capture', 'check_failed', `${unsafeSources.length} source(s) failed URL, access, content-type or snapshot-integrity checks.`) : result('safe_source_capture', 'complete', 'Sources use allowed HTTPS URLs and match available safe snapshots.'));

  const excerptMismatches = normalized.sources.filter((source) => {
    const snapshot = sourceSnapshots[source.id];
    return snapshot && source.excerpt && !String(snapshot.content ?? '').includes(source.excerpt);
  });
  checks.push(excerptMismatches.length ? result('excerpt_matches_snapshot', 'check_failed', `${excerptMismatches.length} saved excerpt(s) do not occur in the corresponding source snapshot.`) : result('excerpt_matches_snapshot', 'complete', 'Saved excerpts match the supplied source snapshots or no snapshot was available.'));

  if (freshnessWindow) {
    const cutoff = Date.parse(freshnessWindow.start);
    const stale = normalized.sources.filter((source) => source.publishedAt && Date.parse(source.publishedAt) < cutoff);
    checks.push(stale.length ? result('freshness', 'incomplete', `${stale.length} source(s) are outside the requested freshness window.`) : result('freshness', 'complete', 'Known publication dates meet the requested freshness window.'));
  } else checks.push(result('freshness', 'needs_human_review', 'No freshness window was supplied.'));

  const linkedClaimIds = new Set(normalized.links.map((link) => link.claimId));
  const missingClaims = [...new Set([...requiredClaimIds, ...normalized.claims.filter((claim) => claim.importance === 'material').map((claim) => claim.id)])].filter((id) => !linkedClaimIds.has(id));
  checks.push(missingClaims.length ? result('claim_coverage', 'incomplete', `Claims without a source link: ${missingClaims.join(', ')}.`) : result('claim_coverage', 'complete', 'Required and material claims have source links.'));

  const independent = new Set(normalized.sources.map((source) => `${sourceDomain(source.url)}:${source.contentHash}`));
  const distinctDomains = new Set(normalized.sources.map((source) => sourceDomain(source.url)).filter(Boolean));
  checks.push(distinctDomains.size < 2 ? result('independent_sources', 'needs_human_review', 'The packet does not establish two independent underlying sources.') : result('independent_sources', 'complete', `${distinctDomains.size} distinct source domain(s) represented; independence still requires review.`));
  if (independent.size !== normalized.sources.length) checks.push(result('duplicate_sources', 'incomplete', 'At least two source records share the same domain and content hash.'));

  const unsupported = normalized.claims.filter((claim) => !normalized.links.some((link) => link.claimId === claim.id && ['supports', 'contradicts', 'contextualizes'].includes(link.relationship)));
  const contradictory = normalized.links.filter((link) => link.relationship === 'contradicts');
  checks.push(unsupported.length ? result('unsupported_claims', 'incomplete', `${unsupported.length} claim(s) have no supporting, contradicting or contextualizing link.`) : result('unsupported_claims', 'complete', 'Every claim has an attributed relationship to a source.'));
  checks.push(contradictory.length ? result('contradictions', 'needs_human_review', `${contradictory.length} contradiction link(s) require human review.`) : result('contradictions', 'complete', 'No contradiction links were recorded.'));

  const badCalculations = calculations.filter((item) => !Number.isFinite(item.expected) || !Number.isFinite(item.actual) || item.expected !== item.actual);
  checks.push(badCalculations.length ? result('reproducible_arithmetic', 'check_failed', `${badCalculations.length} calculation(s) do not reproduce the recorded result.`) : result('reproducible_arithmetic', 'complete', 'All supplied calculations reproduce exactly.'));

  const status = checks.some((item) => item.status === 'check_failed') ? 'check_failed' : checks.some((item) => item.status === 'incomplete') ? 'incomplete' : checks.some((item) => item.status === 'needs_human_review') ? 'needs_human_review' : 'complete';
  return { status, checks, limitation: 'Deterministic checks verify structure, hashes, capture metadata and reproducibility. They do not prove factual truth, source authenticity, authorship or provider quality.', manifest: normalized };
}

export function createEvidencePacket({ jobId, packetId, rawArtifact, claims = [], sources = [], links = [], method, limitations = [], reviews = [], now = new Date().toISOString() }) {
  const manifest = {
    schemaVersion: SCHEMA_VERSIONS.evidenceManifest,
    jobId,
    packetId,
    claims,
    sources,
    links,
    method,
    limitations,
    reviews,
    rawArtifactHash: sha256(String(rawArtifact ?? ''))
  };
  const committed = commitRecord(manifest, validateEvidenceManifest);
  return { ...committed, rawArtifactHash: committed.record.rawArtifactHash, createdAt: now };
}

export function buildDemoEvidencePacket({ jobId, packageId, rawArtifact, createdAt = new Date().toISOString() }) {
  const badSourceContent = 'This source is deliberately unavailable in the sandbox.';
  const source = { id: 'bad-source', url: 'https://example.invalid/dead-source', publisher: 'example.invalid', publishedAt: null, retrievedAt: createdAt, accessStatus: 'http_404', contentHash: sha256(badSourceContent), excerpt: badSourceContent };
  const packet = createEvidencePacket({
    jobId,
    packetId: `${jobId}-${packageId}-evidence`,
    rawArtifact,
    claims: [{ id: 'demo-claim', claim: 'The simulated deliverable contains a source-backed conclusion.', type: 'illustrative', importance: 'material', period: 'demo', confidence: 0 }],
    sources: [source],
    links: [{ claimId: 'demo-claim', sourceId: 'bad-source', relationship: 'unsupported', rationale: 'The deliberate fixture is not evidence.', attributedTo: { kind: 'system', id: 'workrelay-demo' } }],
    method: 'Deterministic sandbox fixture; no external source was consulted.',
    limitations: ['Simulated output only.', 'The deliberate source is dead and must remain flagged.'],
    reviews: [{ criterion: 'bad-source-fixture', result: 'incomplete', evidence: 'HTTP 404 fixture', reviewer: { kind: 'system', id: 'workrelay-demo' }, reviewedAt: createdAt, humanJudgmentRequired: true }],
    now: createdAt
  });
  const sourceSnapshots = { 'bad-source': { ...source, content: badSourceContent, safe: false } };
  return {
    ...packet,
    verification: verifyEvidencePacket({ manifest: packet.record, rawArtifact, sourceSnapshots, requiredClaimIds: ['demo-claim'] }),
    qualityEvaluation: evaluateEvidenceQuality({ manifest: packet.record, packetDigest: packet.digest, rawArtifact, sourceSnapshots, requiredClaimIds: ['demo-claim'], evaluationAt: createdAt })
  };
}
