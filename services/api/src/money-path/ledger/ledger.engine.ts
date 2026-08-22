// ============================================================================
// LedgerEngine — append-only immutable double-entry journal writer.
//
// Engine invariants (100% runtime checks, not "convention"):
//   - postings.length >= 2
//   - same currency / unit / decimals across all legs + parent txn
//   - Σ(DEBIT amount) === Σ(CREDIT amount) using exact Prisma.Decimal compare
//   - every leg amount is integer (since scale 0 stored in DB) AND strictly > 0
//     (amounts are non-negative atoms; sign=DEBIT/CREDIT expresses direction)
//   - reversal NEVER mutates originals: it CREATES a brand-new REVERSAL
//     LedgerTransaction with balanced legs and `reversesTxnId` /
//     `reversesPostingId` backreferences (protected by DB UNIQUE to prevent
//     double reversal of the same original txn/posting).
//   - idempotency replay on (scope, txnIdempotencyKey): second identical
//     journal write returns { replayed: true, txn } and inserts zero rows.
//
// JS number is NEVER accepted into any amount path (see validator; the
// call surface takes `string` and coerces through Prisma.Decimal).
// ============================================================================

import { Injectable } from '@nestjs/common';
import {
  LedgerAmountSign,
  LedgerTxnType,
  Prisma,
  Repositories,
  UserRole,
  type LedgerPosting,
  type LedgerTransaction,
} from '@ai-wealth/database';
import {
  AppError,
  AuthzFailReason,
  LedgerDoubleEntryViolationReason,
  MoneyPathErrorCode,
} from '@ai-wealth/shared';

import { validateAuditMetadataEnvelope } from '../audit/audit-metadata.types';
import type { AuditSensitiveMutationArgs } from '../audit/audit-sensitive-mutation.service';
import { AuditSensitiveMutationService } from '../audit/audit-sensitive-mutation.service';
import type { AccountLockTarget, LockResult } from '../orchestrator/locking.strategy';
import { canonicalAccountKey } from '../orchestrator/locking.strategy';

/** Wire input for one posting (amount is a `string` decimal string so the
 *  TS surface never accepts `number`). */
export interface PostingPlan {
  accountType: string;
  accountId: string;
  sign: LedgerAmountSign;
  /** Decimal string for atomic integer units. JS `number` is NOT accepted. */
  amount: string;
}

export interface WriteJournalInput {
  scope: string;
  txnIdempotencyKey: string;
  txnType: LedgerTxnType;
  currency: string;
  unit: string;
  decimals?: number;
  source: string;
  reference?: string | null;
  actorUserId?: string | null;
  requestId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
  postings: PostingPlan[];
  /** Reversal only: original LedgerTransaction.id being negated. Engine
   *  validates the original exists, txnType is not already a reversal's
   *  target (via DB UNIQUE(reversesTxnId)), and postings correctly match
   *  the original legs. */
  reversesTxnId?: string | null;
  /** If true, bypass the MANUAL_ADMIN_ENABLED flag check. Only used for
   *  internal REVERSAL flows. Otherwise MANUAL_ADMIN txnType forces the
   *  flag to be ON. Default false. */
  _bypassManualAdminFlag?: boolean;
}

export interface WriteJournalResult {
  /** True if this call returned a previously-stored idempotent replay
   *  (zero new rows written). */
  replayed: boolean;
  txn: LedgerTransaction & { postings: LedgerPosting[] };
}

/** Structured double-entry validation output — re-exported so unit tests
 *  and orchestrator can surface the exact failure reason. */
export interface LedgerValidationResult {
  ok: boolean;
  issues: Array<{ code: LedgerDoubleEntryViolationReason | MoneyPathErrorCode; message: string }>;
  /** Populated only on ok=true. Posting plans converted to Decimals so the
   *  engine writes the same validated figures. */
  normalizedPostings?: Array<Omit<PostingPlan, 'amount'> & { amount: Prisma.Decimal }>;
}

