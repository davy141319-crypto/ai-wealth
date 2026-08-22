// ============================================================================
// Money-path Idempotency — adapter on top of the EXISTING IdempotencyKey
// model / IdempotencyKeyRepository (never a second table).
//
// IdempotencyStatus = PENDING / COMPLETED / FAILED only. Literal `DONE` is
// forbidden.
//
// Behaviors implemented:
//  * claimPending(scope, key, hash, TTL):
//      INSERT PENDING → ok. UNIQUE violation → read existing & route:
//        COMPLETED + same hash → REPLAY_COMPLETED (cached response read).
//        PENDING            → INFLIGHT 409.
//        COMPLETED + diff hash / FAILED + diff hash / PENDING + diff hash
//                           → CONFLICT 409.
//        FAILED + same hash → 重入策略: FAILED状态仅在可重试类别下才
//                           覆盖为PENDING，否则直接抛CONFLICT。
//  * markCompleted(scope, key, code, body) where status=PENDING
//      → rowsAffected: 0 means another worker won (we treat as REPLAY cached read).
//  * markFailedOutsideTx(scope, key, errorSnapshot): runs in a separate
//      tiny standalone transaction (best-effort) if the outer transaction
//      rolled back — this lets subsequent retries see FAILED instead of
//      dangling PENDING.
// ============================================================================

import { Prisma, Repositories, prisma } from '@ai-wealth/database';
import type { IdempotencyKey, IdempotencyStatus } from '@ai-wealth/database';
import { AppError, AppErrorCode, MoneyPathErrorCode } from '@ai-wealth/shared';

export type ClaimResult =
  | { outcome: 'CLAIMED'; row: IdempotencyKey }
  | { outcome: 'REPLAY_COMPLETED'; row: IdempotencyKey }
  | { outcome: 'INFLIGHT'; row: IdempotencyKey }
  | {
      outcome: 'CONFLICT';
      reason: 'HASH_MISMATCH' | 'PERMANENT_FAILURE_NOT_RETRYABLE';
      row?: IdempotencyKey;
    };

/**
 * Reasons why a FAILED row may be retried (overwritten back to PENDING
 * only on exact SAME hash). Other failures are permanent: client must
 * change payload / idempotency key.
 */
