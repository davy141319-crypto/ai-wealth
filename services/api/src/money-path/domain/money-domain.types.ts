// ============================================================================
// Money-path shared types — Risk / Settlement / Commission preflight &
// commit interfaces (Phase A + Phase B Commit DTOs), plus the canonical
// request hash function and Phase A/B contracts used by TwoPhaseOrchestrator.
//
// These engines DO NOT have implementation bodies here — they are pure
// interface contracts. Concrete settlement/commission implementations
// arrive in follow-up tasks; P1-008 provides the abstraction, locking
// policy, orchestrator, and test fixtures only.
// ============================================================================

import { Repositories } from '@ai-wealth/database';
import type { LedgerAmountSign, LedgerTxnType } from '@ai-wealth/database';
import type { PostingPlan } from '../ledger/ledger.engine';

export * from './settlement.engine';
export * from './commission.engine';
export * from './risk.engine';

export interface MoneyDomainPreflightCtx {
  readonly actorUserId: string | null;
  readonly requestId: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly input: unknown;
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

/**
 * Output of Phase A (deterministic, serializable plan that is passed
 * unchanged into Phase B). This allows full idempotency replays and
 * ensures any retry of Phase A+B with the same input produces identical
 * write behavior in Phase B.
 */
export interface CommitPlan {
  /** Which feature flags are required. Used by A4 + B1 double-check. */
  requiredFlags: Array<{ scope: string; feature: string }>;
  /**
   * Account lock targets (deduplicated). Orchestrator will sort + lock
   * them in Phase B2 using the canonical locking strategy.
   */
  lockTargets: Array<{ accountType: string; accountId: string }>;
  /** Optional domain state write. Returned as a function reference that
   *  will be called inside the transaction (Phase B4) with the tx-bound
   *  repositories. Void means no state write is required. */
  stateMutation: ((repos: Repositories) => Promise<unknown>) | null;
  /** The ledger journal write — always performed if present (B5). */
  ledger: CommitPlanLedger | null;
  /** Audit envelope written AFTER ledger write (B6). Note: Feature-flag
   *  mutations produce their own separate audit (inside setFlag) and do
   *  not use this envelope. */
  auditEnvelope: {
    action: string;
    resource: string;
    before: unknown;
    after: unknown;
    reason: string | null;
    source: string;
    correlation: string | null;
  } | null;
  /**
   * ResponseCode/Body stored in idempotency row on COMPLETED. Orchestrator
   * returns this same body to the client on replay.
   */
  response: { statusCode: number; body: unknown };
}

export interface CommitPlanLedger {
  txnType: LedgerTxnType;
  currency: string;
  unit: string;
  decimals?: number;
  source: string;
  reference?: string | null;
  scope: string;
  txnIdempotencyKey: string;
  metadata?: unknown;
  postings: PostingPlan[];
  /** Optional reversal hint — if present, engine.reverse() is used. */
  reversalOfTxnId?: string | null;
  reversalReason?: string | null;
  /** Extra sign/type safety. */
  signType?: LedgerAmountSign;
}

export interface RiskPreflightInput {
  ctx: MoneyDomainPreflightCtx;
  planPreview: {
    lockTargets: Array<{ accountType: string; accountId: string }>;
    ledgerSummary?: {
      currency: string;
      postings: Array<{
        accountType: string;
        accountId: string;
        sign: LedgerAmountSign;
        amount: string;
      }>;
    };
  };
}

export type RiskPreflightResult =
  { outcome: 'PASS' } | { outcome: 'BLOCK'; reasonCode: string; message: string };
