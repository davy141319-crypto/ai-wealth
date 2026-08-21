// ============================================================================
// UserRepository — data access for the `users` table.
// No business rules; CRUD + lookup by status. Errors propagate as Prisma
// errors and are mapped by the Service layer.
// ============================================================================

import { Prisma, type User, type UserRole, type UserStatus } from '@prisma/client';
import { prisma } from '../client';
import { normalizePagination, type PaginationInput, type SortDirection } from '../types';

export interface UserCreateInput {
  status?: UserStatus;
  lastLoginAt?: Date;
}

export interface UserUpdateInput {
  status?: UserStatus;
  lastLoginAt?: Date | null;
}

/**
 * P1-006 — Authorization projection (role + status) used by RolesGuard.
 * Deliberately read-only and role-mutation-free: there is NO setRole /
 * updateRole method on this repository, and `UserUpdateInput` does NOT expose
 * `role`. Admin role changes happen only via the controlled provisioning SQL
 * transaction defined in the P1-006 spec (out of application-code scope).
 *
 * A single DB query returns both fields so RolesGuard reads authorization
 * context in ONE round-trip per request (no double lookup).
 */
export interface AuthorizationContext {
  role: UserRole;
  status: UserStatus;
}

export interface UserListOptions extends PaginationInput {
  status?: UserStatus;
  orderBy?: { field: 'createdAt' | 'updatedAt' | 'lastLoginAt'; dir: SortDirection };
}

export interface UserWithRelations {
  includeWallets?: boolean;
  includeAuditLogs?: boolean;
}

export class UserRepository {
  constructor(private readonly tx?: Prisma.TransactionClient) {}

  private get db() {
    return this.tx ?? prisma;
  }

  create(input: UserCreateInput = {}): Promise<User> {
    return this.db.user.create({
      data: {
        status: input.status,
        lastLoginAt: input.lastLoginAt,
      },
    });
  }

  findById(id: string, opts: UserWithRelations = {}): Promise<User | null> {
    return this.db.user.findUnique({
      where: { id },
      include: {
        wallets: opts.includeWallets ?? false,
        auditLogs: opts.includeAuditLogs ?? false,
      },
    });
  }

  /**
   * P1-006 — Authorization context projection (role + status) in a SINGLE DB
   * query. Used by RolesGuard to make per-request authorization decisions live
   * from the DB (never from the JWT). Returns `null` when the user does not
   * exist; RolesGuard treats null as AUTHZ_USER_NOT_FOUND (fail-closed 403).
   *
   * Role mutation is intentionally NOT exposed here. See AuthorizationContext.
   */
  getAuthorizationContext(id: string): Promise<AuthorizationContext | null> {
    return this.db.user.findUnique({
      where: { id },
      select: { role: true, status: true },
    });
  }

  list(opts: UserListOptions = {}): Promise<User[]> {
    const { skip, take } = normalizePagination(opts);
    const where: Prisma.UserWhereInput = {};
    if (opts.status) where.status = opts.status;

    const orderBy: Prisma.UserOrderByWithRelationInput = opts.orderBy
      ? { [opts.orderBy.field]: opts.orderBy.dir }
      : { createdAt: 'desc' };

    return this.db.user.findMany({ where, skip, take, orderBy });
  }

  count(where: Prisma.UserWhereInput = {}): Promise<number> {
    return this.db.user.count({ where });
  }

  update(id: string, input: UserUpdateInput): Promise<User> {
    return this.db.user.update({
      where: { id },
      data: {
        status: input.status,
        lastLoginAt: input.lastLoginAt,
      },
    });
  }

  /** Soft transitions only; physical delete is intentionally not exposed. */
  updateStatus(id: string, status: UserStatus): Promise<User> {
    return this.db.user.update({ where: { id }, data: { status } });
  }

  touchLastLogin(id: string, at: Date = new Date()): Promise<User> {
    return this.db.user.update({ where: { id }, data: { lastLoginAt: at } });
  }
}
