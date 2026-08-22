import type { Repositories } from '@ai-wealth/database';
import type { CommitPlan, MoneyDomainPreflightCtx } from './money-domain.types';

/**
 * SettlementEngine — pure interface contract (P1-008). Implementation is
 * intentionally NOT part of the foundation task. The interface guarantees:
 *   - Preflight(ctx): runs in Phase A (I/O OK) to build a commit plan.
 *   - Commit plan is deterministic for identical ctx.input.
 * Future settlement implementations MUST implement this interface so the
 * TwoPhaseOrchestrator can run them uniformly.
 */
export interface SettlementEngine {
  preflight(ctx: MoneyDomainPreflightCtx): Promise<CommitPlan>;
}

/**
 * No-op stub used by orchestrator tests. Throws if actually called —
 * production implementations are provided in later phases.
 */
export class SettlementEngineStub implements SettlementEngine {
  async preflight(_ctx: MoneyDomainPreflightCtx): Promise<CommitPlan> {
    throw new Error(
      'SettlementEngineStub.preflight is not implemented. P1-008 only provides the contract.',
    );
  }
}

/**
 * Post-commit hook (optional, informational only — runs OUTSIDE Phase B
 * after commit, e.g. publish notification). NEVER writes to any money-path
 * persistence.
 */
export type SettlementPostCommitHook = (
  repos: Repositories,
  commitResult: unknown,
) => Promise<void>;
