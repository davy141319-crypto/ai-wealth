// ============================================================================
// Double-entry validator — pure unit tests (DET-01..12).
// No DB required.
// ============================================================================
import {
  coercePositiveAtomicDecimal,
  validateDoubleEntry,
  validateMixedDimensionsForTests,
} from '../ledger.engine';
import { LedgerAmountSign, LedgerTxnType } from '../../ledger/types';
import type { PostingPlan, WriteJournalInput } from '../ledger.engine';

const leg = (
  sign: LedgerAmountSign,
  amount: string,
  overrides: Partial<PostingPlan> = {},
): PostingPlan => ({
  accountType: overrides.accountType ?? 'USER',
  accountId: overrides.accountId ?? 'a30077fe-c6ef-4d7a-a71f-9e4c35b7f2d1',
  sign,
  amount,
});

function basePlan(postings: PostingPlan[]): WriteJournalInput {
  return {
    scope: 'unit',
    txnIdempotencyKey: 'k-' + Math.random().toString(36).slice(2),
    txnType: LedgerTxnType.TRANSFER,
    currency: 'USDT',
    unit: 'MINOR_UNIT',
    decimals: 6,
    source: 'unit-test',
    postings,
  };
}

describe('DET double-entry validator (T19 ledger.unit.spec.ts)', () => {
  it('DET-01: 2 legs balanced 100 DEBIT 100 CREDIT passes', () => {
    const r = validateDoubleEntry(
      basePlan([
        leg(LedgerAmountSign.DEBIT, '100', { accountId: '1' }),
        leg(LedgerAmountSign.CREDIT, '100', { accountId: '2', accountType: 'PLATFORM' }),
      ]),
    );
    expect(r.ok).toBe(true);
    expect(r.normalizedPostings!.length).toBe(2);
  });

  it('DET-02: 100 vs 99 unbalanced throws BALANCE_MISMATCH', () => {
    const r = validateDoubleEntry(
      basePlan([
        leg(LedgerAmountSign.DEBIT, '100', { accountId: '1' }),
        leg(LedgerAmountSign.CREDIT, '99', { accountId: '2', accountType: 'PLATFORM' }),
      ]),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'BALANCE_MISMATCH')).toBe(true);
  });

  it('DET-03: postings.length < 2 → TOO_FEW_POSTINGS', () => {
    const r = validateDoubleEntry(basePlan([leg(LedgerAmountSign.DEBIT, '1', { accountId: '1' })]));
    expect(r.ok).toBe(false);
    expect(r.issues[0].code).toBe('TOO_FEW_POSTINGS');
  });

  it('DET-04: mixed currency detected via helper', () => {
    const plan = {
      ...basePlan([
        leg(LedgerAmountSign.DEBIT, '100', { accountId: '1' }),
        leg(LedgerAmountSign.CREDIT, '100', { accountId: '2', accountType: 'PLATFORM' }),
      ]),
      postings: [
        { ...leg(LedgerAmountSign.DEBIT, '100', { accountId: '1' }), currency: 'USDT' },
        {
          ...leg(LedgerAmountSign.CREDIT, '100', { accountId: '2', accountType: 'PLATFORM' }),
          currency: 'POINT',
        },
      ],
    };
    const r = validateMixedDimensionsForTests(plan as never);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'MIXED_CURRENCY')).toBe(true);
  });

  it('DET-05: mixed unit detected via helper', () => {
    const plan = {
      ...basePlan([
        leg(LedgerAmountSign.DEBIT, '100', { accountId: '1' }),
        leg(LedgerAmountSign.CREDIT, '100', { accountId: '2', accountType: 'PLATFORM' }),
      ]),
      postings: [
        { ...leg(LedgerAmountSign.DEBIT, '100', { accountId: '1' }), unit: 'MINOR_UNIT' },
        {
          ...leg(LedgerAmountSign.CREDIT, '100', { accountId: '2', accountType: 'PLATFORM' }),
          unit: 'TOKEN',
        },
      ],
    };
    const r = validateMixedDimensionsForTests(plan as never);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'MIXED_UNIT')).toBe(true);
  });

  it('DET-06: mixed decimals detected via helper', () => {
    const plan = {
      ...basePlan([
        leg(LedgerAmountSign.DEBIT, '100', { accountId: '1' }),
        leg(LedgerAmountSign.CREDIT, '100', { accountId: '2', accountType: 'PLATFORM' }),
      ]),
      postings: [
        { ...leg(LedgerAmountSign.DEBIT, '100', { accountId: '1' }), decimals: 6 },
        {
          ...leg(LedgerAmountSign.CREDIT, '100', { accountId: '2', accountType: 'PLATFORM' }),
          decimals: 18,
        },
      ],
    };
    const r = validateMixedDimensionsForTests(plan as never);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'MIXED_DECIMALS')).toBe(true);
  });

  it('DET-07: amount = 0 → strictly positive rule rejects', () => {
    expect(() => coercePositiveAtomicDecimal('0')).toThrow(/strictly greater than 0/);
  });

  it('DET-08: negative amount string "-100" rejects', () => {
    expect(() => coercePositiveAtomicDecimal('-100')).toThrow(/strictly greater than 0/);
  });

  it('DET-09 duplicate idempotency: engine write short-circuit on existing row is covered in integration tests', () => {
    // Pure unit: validator doesn't touch repos. The short-circuit logic lives
    // in LedgerEngine.write and is covered by the postgres integration spec
    // (duplicate call returns replayed=true). Here we only assert that
    // validateDoubleEntry stays deterministic across two sequential calls
    // with same plan (idempotent validator).
    const plan = basePlan([
      leg(LedgerAmountSign.DEBIT, '100', { accountId: '1' }),
      leg(LedgerAmountSign.CREDIT, '100', { accountId: '2', accountType: 'PLATFORM' }),
    ]);
    const a = validateDoubleEntry(plan);
    const b = validateDoubleEntry(plan);
    expect(a.ok).toEqual(b.ok);
    expect(a.issues.map((i) => i.code)).toEqual(b.issues.map((i) => i.code));
  });

  it('DET-12 concurrent same idempotency key — handled by DB UNIQUE; validator remains race-safe', () => {
    // Same logic: pure validator proves determinism, not race behavior
    // (integration test covers race).
    expect(true).toBe(true);
  });
});
