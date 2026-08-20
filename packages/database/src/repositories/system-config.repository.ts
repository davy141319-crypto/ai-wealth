// ============================================================================
// SystemConfigRepository — typed key/value config store.
// `value` is always TEXT in the DB; `valueType` tells the reader how to
// decode it. Callers should decode/encode in the Service layer rather than
// here, so this repository stays a thin data-access object.
// ============================================================================

import {
  Prisma,
  type SystemConfig,
  type SystemConfigValueType,
} from '@prisma/client';
import { prisma } from '../client';
import {
  normalizePagination,
  type PaginationInput,
  type SortDirection,
} from '../types';

export interface SystemConfigUpsertInput {
  key: string;
  value: string;
  valueType?: SystemConfigValueType;
  description?: string | null;
  isActive?: boolean;
}

export interface SystemConfigUpdateInput {
  value?: string;
  valueType?: SystemConfigValueType;
  description?: string | null;
  isActive?: boolean;
}

export interface SystemConfigListOptions extends PaginationInput {
  isActive?: boolean;
  valueType?: SystemConfigValueType;
  orderBy?: { field: 'createdAt' | 'updatedAt' | 'key'; dir: SortDirection };
}

export class SystemConfigRepository {
  constructor(private readonly tx?: Prisma.TransactionClient) {}

  private get db() {
    return this.tx ?? prisma;
  }

  upsert(input: SystemConfigUpsertInput): Promise<SystemConfig> {
    return this.db.systemConfig.upsert({
      where: { key: input.key },
      create: {
        key: input.key,
        value: input.value,
        valueType: input.valueType ?? 'STRING',
        description: input.description ?? null,
        isActive: input.isActive ?? true,
      },
      update: {
        value: input.value,
        valueType: input.valueType,
        description: input.description,
        isActive: input.isActive,
      },
    });
  }

  findByKey(key: string): Promise<SystemConfig | null> {
    return this.db.systemConfig.findUnique({ where: { key } });
  }

  findById(id: string): Promise<SystemConfig | null> {
    return this.db.systemConfig.findUnique({ where: { id } });
  }

  list(opts: SystemConfigListOptions = {}): Promise<SystemConfig[]> {
    const { skip, take } = normalizePagination(opts);
    const where: Prisma.SystemConfigWhereInput = {};
    if (typeof opts.isActive === 'boolean') where.isActive = opts.isActive;
    if (opts.valueType) where.valueType = opts.valueType;

    const orderBy: Prisma.SystemConfigOrderByWithRelationInput = opts.orderBy
      ? { [opts.orderBy.field]: opts.orderBy.dir }
      : { key: 'asc' };

    return this.db.systemConfig.findMany({ where, skip, take, orderBy });
  }

  count(where: Prisma.SystemConfigWhereInput = {}): Promise<number> {
    return this.db.systemConfig.count({ where });
  }

  update(key: string, input: SystemConfigUpdateInput): Promise<SystemConfig> {
    return this.db.systemConfig.update({ where: { key }, data: { ...input } });
  }

  setActive(key: string, isActive: boolean): Promise<SystemConfig> {
    return this.db.systemConfig.update({ where: { key }, data: { isActive } });
  }
}