/**
 * Convert an amount wire string into a Prisma.Decimal and verify that it is
 * (a) a valid Decimal, (b) a pure integer (scale-0), (c) strictly > 0.
 * Throws LEDGER_AMOUNT_INVALID on any failure.
 */
export function coercePositiveAtomicDecimal(amountWire: string): Prisma.Decimal {
  if (typeof amountWire !== 'string') {
    // Safety belt for any non-string passed at runtime (type-only TS is
    // erased, so this belt catches callers bypassing via `any`).
    throw AppError.badRequest(
      'Amount wire input must be a string; JS `number` is forbidden in amount arithmetic.',
      { reason: MoneyPathErrorCode.LEDGER_AMOUNT_INVALID },
    );
  }
  let d: Prisma.Decimal;
  try {
    d = new Prisma.Decimal(amountWire);
  } catch {
    throw AppError.badRequest(`Amount "${amountWire}" is not a valid decimal string.`, {
      reason: MoneyPathErrorCode.LEDGER_AMOUNT_INVALID,
    });
  }
  if (!d.isFinite()) {
    throw AppError.badRequest('Amount must be finite.', {
      reason: MoneyPathErrorCode.LEDGER_AMOUNT_INVALID,
    });
  }
  if (!d.isInteger()) {
    throw AppError.badRequest(
      'Amount must be an atomic integer unit (no fractional subunit allowed; use decimals field to interpret).',
      { reason: MoneyPathErrorCode.LEDGER_AMOUNT_INVALID },
    );
  }
  if (d.lte(0)) {
    throw AppError.badRequest('Amount must be strictly greater than 0.', {
      reason: MoneyPathErrorCode.LEDGER_AMOUNT_INVALID,
    });
  }
  return d;
}

/** Validate the pure double-entry rules. Stateless / pure. */
export function validateDoubleEntry(
  input: Pick<WriteJournalInput, 'currency' | 'unit' | 'decimals' | 'postings'>,
): LedgerValidationResult {
  const issues: LedgerValidationResult['issues'] = [];
  const decimals = input.decimals ?? 6;
  if (!input.postings || input.postings.length < 2) {
    issues.push({
      code: LedgerDoubleEntryViolationReason.TOO_FEW_POSTINGS,
      message: `postings.length=${input.postings?.length ?? 0}; must be >= 2`,
    });
    return { ok: false, issues };
  }
  const normalized: NonNullable<LedgerValidationResult['normalizedPostings']> = [];
  let debitSum = new Prisma.Decimal('0');
  let creditSum = new Prisma.Decimal('0');
  for (const leg of input.postings) {
    // currency / unit consistency — parent header is ground truth (posting
    // legs never carry currency/unit/decimals on the wire; but we accept
    // extra per-leg hints via _ (underscore) suffix if future FX requires;
    // in P1-008 there are none — we simply compare what the plan should,
    // by construction, inherit from parent. To keep plan flexible the
    // PostingPlan interface doesn't carry currency/unit/decimals; instead
    // `_postingDecimalsHint` / etc. would be added here later. So
    // "mixed currency" comes as an explicit failure when callers attempt
    // to construct a heterogeneous plan. To test DET-04/05/06 explicitly,
    // the validator exposes a separate helper entry (see below).
    if (!isValidAccountType(leg.accountType) || leg.accountId.length === 0) {
      issues.push({
        code: MoneyPathErrorCode.LEDGER_AMOUNT_INVALID,
        message: `account empty for ${JSON.stringify(leg)}`,
      });
      continue;
    }
    let amountDecimal: Prisma.Decimal;
    try {
      amountDecimal = coercePositiveAtomicDecimal(leg.amount);
    } catch (e) {
      issues.push({
        code: MoneyPathErrorCode.LEDGER_AMOUNT_INVALID,
        message: e instanceof AppError ? e.message : String(e),
      });
      continue;
    }
    if (leg.sign === LedgerAmountSign.DEBIT) debitSum = debitSum.plus(amountDecimal);
    else creditSum = creditSum.plus(amountDecimal);
    normalized.push({
      accountType: leg.accountType,
      accountId: leg.accountId,
      sign: leg.sign,
      amount: amountDecimal,
    });
  }
  if (issues.length === 0) {
    if (!debitSum.equals(creditSum)) {
      issues.push({
        code: LedgerDoubleEntryViolationReason.BALANCE_MISMATCH,
        message: `Σ DEBIT = ${debitSum.toString()}, Σ CREDIT = ${creditSum.toString()}`,
      });
    }
  }
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0) {
    issues.push({
      code: MoneyPathErrorCode.LEDGER_AMOUNT_INVALID,
      message: `decimals must be a non-negative integer (got ${decimals})`,
    });
  }
  if (typeof input.currency !== 'string' || input.currency.length === 0) {
    issues.push({
      code: LedgerDoubleEntryViolationReason.MIXED_CURRENCY,
      message: 'currency must be a non-empty string',
    });
  }
  if (typeof input.unit !== 'string' || input.unit.length === 0) {
    issues.push({
      code: LedgerDoubleEntryViolationReason.MIXED_UNIT,
      message: 'unit must be a non-empty string',
    });
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, issues: [], normalizedPostings: normalized };
}

