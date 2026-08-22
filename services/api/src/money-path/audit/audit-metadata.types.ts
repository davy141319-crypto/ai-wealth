// ============================================================================
// Money-path audit — AuditLog.metadata envelope contract.
// Reuses the EXISTING AuditLog.metadata column. NO new DB columns.
// Contract: { before, after, reason, source, correlation } — the five
// object keys must always be present (values may be null), so that audit
// consumers can read them with zero optional chaining guessing.
// ============================================================================

import type { AuditEnvelopeSource } from '@ai-wealth/shared';

/**
 * Standard envelope persisted inside AuditLog.metadata for every
 * sensitive mutation recorded by the money-path AuditSensitiveMutation
 * wrapper.
 */
export interface AuditMetadataEnvelope {
  /** State BEFORE the mutation (null for inserts such as CREATE tx). */
  before: unknown;
  /** State AFTER the mutation (null for deletion-style mutations). */
  after: unknown;
  /** Short free-text or stable-code reason: e.g. reversal description,
   *  admin provisioning rationale. */
  reason: string | null;
  /** Origin category. Stable code from AuditEnvelopeSource enum. */
  source: AuditEnvelopeSource | string;
  /** Correlation id: idempotency key / original ledger tx id / request id. */
  correlation: string | null;
}

/** Validated envelope. */
export interface ValidAuditMetadataEnvelope extends AuditMetadataEnvelope {
  // Always the 5 exact keys above (enforced at runtime).
}

const EXPECTED_KEYS = new Set(['before', 'after', 'reason', 'source', 'correlation']);

/**
 * Runtime shape check — validates that the envelope object has exactly the
 * five required keys (no more, no less — but unknown keys are rejected so
 * implementations cannot accidentally smuggle extra sensitive fields into
 * the single metadata envelope key count check used by CI).
 *
 * Returns the input cast to ValidAuditMetadataEnvelope on success, or a
 * structured `{missing, extraneous, invalidSource}` diagnostic.
 */
export function validateAuditMetadataEnvelope(
  input: unknown,
): { ok: true; value: ValidAuditMetadataEnvelope } | { ok: false; issues: string[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, issues: ['AUDIT_ENVELOPE_NOT_OBJECT'] };
  }
  const rec = input as Record<string, unknown>;
  const keys = Object.keys(rec);
  const issues: string[] = [];
  for (const k of EXPECTED_KEYS)
    if (!Object.prototype.hasOwnProperty.call(rec, k)) issues.push(`MISSING:${k}`);
  for (const k of keys) if (!EXPECTED_KEYS.has(k)) issues.push(`EXTRANEOUS:${k}`);
  if (typeof rec.source !== 'string') issues.push('INVALID_SOURCE_TYPE');
  if (rec.reason !== null && typeof rec.reason !== 'string') issues.push('INVALID_REASON_TYPE');
  if (rec.correlation !== null && typeof rec.correlation !== 'string')
    issues.push('INVALID_CORRELATION_TYPE');
  if (issues.length) return { ok: false, issues };
  return { ok: true, value: rec as unknown as ValidAuditMetadataEnvelope };
}
