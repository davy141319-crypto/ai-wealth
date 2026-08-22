// ============================================================================
// Shared repository types for the @ai-wealth/database package.
// These are data-access DTOs: repository methods accept inputs shaped by
// these types and return Prisma-generated model types (re-exported below).
//
// Repository layer contract (Controller → Service → Repository → Prisma):
//   - Repositories own ONLY data access (CRUD + queries). No business rules,
//     no HTTP/transport concerns, no error formatting.
//   - Repositories may throw Prisma errors; the Service layer maps them to
//     AppError via shared/error-codes. Repositories do not import AppError.
//   - All list methods accept PaginationInput and return Paginated<T> from
//     @ai-wealth/shared so pagination shape is uniform across services.
// ============================================================================

import type { Prisma } from '@prisma/client';

// ---- Pagination -----------------------------------------------------------

export interface PaginationInput {
  page?: number; // 1-based, default 1
  pageSize?: number; // default 20, max 100
}

export const DEFAULT_PAGE = 1;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Clamp a PaginationInput to safe bounds; returns {skip, take, page, pageSize}. */
export function normalizePagination(input: PaginationInput = {}): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const page = Math.max(1, Math.floor(input.page ?? DEFAULT_PAGE));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(input.pageSize ?? DEFAULT_PAGE_SIZE)),
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

// ---- Sort direction -------------------------------------------------------

export type SortDirection = 'asc' | 'desc';

// ---- Re-export Prisma-generated types so callers import from one place ----

export type {
  User,
  Wallet,
  WalletIdentity,
  AuthNonce,
  AuditLog,
  IdempotencyKey,
  SystemConfig,
  SystemMeta,
  LedgerTransaction,
  LedgerPosting,
} from '@prisma/client';

export type {
  UserStatus,
  Chain,
  WalletStatus,
  IdentityType,
  IdempotencyStatus,
  SystemConfigValueType,
  // P1-008 enums (types)
  LedgerTxnType,
  LedgerAmountSign,
} from '@prisma/client';

// Runtime re-export for Prisma.Decimal / InputJsonValue / where types — kept
// for packages that already depend on `import type { Prisma }`; but the
// VALUE-ful `Prisma` lives in `index.ts` for runtime usage.
export type { Prisma };
