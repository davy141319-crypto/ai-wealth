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