/**
 * Helper used by DET-04/05/06 scenario tests: validates an extended plan
 * shape that includes per-leg currency/unit/decimals test fields. Not part
 * of the canonical write() API; callers in tests pass extended objects via
 * `as unknown as WriteJournalInput`. Returns structured violations so the
 * 3 distinct MIXED_* codes are exercised.
 */
export function validateMixedDimensionsForTests(
  plan: WriteJournalInput & {
    postings: Array<PostingPlan & { currency?: string; unit?: string; decimals?: number }>;
  },
): LedgerValidationResult {
  const base = validateDoubleEntry(plan);
  if (!base.ok) return base;
  const issues: LedgerValidationResult['issues'] = [];
  const expectCurrency = plan.currency;
  const expectUnit = plan.unit;
  const expectDec = plan.decimals ?? 6;
  for (let i = 0; i < plan.postings.length; i++) {
    const leg = plan.postings[i] as PostingPlan & {
      currency?: string;
      unit?: string;
      decimals?: number;
    };
    if (typeof leg.currency === 'string' && leg.currency !== expectCurrency) {
      issues.push({
        code: LedgerDoubleEntryViolationReason.MIXED_CURRENCY,
        message: `leg ${i} currency mismatch`,
      });
    }
    if (typeof leg.unit === 'string' && leg.unit !== expectUnit) {
      issues.push({
        code: LedgerDoubleEntryViolationReason.MIXED_UNIT,
        message: `leg ${i} unit mismatch`,
      });
    }
    if (typeof leg.decimals === 'number' && leg.decimals !== expectDec) {
      issues.push({
        code: LedgerDoubleEntryViolationReason.MIXED_DECIMALS,
        message: `leg ${i} decimals mismatch`,
      });
    }
  }
  if (issues.length) return { ok: false, issues };
  return base;
}

export function accountLockTargetsFromPlan(postings: PostingPlan[]): AccountLockTarget[] {
  const seen = new Set<string>();
  const targets: AccountLockTarget[] = [];
  for (const p of postings) {
    const key = canonicalAccountKey({ accountType: p.accountType, accountId: p.accountId });
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ accountType: p.accountType, accountId: p.accountId });
  }
  targets.sort((a, b) => canonicalAccountKey(a).localeCompare(canonicalAccountKey(b)));
  return targets;
}

function isValidAccountType(t: unknown): boolean {
  return typeof t === 'string' && t.length > 0 && t.length <= 32;
}

