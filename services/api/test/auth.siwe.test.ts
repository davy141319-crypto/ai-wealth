// ============================================================================
// P1-002 — 15 scenarios for the full SIWE auth journey.
//
// This suite drives both SERVICE (AuthService.* + domain helpers) and HTTP
// (supertest against a real Nest app) layers deterministically — with no
// external Postgres or Redis required:
//
//   * Repositories are replaced with an in-memory fake via
//     `InMemoryRepositoriesBackend`, covering every read + write path used by
//     P1-002 (user / wallet / walletIdentity / authNonce / auditLog).
//     Transaction semantics are simulated via a "snapshot → apply → rollback
//     on throw" strategy so the atomic consume→bind→identity→audit write-set
//     behaves identically to Prisma.$transaction.
//   * Redis session/blocklist is provided by FakeRedisService (used by the
//     Nest app through a module override).
//
// Coverage matrix (15 scenarios — 1 per `it()`):
//   T01 normal login
//   T02 bad signature (cryptographic mismatch)
//   T03 bad address (body vs SIWE claim mismatch)
//   T04 bad domain
//   T05 bad URI
//   T06 bad chainId
//   T07 expired SIWE (expirationTime already past)
//   T08 duplicate nonce (same payload twice)
//   T09 already-used nonce (fresh SIWE message reusing a used nonce)
//   T10 concurrent login (Promise.all race over same nonce)
//   T11 repeat wallet login → reuses the same user
//   T12 revoked wallet login → 403 WALLET_REVOKED
//   T13 logout → JWT blocklisted + audit log
//   T14 JWT invalid / expired → 401 TOKEN_INVALID / TOKEN_EXPIRED
//   T15 anonymous access to protected routes → 401 NOT_AUTHENTICATED
// ============================================================================

import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type {
  AuthNonce,
  AuditLog,
  Chain,
  IdentityType,
  User,
  UserStatus,
  Wallet,
  WalletIdentity,
  WalletStatus,
} from '@ai-wealth/database';
import { Repositories } from '@ai-wealth/database';
import { AppError, AppErrorCode, AuthFailReason, createLogger } from '@ai-wealth/shared';
import { env } from '@ai-wealth/config';
import { AppModule } from '../src/app.module';
import { RedisService } from '../src/common/redis/redis.service';
import { SiweService } from '../src/auth/siwe.service';
import type { SiweMessage } from '../src/auth/siwe.message';
import { FakeRedisService } from './fake-redis.service';

// Silence unused-import noise from type-only pulls
void createLogger;

// ---------------------------------------------------------------------------
// In-memory fake database — mirrors the repository surface actually used.
// ---------------------------------------------------------------------------

type DB = {
  users: Record<string, User>;
  wallets: Record<string, Wallet>;
  identities: Record<string, WalletIdentity>;
  nonces: Record<string, AuthNonce>;
  audits: AuditLog[];
};

function newDB(): DB {
  return { users: {}, wallets: {}, identities: {}, nonces: {}, audits: [] };
}

const chainToChainId: Record<string, number> = {
  ETH: 1,
  BSC: 56,
  POLYGON: 137,
  ARBITRUM: 42161,
};

const TEST_JWT_SECRET = 'test-jwt-secret-aaaaaaaaaaaa-bbbbbbbbbbbbbb-cccccccc-12';
const TEST_JWT_TTL_SEC = 15 * 60;
const TEST_DOMAIN = 'test.example.com';
const TEST_URI = 'https://test.example.com/api/auth/verify';
const TEST_STMT = 'Sign in to AI Wealth (CI build test).';
const TEST_SIWE_TTL_SEC = 600;
const TEST_CLOCK_SKEW_SEC = 300;

