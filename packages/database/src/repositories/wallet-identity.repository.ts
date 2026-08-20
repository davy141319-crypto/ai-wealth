// ============================================================================
// WalletIdentityRepository — data access for `wallet_identities`.
// Records a verified proof-of-ownership for a wallet. (walletId, identityType)
// is unique at the DB level; this repository does not deduplicate in app code.
// ============================================================================

import { Prisma, type IdentityType, type WalletIdentity } from '@prisma/client';
import { prisma } from '../client';
import { normalizePagination, type PaginationInput, type SortDirection } from '../types';

export interface WalletIdentityCreateInput {
  walletId: string;
  identityType: IdentityType;
  verifiedAt?: Date;
}

export interface WalletIdentityListOptions extends PaginationInput {
  walletId?: string;
  identityType?: IdentityType;
  orderBy?: { field: 'createdAt' | 'verifiedAt'; dir: SortDirection };
}

export class WalletIdentityRepository {
  constructor(private readonly tx?: Prisma.TransactionClient) {}

  private get db() {
    return this.tx ?? prisma;
  }

  create(input: WalletIdentityCreateInput): Promise<WalletIdentity> {
    return this.db.walletIdentity.create({
      data: {
        walletId: input.walletId,
        identityType: input.identityType,
        verifiedAt: input.verifiedAt,
      },
    });
  }

  findById(id: string): Promise<WalletIdentity | null> {
    return this.db.walletIdentity.findUnique({ where: { id } });
  }

  findUnique(walletId: string, identityType: IdentityType): Promise<WalletIdentity | null> {
    return this.db.walletIdentity.findUnique({
      where: { walletId_identityType: { walletId, identityType } },
    });
  }

  list(opts: WalletIdentityListOptions = {}): Promise<WalletIdentity[]> {
    const { skip, take } = normalizePagination(opts);
    const where: Prisma.WalletIdentityWhereInput = {};
    if (opts.walletId) where.walletId = opts.walletId;
    if (opts.identityType) where.identityType = opts.identityType;

    const orderBy: Prisma.WalletIdentityOrderByWithRelationInput = opts.orderBy
      ? { [opts.orderBy.field]: opts.orderBy.dir }
      : { verifiedAt: 'desc' };

    return this.db.walletIdentity.findMany({ where, skip, take, orderBy });
  }

  count(where: Prisma.WalletIdentityWhereInput = {}): Promise<number> {
    return this.db.walletIdentity.count({ where });
  }
}
