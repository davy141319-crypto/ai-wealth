// ============================================================================
// P1-008 Money-Path Foundation — stable error codes (additive, not merged
// into existing AppErrorCode / AuthzFailReason enums to avoid merge drift).
// All codes are emitted through the generic AppError wrapper so the client
// still reads error.code as a string.
// ============================================================================

export enum MoneyPathErrorCode {
  // Ledger
  LEDGER_DOUBLE_ENTRY_VIOLATION = 'LEDGER_DOUBLE_ENTRY_VIOLATION',
  LEDGER_AMOUNT_INVALID = 'LEDGER_AMOUNT_INVALID',
  LEDGER_IDEMPOTENCY_REPLAY = 'LEDGER_IDEMPOTENCY_REPLAY',
  LEDGER_REVERSAL_ALREADY_EXISTS = 'LEDGER_REVERSAL_ALREADY_EXISTS',
  LEDGER_ORIGINAL_NOT_FOUND = 'LEDGER_ORIGINAL_NOT_FOUND',
  MANUAL_ADMIN_DISABLED = 'MANUAL_ADMIN_DISABLED',

  // Feature flags / TOCTOU
  MONEY_FEATURE_DISABLED = 'MONEY_FEATURE_DISABLED',
  MONEY_FEATURE_UNAVAILABLE = 'MONEY_FEATURE_UNAVAILABLE',
  FLAG_RACE_FLIPPED = 'FLAG_RACE_FLIPPED',
  TESTNET_GATE_MISSING = 'TESTNET_GATE_MISSING',

  // Idempotency
  IDEMPOTENCY_INFLIGHT = 'IDEMPOTENCY_INFLIGHT',
  IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT',

  // Transactional / concurrency
  CONCURRENCY_LOCK_TIMEOUT = 'CONCURRENCY_LOCK_TIMEOUT',
  SERIALIZATION_FAILURE = 'SERIALIZATION_FAILURE',
  SERIALIZATION_FAILURE_AFTER_RETRY = 'SERIALIZATION_FAILURE_AFTER_RETRY',
  PHASE_B_IO_FORBIDDEN = 'PHASE_B_IO_FORBIDDEN',
  STATE_MUTATION_FAILED = 'STATE_MUTATION_FAILED',

  // Audit envelope
  AUDIT_ENVELOPE_INVALID = 'AUDIT_ENVELOPE_INVALID',
  AUDIT_WRITE_FAILED = 'AUDIT_WRITE_FAILED',

  // Risk / plan
  RISK_BLOCKED = 'RISK_BLOCKED',
  RISK_PREFLIGHT_TIMEOUT = 'RISK_PREFLIGHT_TIMEOUT',
  PLAN_BUILD_INVALID = 'PLAN_BUILD_INVALID',
}

/**
 * Sensitive-action sources permitted inside AuditMetadataEnvelope.
 * (AuditLog.action is a free-form string column; this enum is the internal
 * Typed contract for money-path audit envelope.source.)
 */
export enum AuditEnvelopeSource {
  AUTH = 'auth',
  RBAC = 'rbac',
  FLAGS = 'flags',
  LEDGER = 'ledger',
  SETTLEMENT = 'settlement',
  COMMISSION = 'commission',
  TREASURY = 'treasury',
  MANUAL_ADMIN = 'manual_admin',
  SYSTEM = 'system',
}

/** Subcategories used by LEDGER_DOUBLE_ENTRY_VIOLATION details. */
export enum LedgerDoubleEntryViolationReason {
  TOO_FEW_POSTINGS = 'TOO_FEW_POSTINGS',
  BALANCE_MISMATCH = 'BALANCE_MISMATCH',
  MIXED_CURRENCY = 'MIXED_CURRENCY',
  MIXED_UNIT = 'MIXED_UNIT',
  MIXED_DECIMALS = 'MIXED_DECIMALS',
}
