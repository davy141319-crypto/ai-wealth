// ============================================================================
// Money-path two-phase orchestrator.
//
// Phase A (preflight, outside DB tx, I/O OK):
//   A1  Auth/RBAC              → actorUserId & role live re-read (already
//                               done by HTTP guards, but preflight double-
//                               checks role for ADMIN-only ops).
//   A2  Validation            → deterministic parsed input.
//   A3  Canonical request hash → SHA-256 of JSON.stringified stable fields.
//   A4  Initial flag check     → all flags in requiredFlags enabled.
//   A5  Risk preflight        → RiskEngine evaluateFromRequest +
//                               evaluatePreflight after plan preview.
//   A6  Deterministic commit plan → engine.preflight(ctx).
//
// Phase B (short Serializable DB transaction, NO I/O):
//   B1  Flag re-check          → TOCTOU protection.
//   B2  Lock accounts          → sorted FOR UPDATE / advisory locks.
//   B3  Idempotency claim      → PENDING / route to replay or 409s.
//   B4  Domain state mutation  → if plan.stateMutation set.
//   B5  Balanced ledger write  → LedgerEngine.write/reverse.
//   B6  Audit envelope         → if plan.auditEnvelope set.
//   B7  Idempotency COMPLETED  → response snapshot stored.
//   B8  COMMIT.
//
// Top-level retry: if Phase B2 lock-timeout OR Phase B8 serialization
// failure, run the ENTIRE A+B pipeline once again (exactly 1 auto-retry).
// Any subsequent failure → 503 with the appropriate MoneyPathErrorCode.
// ============================================================================

import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { AppError, AppErrorCode, AuthzFailReason, MoneyPathErrorCode } from '@ai-wealth/shared';
import { Prisma, Repositories, UserRole, prisma } from '@ai-wealth/database';
import type { IdempotencyKey } from '@ai-wealth/database';

import { LedgerEngine, accountLockTargetsFromPlan } from '../ledger';
import type { WriteJournalInput } from '../ledger/ledger.engine';
import { FeatureFlagService } from '../flags/feature-flag.service';
import type {
  MoneyDomainPreflightCtx,
  RiskEngine,
  SettlementEngine,
  CommissionEngine,
} from '../domain';
import { IdempotencyIntegration } from './idempotency.integration';
import { acquireAccountLocks, canonicalAccountKey } from './locking.strategy';
import { AuditSensitiveMutationService, type AuditSensitiveMutationArgs } from '../audit';

/**
 * Inputs the orchestrator needs to execute a single A+B run. Callers are
 * thin controllers (or tests) that MUST go through this orchestrator
 * rather than touching repositories / persistence directly. The strict
 * controller-bypass rule is enforced by a dedicated architecture test
 * (T18 controller-db-bypass.spec.ts).
 */
export interface TwoPhaseRunInput {
  /** Raw, unvalidated payload. Validation is Phase A2, deterministic. */
  rawInput: unknown;
  /** Zod / class-validator function. Must be pure. */
  validate: (raw: unknown) => { ok: true; value: unknown } | { ok: false; message: string };
  /** Money-path operation scope (drives idempotency UNIQUE partitioning). */
  scope: string;
  /** Client-supplied idempotency key. */
  idempotencyKey: string;
  /** Authenticated user id or null (anonymous/system). */
  actorUserId: string | null;
  /** Minimum required role (USER/ADMIN). Phase A1. */
  requiredRole: UserRole;
  /** Optional request metadata for correlation/audit. */
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Domain engine (SettlementEngine OR CommissionEngine). The orchestrator
   *  dispatches to engine.preflight in Phase A6. */
  engine: SettlementEngine | CommissionEngine;
  /** Risk engine (Phase A5). */
  riskEngine: RiskEngine;
  /** Flags required for this operation (Phase A4 + Phase B1). */
  requiredFlags?: Array<{ scope: string; feature: string }>;
  /** Idempotency TTL in ms. Default: 24h. */
  ttlMs?: number;
}

export interface TwoPhaseRunResult {
  statusCode: number;
  body: unknown;
  /** True if an earlier COMPLETED idempotency replay produced this result. */
  replayed: boolean;
  /** True if the orchestrator performed its one auto retry before success. */
  retried: boolean;
}

/**
 * Canonical SHA-256 hex hash of a stable JSON serialization. Used as the
 * idempotency requestHash (so identical payloads reuse responses while
 * payload-tampering gets 409 IDEMPOTENCY_CONFLICT).
 */