// Reset env cache to known values so every invocation reads the same constants.
function resetTestEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.API_PORT = '0';
  process.env.LOG_LEVEL = 'error';
  process.env.WEB_APP_URL = 'https://test.example.com';
  process.env.ADMIN_APP_URL = 'https://admin.test.example.com';
  process.env.CORS_ORIGINS =
    process.env.CORS_ORIGINS || 'https://test.example.com,https://admin.test.example.com';
  process.env.CORS_CREDENTIALS = process.env.CORS_CREDENTIALS || 'true';
  process.env.RATE_LIMIT_DEFAULT = process.env.RATE_LIMIT_DEFAULT || '120';
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.JWT_EXPIRES_IN = `${TEST_JWT_TTL_SEC}s`;
  process.env.SIWE_DOMAIN = TEST_DOMAIN;
  process.env.SIWE_URI = TEST_URI;
  process.env.SIWE_STATEMENT = TEST_STMT;
  process.env.SIWE_NONCE_TTL_SEC = String(TEST_SIWE_TTL_SEC);
  process.env.SIWE_CLOCK_SKEW_SEC = String(TEST_CLOCK_SKEW_SEC);
  // Dummy DB URL — not actually used (we bypass real prisma via the fake
  // repository shim installed in beforeEach). Must still be a valid string
  // because NonceService + AuthService constructors call `new Repositories()`
  // to get their defaults. The prisma singleton only touches the connection
  // on first DB call, which never happens (all calls are mocked).
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    'postgresql://ci:ci@127.0.0.1:5432/aiwealth_ci_not_used?schema=public';
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379/0';

  const mod = require('@ai-wealth/config');
  if (typeof mod._resetEnvCache === 'function') mod._resetEnvCache();
  const e = mod.env('api');
  expect(e.siweDomain).toBe(TEST_DOMAIN);
  expect(e.jwtSecret.length).toBeGreaterThanOrEqual(32);
}

/**
 * installRepositoriesProxy — install a class-level Proxy for `Repositories`
 * ONCE for the whole suite. The proxy dereferences `currentDB`, a per-test
 * mutable reference swapped in beforeEach. Uses Object.defineProperty because
 * compiled CJS modules re-export ES module semantics with getter-only props.
 *
 * Transaction semantics: snapshot `currentDB` at start, restore on throw.
 */
let currentDB: DB = newDB();

function installRepositoriesProxy(): { restore(): void; flush(): DB } {
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const OrigRepo = Repositories;
  const newRepos = (view: DB) => {
    const getDB = () => view;
    const self: any = {
      user: buildUserRepo(getDB),
      wallet: buildWalletRepo(getDB),
      walletIdentity: buildWalletIdentityRepo(getDB),
      authNonce: buildAuthNonceRepo(getDB),
      auditLog: buildAuditLogRepo(getDB),
      idempotencyKey: {
        findByKey: async () => null,
        acquire: async () => ({ id: 'fake' }) as any,
      },
      systemConfig: { get: async () => null, set: async () => undefined as any },
    };
    return self as unknown as Repositories;
  };

  const handler: ProxyHandler<typeof OrigRepo> = {
    construct(): Repositories {
      return newRepos(currentDB);
    },
    apply(): never {
      throw new Error('Repositories is a class, not callable');
    },
    get(target: any, prop: string | symbol): any {
      if (prop === 'transaction') {
        return async function transaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
          const snap = structuredCloneSafe(currentDB);
          try {
            const txRepos = newRepos(currentDB);
            return await fn(txRepos);
          } catch (err) {
            // Rollback: replace currentDB's own properties with snapshot.
            Object.keys(currentDB).forEach((k) => delete (currentDB as any)[k]);
            Object.assign(currentDB, snap);
            throw err;
          }
        };
      }
      return (target as any)[prop];
    },
  };
  const ProxyCtor = new Proxy(OrigRepo, handler) as typeof Repositories;

  function patchOnce(importPath: string) {
    try {
      const mod = require(importPath);
      // Override ESM-style getters.
      Object.defineProperty(mod, 'Repositories', {
        configurable: true,
        enumerable: true,
        get: () => ProxyCtor,
        set: () => {
          /* no-op: proxy lifetime is controlled by the suite */
        },
      });
    } catch {
      /* import path not resolvable — skip */
    }
  }
  patchOnce('@ai-wealth/database');

  return {
    restore() {
      // Drop require cache for @ai-wealth/database so post-suite consumers
      // (if any) get the original export next time.
      try {
        const resolved = require.resolve('@ai-wealth/database');
        delete require.cache[resolved];
      } catch {
        /* ignore */
      }
    },
    flush(): DB {
      return currentDB;
    },
  };
}

