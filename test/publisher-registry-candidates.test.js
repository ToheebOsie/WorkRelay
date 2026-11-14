import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const candidatePath = join(root, 'config', 'publisher-authority-candidates.nigeria-fintech.json');

test('Nigeria fintech publisher candidates are exact-host, source-backed and inactive until owner review', async () => {
  const pack = JSON.parse(await readFile(candidatePath, 'utf8'));
  assert.equal(pack.status, 'candidate_only_not_active');
  assert.equal(pack.schemaVersion, 'workrelay.publisher-authority-candidates.v1');
  assert.ok(pack.entries.length >= 8);
  const hosts = pack.entries.map((entry) => entry.hostname);
  assert.equal(new Set(hosts).size, hosts.length);
  for (const entry of pack.entries) {
    assert.equal(entry.reviewStatus, 'requires_deployment_owner_review');
    assert.ok(!entry.hostname.includes('*'));
    assert.ok(entry.supportingSources.every((source) => new URL(source.url).protocol === 'https:'));
    assert.ok(Array.isArray(entry.scope) && entry.scope.length > 0 && entry.scope.every((item) => typeof item === 'string' && item.trim()));
    assert.ok(Array.isArray(entry.permittedClaimTypes) && entry.permittedClaimTypes.length > 0);
    assert.ok(!Object.hasOwn(entry, 'confirmed'));
    assert.ok(!Object.hasOwn(entry, 'validUntil'));
  }
});

test('CBN and NIBSS affiliation is disclosed as a review signal, not automatic independence', async () => {
  const pack = JSON.parse(await readFile(candidatePath, 'utf8'));
  const note = pack.affiliationReviewNotes.find((item) => item.publisherGroups.includes('central-bank-of-nigeria') && item.publisherGroups.includes('nigeria-inter-bank-settlement-system'));
  assert.ok(note);
  assert.equal(note.status, 'documented_review_signal_not_automatic_group_merge');
  assert.match(note.reviewInstruction, /independent corroboration/i);
});