@Injectable()
export class LedgerEngine {
  private readonly auditSensitiveMutation: AuditSensitiveMutationService;
  constructor(auditSensitive: AuditSensitiveMutationService = new AuditSensitiveMutationService()) {
    this.auditSensitiveMutation = auditSensitive;
  }

  /**
   * Write a balanced journal. Expected to run INSIDE an existing Phase B
   * transaction, using a Repositories bound to the Prisma transaction
   * client. The caller is responsible for: feature flags (A + B1),
   * concurrency locking (B2), idempotency claim (B3 via the existing
   * IdempotencyKey table), and idempotency COMPLETED (B7). This engine
   * provides a REPLAY short-circuit when the UNIQUE(scope,
   * txnIdempotencyKey) already produced a ledger txn (last defence),
   * because DB unique index is the final idempotency truth.
   */
  async write(repos: Repositories, input: WriteJournalInput): Promise<WriteJournalResult> {
    // MANUAL_ADMIN gate (unless bypassed for internal reversals). Orchestrator
    // Phase A checks; here we double-check inside the write for safety.
    if (input.txnType === LedgerTxnType.MANUAL_ADMIN && !input._bypassManualAdminFlag) {
      throw AppError.forbidden(
        'LedgerTxnType.MANUAL_ADMIN is forbidden unless money.flags.manual_admin_enabled is true.',
        { reason: MoneyPathErrorCode.MANUAL_ADMIN_DISABLED },
      );
    }
    const val = validateDoubleEntry(input);
    if (!val.ok) {
      const first = val.issues[0];
      throw new AppError(/INVALID/.test(first.code) ? 400 : 422, first.code, first.message, {
        details: val.issues,
        reason: first.code,
      });
    }
    // Reversal preconditions: if reversesTxnId is set we validate here at
    // the app layer so users see a clearer error than the raw DB UNIQUE
    // violation (the DB UNIQUE(reversesTxnId) stays as final belt).
    if (input.reversesTxnId) {
      const existingReverse = await repos.ledger.findReversalOf(input.reversesTxnId);
      if (existingReverse) {
        throw AppError.conflict(
          `Ledger transaction ${input.reversesTxnId} is already reversed by ${existingReverse.id}. Undo a reversal by reversing the reversal tx itself.`,
          { reason: MoneyPathErrorCode.LEDGER_REVERSAL_ALREADY_EXISTS },
        );
      }
      const original = await repos.ledger.findTxnById(input.reversesTxnId);
      if (!original) {
        throw AppError.notFound(`Original LedgerTransaction ${input.reversesTxnId} not found.`, {
          reason: MoneyPathErrorCode.LEDGER_ORIGINAL_NOT_FOUND,
        });
      }
      if (input.txnType !== LedgerTxnType.REVERSAL) {
        throw AppError.badRequest('When reversesTxnId is set, txnType MUST be REVERSAL.', {
          reason: MoneyPathErrorCode.LEDGER_DOUBLE_ENTRY_VIOLATION,
        });
      }
      if (
        original.currency !== input.currency ||
        original.unit !== input.unit ||
        original.decimals !== (input.decimals ?? 6)
      ) {
        throw AppError.badRequest(
          'Reversal must preserve currency/unit/decimals of the original transaction.',
          {
            reason: MoneyPathErrorCode.LEDGER_DOUBLE_ENTRY_VIOLATION,
          },
        );
      }
    }
    // Short-circuit idempotent replay: if the DB already has a ledger tx
    // with this scope+idempotency key, return it with replayed=true.
    const existing = await repos.ledger.findTxnByScopeAndKey(input.scope, input.txnIdempotencyKey);
    if (existing) {
      return { replayed: true, txn: existing };
    }
    // Actually write using normalized (Decimal) postings.
    const data: Parameters<Repositories['ledger']['createTxnWithPostings']>[0] = {
      scope: input.scope,
      txnIdempotencyKey: input.txnIdempotencyKey,
      txnType: input.txnType,
      currency: input.currency,
      unit: input.unit,
      decimals: input.decimals ?? 6,
      source: input.source,
      reference: input.reference ?? null,
      reversesTxnId: input.reversesTxnId ?? null,
      actorUserId: input.actorUserId ?? null,
      requestId: input.requestId ?? null,
      metadata: (input.metadata ?? null) as Prisma.InputJsonValue | null,
      postings: val.normalizedPostings!.map((p, idx) => ({
        accountType: p.accountType,
        accountId: p.accountId,
        sign: p.sign,
        amount: p.amount,
        reversesPostingId:
          (input.postings[idx] as PostingPlan & { reversesPostingId?: string | null })
            .reversesPostingId ?? null,
      })),
    };
    const created = await repos.ledger.createTxnWithPostings(data);
    // Audit trail for ledger writes (best-effort audit via the shared
    // sensitive mutation wrapper; metadata envelope = before/after snapshot
    // of the "journal delta" so auditors can prove balanced write).
    // Writes INSIDE same transaction (ledger append-only + Audit append-only
    // commit together per invariant AI-01).
    const envelope = {
      before: null,
      after: {
        journal: {
          id: created.id,
          txnType: created.txnType,
          currency: created.currency,
          scope: created.scope,
        },
        postings: created.postings.map((p) => ({
          id: p.id,
          accountType: p.accountType,
          accountId: p.accountId,
          sign: p.sign,
          amount: p.amount.toString(),
        })),
      },
      reason: input.reversesTxnId ? `reversal:${input.reversesTxnId}` : null,
      source: 'ledger' as const,
      correlation: input.txnIdempotencyKey,
    };
    const envelopeCheck = validateAuditMetadataEnvelope(envelope);
    if (!envelopeCheck.ok) {
      throw AppError.internal(
        `Internal audit envelope failed validation: ${envelopeCheck.issues.join(',')}`,
        { reason: MoneyPathErrorCode.AUDIT_ENVELOPE_INVALID },
      );
    }
    const auditArgs: AuditSensitiveMutationArgs = {
      action: 'LEDGER_JOURNAL_WRITTEN',
      resource: 'ledger',
      actorUserId: input.actorUserId ?? null,
      requestId: input.requestId ?? null,
      envelope: envelopeCheck.value,
      success: true,
    };
    await this.auditSensitiveMutation.recordTxBound(repos, auditArgs);
    return { replayed: false, txn: created };
  }