export function canonicalRequestHash(
  scope: string,
  idempotencyKey: string,
  validatedInput: unknown,
): string {
  const stable = JSON.stringify({ scope, idempotencyKey, input: validatedInput });
  return createHash('sha256').update(stable, 'utf8').digest('hex');
}

/**
 * Throw PHASE_B_IO_FORBIDDEN when network is attempted inside Phase B.
 * This dev-guard is only triggered when the test harness installs a
 * fetch-mock. In production there is no guard — the architecture test
 * AC-TXN-23 catches accidental I/O via static analysis.
 */
export function installPhaseBIoGuard(): () => void {
  if (typeof (globalThis as unknown as { fetch?: unknown }).fetch === 'undefined')
    return () => undefined;
  const orig = globalThis.fetch as typeof fetch;
  const handler = () => {
    throw new AppError(
      500,
      MoneyPathErrorCode.PHASE_B_IO_FORBIDDEN,
      'Network I/O is forbidden inside Phase B.',
    );
  };
  (globalThis as unknown as { fetch: typeof fetch }).fetch = handler as unknown as typeof fetch;
  return () => {
    (globalThis as unknown as { fetch: typeof fetch }).fetch = orig;
  };
}

@Injectable()
export class TwoPhaseOrchestrator {
  private readonly prismaClient: typeof prisma;
  private readonly reposFactory: (tx?: Prisma.TransactionClient) => Repositories;

  constructor(
    private readonly ledger: LedgerEngine = new LedgerEngine(),
    private readonly flags: FeatureFlagService = new FeatureFlagService(),
    private readonly audit: AuditSensitiveMutationService = new AuditSensitiveMutationService(),
    opts?: {
      /** Override singleton prisma client (used ONLY by unit tests that
       *  intentionally want to avoid the global PrismaClient which
       *  requires a live DB connection). Production MUST leave unset. */
      prismaClient?: typeof prisma;
      /** Override Repositories constructor — primarily for test DI. */
      reposFactory?: (tx?: Prisma.TransactionClient) => Repositories;
    },
  ) {
    this.prismaClient = opts?.prismaClient ?? prisma;
    this.reposFactory = opts?.reposFactory ?? ((tx) => new Repositories(tx));
  }

  async run(input: TwoPhaseRunInput): Promise<TwoPhaseRunResult> {
    try {
      return await this.runOnce(input, /* retried= */ false);
    } catch (err: unknown) {
      if (isAutoRetryablePhaseBFailure(err)) {
        return this.runOnce(input, /* retried= */ true).catch((e2: unknown) => {
          // Second failure → 503 explicit.
          if (isSerializationFailure(e2)) {
            throw AppError.unavailable('Serializable isolation failure after single auto retry.', {
              reason: MoneyPathErrorCode.SERIALIZATION_FAILURE_AFTER_RETRY,
            });
          }
          // lock timeout second failure
          throw AppError.unavailable('Concurrency lock timeout after single auto retry.', {
            reason: MoneyPathErrorCode.CONCURRENCY_LOCK_TIMEOUT,
          });
        });
      }
      throw err;
    }
  }

