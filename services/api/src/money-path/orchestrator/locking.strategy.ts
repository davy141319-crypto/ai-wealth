// ============================================================================
// Money-path locking strategy (P1-008 — final recommendation by ChatGPT):
//
//   accountType=USER  + valid UUID   →   SELECT ... FROM users FOR UPDATE
//                                        on the real user row (rejects
//                                        nonexistent users — can't lock a
//                                        fake account row to serialize on
//                                        a ghost account id).
//   everything else                   →   pg_advisory_xact_lock with a
//                                        server-side stable hash produced
//                                        by hashtextextended(<canonical
//                                        key>, 0xB10080) — never a hand-
//                                        rolled JS hash.
//
// Locks are always acquired in canonical order (by `canonicalAccountKey`
// lexicographic sort) to prevent deadlocks.
//
// The strategy runs INSIDE a running Prisma transaction (Phase B).
// ============================================================================

import { Prisma, Repositories } from '@ai-wealth/database';
import { AppError, MoneyPathErrorCode } from '@ai-wealth/shared';

export interface AccountLockTarget {
  accountType: string;
  accountId: string;
}

export interface LockResult {
  userLocks: Array<{ userId: string }>;
  advisoryLocks: Array<{ canonicalKey: string }>;
}

/**
 * Advisory-lock seed. Fixed arbitrary prefix used so account keys never
 * collide with advisory locks taken by other modules.
 * ('0xB10080' in decimal = 1160160 — 32-bit value safe for hashtextextended
 * second argument — bigint cast on PG side).
 */
export const ADVISORY_LOCK_SEED = 1_160_160n;

/** Canonical account key — used for (a) advisory hash source text and
 *  (b) sort ordering. Format: `${accountType}:${accountId}`. */
export function canonicalAccountKey(target: AccountLockTarget): string {
  return `${target.accountType}:${target.accountId}`;
}

/**
 * Tests whether an account id is a well-formed UUID (for accountType=USER
 * locking policy). Uses the same regex Prisma UUID defaults accept.
 */
export const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Acquire locks for every target inside the active transaction bound to
 * `repos`. Throws if this repository has no transaction client (locks
 * must not be acquired outside a transaction as they'd never release).
 *
 * Returns LockResult (informational for test assertions / debugging).
 */
export async function acquireAccountLocks(
  repos: Repositories,
  targets: AccountLockTarget[],
): Promise<LockResult> {
  const tx = (repos as unknown as { tx?: Prisma.TransactionClient }).tx ?? undefined;
  if (!tx) {
    throw new Error(
      'acquireAccountLocks requires a Repositories bound to a Prisma transaction (Phase B).',
    );
  }
  // Deduplicate & sort — canonical keys order, stable, prevents deadlocks.
  const sorted = Array.from(new Map(targets.map((t) => [canonicalAccountKey(t), t])).values()).sort(
    (a, b) => canonicalAccountKey(a).localeCompare(canonicalAccountKey(b)),
  );
  const result: LockResult = { userLocks: [], advisoryLocks: [] };
  for (const t of sorted) {
    if (t.accountType === 'USER' && UUID_REGEX.test(t.accountId)) {
      const ok = await repos.user.lockForUpdate(t.accountId);
      if (!ok) {
        throw AppError.notFound(
          `Cannot lock USER account ${t.accountId}: user row does not exist. Fake user ids cannot participate in account locks.`,
          { reason: MoneyPathErrorCode.CONCURRENCY_LOCK_TIMEOUT },
        );
      }
      result.userLocks.push({ userId: t.accountId });
    } else {
      // PostgreSQL service-side hash — hashtextextended(text, bigint) → int8
      // pg_advisory_xact_lock(bigint) automatically releases at tx end.
      // NOTE: pg_advisory_xact_lock returns void — do NOT cast to ::int or
      // PostgreSQL raises "cannot cast type void to integer" (42846).
      // We execute the function for its side effect (lock acquisition) only.
      const key = canonicalAccountKey(t);
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(hashtextextended($1::text, ${ADVISORY_LOCK_SEED.toString()}::bigint)::bigint # 0::bigint)`,
        key,
      );
      result.advisoryLocks.push({ canonicalKey: key });
    }
  }
  return result;
}

/**
 * Small helper: sort + dedup an array of lock targets. Used by tests that
 * need to prove determinism of lock order.
 */
export function normalizeLockOrder(targets: AccountLockTarget[]): AccountLockTarget[] {
  return Array.from(new Map(targets.map((t) => [canonicalAccountKey(t), t])).values()).sort(
    (a, b) => canonicalAccountKey(a).localeCompare(canonicalAccountKey(b)),
  );
}
