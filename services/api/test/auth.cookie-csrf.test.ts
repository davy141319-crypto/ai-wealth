// ============================================================================
// P1-003 — Cookie / CSRF / dual-mode guard scenarios.
//
// Reuses the same in-memory fake repository + FakeRedisService pattern as
// auth.siwe.test.ts (P1-002) so the full SIWE → JWT → cookie flow runs end to
// end without Postgres or Redis. These tests are ADDITIVE — the P1-002 T01-T15
// suite is untouched and must keep passing.
//
// Coverage:
//   C01 GET /auth/csrf-token returns a token + sets the CSRF cookie
//   C02 verify success sets an HttpOnly access cookie (attributes asserted)
//   C03 /auth/me works with Cookie alone (no Bearer header)
//   C04 Bearer takes priority when both Bearer + Cookie are present
//   C05 logout (cookie mode) without X-CSRF-TOKEN → 403 CSRF_TOKEN_INVALID
//   C06 logout (cookie mode) with matching X-CSRF-TOKEN → 200 + clears cookies
//   C07 Bearer-only logout (no access cookie) → CSRF exempt → 200
//   C08 anonymous POST with no access cookie → CSRF exempt (reaches JwtAuthGuard)
//   C09 CSRF mismatch (header != cookie) → 403 + AUTH_CSRF_FAILURE audit
//   C10 GET (state-safe verb) is always CSRF-exempt
//   C11 concurrent /auth/csrf-token issues independent tokens
// ============================================================================

import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
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
import { AppError, AuthFailReason } from '@ai-wealth/shared';
import { env } from '@ai-wealth/config';
import { AppModule } from '../src/app.module';
import { RedisService } from '../src/common/redis/redis.service';
import { SiweService } from '../src/auth/siwe.service';
import type { SiweMessage } from '../src/auth/siwe.message';
import { FakeRedisService } from './fake-redis.service';

// ---------------------------------------------------------------------------
// In-memory fake database (mirrors auth.siwe.test.ts).
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

const TEST_JWT_SECRET = 'test-jwt-secret-cookie-csrf-aaaaaaaa-bbbbbbbb-cccc-12';
const TEST_JWT_TTL_SEC = 15 * 60;
const TEST_DOMAIN = 'test.example.com';
const TEST_URI = 'https://test.example.com/api/auth/verify';
const TEST_STMT = 'Sign in to AI Wealth (cookie/csrf test).';
const TEST_SIWE_TTL_SEC = 600;
const TEST_CLOCK_SKEW_SEC = 300;

function resetTestEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.API_PORT = '0';
  process.env.LOG_LEVEL = 'error';
  process.env.WEB_APP_URL = 'https://test.example.com';
  process.env.ADMIN_APP_URL = 'https://admin.test.example.com';
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.JWT_EXPIRES_IN = `${TEST_JWT_TTL_SEC}s`;
  process.env.SIWE_DOMAIN = TEST_DOMAIN;
  process.env.SIWE_URI = TEST_URI;
  process.env.SIWE_STATEMENT = TEST_STMT;
  process.env.SIWE_NONCE_TTL_SEC = String(TEST_SIWE_TTL_SEC);
  process.env.SIWE_CLOCK_SKEW_SEC = String(TEST_CLOCK_SKEW_SEC);
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ||
    'postgresql://ci:ci@127.0.0.1:5432/aiwealth_ci_not_used?schema=public';
  process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379/0';
  // Cookie names: dev/test defaults (no __Host- prefix so HTTP supertest works).
  delete process.env.COOKIE_NAME;
  delete process.env.CSRF_COOKIE_NAME;
  const mod = require('@ai-wealth/config');
  if (typeof mod._resetEnvCache === 'function') mod._resetEnvCache();
}