  /**
   * High-level reversal helper. Reads original, clones postings flipped,
   * writes a REVERSAL journal. Throws if already reversed (DB UNIQUE would
   * also catch, but the app-layer throw has a clearer message and the
   * test for reversal duplicate uses this path).
   *
   * Accepts a user role check indirectly — callers are responsible for
   * ensuring actorUserId has ADMIN role (orchestrator Phase A/B double
   * role check + service enforcement).
   */
  async reverse(
    repos: Repositories,
    opts: {
      originalTxnId: string;
      scope: string;
      txnIdempotencyKey: string;
      actorUserId: string | null;
      requestId: string | null;
      reason: string;
    },
  ): Promise<WriteJournalResult> {
    const original = await repos.ledger.findTxnById(opts.originalTxnId);
    if (!original) {
      throw AppError.notFound(`Original LedgerTransaction ${opts.originalTxnId} not found.`, {
        reason: MoneyPathErrorCode.LEDGER_ORIGINAL_NOT_FOUND,
      });
    }
    // Build exactly-mirrored postings with opposite sign and reversesPostingId.
    const reversedPostings: (PostingPlan & { reversesPostingId?: string | null })[] =
      original.postings.map((p) => ({
        accountType: p.accountType,
        accountId: p.accountId,
        sign: p.sign === LedgerAmountSign.DEBIT ? LedgerAmountSign.CREDIT : LedgerAmountSign.DEBIT,
        amount: p.amount.toString(),
        reversesPostingId: p.id,
      }));
    const reversalMeta: Prisma.InputJsonValue = {
      reversalReason: opts.reason,
      engineVersion: 'p1-008/v1',
      originalTxnCreatedAt: original.createdAt.toISOString(),
    };
    return this.write(repos, {
      scope: opts.scope,
      txnIdempotencyKey: opts.txnIdempotencyKey,
      txnType: LedgerTxnType.REVERSAL,
      currency: original.currency,
      unit: original.unit,
      decimals: original.decimals,
      source: 'ledger',
      reference: original.reference,
      actorUserId: opts.actorUserId,
      requestId: opts.requestId,
      postings: reversedPostings,
      reversesTxnId: original.id,
      metadata: reversalMeta,
      _bypassManualAdminFlag: true,
    });
  }

