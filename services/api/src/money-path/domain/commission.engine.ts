import type { CommitPlan, MoneyDomainPreflightCtx } from './money-domain.types';

/**
 * CommissionEngine — pure interface contract (P1-008). Implementation is
 * intentionally NOT part of this foundation task.
 */
export interface CommissionEngine {
  preflight(ctx: MoneyDomainPreflightCtx): Promise<CommitPlan>;
}

export class CommissionEngineStub implements CommissionEngine {
  async preflight(_ctx: MoneyDomainPreflightCtx): Promise<CommitPlan> {
    throw new Error(
      'CommissionEngineStub.preflight is not implemented. P1-008 only provides the contract.',
    );
  }
}