  // ----------------------------------------------------------------------
  // Single A+B run. retried=true only on the 2nd attempt (used for stats).
  // ----------------------------------------------------------------------
  private async runOnce(input: TwoPhaseRunInput, retried: boolean): Promise<TwoPhaseRunResult> {
    // --------------------------------------------------------------------
    // Phase A (outside DB tx, I/O OK)
    // --------------------------------------------------------------------
    // A1 Authz double-read: the controller/JWT layer also enforces role,
    // but we re-read live role here so privilege changes take effect
    // immediately even if the token was minted earlier.
    let liveRole: UserRole = UserRole.USER;
    if (input.actorUserId) {
      const readCtx = await this.reposFactory().user.getAuthorizationContext(input.actorUserId);
      if (!readCtx)
        throw AppError.forbidden('Actor not found.', {
          reason: AuthzFailReason.AUTHZ_USER_NOT_FOUND,
        });
      if (readCtx.status !== 'ACTIVE')
        throw AppError.forbidden('Actor inactive.', {
          reason: AuthzFailReason.AUTHZ_USER_INACTIVE,
        });
      liveRole = readCtx.role;
    }
    if (input.requiredRole === UserRole.ADMIN && liveRole !== UserRole.ADMIN) {
      throw AppError.forbidden('Operation requires ADMIN role.', {
        reason: AuthzFailReason.AUTHZ_ROLE_INSUFFICIENT,
      });
    }
    // A2 Validation
    const valid = input.validate(input.rawInput);
    if (!valid.ok) {
      throw AppError.validation(valid.message);
    }
    const validatedInput = valid.value;
    // A3 canonical hash
    const requestHash = canonicalRequestHash(input.scope, input.idempotencyKey, validatedInput);
    // A4 initial flags (fail-closed via isEnabledSafe singleton repos)
    const singletonRepos = this.reposFactory();
    for (const f of input.requiredFlags ?? []) {
      const enabled = await this.flags.isEnabledSafe(singletonRepos, f.scope, f.feature);
      if (!enabled) {
        throw AppError.forbidden(
          `Money feature flag ${FeatureFlagService.key(f.scope, f.feature)} is OFF.`,
          {
            reason: MoneyPathErrorCode.MONEY_FEATURE_DISABLED,
          },
        );
      }
    }
    // A5 Risk (Phase A only)
    const preCtx: MoneyDomainPreflightCtx = {
      actorUserId: input.actorUserId,
      requestId: input.requestId ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
      input: validatedInput,
      scope: input.scope,
      idempotencyKey: input.idempotencyKey,
      requestHash,
    };
    const riskA = await input.riskEngine.evaluateFromRequest(preCtx);
    if (riskA.outcome === 'BLOCK') {
      throw AppError.forbidden(riskA.message, {
        reason: MoneyPathErrorCode.RISK_BLOCKED,
        details: riskA.reasonCode,
      });
    }
    // A6 engine preflight deterministically builds the commit plan.
    const plan = await input.engine.preflight(preCtx);
    // A5 (part 2 — rich preflight after plan preview)
    const lockTargets = plan.lockTargets;
    const riskB = await input.riskEngine.evaluatePreflight({
      ctx: preCtx,
      planPreview: {
        lockTargets,
        ledgerSummary: plan.ledger
          ? {
              currency: plan.ledger.currency,
              postings: plan.ledger.postings.map((p) => ({
                accountType: p.accountType,
                accountId: p.accountId,
                sign: p.sign,
                amount: p.amount,
              })),
            }
          : undefined,
      },
    });
    if (riskB.outcome === 'BLOCK') {
      throw AppError.forbidden(riskB.message, {
        reason: MoneyPathErrorCode.RISK_BLOCKED,
        details: riskB.reasonCode,
      });
    }
    // Ensure consistent engine output w/ idempotency scope match.
    if (plan.ledger && plan.ledger.scope !== input.scope) {
      throw AppError.internal(
        `Engine returned plan.ledger.scope="${plan.ledger.scope}" but orchestrator scope="${input.scope}"`,
        { reason: MoneyPathErrorCode.PLAN_BUILD_INVALID },
      );
    }
    if (plan.ledger && plan.ledger.txnIdempotencyKey !== input.idempotencyKey) {
      throw AppError.internal('Engine returned mismatched idempotency key for ledger write.', {
        reason: MoneyPathErrorCode.PLAN_BUILD_INVALID,
      });
    }
    // Ensure flag consistency between caller-supplied and plan flags.
    const requiredFlagKey = (f: { scope: string; feature: string }) =>
      FeatureFlagService.key(f.scope, f.feature);
    const extraFlags = plan.requiredFlags.filter(
      (pf) =>
        !(input.requiredFlags ?? []).some(
          (iflag) => requiredFlagKey(iflag) === requiredFlagKey(pf),
        ),
    );
    for (const f of extraFlags) {
      const enabled = await this.flags.isEnabledSafe(singletonRepos, f.scope, f.feature);
      if (!enabled) {
        throw AppError.forbidden(`Engine-required flag ${requiredFlagKey(f)} is OFF.`, {
          reason: MoneyPathErrorCode.MONEY_FEATURE_DISABLED,
        });
      }
    }
    const allRequiredFlags = [...(input.requiredFlags ?? []), ...extraFlags];

    // --------------------------------------------------------------------
    // Phase B — short Serializable transaction. NO I/O.
    // --------------------------------------------------------------------
    const isolationLevel: Prisma.TransactionIsolationLevel = 'Serializable';
    const MAX_WAIT_MS = 1_500;
    const TIMEOUT_MS = 2_000;
    try {
      return await this.prismaClient.$transaction(
        async (tx) => {
          const txRepos = this.reposFactory(tx);
          // B1 FLAG RACE TOCTOU re-check
          for (const f of allRequiredFlags) {
            const enabled = await this.flags.isEnabled(txRepos, f.scope, f.feature);
            if (!enabled) {
              throw AppError.conflict(
                `Flag ${requiredFlagKey(f)} flipped OFF between Phase A and Phase B.`,
                { reason: MoneyPathErrorCode.FLAG_RACE_FLIPPED },
              );
            }
          }
          // B2 Locks sorted (deduplicated inside strategy). plan.lockTargets
          // UNION ledger posting accounts if ledger present (belt).
          const locksDeduped = new Map<string, { accountType: string; accountId: string }>();
          for (const t of plan.lockTargets) locksDeduped.set(canonicalAccountKey(t), t);
          if (plan.ledger) {
            for (const t of accountLockTargetsFromPlan(plan.ledger.postings)) {
              locksDeduped.set(canonicalAccountKey(t), t);
            }
          }
          const lockArray = Array.from(locksDeduped.values());
          await acquireAccountLocks(txRepos, lockArray);

          // B3 Idempotency claim.
          const claim = await IdempotencyIntegration.claimPending(txRepos, {
            scope: input.scope,
            key: input.idempotencyKey,
            requestHash,
            ttlMs: input.ttlMs,
          });
          switch (claim.outcome) {
            case 'REPLAY_COMPLETED':
              return {
                statusCode: claim.row.responseCode ?? plan.response.statusCode,
                body: claim.row.responseBody ?? plan.response.body,
                replayed: true,
                retried,
              } satisfies TwoPhaseRunResult as TwoPhaseRunResult;
            case 'INFLIGHT':
              throw AppError.conflict(
                'Another request is already processing under this idempotency key.',
                { reason: MoneyPathErrorCode.IDEMPOTENCY_INFLIGHT },
              );
            case 'CONFLICT':
              throw AppError.conflict(`Idempotency conflict: ${claim.reason}`, {
                reason: MoneyPathErrorCode.IDEMPOTENCY_CONFLICT,
                details: claim.reason,
              });
            case 'CLAIMED': {
              // B4 state mutation (optional)
              let stateResult: unknown = null;
              try {
                if (plan.stateMutation) stateResult = await plan.stateMutation(txRepos);
              } catch (e: unknown) {
                throw wrapWithReason(e, MoneyPathErrorCode.STATE_MUTATION_FAILED);
              }
              // B5 Ledger write (optional)
              if (plan.ledger) {
                if (plan.ledger.reversalOfTxnId) {
                  await this.ledger.reverse(txRepos, {
                    originalTxnId: plan.ledger.reversalOfTxnId,
                    scope: plan.ledger.scope,
                    txnIdempotencyKey: plan.ledger.txnIdempotencyKey,
                    actorUserId: input.actorUserId,
                    requestId: input.requestId ?? null,
                    reason:
                      plan.ledger.reversalReason ??
                      `reversal by request id=${input.requestId ?? ''}`,
                  });
                } else {
                  const journalInput: WriteJournalInput = {
                    scope: plan.ledger.scope,
                    txnIdempotencyKey: plan.ledger.txnIdempotencyKey,
                    txnType: plan.ledger.txnType,
                    currency: plan.ledger.currency,
                    unit: plan.ledger.unit,
                    decimals: plan.ledger.decimals,
                    source: plan.ledger.source,
                    reference: plan.ledger.reference ?? null,
                    actorUserId: input.actorUserId,
                    requestId: input.requestId ?? null,
                    metadata: (plan.ledger.metadata ?? null) as Prisma.InputJsonValue | null,
                    postings: plan.ledger.postings,
                    reversesTxnId: null,
                  };
                  await this.ledger.write(txRepos, journalInput);
                }
              }
              // B6 Audit envelope
              if (plan.auditEnvelope) {
                const args: AuditSensitiveMutationArgs = {
                  action: plan.auditEnvelope.action,
                  resource: plan.auditEnvelope.resource,
                  actorUserId: input.actorUserId,
                  requestId: input.requestId ?? null,
                  ip: input.ip ?? null,
                  userAgent: input.userAgent ?? null,
                  envelope: {
                    before: plan.auditEnvelope.before,
                    after: plan.auditEnvelope.after,
                    reason: plan.auditEnvelope.reason,
                    source: plan.auditEnvelope.source,
                    correlation: plan.auditEnvelope.correlation,
                  },
                  success: true,
                };
                await this.audit.recordTxBound(txRepos, args);
              }
              // B7 mark idempotency COMPLETED
              const response = {
                code: plan.response.statusCode,
                body: plan.response.body,
              };
              const completed = await IdempotencyIntegration.markCompleted(
                txRepos,
                input.scope,
                input.idempotencyKey,
                response,
              );
              let finalBody: unknown = response.body;
              let finalCode: number = response.code;
              let replayedOutcome = false;
              if (completed.rowsAffected === 0) {
                // Another worker won the race → replay stored (or if we have
                // no stored row due to transient gap, return our computed
                // response; tests assert row counts to verify).
                const replayed: IdempotencyKey | null = await txRepos.idempotencyKey.findUnique(
                  input.scope,
                  input.idempotencyKey,
                );
                if (replayed && replayed.status === 'COMPLETED') {
                  finalCode = replayed.responseCode ?? finalCode;
                  finalBody = replayed.responseBody ?? finalBody;
                  replayedOutcome = true;
                }
              }
              return {
                statusCode: finalCode,
                body: finalBody ?? stateResult,
                replayed: replayedOutcome,
                retried,
              } satisfies TwoPhaseRunResult as TwoPhaseRunResult;
            }
          }
        },
        { isolationLevel, timeout: TIMEOUT_MS, maxWait: MAX_WAIT_MS },
      );
    } catch (txErr: unknown) {
      if (isLockTimeout(txErr)) {
        // Auto-retry signal → propagate as a specific throw handled in run().
        throw makeTaggedError(MoneyPathErrorCode.CONCURRENCY_LOCK_TIMEOUT, txErr);
      }
      if (isSerializationFailure(txErr)) {
        throw makeTaggedError(MoneyPathErrorCode.SERIALIZATION_FAILURE, txErr);
      }
      // Non-retryable. Best-effort FAILED status if we had a PENDING row.
      const code = (txErr as AppError)?.reason ?? AppErrorCode.INTERNAL_ERROR;
      void IdempotencyIntegration.markFailedOutsideTx(
        input.scope,
        input.idempotencyKey,
        requestHash,
        String(code),
        txErr instanceof Error ? { message: txErr.message } : undefined,
      );
      throw txErr;
    }
  }
}

