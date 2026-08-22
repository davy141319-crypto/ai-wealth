// ============================================================================
// IdempotencyKeyRepository — request replay cache.
// (scope, key) is unique at the DB. The Service layer typically:
//   1. tryAcquire(): INSERT with status=PENDING (expect unique-violation if a
//      concurrent request already created it).
//   2. On unique-violation: read the existing row. If COMPLETED, return the
//      cached response. If PENDING, the caller may poll or reject.
//   3. complete(): set status=COMPLETED and store the response to replay.
//   4. fail(): set status=FAILED so the client can retry with the same key.
// ============================================================================

import { Prisma, type IdempotencyKey, type IdempotencyStatus } from '@prisma/client';
import { prisma } from '../client';
import { normalizePagination, type PaginationInput, type SortDirection } from '../types';

export interface IdempotencyKeyCreateInput {
  key: string;
  scope: string;
  requestHash?: string | null;
  expiresAt: Date;
}

export interface IdempotencyKeyCompleteInput {
  responseCode: number;
  responseBody: Prisma.InputJsonValue;
}

export interface IdempotencyKeyListOptions extends PaginationInput {
  scope?: string;
  status?: IdempotencyStatus;
  orderBy?: { field: 'createdAt' | 'expiresAt'; dir: SortDirection };
}

export class IdempotencyKeyRepository {
  constructor(private readonly tx?: Prisma.TransactionClient) {}

  private get db() {
    return this.tx ?? prisma;
  }

  create(input: IdempotencyKeyCreateInput): Promise<IdempotencyKey> {
    return this.db.idempotencyKey.create({
      data: {
        key: input.key,
        scope: input.scope,
        requestHash: input.requestHash,
        expiresAt: input.expiresAt,
      },
    });
  }

  /**
   * Atomic idempotency claim using `INSERT ... ON CONFLICT DO NOTHING`.
   * This is the P1-008 fix for the previous INSERT+catch-P2002 flow: under
   * PostgreSQL a unique-constraint error puts the surrounding transaction
   * into an aborted state, so a subsequent `SELECT existing` in the same
   * transaction would fail. Using ON CONFLICT DO NOTHING keeps the
   * transaction usable and lets the caller branch on the affected-row
   * count returned by `$executeRaw`.
   *
   * Returns:
   *   - the newly inserted row when this caller won the claim (affected=1), OR
   *   - `null` when a row with the same (scope,key) already exists (affected=0).
   *     The caller must then `findUnique(scope,key)` to read existing state and
   *     apply the status-state machine (COMPLETED/PENDING/FAILED).
   *
   * `requestHash`, `expiresAt` are persisted on the new row so a CLAIMED
   * row carries the same hash used for later conflict detection.
   *
   * Implementation note: we use `$executeRaw` (returns affected row count as
   * number) instead of `$queryRaw` + `RETURNING *` because Prisma's
   * `$queryRaw` type inference fails with `RETURNING *` on tables that have
   * nullable integer + enum columns ("cannot cast type void to integer").
   * The INSERT + findUnique pair is still atomic within the same
   * transaction: if affected=1 the row was just inserted by us and
   * findUnique reads our own row; if affected=0 the conflict row is visible
   * (READ COMMITTED sees committed rows, Serializable serialises access).
   */
  async claimAtomic(
    scope: string,
    key: string,
    requestHash: string,
    expiresAt: Date,
  ): Promise<IdempotencyKey | null> {
    const affected = await this.db.$executeRaw`
      INSERT INTO "idempotency_keys" ("id", "scope", "key", "request_hash", "status", "response_code", "response_body", "expires_at", "created_at", "updated_at")
      VALUES (
        gen_random_uuid(),
        ${scope},
        ${key},
        ${requestHash},
        'PENDING'::"IdempotencyStatus",
        NULL,
        NULL,
        ${expiresAt},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("scope", "key") DO NOTHING
    `;
    if (affected === 0) return null;
    return this.db.idempotencyKey.findUnique({
      where: { scope_key: { scope, key } },
    });
  }

  /**
   * Atomic FAILED → PENDING reclaim via conditional UPDATE.
   * Used by the idempotency integration layer when a previous attempt
   * FAILED with a retryable reason and the SAME request hash is replayed.
   * The conditional WHERE (status='FAILED' AND request_hash=…) guarantees
   * at most ONE worker can reclaim — concurrent callers get 0 affected and
   * must then re-read the row to decide INFLIGHT vs REPLAY vs CONFLICT.
   *
   * `expiresAt` refreshes the TTL on reclaim.
   */
  async reclaimFailedAtomic(
    scope: string,
    key: string,
    requestHash: string,
    expiresAt: Date,
  ): Promise<IdempotencyKey | null> {
    const affected = await this.db.$executeRaw`
      UPDATE "idempotency_keys"
      SET
        "status" = 'PENDING'::"IdempotencyStatus",
        "response_code" = NULL,
        "response_body" = NULL,
        "expires_at" = ${expiresAt},
        "updated_at" = CURRENT_TIMESTAMP
      WHERE
        "scope" = ${scope}
        AND "key" = ${key}
        AND "status" = 'FAILED'::"IdempotencyStatus"
        AND "request_hash" = ${requestHash}
    `;
    if (affected === 0) return null;
    return this.db.idempotencyKey.findUnique({
      where: { scope_key: { scope, key } },
    });
  }