function structuredCloneSafe<T>(obj: T): T {
  if (typeof (globalThis as any).structuredClone === 'function') {
    return (globalThis as any).structuredClone(obj);
  }
  return JSON.parse(JSON.stringify(obj));
}

// ---- Individual repository fakes matching the subset used in P1-002 ----
// These accept a *reference* to a mutable `DB`.
function buildUserRepo(getDB: () => DB) {
  return {
    create: async (): Promise<User> => {
      const db = getDB();
      const id = randomUUID();
      const now = new Date();
      const u: User = {
        id,
        status: 'ACTIVE' as UserStatus,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
        locale: 'en',
        timezone: 'UTC',
      };
      db.users[id] = u;
      return u;
    },
    findById: async (id: string, opts?: any): Promise<any> => {
      const db = getDB();
      const u = db.users[id];
      if (!u) return null;
      if (opts?.includeWallets) {
        const wallets = Object.values(db.wallets).filter((w) => w.userId === id);
        return { ...u, wallets };
      }
      return u;
    },
    touchLastLogin: async (id: string): Promise<User> => {
      const db = getDB();
      const u = db.users[id];
      if (!u) throw AppError.notFound('user not found');
      const upd = { ...u, updatedAt: new Date(), lastLoginAt: new Date() };
      db.users[id] = upd;
      return upd;
    },
  };
}

