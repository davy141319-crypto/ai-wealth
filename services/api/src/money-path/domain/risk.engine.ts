import type {
  MoneyDomainPreflightCtx,
  RiskPreflightInput,
  RiskPreflightResult,
} from './money-domain.types';

/**
 * RiskEngine — pure interface contract (P1-008).
 *
 * The risk engine runs ONLY in Phase A (preflight, outside DB tx, I/O OK:
 * can call external APIs / chain state / remote risk services).
 *
 * The two split methods allow callers to choose between:
 *   - thin: evaluateFromRequest(ctx) for early gate
 *   - rich: evaluatePreflight(input) after plan preview is built
 * Both MUST return either PASS or BLOCK with a stable code.
 */
export interface RiskEngine {
  evaluateFromRequest(ctx: MoneyDomainPreflightCtx): Promise<RiskPreflightResult>;
  evaluatePreflight(input: RiskPreflightInput): Promise<RiskPreflightResult>;
}

/**
 * Test stub used by orchestrator unit tests. Callers can preconfigure
 * PASS / BLOCK responses with static values.
 */
export class RiskEngineStub implements RiskEngine {
  constructor(
    private readonly reqResult: RiskPreflightResult = { outcome: 'PASS' },
    private readonly preResult: RiskPreflightResult = { outcome: 'PASS' },
  ) {}
  async evaluateFromRequest(_ctx: MoneyDomainPreflightCtx): Promise<RiskPreflightResult> {
    return this.reqResult;
  }
  async evaluatePreflight(_input: RiskPreflightInput): Promise<RiskPreflightResult> {
    return this.preResult;
  }
}