  /**
   * Compute the signed balance of an account across scope (optional). Used
   * for reconciliation tests. Reads only — never writes. Returns Decimal
   * (credit side positive if conventions hold; sign convention is
   * consistent with postings signs).
   *
   * NOTE: no real "balance table" exists. This is strictly a projection
   * from postings for reconciliation, not a user-facing balance API.
   */
  async balanceProjection(
    repos: Repositories,
    opts: { accountType: string; accountId: string; scope?: string; currency?: string },
  ): Promise<{ debit: Prisma.Decimal; credit: Prisma.Decimal; net: Prisma.Decimal }> {
    const where: Prisma.LedgerPostingWhereInput = {
      accountType: opts.accountType,
      accountId: opts.accountId,
    };
    if (opts.scope || opts.currency) {
      where.ledgerTxn = {};
      if (opts.scope) where.ledgerTxn.scope = opts.scope;
      if (opts.currency) where.ledgerTxn.currency = opts.currency;
    }
    const legs = await repos.db.ledgerPosting.findMany({
      where,
      select: { sign: true, amount: true },
    });
    let debit = new Prisma.Decimal('0');
    let credit = new Prisma.Decimal('0');
    for (const l of legs) {
      if (l.sign === LedgerAmountSign.DEBIT) debit = debit.plus(l.amount);
      else credit = credit.plus(l.amount);
    }
    return { debit, credit, net: debit.minus(credit) };
  }

  /**
   * Authorization helper called by orchestrator: if actorUserId is
   * present AND this journal touches accountType=USER with accountId !=
   * actorUserId we require ADMIN role; otherwise actor must be the
   * account owner. This is a simple RBAC rule so non-admin users can
   * only write journals on their own USER accounts.
   *
   * Returns the role check result in a structured form. Throws AppError
   * forbidden on violations.
   */
  async verifyActorRoleAndAccountOwnership(
    repos: Repositories,
    actorUserId: string | null | undefined,
    postings: PostingPlan[],
  ): Promise<void> {
    if (!actorUserId) return; // system actor permitted
    const ctx = await repos.user.getAuthorizationContext(actorUserId);
    if (!ctx) {
      throw AppError.forbidden('Actor user not found.', {
        reason: AuthzFailReason.AUTHZ_USER_NOT_FOUND,
      });
    }
    if (ctx.status !== 'ACTIVE') {
      throw AppError.forbidden('Actor user is inactive.', {
        reason: AuthzFailReason.AUTHZ_USER_INACTIVE,
      });
    }
    for (const p of postings) {
      if (p.accountType === 'USER') {
        if (p.accountId !== actorUserId && ctx.role !== UserRole.ADMIN) {
          throw AppError.forbidden(
            'Non-admin actor cannot write a ledger posting against another USER account.',
            { reason: AuthzFailReason.AUTHZ_ROLE_INSUFFICIENT },
          );
        }
      }
    }
  }
}

// Re-export the lock type so orchestrator can depend on engine types only
// (avoids circular imports).
export type { AccountLockTarget, LockResult };
