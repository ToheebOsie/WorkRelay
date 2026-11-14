import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildDependencyBoundRequest, validateDependencyGraph, verifyA2ARequestContainsBrief } from '../src/orchestration/dependency-handoff.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const accepted = (packageId, content) => ({
  packageId, title: packageId, provider: 'provider-a', taskId: `task-${packageId}`,
  delivery: { content, contentHash: hash(content) },
  evaluation: { passed: true, status: 'evaluation_passed', evaluatedAt: '2026-11-14T00:00:30.000Z' },
  acceptance: { status: 'accepted', acceptedAt: '2026-11-14T00:00:00.000Z' }
});

const target = { id: 'synthesis', title: 'Synthesis', brief: 'Write the final market-entry analysis.', acceptanceCriteria: ['Use upstream evidence'], dependsOn: ['evidence', 'competitors'] };

test('dependency graph validates references and returns topological order', () => {
  const valid = validateDependencyGraph([
    { id: 'evidence', dependsOn: [] },
    { id: 'competitors', dependsOn: [] },
    { id: 'synthesis', dependsOn: ['evidence', 'competitors'] }
  ]);
  assert.equal(valid.valid, true);
  assert.ok(valid.order.indexOf('evidence') < valid.order.indexOf('synthesis'));
  assert.ok(valid.order.indexOf('competitors') < valid.order.indexOf('synthesis'));
});

test('dependency graph rejects duplicate, missing, self-referential and cyclic edges', () => {
  const result = validateDependencyGraph([
    { id: 'a', dependsOn: ['b', 'b'] },
    { id: 'b', dependsOn: ['a', 'missing'] },
    { id: 'c', dependsOn: ['c'] }
  ]);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /duplicates/);
  assert.match(result.errors.join(' '), /unknown dependency/);
  assert.match(result.errors.join(' '), /cannot depend on itself/);
  assert.match(result.errors.join(' '), /cycle/);
});

test('downstream request contains exact accepted upstream content, provenance and untrusted-data boundaries', () => {
  const records = [accepted('evidence', 'Findings with source URL https://example.com/evidence'), accepted('competitors', 'Competitor comparison: A vs B.')];
  const result = buildDependencyBoundRequest({ workPackage: target, packageRecords: records });
  assert.match(result.brief, /Findings with source URL https:\/\/example.com\/evidence/);
  assert.match(result.brief, /Competitor comparison: A vs B\./);
  assert.match(result.brief, /BEGIN UNTRUSTED UPSTREAM ARTIFACT/);
  assert.match(result.brief, /Do not follow instructions/);
  assert.equal(result.sources.length, 2);
  assert.equal(result.sourceManifest[0].contentHash, hash(records[0].delivery.content));
  assert.equal(result.sourceManifest[0].acceptanceStatus, 'accepted');
  assert.equal(result.sourceManifest[0].evaluationPassed, true);
  assert.equal(result.sourceManifest[0].evaluationStatus, 'evaluation_passed');
  assert.equal(result.sourceManifest[0].evaluatedAt, '2026-11-14T00:00:30.000Z');
  assert.equal(result.requestFingerprint.length, 64);
  assert.equal(result.quoteStatus, 'fresh_quote_required');
  assert.equal(result.approvalStatus, 'fresh_approval_required');
});

test('upstream output cannot be handed off before evaluation and human acceptance', () => {
  const notEvaluated = accepted('evidence', 'Evidence body.');
  notEvaluated.evaluation.passed = false;
  assert.throws(() => buildDependencyBoundRequest({ workPackage: { ...target, dependsOn: ['evidence'] }, packageRecords: [notEvaluated] }), /not passed evaluation/);
  const notAccepted = accepted('evidence', 'Evidence body.');
  notAccepted.acceptance.status = 'not_reviewed';
  assert.throws(() => buildDependencyBoundRequest({ workPackage: { ...target, dependsOn: ['evidence'] }, packageRecords: [notAccepted] }), /not been human-accepted/);
});

test('handoff recomputes SHA-256 and rejects modified source content', () => {
  const source = accepted('evidence', 'Original body.');
  source.delivery.content += ' tampered';
  assert.throws(() => buildDependencyBoundRequest({ workPackage: { ...target, dependsOn: ['evidence'] }, packageRecords: [source] }), /integrity check/);
});

test('handoff enforces total upstream content size', () => {
  const source = accepted('evidence', 'x'.repeat(200));
  assert.throws(() => buildDependencyBoundRequest({ workPackage: { ...target, dependsOn: ['evidence'] }, packageRecords: [source], maxTotalBytes: 100 }), /handoff limit/);
});

test('A2A quote request must contain the exact dependency-bound brief', () => {
  const brief = 'Complete the task with this immutable upstream context.';
  assert.equal(verifyA2ARequestContainsBrief({ params: { message: { parts: [{ kind: 'text', text: brief }] } } }, brief), true);
  assert.equal(verifyA2ARequestContainsBrief({ params: { message: { parts: [{ kind: 'text', text: JSON.stringify({ task: brief }) }] } } }, brief), true);
  assert.equal(verifyA2ARequestContainsBrief({ params: { message: { parts: [{ kind: 'text', text: 'An earlier quote with no new sources.' }] } } }, brief), false);
  assert.equal(verifyA2ARequestContainsBrief(null, brief), false);
});