function isAutoRetryablePhaseBFailure(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  return (
    err.reason === MoneyPathErrorCode.SERIALIZATION_FAILURE ||
    err.reason === MoneyPathErrorCode.CONCURRENCY_LOCK_TIMEOUT
  );
}

function isSerializationFailure(err: unknown): boolean {
  if (err instanceof AppError)
    return (
      err.reason === MoneyPathErrorCode.SERIALIZATION_FAILURE ||
      err.reason === MoneyPathErrorCode.SERIALIZATION_FAILURE_AFTER_RETRY
    );
  const code = typeof err === 'object' && err !== null && (err as { code?: string }).code;
  if (code === 'P2034' /* PostgreSQL serialization failure Prisma code */) return true;
  const m = String((err as { message?: string })?.message ?? '');
  return m.includes('40001') || m.toLowerCase().includes('could not serialize');
}

function isLockTimeout(err: unknown): boolean {
  const m = String((err as { message?: string })?.message ?? '');
  if (m.includes('lock timeout') || m.includes('55P03')) return true;
  const code = typeof err === 'object' && err !== null && (err as { code?: string }).code;
  return code === 'P2024'; // Prisma transaction API timeout
}

function wrapWithReason(err: unknown, reason: string): never {
  if (err instanceof AppError) {
    if (!err.reason || err.reason === AppErrorCode.INTERNAL_ERROR) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, dot-notation
      (err as unknown as { reason: unknown })['reason'] = reason;
    }
    throw err;
  }
  throw AppError.internal(err instanceof Error ? err.message : String(err), {
    reason,
  });
}

function makeTaggedError(reason: MoneyPathErrorCode, _cause: unknown): AppError {
  const msg =
    reason === MoneyPathErrorCode.SERIALIZATION_FAILURE
      ? 'Serializable isolation failure (single auto retry queued).'
      : 'Concurrency lock timeout (single auto retry queued).';
  return AppError.unavailable(msg, {
    reason,
  });
}

export type { TwoPhaseRunResult as TwoPhaseOrchestratorResult };