  /**
   * Atomic UPSERT of a FAILED row in an INDEPENDENT transaction (not the
   * rolled-back Phase B tx). Used by `markFailedOutsideTx` so that even when
   * Phase B rolls back (which would also roll back the PENDING claim), a
   * durable FAILED row survives for retry policy and 409 conflict routing.
   *
   * Behaviour:
   *   - If no row exists for (scope,key): INSERT FAILED with the snapshot.
   *   - If a row exists: UPDATE status=FAILED + body, ONLY when the current
   *     status is NOT COMPLETED (we never overwrite a COMPLETED row that a
   *     concurrent worker may have just produced). If the existing row IS
   *     COMPLETED the WHERE clause is false and 0 rows are affected — the
   *     caller reads the COMPLETED row for replay.
   *
   * `expiresAt` is set so FAILED rows still age out via TTL purge.
   */
  async upsertFailedAtomic(
    scope: string,
    key: string,
    requestHash: string,
    responseBody: Prisma.InputJsonValue,
    expiresAt: Date,
  ): Promise<IdempotencyKey | null> {
    const bodyJson = JSON.stringify(responseBody);
    const affected = await this.db.$executeRaw`
      INSERT INTO "idempotency_keys" ("id", "scope", "key", "request_hash", "status", "response_code", "response_body", "expires_at", "created_at", "updated_at")
      VALUES (
        gen_random_uuid(),
        ${scope},
        ${key},
        ${requestHash},
        'FAILED'::"IdempotencyStatus",
        NULL,
        ${bodyJson}::jsonb,
        ${expiresAt},
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("scope", "key")
      DO UPDATE SET
        "status" = 'FAILED'::"IdempotencyStatus",
        "response_code" = NULL,
        "response_body" = ${bodyJson}::jsonb,
        "expires_at" = ${expiresAt},
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "idempotency_keys"."status" IS DISTINCT FROM 'COMPLETED'::"IdempotencyStatus"
    `;
    if (affected === 0) {
      // Row exists but is COMPLETED — read it so caller can replay.
      return this.db.idempotencyKey.findUnique({
        where: { scope_key: { scope, key } },
      });
    }
    return this.db.idempotencyKey.findUnique({
      where: { scope_key: { scope, key } },
    });
  }

  findUnique(scope: string, key: string): Promise<IdempotencyKey | null> {
    return this.db.idempotencyKey.findUnique({
      where: { scope_key: { scope, key } },
    });
  }

  findById(id: string): Promise<IdempotencyKey | null> {
    return this.db.idempotencyKey.findUnique({ where: { id } });
  }

  list(opts: IdempotencyKeyListOptions = {}): Promise<IdempotencyKey[]> {
    const { skip, take } = normalizePagination(opts);
    const where: Prisma.IdempotencyKeyWhereInput = {};
    if (opts.scope) where.scope = opts.scope;
    if (opts.status) where.status = opts.status;

    const orderBy: Prisma.IdempotencyKeyOrderByWithRelationInput = opts.orderBy
      ? { [opts.orderBy.field]: opts.orderBy.dir }
      : { createdAt: 'desc' };

    return this.db.idempotencyKey.findMany({ where, skip, take, orderBy });
  }

  count(where: Prisma.IdempotencyKeyWhereInput = {}): Promise<number> {
    return this.db.idempotencyKey.count({ where });
  }

  complete(
    scope: string,
    key: string,
    input: IdempotencyKeyCompleteInput,
  ): Promise<IdempotencyKey> {
    return this.db.idempotencyKey.update({
      where: { scope_key: { scope, key } },
      data: {
        status: 'COMPLETED',
        responseCode: input.responseCode,
        responseBody: input.responseBody,
      },
    });
  }

  fail(scope: string, key: string): Promise<IdempotencyKey> {
    return this.db.idempotencyKey.update({
      where: { scope_key: { scope, key } },
      data: { status: 'FAILED' },
    });
  }

  /** Delete expired rows older than `before`. For worker cleanup. */
  purgeExpired(before: Date): Promise<number> {
    return this.db.idempotencyKey
      .deleteMany({ where: { expiresAt: { lt: before } } })
      .then((r) => r.count);
  }
}
