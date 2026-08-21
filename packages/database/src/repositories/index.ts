// ============================================================================
// Repository barrel + aggregate root.
//
// The `Repositories` aggregate is the single entry point a Service layer
// should use. It bundles all repositories and supports running them inside
// a Prisma transaction via `.tx(client)`:
//
//   const repos = new Repositories();
//   await repos.user.create({});
//
//   // transactional:
//   await prisma.$transaction(async (tx) => {
//     const txRepos = new Repositories(tx);
//     const user = await txRepos.user.create({});
//     await txRepos.wallet.create({ userId: user.id, ... });
//   });
//
// Constructor takes an optional Prisma.TransactionClient so a single
// `Repositories` instance is bound to either the singleton prisma client or a
// transaction. Repositories read from that client uniformly via `this.db`.
// ============================================================================

import { Prisma } from '@prisma/client';
import { prisma } from '../client';
import { UserRepository } from './user.repository';
import { WalletRepository } from './wallet.repository';
import { WalletIdentityRepository } from './wallet-identity.repository';
import { AuthNonceRepository } from './auth-nonce.repository';
import { AuditLogRepository } from './audit-log.repository';
import { IdempotencyKeyRepository } from './idempotency-key.repository';
import { SystemConfigRepository } from './system-config.repository';

export { UserRepository } from './user.repository';
export type { AuthorizationContext } from './user.repository';
export { WalletRepository } from './wallet.repository';
export { WalletIdentityRepository } from './wallet-identity.repository';
export { AuthNonceRepository } from './auth-nonce.repository';
export { AuditLogRepository } from './audit-log.repository';
export { IdempotencyKeyRepository } from './idempotency-key.repository';
export { SystemConfigRepository } from './system-config.repository';

export type TransactionClient = Prisma.TransactionClient;

export class Repositories {
  readonly user: UserRepository;
  readonly wallet: WalletRepository;
  readonly walletIdentity: WalletIdentityRepository;
  readonly authNonce: AuthNonceRepository;
  readonly auditLog: AuditLogRepository;
  readonly idempotencyKey: IdempotencyKeyRepository;
  readonly systemConfig: SystemConfigRepository;

  constructor(tx?: TransactionClient) {
    this.user = new UserRepository(tx);
    this.wallet = new WalletRepository(tx);
    this.walletIdentity = new WalletIdentityRepository(tx);
    this.authNonce = new AuthNonceRepository(tx);
    this.auditLog = new AuditLogRepository(tx);
    this.idempotencyKey = new IdempotencyKeyRepository(tx);
    this.systemConfig = new SystemConfigRepository(tx);
  }

  /**
   * Run `fn` inside a Prisma transaction with a fresh Repositories bound to
   * the transaction client. The transaction commits iff fn resolves; any throw
   * rolls back. Use this for multi-table writes that must be atomic.
   *
   * Static form: `Repositories.transaction(fn)` — uses the singleton prisma
   * client (i.e. opens a brand-new transaction).
   *
   * Instance form: `repos.transaction(fn)` — delegates to the static form so
   * DI-injected Repositories instances still get real Prisma transaction
   * semantics in production; tests may provide an instance override that
   * snapshots/rolls back an in-memory DB.
   */
  static async transaction<T>(
    fn: (repos: Repositories) => Promise<T>,
    opts?: { timeout?: number; maxWait?: number },
  ): Promise<T> {
    return prisma.$transaction(
      async (tx: Prisma.TransactionClient) => fn(new Repositories(tx)),
      opts,
    );
  }

  /** Instance-level transaction — delegates to Repositories.transaction(). */
  transaction<T>(
    fn: (repos: Repositories) => Promise<T>,
    opts?: { timeout?: number; maxWait?: number },
  ): Promise<T> {
    return Repositories.transaction(fn, opts);
  }
}

/** The PrismaClient type this package is built on. */
export type { PrismaClient } from '@prisma/client';
export { Prisma } from '@prisma/client';
