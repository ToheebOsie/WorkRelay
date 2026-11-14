import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const path = join(root, 'config', 'publisher-authority-candidates.nigeria-fintech.json');
const pack = JSON.parse(await readFile(path, 'utf8'));
const tiers = new Set(['regulator', 'primary', 'academic', 'secondary', 'unknown']);
const claimTypes = new Set(['financial', 'numeric', 'market', 'regulatory', 'regulatory_current', 'daily_series', 'monthly_series', 'quarterly_series', 'annual_series']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(pack.schemaVersion === 'workrelay.publisher-authority-candidates.v1', 'Unsupported candidate-pack schema');
assert(pack.status === 'candidate_only_not_active', 'Candidate pack must remain inactive until deployment-owner review');
assert(Array.isArray(pack.entries) && pack.entries.length > 0, 'Candidate entries are required');
const seen = new Set();
for (const [index, entry] of pack.entries.entries()) {
  assert(typeof entry.hostname === 'string' && entry.hostname.trim(), `Entry ${index} needs an exact hostname`);
  const hostname = entry.hostname.toLowerCase();
  assert(!hostname.includes('*') && !hostname.includes('/') && !hostname.includes(':'), `Entry ${index} is not an exact hostname`);
  let parsed;
  try { parsed = new URL(`https://${hostname}`); } catch { throw new Error(`Entry ${index} has an invalid hostname`); }
  assert(parsed.hostname === hostname && parsed.pathname === '/', `Entry ${index} has a non-canonical hostname`);
  assert(!seen.has(hostname), `Duplicate candidate hostname: ${hostname}`);
  seen.add(hostname);
  assert(tiers.has(entry.proposedAuthorityTier), `Entry ${index} has an invalid proposed authority tier`);
  assert(Array.isArray(entry.scope) && entry.scope.length > 0 && entry.scope.every((item) => typeof item === 'string' && item.trim()), `Entry ${index} needs explicit human-readable publisher scopes`);
  assert(Array.isArray(entry.permittedClaimTypes) && entry.permittedClaimTypes.length > 0, `Entry ${index} needs permittedClaimTypes`);
  assert(new Set(entry.permittedClaimTypes).size === entry.permittedClaimTypes.length, `Entry ${index} repeats a permitted claim type`);
  for (const claimType of entry.permittedClaimTypes) assert(claimTypes.has(claimType), `Entry ${index} has unsupported permitted claim type: ${claimType}`);
  assert(entry.reviewStatus === 'requires_deployment_owner_review', `Entry ${index} must remain pending owner review`);
  assert(Array.isArray(entry.supportingSources) && entry.supportingSources.length > 0, `Entry ${index} needs supporting sources`);
  for (const source of entry.supportingSources) {
    const url = new URL(source.url);
    assert(url.protocol === 'https:', `Entry ${index} has a non-HTTPS supporting source`);
    assert(source.title && source.observedFact, `Entry ${index} has incomplete source notes`);
  }
  assert(!Object.hasOwn(entry, 'confirmed') && !Object.hasOwn(entry, 'validUntil'), `Entry ${index} must not be silently promoted into an active registry`);
}
assert(Array.isArray(pack.affiliationReviewNotes), 'Affiliation review notes must be explicit');
console.log(`Validated ${pack.entries.length} exact-host candidates with explicit scopes and permitted claim types; pack remains inactive pending deployment-owner review.`);
