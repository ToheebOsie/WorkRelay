import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { commitRecord, SCHEMA_VERSIONS, validateEvidenceManifest } from '../contracts/schema.js';
import { evaluateEvidenceQuality } from './evidence-quality.js';

const MAX_SOURCE_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const ALLOWED_CONTENT_TYPES = new Set(['text/plain', 'text/html', 'text/markdown', 'application/json']);
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

// IPv4 ranges that are never valid public source destinations.
const BLOCKED_IPV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) BLOCKED_IPV4.addSubnet(network, prefix, 'ipv4');

// IPv6 is allow-listed rather than block-listed: only global unicast (2000::/3)
// is accepted, minus ranges inside it that are special-purpose. Everything else
// (loopback, unspecified, link-local fe80::/10, unique-local fc00::/7, multicast,
// IPv4-mapped, NAT64, ...) is rejected, so no private range can be missed.
const GLOBAL_UNICAST_IPV6 = new BlockList();
GLOBAL_UNICAST_IPV6.addSubnet('2000::', 3, 'ipv6');
const SPECIAL_IPV6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) SPECIAL_IPV6.addSubnet(network, prefix, 'ipv6');

/** True only for a literal IP address that is safe to treat as a public destination. Unknown input fails closed. */
export function isPublicAddress(address) {
  const text = String(address ?? '');
  const family = isIP(text);
  if (family === 4) return !BLOCKED_IPV4.check(text, 'ipv4');
  if (family === 6) return GLOBAL_UNICAST_IPV6.check(text, 'ipv6') && !SPECIAL_IPV6.check(text, 'ipv6');
  return false;
}

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

/**
 * Resolve a hostname once and require every returned address to be public.
 * The validated addresses are returned so the connection can be pinned to them.
 */
async function resolvePublicAddresses(url, resolveHostname = lookup) {
  const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolveHostname(hostname, { all: true, verbatim: true });
  const list = (Array.isArray(addresses) ? addresses : [addresses]).map((item) => {
    const address = String(item?.address ?? item);
    return { address, family: Number(item?.family) || isIP(address) };
  });
  if (!list.length) fail(`source ${hostname}: hostname did not resolve`);
  for (const item of list) if (!isPublicAddress(item.address)) fail(`source ${hostname}: private or local address is not allowed`);
  return list;
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

function raceDeadline(promise, signal) {
  if (signal.aborted) return Promise.reject(new TypeError('source capture timed out'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new TypeError('source capture timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); }
    );
  });
}

/**
 * Default fetcher. It connects only to the address that was already validated
 * (`address`), so a second DNS answer cannot redirect the request to a private
 * host (DNS rebinding). TLS still verifies the certificate for the original
 * hostname through SNI. Redirects are never followed here.
 */
export function createPinnedHttpsFetcher({ request = httpsRequest } = {}) {
  return (href, { address, family, signal, maxBytes = MAX_SOURCE_BYTES } = {}) => new Promise((resolve, reject) => {
    if (!address || !isPublicAddress(address)) { reject(new TypeError('A validated public address is required to open a connection.')); return; }
    const url = new URL(href);
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const pinnedLookup = (_host, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      if (options && typeof options === 'object' && options.all) cb(null, [{ address, family: family || isIP(address) }]);
      else cb(null, address, family || isIP(address));
    };
    const req = request({
      protocol: 'https:', hostname, port: 443, path: `${url.pathname}${url.search}`, method: 'GET', agent: false, signal,
      lookup: pinnedLookup,
      servername: isIP(hostname) ? undefined : hostname,
      headers: { accept: 'text/plain, text/markdown, text/html, application/json;q=0.9', 'accept-encoding': 'identity', 'user-agent': 'WorkRelay-source-capture/0.1' }
    }, (res) => {
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) { req.destroy(); reject(new TypeError(`source response exceeds ${maxBytes} bytes`)); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text: async () => body });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch one source with scheme, DNS, redirect, content-type, byte and time limits.
 * Every hop resolves the hostname once, requires public addresses, and connects
 * to that validated address. The whole capture shares one hard deadline.
 */
export async function captureSource(rawUrl, { fetcher = createPinnedHttpsFetcher(), resolveHostname = lookup, retrievedAt, maxBytes = MAX_SOURCE_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SOURCE_BYTES) fail('maxBytes must be a positive bounded integer');
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) fail(`timeoutMs must be a positive integer no greater than ${MAX_TIMEOUT_MS}`);
  let current = validateHttpUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let redirects = 0;
    let response;
    while (true) {
      const [pinned] = await raceDeadline(resolvePublicAddresses(current, resolveHostname), controller.signal);
      response = await raceDeadline(Promise.resolve(fetcher(current.href, { redirect: 'manual', signal: controller.signal, address: pinned.address, family: pinned.family, maxBytes })), controller.signal);
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (++redirects > MAX_REDIRECTS) fail('source exceeded redirect limit');
      const location = header(response, 'location');
      if (!location) fail('source redirect is missing Location');
      current = validateHttpUrl(new URL(location, current).href, 'redirect location');
    }
    const contentType = String(header(response, 'content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    const body = await raceDeadline(readBoundedBody(response, maxBytes), controller.signal);
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
  } finally {
    clearTimeout(timer);
  }
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

  if (rawArtifact === null || rawArtifact === undefined) checks.push(result('hash_integrity', 'incomplete', 'No raw artifact was supplied, so its hash could not be verified against the manifest.'));
  else if (sha256(rawArtifact) !== normalized.rawArtifactHash) checks.push(result('hash_integrity', 'check_failed', 'Raw artifact hash does not match the manifest.'));
  else checks.push(result('hash_integrity', 'complete', 'Raw artifact hash matches the committed manifest.'));

  const unsafeSources = normalized.sources.filter((source) => {
    try { validateHttpUrl(source.url); } catch { return true; }
    const snapshot = sourceSnapshots[source.id];
    return Boolean(snapshot && (!snapshot.safe || snapshot.contentHash !== source.contentHash));
  });
  const uncapturedSources = normalized.sources.filter((source) => !sourceSnapshots[source.id]);
  if (unsafeSources.length) checks.push(result('safe_source_capture', 'check_failed', `${unsafeSources.length} source(s) failed URL, access, content-type or snapshot-integrity checks.`));
  else if (uncapturedSources.length) checks.push(result('safe_source_capture', 'incomplete', `No captured snapshot was supplied for ${uncapturedSources.length} source(s): ${uncapturedSources.map((source) => source.id).join(', ')}. Nothing was verified for them.`));
  else checks.push(result('safe_source_capture', 'complete', 'Every source uses an allowed HTTPS URL and matches a safe captured snapshot.'));

  const excerptMismatches = normalized.sources.filter((source) => {
    const snapshot = sourceSnapshots[source.id];
    return snapshot && source.excerpt && !String(snapshot.content ?? '').includes(source.excerpt);
  });
  const excerptsUnchecked = normalized.sources.filter((source) => !sourceSnapshots[source.id] && source.excerpt);
  if (excerptMismatches.length) checks.push(result('excerpt_matches_snapshot', 'check_failed', `${excerptMismatches.length} saved excerpt(s) do not occur in the corresponding source snapshot.`));
  else if (excerptsUnchecked.length) checks.push(result('excerpt_matches_snapshot', 'incomplete', `${excerptsUnchecked.length} saved excerpt(s) could not be compared because no snapshot was supplied.`));
  else checks.push(result('excerpt_matches_snapshot', 'complete', 'Saved excerpts occur in the supplied source snapshots.'));

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