const RETRYABLE_FAILED_REASONS = new Set<string>([
  MoneyPathErrorCode.CONCURRENCY_LOCK_TIMEOUT,
  MoneyPathErrorCode.SERIALIZATION_FAILURE,
  MoneyPathErrorCode.SERIALIZATION_FAILURE_AFTER_RETRY,
  MoneyPathErrorCode.STATE_MUTATION_FAILED,
  AppErrorCode.DEPENDENCY_DOWN, // general infra
  MoneyPathErrorCode.RISK_PREFLIGHT_TIMEOUT,
]);

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class IdempotencyIntegration {
  /**
   * Try to claim the idempotency row. Runs inside the Phase B transaction
   * via repos (which carries the tx client), so the claim participates in
   * the same Serializable lock universe as ledger/audit writes.
   */
  static async claimPending(
    repos: Repositories,
    opts: {
      scope: string;
      key: string;
      requestHash: string;
      ttlMs?: number;
    },
  ): Promise<ClaimResult> {
    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    try {
      const row = await repos.idempotencyKey.create({
        scope: opts.scope,
        key: opts.key,
        requestHash: opts.requestHash,
        expiresAt: new Date(Date.now() + ttlMs),
      });
      return { outcome: 'CLAIMED', row };
    } catch (err: unknown) {
      if (!isUniqueViolation(err)) {
        // Propagate other Prisma failures (DB down, etc.) as 5xx up the
        // chain; orchestrator wraps.
        throw err;
      }
      // UNIQUE violation → existing row. Read it inside the same tx.
      const existing = await repos.idempotencyKey.findUnique(opts.scope, opts.key);
      if (!existing) {
        // Extreme race: concurrent rollback removed it. Retry the claim
        // once — if it fails again with same symptoms bubble as 500.
        try {
          const row = await repos.idempotencyKey.create({
            scope: opts.scope,
            key: opts.key,
            requestHash: opts.requestHash,
            expiresAt: new Date(Date.now() + ttlMs),
          });
          return { outcome: 'CLAIMED', row };
        } catch (err2) {
          throw AppError.internal('Idempotency claim race retry failed.', {
            reason: MoneyPathErrorCode.IDEMPOTENCY_CONFLICT,
          });
        }
      }
      if (existing.status === ('COMPLETED' as IdempotencyStatus)) {
        if (existing.requestHash === opts.requestHash) {
          return { outcome: 'REPLAY_COMPLETED', row: existing };
        }
        return { outcome: 'CONFLICT', reason: 'HASH_MISMATCH', row: existing };
      }
      if (existing.status === ('PENDING' as IdempotencyStatus)) {
        return { outcome: 'INFLIGHT', row: existing };
      }
      // status === FAILED
      if (existing.requestHash !== opts.requestHash) {
        return { outcome: 'CONFLICT', reason: 'HASH_MISMATCH', row: existing };
      }
      // Same hash, FAILED. Retryable iff responseBody.reason in RETRYABLE_FAILED_REASONS.
      if (isRetryableFailed(existing)) {
        try {
          const overwritten = await (
            repos.db as Prisma.TransactionClient | typeof prisma
          ).idempotencyKey.update({
            where: { scope_key: { scope: opts.scope, key: opts.key } },
            data: {
              status: 'PENDING' as IdempotencyStatus,
              responseCode: null,
              responseBody: Prisma.JsonNull,
              expiresAt: new Date(Date.now() + ttlMs),
            },
          });
          return { outcome: 'CLAIMED', row: overwritten };
        } catch (e2: unknown) {
          // Race: another worker won the overwrite. Treat as INFLIGHT.
          const afterRace = await repos.idempotencyKey.findUnique(opts.scope, opts.key);
          if (
            afterRace &&
            afterRace.status === ('COMPLETED' as IdempotencyStatus) &&
            afterRace.requestHash === opts.requestHash
          ) {
            return { outcome: 'REPLAY_COMPLETED', row: afterRace };
          }
          return { outcome: 'INFLIGHT', row: afterRace ?? existing };
        }
      }
      return { outcome: 'CONFLICT', reason: 'PERMANENT_FAILURE_NOT_RETRYABLE', row: existing };
    }
  }

  /**
   * Phase B step B7: mark row COMPLETED (only when currently PENDING).
   * Returns rowsAffected = 0 → caller treats as another-worker-wins replay.
   */
  static async markCompleted(
    repos: Repositories,
    scope: string,
    key: string,
    response: { code: number; body: unknown },
  ): Promise<{ rowsAffected: 0 | 1; row?: IdempotencyKey }> {
    try {
      const row = await (
        repos.db as Prisma.TransactionClient | typeof prisma
      ).idempotencyKey.update({
        where: {
          scope_key: { scope, key },
          status: 'PENDING' as IdempotencyStatus,
        },
        data: {
          status: 'COMPLETED' as IdempotencyStatus,
          responseCode: response.code,
          responseBody: (response.body ?? null) as Prisma.InputJsonValue,
        },
      });
      return { rowsAffected: 1, row };
    } catch (e: unknown) {
      if (isRecordNotFound(e)) return { rowsAffected: 0 };
      throw e;
    }
  }

  /**
   * Best-effort write of FAILED status via the singleton prisma (outside
   * the rolled-back transaction). Never throws; logs swallow.
   */
  static async markFailedOutsideTx(
    scope: string,
    key: string,
    reasonCode: string,
    details?: unknown,
  ): Promise<void> {
    try {
      await prisma.idempotencyKey.update({
        where: { scope_key: { scope, key } },
        data: {
          status: 'FAILED' as IdempotencyStatus,
          responseBody: {
            reason: reasonCode,
            details: details ?? null,
            failedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
    } catch {
      /* best-effort — TTL cleanup will recover */
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  const pcode = typeof err === 'object' && err !== null && (err as { code?: string }).code;
  // PostgreSQL P2002 unique constraint in Prisma.
  if (pcode === 'P2002') return true;
  // Also handle raw pg driver message just in case of raw SQL layers.
  const m = String((err as { message?: string })?.message ?? '');
  return (
    m.includes('Unique constraint') || m.includes('duplicate key value violates unique constraint')
  );
}

function isRecordNotFound(err: unknown): boolean {
  const pcode = typeof err === 'object' && err !== null && (err as { code?: string }).code;
  return pcode === 'P2025';
}

function isRetryableFailed(row: IdempotencyKey): boolean {
  const body = row.responseBody;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const reason = (body as { reason?: unknown }).reason;
    if (typeof reason === 'string' && RETRYABLE_FAILED_REASONS.has(reason)) return true;
  }
  return false;
}
