// ============================================================================
// LedgerRepository — append-only write + read-only lookups.
// No update() / delete() exposed by design. Immutable safety is also
// enforced at PostgreSQL via BEFORE UPDATE/DELETE triggers in the P1-008
// migration (belt-and-braces).
//
// NOTE: ledger reversal is performed by the APPLICATION (LedgerEngine) via
// create() — writing a brand new LedgerTransaction of type=REVERSAL +
// balanced LedgerPostings with reversesTxnId / reversesPostingId + DB
// UNIQUE(reversesTxnId)/UNIQUE(reversesPostingId) to prevent double reversal.
// This repository never mutates existing rows.
// ============================================================================

import { Prisma } from '@prisma/client';
import type {
  LedgerAmountSign,
  LedgerPosting,
  LedgerTransaction,
  LedgerTxnType,
} from '@prisma/client';
import { prisma } from '../client';
import { normalizePagination, type PaginationInput, type SortDirection } from '../types';

export interface LedgerPostingCreateInput {
  accountType: string;
  accountId: string;
  sign: LedgerAmountSign;
  amount: Prisma.Decimal | string | number;
  reversesPostingId?: string | null;
}

export interface LedgerTransactionCreateInput {
  scope: string;
  txnIdempotencyKey: string;
  txnType: LedgerTxnType;
  currency: string;
  unit: string;
  decimals?: number;
  source: string;
  reference?: string | null;
  reversesTxnId?: string | null;
  actorUserId?: string | null;
  requestId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
  postings: LedgerPostingCreateInput[];
}

export interface LedgerListOptions extends PaginationInput {
  scope?: string;
  txnType?: LedgerTxnType;
  currency?: string;
  source?: string;
  actorUserId?: string;
  createdAfter?: Date;
  createdBefore?: Date;
  orderBy?: { field: 'createdAt'; dir: SortDirection };
}

export class LedgerRepository {
  constructor(private readonly tx?: Prisma.TransactionClient) {}

  private get db() {
    return this.tx ?? prisma;
  }

  /**
   * Atomically create one journal header + postings.
   * Caller is responsible for:
   *   - Σ DEBIT === Σ CREDIT (LedgerEngine validates this before calling)
   *   - consistent currency/unit/decimals across legs
   *   - idempotency claim performed via IdempotencyKeyRepository
   * UNIQUE ledger_txn_scope_idempotency_uq at the DB acts as a final belt.
   */
  createTxnWithPostings(
    input: LedgerTransactionCreateInput,
  ): Promise<LedgerTransaction & { postings: LedgerPosting[] }> {
    const decimals = input.decimals ?? 6;
    const decimalAmt = (v: Prisma.Decimal | string | number) =>
      typeof v === 'string' || typeof v === 'number'
        ? new Prisma.Decimal(v as string | number)
        : (v as Prisma.Decimal);

    return this.db.ledgerTransaction.create({
      data: {
        scope: input.scope,
        txnIdempotencyKey: input.txnIdempotencyKey,
        txnType: input.txnType,
        currency: input.currency,
        unit: input.unit,
        decimals,
        source: input.source,
        reference: input.reference ?? null,
        reversesTxnId: input.reversesTxnId ?? null,
        actorUserId: input.actorUserId ?? null,
        requestId: input.requestId ?? null,
        metadata: input.metadata ?? Prisma.JsonNull,
        postings: {
          create: input.postings.map((p) => ({
            accountType: p.accountType,
            accountId: p.accountId,
            sign: p.sign,
            amount: decimalAmt(p.amount),
            reversesPostingId: p.reversesPostingId ?? null,
          })),
        },
      },
      include: { postings: true },
    });
  }

  findTxnById(id: string): Promise<(LedgerTransaction & { postings: LedgerPosting[] }) | null> {
    return this.db.ledgerTransaction.findUnique({
      where: { id },
      include: { postings: true },
    });
  }

  findTxnByScopeAndKey(
    scope: string,
    txnIdempotencyKey: string,
  ): Promise<(LedgerTransaction & { postings: LedgerPosting[] }) | null> {
    return this.db.ledgerTransaction.findUnique({
      where: { scope_txnIdempotencyKey: { scope, txnIdempotencyKey } },
      include: { postings: true },
    });
  }

  /** Returns the REVERSAL txn that negates originalTxnId, or null. */
  findReversalOf(originalTxnId: string): Promise<LedgerTransaction | null> {
    return this.db.ledgerTransaction.findUnique({
      where: { reversesTxnId: originalTxnId },
    });
  }

  listTxns(opts: LedgerListOptions = {}): Promise<LedgerTransaction[]> {
    const { skip, take } = normalizePagination(opts);
    const where: Prisma.LedgerTransactionWhereInput = {};
    if (opts.scope) where.scope = opts.scope;
    if (opts.txnType) where.txnType = opts.txnType;
    if (opts.currency) where.currency = opts.currency;
    if (opts.source) where.source = opts.source;
    if (opts.actorUserId) where.actorUserId = opts.actorUserId;
    if (opts.createdAfter || opts.createdBefore) {
      where.createdAt = {};
      if (opts.createdAfter) where.createdAt.gte = opts.createdAfter;
      if (opts.createdBefore) where.createdAt.lte = opts.createdBefore;
    }
    const dir = opts.orderBy?.dir ?? 'desc';
    return this.db.ledgerTransaction.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: dir },
      include: { postings: true },
    });
  }

  countTxns(where: Prisma.LedgerTransactionWhereInput = {}): Promise<number> {
    return this.db.ledgerTransaction.count({ where });
  }

  countPostings(where: Prisma.LedgerPostingWhereInput = {}): Promise<number> {
    return this.db.ledgerPosting.count({ where });
  }
}
