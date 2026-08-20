// ============================================================================
// WalletRepository — data access for the `wallets` table.
// Identity-only: no balance/asset fields exist on this model and never will
// in P1 (hard constraint: no real fund data). Enforces the (address, chain,
// network) uniqueness via Prisma's unique constraint at the DB level.
// ============================================================================

import { Prisma, type Chain, type Wallet, type WalletStatus } from '@prisma/client';
import { prisma } from '../client';
import {
  normalizePagination,
  type PaginationInput,
  type SortDirection,
} from '../types';

export interface WalletCreateInput {
  userId: string;
  address: string;
  chain: Chain;
  network: string;
  status?: WalletStatus;
  isPrimary?: boolean;
}

export interface WalletUpdateInput {
  status?: WalletStatus;
  isPrimary?: boolean;
}

export interface WalletListOptions extends PaginationInput {
  userId?: string;
  chain?: Chain;
  status?: WalletStatus;
  isPrimary?: boolean;
  orderBy?: { field: 'createdAt' | 'updatedAt' | 'address'; dir: SortDirection };
}

export interface WalletFindUniqueInput {
  address: string;
  chain: Chain;
  network: string;
}

export class WalletRepository {
  constructor(private readonly tx?: Prisma.TransactionClient) {}

  private get db() {
    return this.tx ?? prisma;
  }

  create(input: WalletCreateInput): Promise<Wallet> {
    return this.db.wallet.create({
      data: {
        userId: input.userId,
        address: input.address,
        chain: input.chain,
        network: input.network,
        status: input.status,
        isPrimary: input.isPrimary,
      },
    });
  }

  findById(id: string): Promise<Wallet | null> {
    return this.db.wallet.findUnique({ where: { id } });
  }

  findUnique(input: WalletFindUniqueInput): Promise<Wallet | null> {
    return this.db.wallet.findUnique({
      where: {
        address_chain_network: {
          address: input.address,
          chain: input.chain,
          network: input.network,
        },
      },
    });
  }

  list(opts: WalletListOptions = {}): Promise<Wallet[]> {
    const { skip, take } = normalizePagination(opts);
    const where: Prisma.WalletWhereInput = {};
    if (opts.userId) where.userId = opts.userId;
    if (opts.chain) where.chain = opts.chain;
    if (opts.status) where.status = opts.status;
    if (typeof opts.isPrimary === 'boolean') where.isPrimary = opts.isPrimary;

    const orderBy: Prisma.WalletOrderByWithRelationInput = opts.orderBy
      ? { [opts.orderBy.field]: opts.orderBy.dir }
      : { createdAt: 'desc' };

    return this.db.wallet.findMany({ where, skip, take, orderBy });
  }

  count(where: Prisma.WalletWhereInput = {}): Promise<number> {
    return this.db.wallet.count({ where });
  }

  update(id: string, input: WalletUpdateInput): Promise<Wallet> {
    return this.db.wallet.update({ where: { id }, data: { ...input } });
  }

  listByUser(userId: string): Promise<Wallet[]> {
    return this.db.wallet.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  }
}
