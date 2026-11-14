const REQUIRED_EVIDENCE = Object.freeze([
  'marketplace_or_provider_documentation',
  'provider_controlled_identity_or_agent_card',
  'explicit_payment_routing_confirmation',
  'independent_onchain_or_settlement_evidence'
]);

/**
 * Build a human-review case for a payment recipient reused by multiple handles.
 * This module does not claim to verify wallet ownership automatically.
 */
export function createRecipientReviewCase({ payTo, providers = [] }) {
  if (typeof payTo !== 'string' || !payTo.trim()) throw new TypeError('payTo is required');
  return {
    payTo,
    providers: [...new Set(providers)].sort(),
    status: 'manual_verification_required',
    requiredEvidence: [...REQUIRED_EVIDENCE],
    evidence: {},
    reviewerAttestation: null,
    verified: false,
    warning: 'A shared settlement address is not inherently suspicious, but provider ownership and payment routing are not established by an x402 quote.'
  };
}

/**
 * Evaluate a human-supplied review record. A record is only marked reviewed
 * when all evidence categories have non-empty references and an explicit
 * reviewer attestation. This is an auditable human gate, not chain-level proof.
 */
export function evaluateRecipientReview(review) {
  const errors = [];
  if (!review || typeof review !== 'object') return { valid: false, verified: false, errors: ['A recipient review record is required'] };
  for (const key of REQUIRED_EVIDENCE) {
    if (typeof review.evidence?.[key] !== 'string' || !review.evidence[key].trim()) {
      errors.push(`Missing evidence: ${key}`);
    }
  }
  if (review.reviewerAttestation?.confirmed !== true) errors.push('Explicit reviewer confirmation is required');
  if (typeof review.reviewerAttestation?.reviewer !== 'string' || !review.reviewerAttestation.reviewer.trim()) errors.push('Reviewer identity is required');
  if (typeof review.reviewerAttestation?.reviewedAt !== 'string' || !Number.isFinite(Date.parse(review.reviewerAttestation.reviewedAt))) errors.push('A valid review timestamp is required');
  return {
    valid: errors.length === 0,
    verified: errors.length === 0,
    status: errors.length === 0 ? 'human_review_attested' : 'manual_verification_required',
    errors,
    caveat: 'This status records a human attestation against supplied evidence; it is not an automated proof of wallet ownership or a guarantee against fraud.'
  };
}

export const recipientReviewRequirements = REQUIRED_EVIDENCE;