let currentDB: DB = newDB();

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
    findById: async (id: string, opts?: { includeWallets?: boolean }): Promise<any> => {
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
    create: async (input: {
      address: string;
      chain: string;
      network: string;
      status?: WalletStatus;
      userId?: string | null;
      isPrimary?: boolean;
    }): Promise<Wallet> => {
      const db = getDB();
      const id = randomUUID();
      const now = new Date();
      const w: Wallet = {
        id,
        userId: input.userId ?? null,
        address: input.address,
        chain: input.chain as Chain,
        network: input.network,
        status: (input.status ?? 'DISCONNECTED') as WalletStatus,
        isPrimary: input.isPrimary ?? false,
        createdAt: now,
        updatedAt: now,
      };
      db.wallets[id] = w;
      return w;
    },
    findById: async (id: string): Promise<Wallet | null> => {
      const db = getDB();
      return db.wallets[id] ?? null;
    },
    findUnique: async (input: {
      address: string;
      chain: string;
      network: string;
    }): Promise<Wallet | null> => {
      const db = getDB();
      return (
        Object.values(db.wallets).find(
          (w) =>
            w.address.toLowerCase() === input.address.toLowerCase() &&
            w.chain === input.chain &&
            w.network === input.network,
        ) ?? null
      );
    },
    update: async (id: string, patch: Partial<Wallet>): Promise<Wallet> => {
      const db = getDB();
      const w = db.wallets[id];
      if (!w) throw AppError.notFound('wallet not found');
      const upd = { ...w, ...patch, updatedAt: new Date() };
      db.wallets[id] = upd;
      return upd;
    },
    bindUser: async (id: string, userId: string, status: WalletStatus): Promise<Wallet> => {
      const db = getDB();
      const w = db.wallets[id];
      if (!w) throw AppError.notFound('wallet not found');
      const upd = { ...w, userId, status, updatedAt: new Date() };
      db.wallets[id] = upd;
      return upd;
    },
    listByUser: async (userId: string): Promise<Wallet[]> => {
      const db = getDB();
      return Object.values(db.wallets).filter((w) => w.userId === userId);
    },
  };
}

function buildWalletIdentityRepo(getDB: () => DB) {
  return {
    findUnique: async (walletId: string, identityType: IdentityType) => {
      const db = getDB();
      return (
        Object.values(db.identities).find(
          (i) => i.walletId === walletId && i.identityType === identityType,
        ) ?? null
      );
    },
    create: async (input: { walletId: string; identityType: IdentityType }) => {
      const db = getDB();
      const id = randomUUID();
      const now = new Date();
      const ident: WalletIdentity = {
        id,
        walletId: input.walletId,
        identityType: input.identityType,
        createdAt: now,
        updatedAt: now,
      };
      db.identities[id] = ident;
      return ident;
    },
  };
}

