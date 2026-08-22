// ============================================================================
// Money-path Idempotency — adapter on top of the EXISTING IdempotencyKey
// model / IdempotencyKeyRepository (never a second table).
//
// IdempotencyStatus = PENDING / COMPLETED / FAILED only. Literal `DONE` is
// forbidden.
//
// PR #10 review fix (blocker #1 + #2):
//   * claimPending uses `INSERT ... ON CONFLICT DO NOTHING RETURNING` so
//     PostgreSQL NEVER aborts the surrounding transaction on a unique
//     conflict. Normal concurrent flow is no longer controlled by a
//     thrown P2002 exception — only the RETURNING row count decides.
//   * markFailedOutsideTx uses an atomic UPSERT (INSERT ... ON CONFLICT
//     DO UPDATE WHERE status IS DISTINCT FROM 'COMPLETED') in an
//     INDEPENDENT transaction (the singleton prisma client, NOT the
//     rolled-back Phase B tx). This guarantees a durable FAILED row even
//     when Phase B's PENDING claim was rolled back with the rest of the
//     Phase B work. The previous `prisma.idempotencyKey.update(...)` was
//     unreliable because (a) Phase B's PENDING row had been rolled back
//     so the UPDATE matched zero rows, and (b) two concurrent workers
//     could both UPDATE the same row.
//
// Behaviors implemented:
//  * claimPending(scope, key, hash, TTL):
//      INSERT ON CONFLICT DO NOTHING RETURNING * —
//        RETURNING row  → CLAIMED
//        RETURNING none → findUnique(scope, key), then state machine:
//          COMPLETED + same hash → REPLAY_COMPLETED (cached response read).
//          COMPLETED + diff hash → CONFLICT 409.
//          PENDING                → INFLIGHT 409.
//          FAILED + diff hash     → CONFLICT 409.
//          FAILED + same hash     → reclaimFailedAtomic (UPDATE … WHERE
//                                   status='FAILED' AND request_hash=…
//                                   RETURNING *). 0 rows → re-read &
//                                   route INFLIGHT / REPLAY / CONFLICT.
//                                   1 row  → CLAIMED.
//  * markCompleted(scope, key, code, body) where status=PENDING
//      → rowsAffected: 0 means another worker won (treat as REPLAY cached read).
//  * markFailedOutsideTx(scope, key, requestHash, reasonCode, details):
//      runs upsertFailedAtomic in a tiny standalone transaction. Always
//      durable (independent of the rolled-back Phase B tx). Never throws.
// ============================================================================
import { Prisma, Repositories, prisma } from '@ai-wealth/database';
import { IdempotencyKeyRepository } from '@ai-wealth/database';
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
   *
   * PR #10 fix: uses ON CONFLICT DO NOTHING RETURNING so the surrounding tx
   * never aborts on a unique conflict.
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
    const expiresAt = new Date(Date.now() + ttlMs);

    // Atomic INSERT … ON CONFLICT DO NOTHING RETURNING * — never throws
    // P2002, never aborts the surrounding PostgreSQL transaction.
    const claimed = await repos.idempotencyKey.claimAtomic(
      opts.scope,
      opts.key,
      opts.requestHash,
      expiresAt,
    );
    if (claimed) {
      return { outcome: 'CLAIMED', row: claimed };
    }

    // RETURNING had zero rows → a row with (scope,key) already exists.
    // Read it (still inside the same Serializable tx) and apply state machine.
    const existing = await repos.idempotencyKey.findUnique(opts.scope, opts.key);
    if (!existing) {
      // Extreme race: row vanished between INSERT conflict and SELECT.
      // Treat as internal error so caller wraps into 5xx — this should be
      // vanishingly rare under Serializable isolation.
      throw AppError.internal('Idempotency claim race: row vanished after ON CONFLICT conflict.', {
        reason: MoneyPathErrorCode.IDEMPOTENCY_CONFLICT,
      });
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
    if (!isRetryableFailed(existing)) {
      return {
        outcome: 'CONFLICT',
        reason: 'PERMANENT_FAILURE_NOT_RETRYABLE',
        row: existing,
      };
    }
    // Atomic FAILED → PENDING reclaim via conditional UPDATE … RETURNING.
    // 0 rows means another concurrent worker just reclaimed (or a
    // COMPLETED row appeared) — re-read & decide.
    const reclaimed = await repos.idempotencyKey.reclaimFailedAtomic(
      opts.scope,
      opts.key,
      opts.requestHash,
      new Date(Date.now() + ttlMs),
    );
    if (reclaimed) {
      return { outcome: 'CLAIMED', row: reclaimed };
    }
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
   * Durable write of FAILED status via the singleton prisma client
   * (outside the rolled-back Phase B transaction). Uses an atomic UPSERT
   * so the FAILED row survives even if Phase B's PENDING claim was rolled
   * back. Never throws; logs swallow.
   *
   * `requestHash` is required so the FAILED row carries the same hash for
   * future same-hash retry / different-hash 409 conflict routing.
   */
  static async markFailedOutsideTx(
    scope: string,
    key: string,
    requestHash: string,
    reasonCode: string,
    details?: unknown,
  ): Promise<void> {
    try {
      // Use a fresh repository bound to the singleton prisma client — runs
      // in its own implicit transaction (NOT the rolled-back Phase B tx),
      // so the FAILED row is durable regardless of Phase B rollback.
      const standaloneRepo = new IdempotencyKeyRepository();
      await standaloneRepo.upsertFailedAtomic(
        scope,
        key,
        requestHash,
        {
          reason: reasonCode,
          details: details ?? null,
          failedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
        new Date(Date.now() + DEFAULT_TTL_MS),
      );
    } catch {
      /* best-effort — TTL cleanup will recover */
    }
  }
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
