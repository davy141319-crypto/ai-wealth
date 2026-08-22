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

  /**
   * Lock a user row with SELECT ... FOR UPDATE inside a transaction and
   * return the current role + status. Used by P1-008 money-path locking
   * strategy for accountType=USER (real user rows). Returns null when the
   * user does not exist (caller must fail: you cannot lock a fake user row
   * at the DB level, so a non-existent user id is rejected here).
   *
   * MUST be called inside an active Prisma transaction; if no transaction
   * client is bound, throws to avoid silently using the singleton client.
   */
  async lockForUpdate(id: string): Promise<AuthorizationContext | null> {
    if (!this.tx) {
      throw new Error('UserRepository.lockForUpdate requires a Prisma transaction client');
    }
    // Use $queryRaw with parameter binding to safely inject the uuid into
    // a SELECT … FOR UPDATE statement (Prisma findUnique does not support
    // the FOR UPDATE lock strength on Postgres via the query builder).
    const rows = await this.tx.$queryRaw<Prisma.Sql>`
      SELECT role::text AS role, status::text AS status
      FROM users
      WHERE id = ${id}::uuid
      FOR UPDATE
    `;
    const arr = Array.isArray(rows) ? (rows as Array<{ role: unknown; status: unknown }>) : [];
    if (arr.length === 0) return null;
    const r = arr[0];
    return { role: r.role as UserRole, status: r.status as UserStatus };
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