function buildAuthNonceRepo(getDB: () => DB) {
  return {
    create: async (input: any): Promise<AuthNonce> => {
      const db = getDB();
      const id = randomUUID();
      const now = new Date();
      const n: AuthNonce = {
        id,
        nonce: input.nonce,
        address: input.address,
        chain: input.chain,
        network: input.network,
        walletId: input.walletId,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        usedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      db.nonces[input.nonce] = n;
      return n;
    },
    findByNonce: async (nonce: string): Promise<AuthNonce | null> => {
      const db = getDB();
      return db.nonces[nonce] ?? null;
    },
    consume: async (nonce: string): Promise<{ ok: boolean; nonce: AuthNonce | null }> => {
      const db = getDB();
      const n = db.nonces[nonce];
      if (!n) return { ok: false, nonce: null };
      if (n.usedAt) return { ok: false, nonce: n };
      const upd = { ...n, usedAt: new Date(), updatedAt: new Date() };
      db.nonces[nonce] = upd;
      return { ok: true, nonce: upd };
    },
  };
}

function buildAuditLogRepo(getDB: () => DB) {
  return {
    create: async (input: any): Promise<AuditLog> => {
      const db = getDB();
      const id = randomUUID();
      const now = new Date();
      const row: AuditLog = {
        id,
        action: input.action,
        resource: input.resource ?? 'auth',
        actorUserId: input.actor ?? input.actorUserId ?? null,
        requestId: input.requestId ?? null,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
        metadata: (input.metadata ?? null) as never,
        success: input.success ?? true,
        createdAt: now,
      };
      db.audits.push(row);
      return row;
    },
  };
}

function newRepos(view: DB): Repositories {
  const getDB = () => view;
  const self: any = {
    user: buildUserRepo(getDB),
    wallet: buildWalletRepo(getDB),
    walletIdentity: buildWalletIdentityRepo(getDB),
    authNonce: buildAuthNonceRepo(getDB),
    auditLog: buildAuditLogRepo(getDB),
    idempotencyKey: { findByKey: async () => null, acquire: async () => ({ id: 'fake' }) as any },
    systemConfig: { get: async () => null, set: async () => undefined as any },
    async transaction<T>(fn: (r: Repositories) => Promise<T>): Promise<T> {
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
    },
  };
  return self as unknown as Repositories;
}

// ---- SIWE message builder ----
// Defers to SiweService.format() so the EIP-4361 A-BNF output matches what the
// server's line-by-line parser expects (mirrors auth.siwe.test.ts). Accepts
// the field names returned by GET /auth/nonce (issuedAt / expiresAt) and
// normalises Date/string → ISO.
function buildSiweMessage(params: {
  domain: string;
  address: string;
  uri: string;
  chainId: number;
  nonce: string;
  statement?: string;
  issuedAt?: Date | string;
  expiresAt?: Date | string;
}): string {
  const issuedAt =
    params.issuedAt instanceof Date ? params.issuedAt : new Date(params.issuedAt ?? Date.now());
  const expirationTime =
    params.expiresAt instanceof Date
      ? params.expiresAt
      : new Date(params.expiresAt ?? Date.now() + 10 * 60_000);
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
  return (await account.signMessage({ message })) as `0x${string}`;
}

// ===========================================================================
describe('P1-003 Cookie / CSRF / dual-mode guard', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let fakeRedis: FakeRedisService;
  let alice: PrivateKeyAccount;
  let ACCESS_COOKIE: string;
  let CSRF_COOKIE: string;

  beforeAll(async () => {
    resetTestEnv();
    ACCESS_COOKIE = env().cookieName; // 'access_token' in test
    CSRF_COOKIE = env().csrfCookieName; // 'csrf' in test
    fakeRedis = new FakeRedisService();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisService)
      .useValue(fakeRedis)
      .overrideProvider(Repositories)
      .useFactory({ factory: () => newRepos(currentDB) })
      .compile();
    app = moduleRef.createNestApplication();
    // Mirror main.ts: parse Cookie header so req.cookies is populated for the
    // Cookie-mode auth + CSRF guard paths under test.
    app.use(cookieParser());
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
    http = request(app.getHttpServer());
    alice = privateKeyToAccount(generatePrivateKey());
  }, 60_000);

  beforeEach(() => {
    resetTestEnv();
    fakeRedis.clear();
    const fresh = newDB();
    Object.keys(currentDB).forEach((k) => delete (currentDB as any)[k]);
    Object.assign(currentDB, fresh);
  });

  afterAll(async () => {
    await app?.close();
  });

  // ---- helpers ----
  async function getNonce(account: PrivateKeyAccount, chain: Chain = 'ETH', network = 'mainnet') {
    const r = await http.get('/auth/nonce').query({ address: account.address, chain, network });
    expect(r.status).toBe(200);
    return r.body.data;
  }

  async function verify(payload: {
    message: string;
    signature: `0x${string}`;
    address: string;
    chain?: Chain;
    network?: string;
  }) {
    return http.post('/auth/verify').send({
      message: payload.message,
      signature: payload.signature,
      address: payload.address,
      chain: payload.chain ?? 'ETH',
      network: payload.network ?? 'mainnet',
    });
  }

  async function login() {
    const n = await getNonce(alice);
    const message = buildSiweMessage({ ...n, address: alice.address });
    const signature = await signMessage(alice, message);
    const r = await verify({ message, signature, address: alice.address });
    expect(r.status).toBe(200);
    return r; // full supertest response (with headers['set-cookie'])
  }

  /** Extract the access-token cookie value from a Set-Cookie header array. */
  function extractCookie(res: request.Response, name: string): string | undefined {
    const setCookies = res.headers['set-cookie'] as string[] | undefined;
    if (!setCookies) return undefined;
    for (const c of setCookies) {
      const kv = c.split(';')[0];
      const eq = kv.indexOf('=');
      if (eq > 0 && kv.slice(0, eq) === name) return kv.slice(eq + 1);
    }
    return undefined;
  }

  // ---------------------------- C01 ----------------------------
  it('C01 GET /auth/csrf-token returns a token and sets the CSRF cookie', async () => {
    const r = await http.get('/auth/csrf-token');
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.csrfToken).toBeTruthy();
    const cookieVal = extractCookie(r, CSRF_COOKIE);
    expect(cookieVal).toBe(r.body.data.csrfToken);
    // CSRF cookie is non-HttpOnly (browser must read it).
    const setCookieHeader = (r.headers['set-cookie'] as string[]).join('\n');
    expect(setCookieHeader.toLowerCase()).not.toContain('httponly');
  });

  // ---------------------------- C02 ----------------------------
  it('C02 verify success sets an HttpOnly access cookie with correct attributes', async () => {
    const r = await login();
    const accessVal = extractCookie(r, ACCESS_COOKIE);
    expect(accessVal).toBeTruthy();
    expect(accessVal).toMatch(/^eyJ/); // it's the JWT
    const setCookieHeader = (r.headers['set-cookie'] as string[]).join('\n');
    // Access cookie MUST be HttpOnly.
    expect(setCookieHeader.toLowerCase()).toContain('httponly');
    // Path=/ always.
    expect(setCookieHeader.toLowerCase()).toContain('path=/');
    // In test (NODE_ENV=test) Secure is false — assert the cookie is NOT marked
    // Secure so localhost HTTP supertest works.
    const accessLine = (r.headers['set-cookie'] as string[]).find((c) =>
      c.startsWith(`${ACCESS_COOKIE}=`),
    );
    expect(accessLine!.toLowerCase()).not.toContain('secure');
  });

  // ---------------------------- C03 ----------------------------
  it('C03 /auth/me works with Cookie alone (no Bearer header)', async () => {
    const r = await login();
    const accessVal = extractCookie(r, ACCESS_COOKIE);
    const me = await http.get('/auth/me').set('Cookie', [`${ACCESS_COOKIE}=${accessVal}`]);
    expect(me.status).toBe(200);
    expect(me.body.success).toBe(true);
    expect(me.body.data.id).toBe(r.body.data.user.id);
  });

  // ---------------------------- C04 ----------------------------
  it('C04 Bearer takes priority when both Bearer and Cookie are present', async () => {
    const r = await login();
    const accessVal = extractCookie(r, ACCESS_COOKIE);
    // Use a DIFFERENT (invalid) token in the cookie; Bearer must win → 200.
    const me = await http
      .get('/auth/me')
      .set('Authorization', `Bearer ${r.body.data.accessToken}`)
      .set('Cookie', [`${ACCESS_COOKIE}=invalid.cookie.value`]);
    expect(me.status).toBe(200);
    expect(me.body.data.id).toBe(r.body.data.user.id);
  });

  // ---------------------------- C05 ----------------------------
  it('C05 logout (cookie mode) without X-CSRF-TOKEN → 403 CSRF_TOKEN_INVALID', async () => {
    const r = await login();
    const accessVal = extractCookie(r, ACCESS_COOKIE);
    const lout = await http.post('/auth/logout').set('Cookie', [`${ACCESS_COOKIE}=${accessVal}`]); // no X-CSRF-TOKEN
    expect(lout.status).toBe(403);
    expect(lout.body.error.details?.reason).toBe(AuthFailReason.CSRF_TOKEN_INVALID);
    // Audit written.
    const log = currentDB.audits.find((a) => a.action === 'AUTH_CSRF_FAILURE');
    expect(log).toBeTruthy();
    expect(log!.success).toBe(false);
  });

  // ---------------------------- C06 ----------------------------
  it('C06 logout (cookie mode) with matching X-CSRF-TOKEN → 200 + clears cookies', async () => {
    const r = await login();
    const accessVal = extractCookie(r, ACCESS_COOKIE);
    // Fetch a CSRF token (sets the csrf cookie).
    const csrfRes = await http.get('/auth/csrf-token');
    const csrfToken = csrfRes.body.data.csrfToken;
    const csrfCookieVal = extractCookie(csrfRes, CSRF_COOKIE);
    const lout = await http
      .post('/auth/logout')
      .set('Cookie', [`${ACCESS_COOKIE}=${accessVal}`, `${CSRF_COOKIE}=${csrfCookieVal}`])
      .set('X-CSRF-TOKEN', csrfToken);
    expect(lout.status).toBe(200);
    expect(lout.body.data.loggedOut).toBe(true);
    // Response should clear both access + csrf cookies. Express's
    // res.clearCookie() sets `Expires` to the epoch (and only emits `Max-Age=0`
    // when the cookie-serialiser receives a truthy maxAge — `0` is falsy and gets
    // skipped, so we accept EITHER deletion signal).
    const setCookieHeader = (lout.headers['set-cookie'] as string[] | undefined) ?? [];
    const cleared = setCookieHeader.map((c) => c.toLowerCase());
    const isCleared = (line: string, name: string) =>
      line.startsWith(`${name}=`) &&
      (line.includes('max-age=0') || line.includes('expires=thu, 01 jan 1970'));
    expect(cleared.some((c) => isCleared(c, ACCESS_COOKIE))).toBe(true);
    expect(cleared.some((c) => isCleared(c, CSRF_COOKIE))).toBe(true);
  });

  // ---------------------------- C07 ----------------------------
  it('C07 Bearer-only logout (no access cookie) → CSRF exempt → 200', async () => {
    const r = await login();
    // No Cookie header at all → no access cookie → CSRF guard passes through.
    const lout = await http
      .post('/auth/logout')
      .set('Authorization', `Bearer ${r.body.data.accessToken}`);
    expect(lout.status).toBe(200);
    expect(lout.body.data.loggedOut).toBe(true);
  });

  // ---------------------------- C08 ----------------------------
  it('C08 anonymous POST with no access cookie → CSRF exempt (reaches JwtAuthGuard → 401)', async () => {
    const lout = await http.post('/auth/logout'); // no cookie, no bearer
    // CSRF guard exempts (no access cookie); JwtAuthGuard then rejects → 401.
    expect(lout.status).toBe(401);
    expect(lout.body.error.details?.reason).toBe(AuthFailReason.NOT_AUTHENTICATED);
  });

  // ---------------------------- C09 ----------------------------
  it('C09 CSRF mismatch (header != cookie) → 403 + AUTH_CSRF_FAILURE audit', async () => {
    const r = await login();
    const accessVal = extractCookie(r, ACCESS_COOKIE);
    const csrfRes = await http.get('/auth/csrf-token');
    const csrfCookieVal = extractCookie(csrfRes, CSRF_COOKIE);
    const lout = await http
      .post('/auth/logout')
      .set('Cookie', [`${ACCESS_COOKIE}=${accessVal}`, `${CSRF_COOKIE}=${csrfCookieVal}`])
      .set('X-CSRF-TOKEN', 'mismatched-token-value');
    expect(lout.status).toBe(403);
    expect(lout.body.error.details?.reason).toBe(AuthFailReason.CSRF_TOKEN_INVALID);
    const log = currentDB.audits.find((a) => a.action === 'AUTH_CSRF_FAILURE');
    expect(log).toBeTruthy();
  });

  // ---------------------------- C10 ----------------------------
  it('C10 GET (state-safe verb) is always CSRF-exempt even with access cookie', async () => {
    const r = await login();
    const accessVal = extractCookie(r, ACCESS_COOKIE);
    // GET /auth/me with cookie but no CSRF header → must pass (GET exempt).
    const me = await http.get('/auth/me').set('Cookie', [`${ACCESS_COOKIE}=${accessVal}`]);
    expect(me.status).toBe(200);
  });

  // ---------------------------- C11 ----------------------------
  it('C11 concurrent /auth/csrf-token issues independent tokens', async () => {
    const results = await Promise.all([
      http.get('/auth/csrf-token'),
      http.get('/auth/csrf-token'),
      http.get('/auth/csrf-token'),
    ]);
    const tokens = results.map((r) => r.body.data.csrfToken);
    expect(new Set(tokens).size).toBe(3); // all distinct
    for (const r of results) expect(r.status).toBe(200);
  });
});
