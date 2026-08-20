// ============================================================================
// AuthNonceRepository — data access for `auth_nonces`.
// Issues and consumes single-use challenge nonces for wallet sign-in.
//   - issue():  creates a new nonce row with an expiry.
//   - consume(): marks a nonce as used (single-use). Returns null if already
//                used or expired; the Service layer translates that into an
//                AppError (UNAUTHORIZED / CONFLICT).
// Repository stays dumb: it does not generate the nonce string itself —
// the caller (Service) supplies it so the cryptographic source is testable
// and injectable. This repository just persists and queries.
// ============================================================================

import { Prisma, type AuthNonce } from '@prisma/client';
import { prisma } from '../client';
import {
  normalizePagination,
  type PaginationInput,
  type SortDirection,
} from '../types';

export interface AuthNonceCreateInput {
  walletId: string;
  nonce: string;
  expiresAt: Date;
}

export interface AuthNonceListOptions extends PaginationInput {
  walletId?: string;
  used?: boolean;
  orderBy?: { field: 'createdAt' | 'expiresAt' | 'issuedAt'; dir: SortDirection };
}

export interface ConsumeResult {
  ok: boolean;
  nonce: AuthNonce | null;
}

export class AuthNonceRepository {
  constructor(private readonly tx?: Prisma.TransactionClient) {}

  private get db() {
    return this.tx ?? prisma;
  }

  create(input: AuthNonceCreateInput): Promise<AuthNonce> {
    return this.db.authNonce.create({
      data: {
        walletId: input.walletId,
        nonce: input.nonce,
        expiresAt: input.expiresAt,
      },
    });
  }

  findByNonce(nonce: string): Promise<AuthNonce | null> {
    return this.db.authNonce.findUnique({ where: { nonce } });
  }

  findById(id: string): Promise<AuthNonce | null> {
    return this.db.authNonce.findUnique({ where: { id } });
  }

  list(opts: AuthNonceListOptions = {}): Promise<AuthNonce[]> {
    const { skip, take } = normalizePagination(opts);
    const where: Prisma.AuthNonceWhereInput = {};
    if (opts.walletId) where.walletId = opts.walletId;
    if (typeof opts.used === 'boolean') {
      where.usedAt = opts.used ? { not: null } : null;
    }

    const orderBy: Prisma.AuthNonceOrderByWithRelationInput = opts.orderBy
      ? { [opts.orderBy.field]: opts.orderBy.dir }
      : { issuedAt: 'desc' };

    return this.db.authNonce.findMany({ where, skip, take, orderBy });
  }

  count(where: Prisma.AuthNonceWhereInput = {}): Promise<number> {
    return this.db.authNonce.count({ where });
  }

  /**
   * Consume a nonce: atomically set usedAt = now() iff it is still unused.
   * Returns { ok: true, nonce } on success, { ok: false, nonce: null } if the
   * nonce was already used or does not exist.
   *
   * NOTE: expiry is intentionally NOT checked here, because the Service layer
   * should distinguish "expired" from "already used" for logging/throttling.
   * The Service calls findByNonce(), inspects expiresAt/usedAt, then calls
   * consume() only when the nonce is valid.
   */
  async consume(nonce: string, at: Date = new Date()): Promise<ConsumeResult> {
    const updated = await this.db.authNonce.updateMany({
      where: { nonce, usedAt: null },
      data: { usedAt: at },
    });
    if (updated.count === 0) {
      return { ok: false, nonce: null };
    }
    // Re-read to return the persisted row with the new usedAt.
    const row = await this.db.authNonce.findUnique({ where: { nonce } });
    return { ok: true, nonce: row };
  }

  /** Delete expired and used nonces older than `before`. For worker cleanup. */
  purgeExpired(before: Date): Promise<number> {
    return this.db.authNonce
      .deleteMany({ where: { expiresAt: { lt: before } } })
      .then((r) => r.count);
  }
}