function buildWalletRepo(getDB: () => DB) {
  return {
    create: async (input: any): Promise<Wallet> => {
      const db = getDB();
      const id = randomUUID();
      const now = new Date();
      const w: Wallet = {
        id,
        userId: input.userId ?? null,
        address: input.address,
        chain: input.chain,
        network: input.network,
        status: (input.status ?? 'DISCONNECTED') as WalletStatus,
        isPrimary: input.isPrimary ?? false,
        createdAt: now,
        updatedAt: now,
      };
      db.wallets[id] = w;
      return w;
    },
    findById: async (id: string): Promise<Wallet | null> => getDB().wallets[id] ?? null,
    findUnique: async ({ address, chain, network }: any): Promise<Wallet | null> => {
      const db = getDB();
      return (
        Object.values(db.wallets).find(
          (w) =>
            w.address.toLowerCase() === address.toLowerCase() &&
            w.chain === chain &&
            w.network === network,
        ) ?? null
      );
    },
    listByUser: async (userId: string): Promise<Wallet[]> => {
      const db = getDB();
      return Object.values(db.wallets)
        .filter((w) => w.userId === userId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    },
    update: async (id: string, input: any): Promise<Wallet> => {
      const db = getDB();
      const w = db.wallets[id];
      if (!w) throw AppError.notFound('wallet not found');
      const merged: Wallet = { ...w, updatedAt: new Date() } as Wallet;
      if (input.userId !== undefined) {
        (merged as any).userId = input.userId;
      }
      if (input.status !== undefined) (merged as any).status = input.status;
      if (input.isPrimary !== undefined) (merged as any).isPrimary = input.isPrimary;
      db.wallets[id] = merged;
      return merged;
    },
    bindUser: async (id: string, userId: string, status?: WalletStatus): Promise<Wallet> => {
      const db = getDB();
      const w = db.wallets[id];
      if (!w) throw AppError.notFound('wallet not found');
      const upd: any = { ...w, userId, updatedAt: new Date() };
      if (status) upd.status = status;
      db.wallets[id] = upd;
      return db.wallets[id];
    },
  };
}

function buildWalletIdentityRepo(getDB: () => DB) {
  return {
    findUnique: async (
      walletId: string,
      identityType: IdentityType,
    ): Promise<WalletIdentity | null> => {
      const db = getDB();
      return (
        Object.values(db.identities).find(
          (x) => x.walletId === walletId && x.identityType === identityType,
        ) ?? null
      );
    },
    create: async ({ walletId, identityType }: any): Promise<WalletIdentity> => {
      const db = getDB();
      const now = new Date();
      const i: WalletIdentity = {
        id: randomUUID(),
        walletId,
        identityType,
        createdAt: now,
        verifiedAt: now,
        provider: null,
        providerAccountId: null,
        lastUsedAt: now,
        metadata: null,
      };
      db.identities[i.id] = i;
      return i;
    },
  };
}

function buildAuthNonceRepo(getDB: () => DB) {
  return {
    create: async (input: any): Promise<AuthNonce> => {
      const db = getDB();
      const n: AuthNonce = {
        id: randomUUID(),
        nonce: input.nonce,
        walletId: input.walletId,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        usedAt: input.usedAt ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
      };
      db.nonces[n.nonce] = n;
      return n;
    },
    findByNonce: async (nonce: string): Promise<AuthNonce | null> => getDB().nonces[nonce] ?? null,
    consume: async (nonce: string): Promise<{ ok: boolean; nonce?: AuthNonce }> => {
      const db = getDB();
      const n = db.nonces[nonce];
      if (!n) return { ok: false };
      if (n.usedAt !== null) return { ok: false };
      if (n.expiresAt.getTime() < Date.now()) return { ok: false };
      const updated: AuthNonce = { ...n, usedAt: new Date() };
      db.nonces[nonce] = updated;
      return { ok: true, nonce: updated };
    },
    purgeExpired: async (): Promise<number> => {
      const db = getDB();
      let removed = 0;
      const now = Date.now();
      for (const [k, v] of Object.entries(db.nonces)) {
        if (v.expiresAt.getTime() < now) {
          delete db.nonces[k];
          removed++;
        }
      }
      return removed;
    },
  };
}

function buildAuditLogRepo(getDB: () => DB) {
  return {
    create: async (input: any): Promise<any> => {
      const db = getDB();
      const row: any = {
        id: randomUUID(),
        actor: input.actor ?? null,
        action: input.action,
        resource: input.resource ?? 'auth',
        requestId: input.requestId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        success: input.success ?? input.action !== 'AUTH_LOGIN_FAILURE',
        metadata: input.metadata ?? {},
        createdAt: new Date(),
      };
      db.audits.push(row);
      return row;
    },
  };
}

// ---------------------------------------------------------------------------
// SIWE helper — defers to server-side SiweService.format() so the exact
// EIP-4361 A-BNF output matches what the server's parser expects. Normalizes
// HTTP-transmitted ISO strings (issuedAt / expirationTime) into Date objects
// required by SiweMessage.
// ---------------------------------------------------------------------------
function buildSiweMessage(params: {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  nonce: string;
  statement?: string;
  issuedAt?: Date | string;
  expirationTime?: Date | string;
}): string {
  const issuedAt =
    params.issuedAt instanceof Date ? params.issuedAt : new Date(params.issuedAt ?? Date.now());
  const expirationTime =
    params.expirationTime instanceof Date
      ? params.expirationTime
      : new Date(params.expirationTime ?? Date.now() + 10 * 60_000);
  const msg: SiweMessage = {
    domain: params.domain,
    address: params.address as `0x${string}`,
    statement: params.statement,
    uri: params.uri,
    chainId: params.chainId,
    nonce: params.nonce,
    issuedAt: issuedAt.toISOString(),
    expirationTime: expirationTime.toISOString(),
  };
  return SiweService.format(msg);
}

async function signMessage(account: PrivateKeyAccount, message: string): Promise<`0x${string}`> {
  return account.signMessage({ message });
}

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------
describe('P1-002 Wallet Authentication (15 scenarios)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let fakeRedis: FakeRedisService;
  let repoProxy: { restore(): void; flush(): DB };
  let alice: PrivateKeyAccount;
  let bob: PrivateKeyAccount;
  let jwtService: JwtService;

  beforeAll(async () => {
    resetTestEnv();
    fakeRedis = new FakeRedisService();
    repoProxy = installRepositoriesProxy();

    // Test module swaps RedisService + Repositories (to guarantee the proxy
    // is wired regardless of ts-jest transpile/caching) and disables throttler
    // globally so the 15 scenarios don't need to worry about rate limits.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisService)
      .useValue(fakeRedis)
      .overrideProvider(Repositories)
      .useFactory({
        factory: () => {
          // Build a fresh Repositories-proxy instance bound to `currentDB` view
          // (mutable ref swapped in beforeEach). Build exactly once per
          // provider inject — i.e. a singleton for the module. Sub-closures
          // inside buildXxxRepo all call `getDB = () => currentDB` which sees
          // the same object identity. beforeEach mutates the object identity —
          // we reuse the same object via shallow clear + assign.
          const getDB = () => currentDB;
          const self: any = {
            user: buildUserRepo(getDB),
            wallet: buildWalletRepo(getDB),
            walletIdentity: buildWalletIdentityRepo(getDB),
            authNonce: buildAuthNonceRepo(getDB),
            auditLog: buildAuditLogRepo(getDB),
            idempotencyKey: {
              findByKey: async () => null,
              acquire: async () => ({ id: 'fake' }) as any,
            },
            systemConfig: { get: async () => null, set: async () => undefined as any },
            // Instance-level transaction: snapshot → run → rollback on throw.
            async transaction<T>(fn: (r: Repositories) => Promise<T>): Promise<T> {
              const snap = structuredCloneSafe(currentDB);
              try {
                // Transaction repos share the same currentDB — writes become
                // visible immediately and are committed on resolve.
                const txRepos: any = {
                  user: buildUserRepo(getDB),
                  wallet: buildWalletRepo(getDB),
                  walletIdentity: buildWalletIdentityRepo(getDB),
                  authNonce: buildAuthNonceRepo(getDB),
                  auditLog: buildAuditLogRepo(getDB),
                  idempotencyKey: {
                    findByKey: async () => null,
                    acquire: async () => ({ id: 'fake' }) as any,
                  },
                  systemConfig: { get: async () => null, set: async () => undefined as any },
                };
                return await fn(txRepos as unknown as Repositories);
              } catch (err) {
                // Rollback: replace currentDB fields with snapshot keys.
                Object.keys(currentDB).forEach((k) => delete (currentDB as any)[k]);
                Object.assign(currentDB, snap);
                throw err;
              }
            },
          };
          return self as unknown as Repositories;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: true }),
    );
    await app.init();
    http = request(app.getHttpServer());
    jwtService = app.get(JwtService) as JwtService;
    alice = privateKeyToAccount(generatePrivateKey());
    bob = privateKeyToAccount(generatePrivateKey());
  }, 60_000);

  beforeEach(() => {
    resetTestEnv();
    fakeRedis.clear();
    // Swap the global `currentDB` view so each test starts empty.
    const fresh = newDB();
    Object.keys(currentDB).forEach((k) => delete (currentDB as any)[k]);
    Object.assign(currentDB, fresh);
  });

  afterAll(async () => {
    await app?.close();
    repoProxy?.restore();
  });

  // ---------------------------- helpers ----------------------------
  async function getNonce(
    account: PrivateKeyAccount,
    chain: Chain = 'ETH',
    network = 'mainnet',
  ): Promise<{ nonce: string; chainId: number; domain: string; uri: string; statement: string }> {
    const r = await http.get('/auth/nonce').query({
      address: account.address,
      chain,
      network,
    });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    return r.body.data;
  }

  async function verify(payload: {
    message: string;
    signature: `0x${string}`;
    address: string;
    chain?: Chain;
    network?: string;
  }) {
    // P1-004 v5+ FINAL: legacy transport mode removed — every /verify request
    // MUST declare X-Auth-Transport. The T01-T15 suite uses api transport
    // (tokens returned in the body; no cookies set) because the assertions
    // check `r.body.data.accessToken`. No browser Origin is sent so the
    // TransportMiddleware Origin × transport matrix passes (api + non-browser).
    return http
      .post('/auth/verify')
      .set('X-Auth-Transport', 'api')
      .send({
        message: payload.message,
        signature: payload.signature,
        address: payload.address,
        chain: payload.chain ?? 'ETH',
        network: payload.network ?? 'mainnet',
      });
  }

  async function login(
    account: PrivateKeyAccount,
    chain: Chain = 'ETH',
    network = 'mainnet',
  ): Promise<{ token: string; userId: string; walletId: string }> {
    const n = await getNonce(account, chain, network);
    const message = buildSiweMessage({ ...n, address: account.address });
    const signature = await signMessage(account, message);
    const r = await verify({ message, signature, address: account.address, chain, network });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    return {
      token: r.body.data.accessToken,
      userId: r.body.data.user.id,
      walletId: r.body.data.user.wallets[0]?.id,
    };
  }

  // ---------------------------- T01 ----------------------------
  it('T01 正常登录：返回 JWT，创建 User/Wallet/WalletIdentity，写 login success audit', async () => {
    const { token, userId, walletId } = await login(alice);
    expect(token).toMatch(/^eyJ/);
    const db = repoProxy.flush();
    const user = db.users[userId];
    const wallet = db.wallets[walletId];
    expect(user.status).toBe('ACTIVE');
    expect(user.lastLoginAt).not.toBeNull();
    expect(wallet.address.toLowerCase()).toBe(alice.address.toLowerCase());
    expect(wallet.userId).toBe(userId);
    expect(wallet.status).toBe('CONNECTED');
    const identity = Object.values(db.identities).find((i) => i.walletId === walletId);
    expect(identity!.identityType).toBe('SIWE');
    const log = db.audits.find((a) => a.action === 'AUTH_LOGIN_SUCCESS');
    expect(log!.actor).toBe(userId);
    expect(log!.success).toBe(true);
  }, 30_000);

  // ---------------------------- T02 ----------------------------
  it('T02 错误签名 → 401 BAD_SIGNATURE 并写失败 audit', async () => {
    const n = await getNonce(alice);
    const message = buildSiweMessage({ ...n, address: alice.address });
    const badSig = await signMessage(bob, message); // wrong signer
    const r = await verify({ message, signature: badSig, address: alice.address });
    expect(r.status).toBe(401);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.BAD_SIGNATURE);
    const log = repoProxy.flush().audits.find((a) => a.action === 'AUTH_LOGIN_FAILURE');
    expect(log!.success).toBe(false);
    expect((log!.metadata as any).reason).toBe(AuthFailReason.BAD_SIGNATURE);
  }, 30_000);

  // ---------------------------- T03 ----------------------------
  it('T03 错误地址（body != SIWE claim）→ 401 BAD_ADDRESS', async () => {
    const n = await getNonce(alice);
    // SIWE message written with bob's address, signed by bob. Body claims alice.
    const message = buildSiweMessage({ ...n, address: bob.address });
    const sig = await signMessage(bob, message);
    const r = await verify({ message, signature: sig, address: alice.address });
    expect(r.status).toBe(401);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.BAD_ADDRESS);
  }, 30_000);

  // ---------------------------- T04 ----------------------------
  it('T04 错误 domain → 401 BAD_DOMAIN', async () => {
    const n = await getNonce(alice);
    const message = buildSiweMessage({ ...n, address: alice.address, domain: 'attacker.xyz' });
    const sig = await signMessage(alice, message);
    const r = await verify({ message, signature: sig, address: alice.address });
    expect(r.status).toBe(401);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.BAD_DOMAIN);
  }, 30_000);

  // ---------------------------- T05 ----------------------------
  it('T05 错误 URI → 401 BAD_URI', async () => {
    const n = await getNonce(alice);
    const message = buildSiweMessage({
      ...n,
      address: alice.address,
      uri: 'https://evil.example/login',
    });
    const sig = await signMessage(alice, message);
    const r = await verify({ message, signature: sig, address: alice.address });
    expect(r.status).toBe(401);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.BAD_URI);
  }, 30_000);

  // ---------------------------- T06 ----------------------------
  it('T06 错误 chainId → 401 BAD_CHAIN_ID', async () => {
    const n = await getNonce(alice, 'ETH');
    const message = buildSiweMessage({ ...n, address: alice.address, chainId: 999 });
    const sig = await signMessage(alice, message);
    const r = await verify({ message, signature: sig, address: alice.address, chain: 'ETH' });
    expect(r.status).toBe(401);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.BAD_CHAIN_ID);
  }, 30_000);

  // ---------------------------- T07 ----------------------------
  it('T07 过期 SIWE expirationTime → 401 EXPIRED', async () => {
    const n = await getNonce(alice);
    const message = buildSiweMessage({
      ...n,
      address: alice.address,
      issuedAt: new Date(Date.now() - 30 * 60_000),
      expirationTime: new Date(Date.now() - 10_000),
    });
    const sig = await signMessage(alice, message);
    const r = await verify({ message, signature: sig, address: alice.address });
    expect(r.status).toBe(401);
    expect([AuthFailReason.EXPIRED, AuthFailReason.EXPIRED_EXP]).toContain(
      r.body.error.details?.reason,
    );
  }, 30_000);

  // ---------------------------- T08 ----------------------------
  it('T08 重复 nonce（相同 verify 提交两次） → 第一次成功 / 第二次 NONCE_USED', async () => {
    const n = await getNonce(alice);
    const message = buildSiweMessage({ ...n, address: alice.address });
    const sig = await signMessage(alice, message);
    const first = await verify({ message, signature: sig, address: alice.address });
    expect(first.status).toBe(200);
    const second = await verify({ message, signature: sig, address: alice.address });
    expect([401, 409]).toContain(second.status);
    expect([AuthFailReason.NONCE_USED, AuthFailReason.BAD_NONCE]).toContain(
      second.body?.error?.details?.reason,
    );
  }, 30_000);

  // ---------------------------- T09 ----------------------------
  it('T09 已使用 nonce（新 SIWE 重放旧 nonce） → 401 NONCE_USED', async () => {
    const n = await getNonce(alice);
    const msgA = buildSiweMessage({ ...n, address: alice.address });
    const sigA = await signMessage(alice, msgA);
    expect((await verify({ message: msgA, signature: sigA, address: alice.address })).status).toBe(
      200,
    );
    // New SIWE message, same nonce
    const msgB = buildSiweMessage({
      ...n,
      address: alice.address,
      issuedAt: new Date(),
      expirationTime: new Date(Date.now() + 8 * 60_000),
    });
    const sigB = await signMessage(alice, msgB);
    const r = await verify({ message: msgB, signature: sigB, address: alice.address });
    expect(r.status).toBe(401);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.NONCE_USED);
  }, 30_000);

  // ---------------------------- T10 ----------------------------
  it('T10 并发登录（同一 nonce 并发提交） → 恰好 1 个成功', async () => {
    const n = await getNonce(alice);
    const message = buildSiweMessage({ ...n, address: alice.address });
    const sig = await signMessage(alice, message);
    const results = await Promise.all([
      verify({ message, signature: sig, address: alice.address }),
      verify({ message, signature: sig, address: alice.address }),
    ]);
    const successes = results.filter((r) => r.status === 200).length;
    const failures = results.filter((r) => r.status !== 200).length;
    expect(successes).toBe(1);
    expect(failures).toBe(1);
  }, 30_000);

  // ---------------------------- T11 ----------------------------
  it('T11 重复钱包登录 → 复用 User，不创建重复', async () => {
    const a = await login(alice);
    const b = await login(alice);
    expect(b.userId).toBe(a.userId);
    const users = Object.keys(repoProxy.flush().users);
    expect(users.length).toBe(1);
  }, 60_000);

  // ---------------------------- T12 ----------------------------
  it('T12 禁用钱包（REVOKED）登录 → 403 WALLET_REVOKED', async () => {
    const a = await login(alice);
    const db = repoProxy.flush();
    db.wallets[a.walletId].status = 'REVOKED' as WalletStatus;
    const n = await getNonce(alice);
    const message = buildSiweMessage({ ...n, address: alice.address });
    const sig = await signMessage(alice, message);
    const r = await verify({ message, signature: sig, address: alice.address });
    expect(r.status).toBe(403);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.WALLET_REVOKED);
  }, 30_000);

  // ---------------------------- T13 ----------------------------
  it('T13 登出后 token 被 blocklist 拒绝，并记录 AUTH_LOGOUT 审计', async () => {
    const { token } = await login(alice);
    // P1-004 v5+ FINAL: /logout requires X-Auth-Transport. Use api mode
    // (Bearer header, no cookies) — passes constraint A and CSRF exempt.
    const lout = await http
      .post('/auth/logout')
      .set('X-Auth-Transport', 'api')
      .set('Authorization', `Bearer ${token}`);
    expect(lout.status).toBe(200);
    expect(lout.body.success).toBe(true);
    expect(lout.body.data.loggedOut).toBe(true);
    const me = await http.get('/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(401);
    expect(me.body.error.details?.reason).toBe(AuthFailReason.TOKEN_REVOKED);
    const out = repoProxy.flush().audits.find((a) => a.action === 'AUTH_LOGOUT');
    expect(out).not.toBeNull();
  }, 30_000);

  // ---------------------------- T14 ----------------------------
  it('T14 JWT 无效 / 过期 → 401 TOKEN_INVALID / TOKEN_EXPIRED', async () => {
    const bad = await http.get('/auth/me').set('Authorization', 'Bearer clearly.broken.token');
    expect(bad.status).toBe(401);
    expect(bad.body.error.details?.reason).toBe(AuthFailReason.TOKEN_INVALID);

    // Expired
    const expired = jwtService.sign(
      { sub: 'u-ghost', jti: 'jti-expired-14', walletId: 'w-ghost' },
      { secret: TEST_JWT_SECRET, expiresIn: -1 },
    );
    const expR = await http.get('/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(expR.status).toBe(401);
    expect([AuthFailReason.TOKEN_EXPIRED, AuthFailReason.TOKEN_REVOKED]).toContain(
      expR.body.error.details?.reason,
    );
  }, 30_000);

  // ---------------------------- T15 ----------------------------
  it('T15 未登录访问受保护 API /auth/me 与 /auth/logout → 401 NOT_AUTHENTICATED', async () => {
    const me = await http.get('/auth/me');
    expect(me.status).toBe(401);
    expect(me.body.error.details?.reason).toBe(AuthFailReason.NOT_AUTHENTICATED);
    // P1-004 v5+ FINAL: /logout requires X-Auth-Transport. Use api mode with
    // no credentials — LogoutGuard returns true (does not throw), controller
    // sees both credentials invalid → 401 NOT_AUTHENTICATED (constraint B in
    // api mode: no cookies to clear).
    const lout = await http.post('/auth/logout').set('X-Auth-Transport', 'api');
    expect(lout.status).toBe(401);
    expect(lout.body.error.details?.reason).toBe(AuthFailReason.NOT_AUTHENTICATED);
  }, 30_000);
});
