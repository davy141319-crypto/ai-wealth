// ============================================================================
// LedgerEngine / validator unit tests.
// Prisma is mocked: persistence layer correctness lives in integration tests.
// ============================================================================

import { Repositories, UserRole } from '@ai-wealth/database';
import { AppError, MoneyPathErrorCode } from '@ai-wealth/shared';
import { readFileSync } from 'node:fs';

import { LedgerEngine, validateDoubleEntry } from '../ledger.engine';
import { LedgerAmountSign, LedgerTxnType } from '../types';
import type { WriteJournalInput } from '../ledger.engine';
import { AuditSensitiveMutationService } from '../../audit/audit-sensitive-mutation.service';

const mockRepos = (
  partial: {
    ledger?: Partial<Repositories['ledger']>;
    user?: Partial<Repositories['user']>;
    auditLog?: Partial<Repositories['auditLog']>;
  } = {},
): Repositories => {
  const r = {
    ledger: {
      createTxnWithPostings: jest.fn().mockResolvedValue({
        id: 'uuid',
        postings: [{ id: 'p1' }, { id: 'p2' }],
      }),
      findTxnByScopeAndKey: jest.fn().mockResolvedValue(null),
      findTxnById: jest.fn().mockResolvedValue(null),
      findReversalOf: jest.fn().mockResolvedValue(null),
      ...(partial.ledger ?? {}),
    } as unknown as Repositories['ledger'],
    user: {
      getAuthorizationContext: jest
        .fn()
        .mockResolvedValue({ role: UserRole.USER, status: 'ACTIVE' }),
      ...(partial.user ?? {}),
    } as unknown as Repositories['user'],
    auditLog: {
      create: jest.fn().mockResolvedValue({ id: 'audit-uuid' }),
      ...(partial.auditLog ?? {}),
    } as unknown as Repositories['auditLog'],
  } as unknown as Repositories;
  return r;
};

const validPlan = (): WriteJournalInput => ({
  scope: 'commission/test',
  txnIdempotencyKey: 'tx-a',
  txnType: LedgerTxnType.COMMISSION,
  currency: 'USDT',
  unit: 'MINOR_UNIT',
  decimals: 6,
  source: 'commission',
  actorUserId: null,
  requestId: 'req-1',
  postings: [
    {
      accountType: 'USER',
      accountId: 'a30077fe-c6ef-4d7a-a71f-9e4c35b7f2d1',
      sign: LedgerAmountSign.CREDIT,
      amount: '1000000',
    },
    {
      accountType: 'PLATFORM',
      accountId: 'platform',
      sign: LedgerAmountSign.DEBIT,
      amount: '1000000',
    },
  ],
});

