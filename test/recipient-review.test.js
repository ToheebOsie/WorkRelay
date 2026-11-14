import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecipientReviewCase, evaluateRecipientReview } from '../src/procurement/recipient-review.js';

test('shared recipient review begins blocked and lists independent evidence requirements', () => {
  const review = createRecipientReviewCase({ payTo: 'wallet-address', providers: ['agent-b', 'agent-a'] });
  assert.equal(review.verified, false);
  assert.equal(review.status, 'manual_verification_required');
  assert.deepEqual(review.providers, ['agent-a', 'agent-b']);
  assert.equal(review.requiredEvidence.length, 4);
});

test('recipient review cannot pass with incomplete evidence or no reviewer attestation', () => {
  const review = createRecipientReviewCase({ payTo: 'wallet-address', providers: ['agent-a'] });
  const result = evaluateRecipientReview(review);
  assert.equal(result.verified, false);
  assert.ok(result.errors.length >= 5);
});

test('complete human review is recorded as attested, not as cryptographic proof', () => {
  const review = createRecipientReviewCase({ payTo: 'wallet-address', providers: ['agent-a'] });
  review.evidence = Object.fromEntries(review.requiredEvidence.map((key) => [key, `evidence://${key}`]));
  review.reviewerAttestation = { confirmed: true, reviewer: 'operator', reviewedAt: '2026-11-14T04:00:00Z' };
  const result = evaluateRecipientReview(review);
  assert.equal(result.verified, true);
  assert.equal(result.status, 'human_review_attested');
  assert.match(result.caveat, /not an automated proof/);
});
