// ============================================================================
// AuditLogRepository — append-only audit trail.
//   - Only create() and read methods are exposed. There is intentionally NO
//     update() or delete(): audit rows are immutable by contract. The Service
//     layer and any admin tooling MUST NOT mutate audit rows.
//   - `actor` is nullable (system / anonymous actions). No FK constraint is
//     enforced at the DB level on purpose so historical audits survive user
//     deletion (ON DELETE SET NULL).
//   - `metadata` is JSONB; never put secrets, PII, or tokens here.
// ============================================================================

import { Prisma, type AuditLog } from '@prisma/client';
import { prisma } from '../client';
import {
  normalizePagination,
  type PaginationInput,
  type SortDirection,
} from '../types';

export interface AuditLogCreateInput {
  actor?: string | null;
  action: string;
  resource: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export interface AuditLogListOptions extends PaginationInput {
  actor?: string;
  action?: string;
  resource?: string;
  requestId?: string;
  createdAfter?: Date;
  createdBefore?: Date;
  orderBy?: { field: 'createdAt'; dir: SortDirection };
}

export class AuditLogRepository {
  constructor(private readonly tx?: Prisma.TransactionClient) {}

  private get db() {
    return this.tx ?? prisma;
  }

  create(input: AuditLogCreateInput): Promise<AuditLog> {
    return this.db.auditLog.create({
      data: {
        actor: input.actor ?? null,
        action: input.action,
        resource: input.resource,
        requestId: input.requestId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: input.metadata ?? Prisma.JsonNull,
      },
    });
  }

  findById(id: string): Promise<AuditLog | null> {
    return this.db.auditLog.findUnique({ where: { id } });
  }

  list(opts: AuditLogListOptions = {}): Promise<AuditLog[]> {
    const { skip, take } = normalizePagination(opts);
    const where: Prisma.AuditLogWhereInput = {};
    if (opts.actor) where.actor = opts.actor;
    if (opts.action) where.action = opts.action;
    if (opts.resource) where.resource = opts.resource;
    if (opts.requestId) where.requestId = opts.requestId;
    if (opts.createdAfter || opts.createdBefore) {
      where.createdAt = {};
      if (opts.createdAfter) where.createdAt.gte = opts.createdAfter;
      if (opts.createdBefore) where.createdAt.lte = opts.createdBefore;
    }

    const dir = opts.orderBy?.dir ?? 'desc';
    return this.db.auditLog.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: dir },
    });
  }

  count(where: Prisma.AuditLogWhereInput = {}): Promise<number> {
    return this.db.auditLog.count({ where });
  }
}
