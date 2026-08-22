export { prisma } from './client';
export type { PrismaClient } from './client';
export { dbHealth } from './health';
export type { DbComponentHealth } from './health';

// P1-001 repository layer
export * from './types';
export * from './repositories';

// P1-002 chain / SIWE helpers
export { ChainUtils, UNSUPPORTED_CHAIN_ID, EV_CHAINS_SUPPORTED } from './chain-utils';

// Re-export Prisma enums/types so packages/services without a direct
// @prisma/client dependency can still use them. @prisma/client is installed
// at the workspace root as a transitive dep (via the database package) so
// re-exporting here lets api use the same type graph as database without
// declaring its own Prisma dependency.
//
// Enums are runtime VALUES — re-exported without `type` so services can use
// them as both types AND values (e.g. `UserStatus.ACTIVE`, `UserRole.ADMIN`
// in P1-006 RolesGuard). Model interfaces remain type-only.
// NOTE: `Prisma` is ALSO re-exported as a VALUE (not only type) because
// money-path engine code uses `Prisma.Decimal`, `Prisma.JsonNull` at runtime.
export type {
  Wallet,
  User,
  AuthNonce,
  WalletIdentity,
  AuditLog,
  LedgerTransaction,
  LedgerPosting,
} from '@prisma/client';
export {
  Chain,
  WalletStatus,
  UserStatus,
  UserRole,
  IdentityType,
  // P1-008 runtime enums
  LedgerTxnType,
  LedgerAmountSign,
} from '@prisma/client';
export { Prisma } from '@prisma/client';