describe('LedgerEngine unit tests', () => {
  it('AC-LED-01: exposes write/reverse/balanceProjection API', () => {
    const e = new LedgerEngine(new AuditSensitiveMutationService());
    expect(typeof e.write).toBe('function');
    expect(typeof e.reverse).toBe('function');
    expect(typeof e.balanceProjection).toBe('function');
  });

  it('AC-LED-02: idempotent replay returns { replayed: true, txn: existing } without calling create', async () => {
    const existing = { id: 'exist', postings: [{ id: 'p1' }] };
    const repos = mockRepos({
      ledger: {
        findTxnByScopeAndKey: jest.fn().mockResolvedValueOnce(existing),
      },
    });
    const e = new LedgerEngine(new AuditSensitiveMutationService());
    const out = await e.write(repos, validPlan());
    expect(out.replayed).toBe(true);
    expect(out.txn).toBe(existing);
    expect(repos.ledger.createTxnWithPostings).not.toHaveBeenCalled();
  });

  it('AC-LED-03: unbalanced plan is rejected before any write', async () => {
    const repos = mockRepos();
    const e = new LedgerEngine(new AuditSensitiveMutationService());
    const p = validPlan();
    p.postings[1].amount = '999999';
    const validation = validateDoubleEntry(p);
    expect(validation.ok).toBe(false);
    await expect(e.write(repos, p)).rejects.toBeInstanceOf(AppError);
    expect(repos.ledger.createTxnWithPostings).not.toHaveBeenCalled();
  });

  it('AC-LED-04/05: reversal create path passes reversal envelope', async () => {
    const original = {
      id: 'orig-1',
      currency: 'USDT',
      unit: 'MINOR_UNIT',
      decimals: 6,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      reference: null,
      postings: [
        {
          id: 'p1',
          accountType: 'USER',
          accountId: 'u1',
          sign: LedgerAmountSign.CREDIT,
          amount: { toString: () => '100' },
        },
        {
          id: 'p2',
          accountType: 'PLATFORM',
          accountId: 'platform',
          sign: LedgerAmountSign.DEBIT,
          amount: { toString: () => '100' },
        },
      ],
    };
    const createdTxn = {
      id: 'rev-1',
      txnType: LedgerTxnType.REVERSAL,
      currency: 'USDT',
      scope: 'rev',
      postings: [
        {
          id: 'rp1',
          accountType: 'USER',
          accountId: 'u1',
          sign: LedgerAmountSign.DEBIT,
          amount: { toString: () => '100' },
        },
        {
          id: 'rp2',
          accountType: 'PLATFORM',
          accountId: 'platform',
          sign: LedgerAmountSign.CREDIT,
          amount: { toString: () => '100' },
        },
      ],
    };
    const createMock = jest.fn().mockResolvedValue(createdTxn);
    const auditCreateMock = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const repos = mockRepos({
      ledger: {
        // reverse() calls findTxnById → original
        // write() (from reverse) calls findTxnById again for reversesTxnId validation
        // → use mockResolvedValue (not Once) so both calls return original
        findTxnById: jest.fn().mockResolvedValue(original),
        // write() reversesTxnId guard calls findReversalOf → null (no existing reversal)
        findReversalOf: jest.fn().mockResolvedValue(null),
        createTxnWithPostings: createMock,
      },
      auditLog: {
        create: auditCreateMock,
      },
    });
    const e = new LedgerEngine(new AuditSensitiveMutationService());
    await e.reverse(repos, {
      originalTxnId: 'orig-1',
      scope: 'rev',
      txnIdempotencyKey: 'rev-a',
      actorUserId: null,
      requestId: 'r',
      reason: 'wrong amount',
    });
    const [called] = createMock.mock.calls;
    expect(called[0].txnType).toBe(LedgerTxnType.REVERSAL);
    expect(called[0].reversesTxnId).toBe('orig-1');
    // Balanced mirror postings: per-leg reversesPostingId populated
    expect(
      called[0].postings.map((x: { reversesPostingId: unknown }) => x.reversesPostingId),
    ).toEqual(['p1', 'p2']);

    // PR #10 review blocker #4: reversal audit envelope must surface
    //   reason = opts.reason verbatim (not "reversal:orig-1")
    //   source = 'ledger'
    //   correlation = originalTxnId (not the reversal's txnIdempotencyKey)
    expect(auditCreateMock).toHaveBeenCalledTimes(1);
    const auditArg = auditCreateMock.mock.calls[0][0];
    const meta = auditArg.metadata as {
      before: unknown;
      after: unknown;
      reason: string | null;
      source: string;
      correlation: string;
    };
    expect(meta.reason).toBe('wrong amount'); // verbatim opts.reason
    expect(meta.source).toBe('ledger');
    expect(meta.correlation).toBe('orig-1'); // original txn id, not 'rev-a'
  });

  it('double reversal → LEDGER_REVERSAL_ALREADY_EXISTS before write', async () => {
    const repos = mockRepos({
      ledger: {
        findReversalOf: jest.fn().mockResolvedValueOnce({ id: 'r' }),
      },
    });
    const e = new LedgerEngine(new AuditSensitiveMutationService());
    await expect(
      e.write(repos, { ...validPlan(), reversesTxnId: 'orig-1', txnType: LedgerTxnType.REVERSAL }),
    ).rejects.toHaveProperty('reason', MoneyPathErrorCode.LEDGER_REVERSAL_ALREADY_EXISTS);
  });

  it('AC-LED-10 / RI-01: idempotency never writes literal DONE status string', () => {
    // Text scan: engine never writes DONE. CI runs grep separately.
    // We ensure the engine module text has no status=DONE.
    const src = require.resolve('../ledger.engine.ts');
    const text = readFileSync(src, 'utf8');
    expect(text.includes("= 'DONE'")).toBe(false);
    expect(text.includes('DONE`')).toBe(false);
    expect(text.includes('"DONE"')).toBe(false);
  });
});
