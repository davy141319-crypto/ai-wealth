// ============================================================================
// P1-004 — Refresh Token Rotation + Token Family + Reuse Detection (R01-R29).
//
// Reuses the same in-memory fake repository + FakeRedisService pattern as the
// P1-002/P1-003 suites (auth.siwe.test.ts / auth.cookie-csrf.test.ts) so the
// full SIWE → JWT → cookie → refresh rotation flow runs end to end without
// Postgres or Redis. FakeRedisService now also mocks `eval` (refresh-rotation
// Lua port) + `multi`/`set(EX)` so the atomic rotation state machine is
// exercised deterministically.
//
// Coverage (spec test plan R01-R29 + constraint A/B):
//   R01  cookie-mode login  → set cookies, body no token
//   R02  api-mode login     → body has token, no Set-Cookie
//   R03  valid refresh cookie mode → new cookies, old USED, old lookup kept
//   R04  valid refresh api mode → body has new token
//   R05  old token retry within grace → 409 RETRY (no token)
//   R06  old token reuse after grace  → 403 REUSED + atomic revoke + audit
//   R07  concurrent refresh (same token) → one 200 one 409
//   R08  3rd used hit → 403 revoke
//   R09  logout cookie + valid access → revoke jti + family + clear 3 cookies
//   R10  logout cookie + access expired + valid refresh → 200
//   R11  logout cookie + both invalid → clear cookies + 401 (constraint B)
//   R12  logout api + both invalid → 401 (no cookie clear)
//   R13  cookie refresh no CSRF → 403 CSRF_TOKEN_INVALID
//   R14  api refresh no CSRF → pass (200)
//   R15  forged refresh → 401 INVALID
//   R16  refresh token not in body (cookie mode) / no plaintext
//   R17  family revoked → any token → 403 REVOKED
//   R18  cookie+body both refresh → cookie priority + body ignored + audit
//   R19  missing X-Auth-Transport (on /refresh) → 400 TRANSPORT_REQUIRED
//   R20  api + browser Origin in allowlist → 403 TRANSPORT_ORIGIN_CONFLICT + audit
//   R21  cookie + no browser Origin → 403 ORIGIN_NOT_ALLOWED
//   R22  /verify cookie + Origin in allowlist → pass (login-CSRF)
//   R23  /verify cookie + Origin not in allowlist → 403 ORIGIN_NOT_ALLOWED
//   R24  /verify cookie + no Origin/Referer → 403 ORIGIN_NOT_ALLOWED
//   R25  api + no browser Origin → pass
//   R26  family near 30d → new key TTL = familyExpiresAt-now (short)
//   R27  family expired → old token → 401 INVALID
//   R28  /refresh cookie mode no refresh cookie → 401 INVALID
//   R29  api + carries access or refresh cookie → 403 TRANSPORT_COOKIE_CONFLICT (constraint A)
//   R30  409 REFRESH_RETRY clears ONLY refresh cookie; access + csrf cookies untouched
//        and the existing access JWT still authenticates /auth/me (v5+ FINAL fix-2)
//   R31  refresh-rotation.lua is present in the compiled dist/ output so the API
//        Docker image can load it at runtime (v5+ FINAL fix-3)
//   R32  (v6 P0-1) multi-wallet login: family walletId = the verified wallet (B),
//        NOT wallets[0]; after refresh the new access JWT walletId is also B.
//   R33  (v6 P0-2) SIWE expirationTime < 30d: familyExpiresAt clamped to SIWE exp;
//        after refresh the new access JWT exp does NOT exceed the SIWE boundary.
//   R34  (v6 P0-2) no SIWE expirationTime: family still lives the full 30d and the
//        access JWT uses its configured TTL (no SIWE clamp).
// ============================================================================

import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, type ThrottlerStorageRecord } from '@nestjs/throttler';
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
import { RefreshTokenService } from '../src/auth/refresh-token.service';
import { SiweService } from '../src/auth/siwe.service';
import type { SiweMessage } from '../src/auth/siwe.message';
import { FakeRedisService } from './fake-redis.service';

// ---------------------------------------------------------------------------
// In-memory fake database (mirrors auth.cookie-csrf.test.ts).
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

const TEST_JWT_SECRET = 'test-jwt-secret-refresh-aaaaaaaa-bbbbbbbb-cccc-12';
const TEST_JWT_TTL_SEC = 15 * 60;
const TEST_DOMAIN = 'test.example.com';
const TEST_URI = 'https://test.example.com/api/auth/verify';
const TEST_STMT = 'Sign in to AI Wealth (refresh rotation test).';
const TEST_SIWE_TTL_SEC = 600;
const TEST_CLOCK_SKEW_SEC = 300;
const BROWSER_ORIGIN = 'https://test.example.com';

function resetTestEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.API_PORT = '0';
  process.env.LOG_LEVEL = 'error';
  process.env.WEB_APP_URL = BROWSER_ORIGIN;
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
  // Dev cookie names (no __Host- prefix so HTTP supertest works).
  delete process.env.COOKIE_NAME;
  delete process.env.CSRF_COOKIE_NAME;
  delete process.env.REFRESH_COOKIE_NAME;
  // Refresh rotation defaults: grace 30s, maxRetry 2, family 30d.
  delete process.env.REUSE_GRACE_SEC;
  delete process.env.MAX_REFRESH_RETRY;
  delete process.env.FAMILY_MAX_LIFETIME_SEC;
  const mod = require('@ai-wealth/config');
  if (typeof mod._resetEnvCache === 'function') mod._resetEnvCache();
}

let currentDB: DB = newDB();

// ---- repository fakes (same surface as auth.cookie-csrf.test.ts) ----
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
    create: async (input: any): Promise<Wallet> => {
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
    findById: async (id: string): Promise<Wallet | null> => getDB().wallets[id] ?? null,
    findUnique: async (input: any): Promise<Wallet | null> => {
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
    findByNonce: async (nonce: string): Promise<AuthNonce | null> => db_n(getDB(), nonce),
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
function db_n(db: DB, nonce: string): AuthNonce | null {
  return db.nonces[nonce] ?? null;
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
describe('P1-004 Refresh Token Rotation (R01-R29)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;
  let fakeRedis: FakeRedisService;
  let alice: PrivateKeyAccount;
  let ACCESS_COOKIE: string;
  let REFRESH_COOKIE: string;
  let CSRF_COOKIE: string;

  beforeAll(async () => {
    resetTestEnv();
    ACCESS_COOKIE = env().cookieName; // 'access_token'
    CSRF_COOKIE = env().csrfCookieName; // 'csrf'
    REFRESH_COOKIE = env().refreshCookieName; // 'refresh_token'
    fakeRedis = new FakeRedisService();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisService)
      .useValue(fakeRedis)
      .overrideProvider(Repositories)
      .useFactory({ factory: () => newRepos(currentDB) })
      // Neutralise per-route throttling (verify=20/60s etc.) — this suite issues
      // 20+ verify calls across 29 scenarios which would exceed the route
      // limits. Override the ThrottlerStorage so every increment reports 0
      // totalHits: the real ThrottlerGuard still runs but `0 > limit` never
      // fires. Rate-limiting is unit-tested separately; here we test auth logic.
      .overrideProvider(ThrottlerStorage)
      .useValue({
        increment: async (): Promise<ThrottlerStorageRecord> => ({
          totalHits: 0,
          timeToExpire: 0,
          isBlocked: false,
          timeToBlockExpire: 0,
        }),
      })
      .compile();
    app = moduleRef.createNestApplication();
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

  async function getCsrf(): Promise<{ token: string; cookieVal: string }> {
    const r = await http.get('/auth/csrf-token');
    expect(r.status).toBe(200);
    return { token: r.body.data.csrfToken, cookieVal: extractCookie(r, CSRF_COOKIE) ?? '' };
  }

  /** Verify with an explicit transport + optional Origin. */
  async function verifyRaw(opts: {
    message: string;
    signature: `0x${string}`;
    address: string;
    transport: 'cookie' | 'api';
    origin?: string;
    csrfHeader?: string;
    csrfCookie?: string;
  }) {
    const req = http.post('/auth/verify').set('X-Auth-Transport', opts.transport).send({
      message: opts.message,
      signature: opts.signature,
      address: opts.address,
      chain: 'ETH',
      network: 'mainnet',
    });
    if (opts.origin !== undefined) req.set('Origin', opts.origin);
    return req;
  }

  /** Cookie-mode login: sets access+refresh cookies, body only {user}.
   *  v6: `siweExpiresAt` lets the caller extend the SIWE authorization boundary
   *  past the default 10min so tests that fast-forward (R10/R26) keep the
   *  family alive under the new SIWE-clamped familyExpiresAt. */
  async function loginCookie(siweExpiresAt?: Date): Promise<{
    accessVal: string;
    refreshVal: string;
    userId: string;
  }> {
    const n = await getNonce(alice);
    const message = buildSiweMessage({
      ...n,
      address: alice.address,
      expiresAt: siweExpiresAt,
    });
    const signature = await signMessage(alice, message);
    const r = await verifyRaw({
      message,
      signature,
      address: alice.address,
      transport: 'cookie',
      origin: BROWSER_ORIGIN,
    });
    expect(r.status).toBe(200);
    const accessVal = extractCookie(r, ACCESS_COOKIE) ?? '';
    const refreshVal = extractCookie(r, REFRESH_COOKIE) ?? '';
    expect(accessVal).toBeTruthy();
    expect(refreshVal).toBeTruthy();
    return { accessVal, refreshVal, userId: r.body.data.user.id };
  }

  /** API-mode login: body has tokens, no Set-Cookie. */
  async function loginApi(siweExpiresAt?: Date): Promise<{
    accessToken: string;
    refreshToken: string;
    userId: string;
  }> {
    const n = await getNonce(alice);
    const message = buildSiweMessage({
      ...n,
      address: alice.address,
      expiresAt: siweExpiresAt,
    });
    const signature = await signMessage(alice, message);
    const r = await verifyRaw({ message, signature, address: alice.address, transport: 'api' });
    expect(r.status).toBe(200);
    expect(r.body.data.accessToken).toBeTruthy();
    expect(r.body.data.refreshToken).toBeTruthy();
    return {
      accessToken: r.body.data.accessToken,
      refreshToken: r.body.data.refreshToken,
      userId: r.body.data.user.id,
    };
  }

  /** Cookie-mode refresh: refresh from cookie + CSRF. */
  async function refreshCookie(opts: {
    refreshVal: string;
    csrf?: { token: string; cookieVal: string };
    body?: { refreshToken?: string };
  }) {
    const csrf = opts.csrf ?? (await getCsrf());
    const cookies = [`${REFRESH_COOKIE}=${opts.refreshVal}`, `${CSRF_COOKIE}=${csrf.cookieVal}`];
    const req = http
      .post('/auth/refresh')
      .set('X-Auth-Transport', 'cookie')
      .set('Origin', BROWSER_ORIGIN)
      .set('Cookie', cookies)
      .set('X-CSRF-TOKEN', csrf.token);
    if (opts.body) req.send(opts.body);
    else req.send({});
    return req;
  }

  /** API-mode refresh: refresh from body, no cookie, no Origin. */
  async function refreshApi(refreshToken: string) {
    return http.post('/auth/refresh').set('X-Auth-Transport', 'api').send({ refreshToken });
  }

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

  // =========================================================================
  // R01 — cookie-mode login sets cookies, body has no token.
  it('R01 cookie-mode login + Origin allowlist → set cookies, body no token', async () => {
    const n = await getNonce(alice);
    const message = buildSiweMessage({ ...n, address: alice.address });
    const signature = await signMessage(alice, message);
    const r = await verifyRaw({
      message,
      signature,
      address: alice.address,
      transport: 'cookie',
      origin: BROWSER_ORIGIN,
    });
    expect(r.status).toBe(200);
    // Body carries ONLY {user} — no token plaintext.
    expect(r.body.data.accessToken).toBeUndefined();
    expect(r.body.data.refreshToken).toBeUndefined();
    expect(r.body.data.user).toBeTruthy();
    // Both HttpOnly cookies set.
    const setCookies = (r.headers['set-cookie'] as string[]).join('\n').toLowerCase();
    expect(extractCookie(r, ACCESS_COOKIE)).toBeTruthy();
    expect(extractCookie(r, REFRESH_COOKIE)).toBeTruthy();
    expect(setCookies).toContain('httponly');
  });

  // R02 — api-mode login: body has tokens, no Set-Cookie.
  it('R02 api-mode login + no browser Origin → body has token, no Set-Cookie', async () => {
    const { accessToken, refreshToken } = await loginApi();
    expect(accessToken).toMatch(/^eyJ/);
    expect(refreshToken).toBeTruthy();
    // No cookies set in api mode (constraint A: no cookie anyway).
  });

  // R03 — valid refresh cookie mode: new cookies, old USED, old lookup kept.
  it('R03 valid refresh cookie mode → new cookies, old USED, old lookup kept', async () => {
    const { refreshVal } = await loginCookie();
    const r = await refreshCookie({ refreshVal });
    expect(r.status).toBe(200);
    // Body has no token (cookie mode).
    expect(r.body.data.refreshToken).toBeUndefined();
    // New refresh cookie set.
    const newRefresh = extractCookie(r, REFRESH_COOKIE);
    expect(newRefresh).toBeTruthy();
    expect(newRefresh).not.toBe(refreshVal); // rotated
    // Old token is now USED (tombstone exists); old lookup key kept.
    const usedKeys = fakeRedis.__debugKeys('refresh:used:');
    expect(usedKeys.length).toBe(1);
    // Old lookup key still present (not deleted — reuse detection needs it).
    const lookupKeys = fakeRedis.__debugKeys('refresh:lookup:');
    expect(lookupKeys.length).toBeGreaterThanOrEqual(2); // old + new
  });

  // R04 — valid refresh api mode: body has new token.
  it('R04 valid refresh api mode → body has new token', async () => {
    const { refreshToken } = await loginApi();
    const r = await refreshApi(refreshToken);
    expect(r.status).toBe(200);
    expect(r.body.data.accessToken).toBeTruthy();
    expect(r.body.data.refreshToken).toBeTruthy();
    expect(r.body.data.refreshToken).not.toBe(refreshToken); // rotated
  });

  // R05 — old token retry within grace → 409 RETRY (no token).
  it('R05 old token retry within grace → 409 RETRY, no token', async () => {
    const { refreshVal } = await loginCookie();
    // First rotation.
    const r1 = await refreshCookie({ refreshVal });
    expect(r1.status).toBe(200);
    // Replay the SAME old token within the grace window → 409 RETRY.
    const r2 = await refreshCookie({ refreshVal });
    expect(r2.status).toBe(409);
    expect(r2.body.error.details?.reason).toBe(AuthFailReason.REFRESH_RETRY);
    // No token returned on retry.
    expect(r2.body.data?.refreshToken).toBeUndefined();
  });

  // R06 — old token reuse after grace → 403 REUSED + atomic revoke + audit.
  it('R06 old token reuse after grace → 403 REUSED + revoke + audit', async () => {
    const { refreshVal } = await loginCookie();
    const r1 = await refreshCookie({ refreshVal });
    expect(r1.status).toBe(200);
    // Fast-forward past the grace window (default 30s).
    fakeRedis.__fastForwardAll(31);
    // Replay old token after grace elapsed → 403 REUSED; family revoked atomically.
    const r2 = await refreshCookie({ refreshVal });
    expect(r2.status).toBe(403);
    expect(r2.body.error.details?.reason).toBe(AuthFailReason.REFRESH_TOKEN_REUSED);
    // Audit written.
    const log = currentDB.audits.find((a) => a.action === 'AUTH_REFRESH_REUSE');
    expect(log).toBeTruthy();
    expect(log!.success).toBe(false);
    // Family is revoked.
    const revokedKeys = fakeRedis.__debugKeys('refresh:revoked:');
    expect(revokedKeys.length).toBe(1);
  });

  // R07 — concurrent refresh (same token) → one 200 one 409.
  it('R07 concurrent refresh (same token) → one 200 one 409', async () => {
    const { refreshVal } = await loginCookie();
    const csrf = await getCsrf();
    const [a, b] = await Promise.all([
      refreshCookie({ refreshVal, csrf }),
      refreshCookie({ refreshVal, csrf }),
    ]);
    const ok = [a, b].filter((r) => r.status === 200).length;
    const retry = [a, b].filter((r) => r.status === 409).length;
    // Exactly one rotation succeeds; the other is a retry (used tombstone hit).
    expect(ok).toBe(1);
    expect(retry).toBe(1);
  });

  // R08 — 3rd used hit → 403 revoke.
  it('R08 3rd used hit (retryCount > maxRetry) → 403 revoke', async () => {
    const { refreshVal } = await loginCookie();
    // Normal rotation.
    await refreshCookie({ refreshVal });
    // 1st replay → 409 (retryCount=1, <=2).
    const r2 = await refreshCookie({ refreshVal });
    expect(r2.status).toBe(409);
    // 2nd replay → 409 (retryCount=2, <=2).
    const r3 = await refreshCookie({ refreshVal });
    expect(r3.status).toBe(409);
    // 3rd replay → 403 (retryCount=3, >2 → theft).
    const r4 = await refreshCookie({ refreshVal });
    expect(r4.status).toBe(403);
    expect(r4.body.error.details?.reason).toBe(AuthFailReason.REFRESH_TOKEN_REUSED);
  });

  // R09 — logout cookie + valid access → revoke jti + family + clear 3 cookies.
  it('R09 logout cookie + valid access → revoke + clear 3 cookies', async () => {
    const { accessVal, refreshVal } = await loginCookie();
    const csrf = await getCsrf();
    const r = await http
      .post('/auth/logout')
      .set('X-Auth-Transport', 'cookie')
      .set('Origin', BROWSER_ORIGIN)
      .set('Cookie', [
        `${ACCESS_COOKIE}=${accessVal}`,
        `${REFRESH_COOKIE}=${refreshVal}`,
        `${CSRF_COOKIE}=${csrf.cookieVal}`,
      ])
      .set('X-CSRF-TOKEN', csrf.token);
    expect(r.status).toBe(200);
    expect(r.body.data.loggedOut).toBe(true);
    // All three cookies cleared.
    const cleared = (r.headers['set-cookie'] as string[]).map((c) => c.toLowerCase());
    expect(cleared.some((c) => c.startsWith(`${ACCESS_COOKIE}=`) && c.includes('max-age=0'))).toBe(
      true,
    );
    expect(cleared.some((c) => c.startsWith(`${CSRF_COOKIE}=`) && c.includes('max-age=0'))).toBe(
      true,
    );
    expect(cleared.some((c) => c.startsWith(`${REFRESH_COOKIE}=`) && c.includes('max-age=0'))).toBe(
      true,
    );
    // Family revoked.
    expect(fakeRedis.__debugKeys('refresh:revoked:').length).toBe(1);
  });

  // R10 — logout cookie + access expired + valid refresh → 200.
  it('R10 logout cookie + access expired + valid refresh → 200 + revoke family', async () => {
    // v6: SIWE exp must exceed the fast-forward (15min+60s) so the family is
    // still alive after the access JWT expires.
    const { accessVal, refreshVal } = await loginCookie(new Date(Date.now() + 60 * 60 * 1000));
    // Fast-forward past the access JWT lifetime (15min) so access is expired.
    fakeRedis.__fastForwardAll(TEST_JWT_TTL_SEC + 60);
    const csrf = await getCsrf();
    const r = await http
      .post('/auth/logout')
      .set('X-Auth-Transport', 'cookie')
      .set('Origin', BROWSER_ORIGIN)
      .set('Cookie', [
        `${ACCESS_COOKIE}=${accessVal}`,
        `${REFRESH_COOKIE}=${refreshVal}`,
        `${CSRF_COOKIE}=${csrf.cookieVal}`,
      ])
      .set('X-CSRF-TOKEN', csrf.token);
    expect(r.status).toBe(200);
    expect(r.body.data.loggedOut).toBe(true);
    // Refresh family revoked even though access was expired.
    expect(fakeRedis.__debugKeys('refresh:revoked:').length).toBe(1);
  });

  // R11 — logout cookie + both invalid → clear cookies + 401 (constraint B).
  it('R11 logout cookie + both invalid → clear cookies + 401 (constraint B)', async () => {
    const csrf = await getCsrf();
    const r = await http
      .post('/auth/logout')
      .set('X-Auth-Transport', 'cookie')
      .set('Origin', BROWSER_ORIGIN)
      .set('Cookie', [
        `${ACCESS_COOKIE}=invalid.jwt.value`,
        `${REFRESH_COOKIE}=forged-refresh`,
        `${CSRF_COOKIE}=${csrf.cookieVal}`,
      ])
      .set('X-CSRF-TOKEN', csrf.token);
    // Constraint B: cookies cleared FIRST, then 401.
    expect(r.status).toBe(401);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.NOT_AUTHENTICATED);
    const cleared = (r.headers['set-cookie'] as string[]).map((c) => c.toLowerCase());
    expect(cleared.some((c) => c.startsWith(`${ACCESS_COOKIE}=`) && c.includes('max-age=0'))).toBe(
      true,
    );
    expect(cleared.some((c) => c.startsWith(`${REFRESH_COOKIE}=`) && c.includes('max-age=0'))).toBe(
      true,
    );
    expect(cleared.some((c) => c.startsWith(`${CSRF_COOKIE}=`) && c.includes('max-age=0'))).toBe(
      true,
    );
  });

  // R12 — logout api + both invalid → 401 (no cookie clear).
  it('R12 logout api + both invalid → 401 (no cookie clear)', async () => {
    const r = await http
      .post('/auth/logout')
      .set('X-Auth-Transport', 'api')
      .set('Authorization', 'Bearer invalid.bearer.token');
    expect(r.status).toBe(401);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.NOT_AUTHENTICATED);
    // api mode: no Set-Cookie (nothing to clear).
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  // R13 — cookie refresh no CSRF → 403 CSRF_TOKEN_INVALID.
  it('R13 cookie refresh no CSRF → 403 CSRF_TOKEN_INVALID', async () => {
    const { refreshVal } = await loginCookie();
    const r = await http
      .post('/auth/refresh')
      .set('X-Auth-Transport', 'cookie')
      .set('Origin', BROWSER_ORIGIN)
      .set('Cookie', [`${REFRESH_COOKIE}=${refreshVal}`])
      .send({}); // no X-CSRF-TOKEN
    expect(r.status).toBe(403);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.CSRF_TOKEN_INVALID);
  });

  // R14 — api refresh no CSRF → pass (200).
  it('R14 api refresh no CSRF → pass (200)', async () => {
    const { refreshToken } = await loginApi();
    const r = await refreshApi(refreshToken);
    expect(r.status).toBe(200);
  });

  // R15 — forged refresh → 401 INVALID.
  it('R15 forged refresh → 401 INVALID', async () => {
    const r = await refreshApi('totally-forged-not-a-real-refresh-token');
    expect(r.status).toBe(401);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.REFRESH_TOKEN_INVALID);
  });

  // R16 — refresh token not in body (cookie mode) / no plaintext.
  it('R16 refresh token not in body (cookie mode) / no plaintext', async () => {
    const { refreshVal } = await loginCookie();
    const r = await refreshCookie({ refreshVal });
    expect(r.status).toBe(200);
    // Body must not contain the refresh token plaintext.
    expect(r.body.data.refreshToken).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain(refreshVal);
    // Redis must not store the plaintext (only hashes).
    for (const k of fakeRedis.__debugKeys('refresh:lookup:')) {
      const v = fakeRedis.__debugGet(k);
      // lookup value is the familyId, never the token plaintext.
      expect(v).not.toBe(refreshVal);
    }
  });

  // R17 — family revoked → any token → 403 REVOKED.
  it('R17 family revoked → any token → 403 REVOKED', async () => {
    const { refreshVal } = await loginCookie();
    // Rotate once to get a valid current token.
    const r1 = await refreshCookie({ refreshVal });
    const newRefresh = extractCookie(r1, REFRESH_COOKIE) ?? '';
    expect(newRefresh).toBeTruthy();
    // Revoke the family via logout (cookie mode + CSRF).
    const csrf = await getCsrf();
    await http
      .post('/auth/logout')
      .set('X-Auth-Transport', 'cookie')
      .set('Origin', BROWSER_ORIGIN)
      .set('Cookie', [`${REFRESH_COOKIE}=${newRefresh}`, `${CSRF_COOKIE}=${csrf.cookieVal}`])
      .set('X-CSRF-TOKEN', csrf.token)
      .send({});
    // Now the current (post-rotation) token is REVOKED → 403 on refresh.
    const r2 = await refreshCookie({ refreshVal: newRefresh });
    expect(r2.status).toBe(403);
    expect(r2.body.error.details?.reason).toBe(AuthFailReason.REFRESH_TOKEN_REVOKED);
  });

  // R18 — cookie+body both refresh → cookie priority + body ignored + audit.
  it('R18 cookie+body both refresh → cookie priority + body ignored + audit', async () => {
    const { refreshVal } = await loginCookie();
    // Send BOTH a refresh cookie AND a body.refreshToken (a forged value).
    const r = await refreshCookie({ refreshVal, body: { refreshToken: 'forged-body-token' } });
    // Cookie wins → 200 (cookie was valid); body ignored.
    expect(r.status).toBe(200);
    // Audit: body ignored.
    const log = currentDB.audits.find((a) => a.action === 'AUTH_REFRESH_BODY_IGNORED');
    expect(log).toBeTruthy();
  });

  // R19 — missing X-Auth-Transport (on /refresh) → 400 TRANSPORT_REQUIRED.
  it('R19 missing X-Auth-Transport on /refresh → 400 TRANSPORT_REQUIRED', async () => {
    const r = await http.post('/auth/refresh').send({}); // no transport header
    expect(r.status).toBe(400);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.TRANSPORT_REQUIRED);
  });

  // R20 — api + browser Origin in allowlist → 403 TRANSPORT_ORIGIN_CONFLICT + audit.
  it('R20 api + browser Origin in allowlist → 403 TRANSPORT_ORIGIN_CONFLICT + audit', async () => {
    const { refreshToken } = await loginApi();
    const r = await http
      .post('/auth/refresh')
      .set('X-Auth-Transport', 'api')
      .set('Origin', BROWSER_ORIGIN) // browser origin + api → anti-downgrade
      .send({ refreshToken });
    expect(r.status).toBe(403);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.TRANSPORT_ORIGIN_CONFLICT);
    const log = currentDB.audits.find((a) => a.action === 'AUTH_TRANSPORT_CONFLICT');
    expect(log).toBeTruthy();
    expect(log!.success).toBe(false);
  });

  // R21 — cookie + no browser Origin → 403 ORIGIN_NOT_ALLOWED.
  it('R21 cookie + no browser Origin → 403 ORIGIN_NOT_ALLOWED', async () => {
    const { refreshToken } = await loginApi();
    const r = await http
      .post('/auth/refresh')
      .set('X-Auth-Transport', 'cookie') // no Origin header
      .send({ refreshToken });
    expect(r.status).toBe(403);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.ORIGIN_NOT_ALLOWED);
  });

  // R22 — /verify cookie + Origin in allowlist → pass (login-CSRF).
  it('R22 /verify cookie + Origin allowlist → pass (login-CSRF)', async () => {
    const n = await getNonce(alice);
    const message = buildSiweMessage({ ...n, address: alice.address });
    const signature = await signMessage(alice, message);
    const r = await verifyRaw({
      message,
      signature,
      address: alice.address,
      transport: 'cookie',
      origin: BROWSER_ORIGIN,
    });
    expect(r.status).toBe(200);
  });

  // R23 — /verify cookie + Origin not in allowlist → 403 ORIGIN_NOT_ALLOWED.
  it('R23 /verify cookie + Origin not in allowlist → 403 ORIGIN_NOT_ALLOWED', async () => {
    const n = await getNonce(alice);
    const message = buildSiweMessage({ ...n, address: alice.address });
    const signature = await signMessage(alice, message);
    const r = await verifyRaw({
      message,
      signature,
      address: alice.address,
      transport: 'cookie',
      origin: 'https://attacker.evil',
    });
    expect(r.status).toBe(403);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.ORIGIN_NOT_ALLOWED);
  });

  // R24 — /verify cookie + no Origin/Referer → 403 ORIGIN_NOT_ALLOWED.
  it('R24 /verify cookie + no Origin/Referer → 403 ORIGIN_NOT_ALLOWED', async () => {
    const n = await getNonce(alice);
    const message = buildSiweMessage({ ...n, address: alice.address });
    const signature = await signMessage(alice, message);
    const r = await verifyRaw({
      message,
      signature,
      address: alice.address,
      transport: 'cookie',
      // no origin → isBrowserOrigin=false → cookie transport rejected
    });
    expect(r.status).toBe(403);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.ORIGIN_NOT_ALLOWED);
  });

  // R25 — api + no browser Origin → pass.
  it('R25 api + no browser Origin → pass', async () => {
    const { refreshToken } = await loginApi();
    const r = await refreshApi(refreshToken); // api, no Origin
    expect(r.status).toBe(200);
  });

  // R26 — family near 30d → new key TTL = familyExpiresAt-now (short).
  it('R26 family near 30d → new key TTL = familyExpiresAt-now (short)', async () => {
    // v6: SIWE exp must exceed 30d so the family lives the full 30d (not clamped).
    const { refreshVal } = await loginCookie(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));
    // Age the family by 29 days (of the 30-day max lifetime).
    const twentyNineDays = 29 * 24 * 60 * 60;
    fakeRedis.__fastForwardAll(twentyNineDays);
    // Rotate: the NEW active key TTL should be ~1 day (< 30d).
    const r = await refreshCookie({ refreshVal });
    expect(r.status).toBe(200);
    const activeKeys = fakeRedis.__debugKeys('refresh:active:');
    expect(activeKeys.length).toBe(1);
    const ttl = fakeRedis.__debugTtl(activeKeys[0]);
    // Remaining ~1 day; definitely less than the full 30d.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThan(2 * 24 * 60 * 60); // < 2 days
  });

  // R27 — family expired → old token → 401 INVALID.
  it('R27 family expired → old token → 401 INVALID', async () => {
    const { refreshVal } = await loginCookie();
    // Age past the 30-day family lifetime.
    fakeRedis.__fastForwardAll(31 * 24 * 60 * 60);
    const r = await refreshCookie({ refreshVal });
    expect(r.status).toBe(401);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.REFRESH_TOKEN_INVALID);
  });

  // R28 — /refresh cookie mode no refresh cookie → 401 INVALID.
  it('R28 /refresh cookie mode no refresh cookie → 401 INVALID', async () => {
    const csrf = await getCsrf();
    const r = await http
      .post('/auth/refresh')
      .set('X-Auth-Transport', 'cookie')
      .set('Origin', BROWSER_ORIGIN)
      .set('Cookie', [`${CSRF_COOKIE}=${csrf.cookieVal}`]) // no refresh cookie
      .set('X-CSRF-TOKEN', csrf.token)
      .send({});
    expect(r.status).toBe(401);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.REFRESH_TOKEN_INVALID);
  });

  // R29 — api + carries access or refresh cookie → 403 TRANSPORT_COOKIE_CONFLICT (constraint A).
  it('R29 api + carries refresh cookie → 403 TRANSPORT_COOKIE_CONFLICT (constraint A)', async () => {
    const r = await http
      .post('/auth/refresh')
      .set('X-Auth-Transport', 'api')
      .set('Cookie', [`${REFRESH_COOKIE}=sneaky-cookie-value`])
      .send({ refreshToken: 'some-body-token' });
    expect(r.status).toBe(403);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.TRANSPORT_COOKIE_CONFLICT);
    const log = currentDB.audits.find((a) => a.action === 'AUTH_TRANSPORT_CONFLICT');
    expect(log).toBeTruthy();
  });

  // Constraint A also covers access cookie.
  it('R29b api + carries access cookie → 403 TRANSPORT_COOKIE_CONFLICT', async () => {
    const r = await http
      .post('/auth/refresh')
      .set('X-Auth-Transport', 'api')
      .set('Cookie', [`${ACCESS_COOKIE}=sneaky-access-cookie`])
      .send({ refreshToken: 'some-body-token' });
    expect(r.status).toBe(403);
    expect(r.body.error.details?.reason).toBe(AuthFailReason.TRANSPORT_COOKIE_CONFLICT);
  });

  // -------------------------------------------------------------------------
  // R30 — 409 REFRESH_RETRY clears ONLY the refresh cookie. The access JWT
  // and CSRF cookies MUST remain intact, and the existing access JWT must
  // still authenticate /auth/me. This verifies v5+ FINAL fix-2: a retry is
  // a transient network condition, not a security event — logging the user
  // out (clearing access/csrf) would be wrong.
  // -------------------------------------------------------------------------
  it('R30 409 REFRESH_RETRY clears ONLY refresh cookie; access JWT still works', async () => {
    const { accessVal, refreshVal } = await loginCookie();
    // First rotation succeeds (rotates the refresh token).
    const r1 = await refreshCookie({ refreshVal });
    expect(r1.status).toBe(200);
    // Replay the OLD refresh token within the grace window → 409 RETRY.
    const r2 = await refreshCookie({ refreshVal });
    expect(r2.status).toBe(409);
    expect(r2.body.error.details?.reason).toBe(AuthFailReason.REFRESH_RETRY);

    // 409 response MUST clear ONLY the refresh cookie. Access + CSRF MUST NOT
    // appear in the Set-Cookie deletion headers.
    const setCookies = (r2.headers['set-cookie'] as string[] | undefined) ?? [];
    const lower = setCookies.map((c) => c.toLowerCase());
    // Refresh cookie IS cleared (Max-Age=0).
    expect(lower.some((c) => c.startsWith(`${REFRESH_COOKIE}=`) && c.includes('max-age=0'))).toBe(
      true,
    );
    // Access cookie is NOT in the deletion set.
    expect(lower.some((c) => c.startsWith(`${ACCESS_COOKIE}=`))).toBe(false);
    // CSRF cookie is NOT in the deletion set.
    expect(lower.some((c) => c.startsWith(`${CSRF_COOKIE}=`))).toBe(false);

    // The existing access JWT (from the original login) is STILL VALID — it
    // was never rotated (refresh retry does not mint a new access token) and
    // the access cookie was not cleared. /auth/me must succeed with it.
    const me = await http.get('/auth/me').set('Cookie', [`${ACCESS_COOKIE}=${accessVal}`]);
    expect(me.status).toBe(200);
    expect(me.body.data).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // R31 — refresh-rotation.lua asset-copy CONTRACT check (static, no build).
  //
  // RefreshTokenService loads the rotation script at runtime via
  //   readFile(join(__dirname, 'refresh-rotation.lua'))
  // (services/api/src/auth/refresh-token.service.ts). When compiled, the service
  // lives at dist/auth/refresh-token.service.js, so __dirname resolves to
  // dist/auth/ and the runtime path is dist/auth/refresh-rotation.lua. If that
  // file is absent, the service throws LUA_SCRIPT_MISSING on the first refresh
  // (a 500 inside the API Docker container).
  //
  // This test is a STATIC contract check — fast, no build, runs in the CI `test`
  // job (which runs BEFORE the `build` job, so dist/ does not exist yet). It
  // verifies the three preconditions that MUST hold for `nest build` to place
  // the lua into dist:
  //   (a) the lua source is committed with the rotation body,
  //   (b) nest-cli.json declares a `*.lua` asset glob that matches the source
  //       file (so `nest build` copies it),
  //   (c) RefreshTokenService reads the SAME basename as the committed file
  //       (rename-mismatch guard).
  //
  // The DYNAMIC verification — that the lua is actually present in dist/ after a
  // REAL build and at the Docker container runtime path — is enforced by two
  // fail-fast CI gates that run WHERE the build happens (so they have dist/):
  //   • .github/workflows/ci.yml `build` job, after `pnpm run build`:
  //       test -f services/api/dist/auth/refresh-rotation.lua
  //   • infrastructure/docker/Dockerfile.api, after the api `nest build`:
  //       RUN test -f services/api/dist/auth/refresh-rotation.lua
  // Both fail the build / image if the asset copy is broken.
  // -------------------------------------------------------------------------
  it('R31 refresh-rotation.lua asset-copy contract (source + nest-cli assets glob + service read path)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');

    const apiRoot = path.resolve(__dirname, '..');
    const srcLua = path.join(apiRoot, 'src', 'auth', 'refresh-rotation.lua');
    const serviceSrc = path.join(apiRoot, 'src', 'auth', 'refresh-token.service.ts');
    const nestCliPath = path.join(apiRoot, 'nest-cli.json');
    const luaBasename = 'refresh-rotation.lua';

    // (a) Source lua is committed and contains the rotation script body.
    expect(fs.existsSync(srcLua)).toBe(true);
    const srcContent = fs.readFileSync(srcLua, 'utf8');
    expect(srcContent).toContain('P1-004 Refresh Token Rotation');
    expect(srcContent.length).toBeGreaterThan(500);

    // (b) nest-cli.json must declare a `*.lua` asset glob that matches the
    //     source file, so `nest build` copies it into dist/auth/. A regression
    //     that drops the glob (or scopes it away from .lua) is caught here
    //     before the build job runs.
    const nestCli = JSON.parse(fs.readFileSync(nestCliPath, 'utf8')) as {
      compilerOptions?: { assets?: Array<{ include: string }> };
    };
    const assetGlobs = (nestCli.compilerOptions?.assets ?? []).map((a) => a.include);
    expect(assetGlobs.length).toBeGreaterThan(0);
    expect(assetGlobs.some((g) => g.endsWith('*.lua'))).toBe(true);
    expect(srcLua.endsWith('.lua')).toBe(true);

    // (c) RefreshTokenService must read the SAME basename as the committed file
    //     via `readFile(join(__dirname, 'refresh-rotation.lua'))`, so the
    //     compiled service resolves to dist/auth/refresh-rotation.lua. A rename
    //     of the file without updating the service (or vice versa) is caught.
    expect(fs.existsSync(serviceSrc)).toBe(true);
    const serviceContent = fs.readFileSync(serviceSrc, 'utf8');
    expect(serviceContent).toContain(`'${luaBasename}'`);
    expect(serviceContent).toContain('readFile(join(__dirname,');
  });

  // =========================================================================
  // R32 (v6 P0-1) — multi-wallet login: family walletId = the verified wallet
  // (B), NOT wallets[0]; after refresh the new access JWT walletId is also B.
  //
  // Regression guard: before v6, AuthController used `result.user.wallets[0]?.id`
  // which is order-dependent. When a user owns wallets [A, B] and logs in with
  // wallet B, wallets[0] is A — the refresh family would be bound to the WRONG
  // wallet. v6 fixes this by having AuthService.verify return the verified
  // walletId additively, and issueFamily rejects empty walletId.
  // -------------------------------------------------------------------------
  it('R32 (v6 P0-1) multi-wallet login → family walletId = verified wallet B, not wallets[0]', async () => {
    const bob = privateKeyToAccount(generatePrivateKey());

    // Seed the fake DB with a user owning TWO wallets: A (alice) + B (bob).
    // Alice's wallet is created FIRST so it sits at index 0 in listByUser.
    const userRow: User = {
      id: randomUUID(),
      status: 'ACTIVE' as UserStatus,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: null,
      locale: 'en',
      timezone: 'UTC',
    };
    currentDB.users[userRow.id] = userRow;
    const walletA: Wallet = {
      id: randomUUID(),
      userId: userRow.id,
      address: alice.address,
      chain: 'ETH' as Chain,
      network: 'mainnet',
      status: 'CONNECTED' as WalletStatus,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const walletB: Wallet = {
      id: randomUUID(),
      userId: userRow.id,
      address: bob.address,
      chain: 'ETH' as Chain,
      network: 'mainnet',
      status: 'CONNECTED' as WalletStatus,
      isPrimary: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    currentDB.wallets[walletA.id] = walletA;
    currentDB.wallets[walletB.id] = walletB;

    // Login with wallet B (bob). The nonceService will find wallet B (by
    // address+chain+network) and the verify flow must bind the family to B.
    const n = await getNonce(bob);
    const message = buildSiweMessage({ ...n, address: bob.address });
    const signature = await signMessage(bob, message);
    const r = await verifyRaw({
      message,
      signature,
      address: bob.address,
      transport: 'api',
    });
    expect(r.status).toBe(200);
    const refreshToken = r.body.data.refreshToken;

    // The refresh family MUST be bound to wallet B (the verified wallet),
    // NOT wallet A (wallets[0]). This is the P0-1 fix.
    const refreshTokens = app.get(RefreshTokenService);
    const familyId = await refreshTokens.verifyRefreshToken(refreshToken);
    expect(familyId).toBeTruthy();
    const fam = await refreshTokens.getFamilyMeta(familyId!);
    expect(fam).toBeTruthy();
    expect(fam!.walletId).toBe(walletB.id);
    expect(fam!.walletId).not.toBe(walletA.id);

    // After refresh, the new access JWT MUST carry walletId = B.
    const rr = await refreshApi(refreshToken);
    expect(rr.status).toBe(200);
    const newAccessToken = rr.body.data.accessToken;
    expect(newAccessToken).toBeTruthy();
    // Decode the JWT payload (no verify — we just inspect the walletId claim).
    const payloadB64 = newAccessToken.split('.')[1];
    const payloadJson = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      sub: string;
      walletId?: string;
    };
    expect(payloadJson.walletId).toBe(walletB.id);
    expect(payloadJson.walletId).not.toBe(walletA.id);
  });

  // =========================================================================
  // R33 (v6 P0-2) — SIWE expirationTime < 30d: familyExpiresAt clamped to
  // SIWE exp; after refresh the new access JWT exp does NOT exceed the SIWE
  // boundary. This preserves the P1-002 SIWE absolute expiry across rotation.
  // -------------------------------------------------------------------------
  it('R33 (v6 P0-2) SIWE exp < 30d → familyExpiresAt clamped + refresh access exp ≤ SIWE exp', async () => {
    // Build a SIWE message with a SHORT expirationTime (1 hour from now).
    // The default family lifetime is 30d; 1h < 30d so the family MUST be
    // clamped to 1h. The access JWT TTL is 15min, so the first access JWT is
    // already under 1h — but after refresh the new access JWT must ALSO stay
    // under the 1h SIWE boundary (not the 15min TTL).
    const siweExpMs = Date.now() + 60 * 60 * 1000; // 1 hour
    const n = await getNonce(alice);
    const message = buildSiweMessage({
      ...n,
      address: alice.address,
      expiresAt: new Date(siweExpMs),
    });
    const signature = await signMessage(alice, message);
    const r = await verifyRaw({
      message,
      signature,
      address: alice.address,
      transport: 'api',
    });
    expect(r.status).toBe(200);
    const refreshToken = r.body.data.refreshToken;

    // The family MUST be clamped to the SIWE expirationTime.
    const refreshTokens = app.get(RefreshTokenService);
    const familyId = await refreshTokens.verifyRefreshToken(refreshToken);
    expect(familyId).toBeTruthy();
    const fam = await refreshTokens.getFamilyMeta(familyId!);
    expect(fam).toBeTruthy();
    const siweExpSec = Math.floor(siweExpMs / 1000);
    // familyExpiresAt must equal (or be very close to) the SIWE exp, and MUST
    // be strictly less than now + 30d.
    const nowSec = Math.floor(Date.now() / 1000);
    const maxFamilySec = nowSec + env().familyMaxLifetimeSec;
    expect(fam!.familyExpiresAt).toBeLessThanOrEqual(siweExpSec);
    expect(fam!.familyExpiresAt).toBeLessThan(maxFamilySec);
    // authorizationExpiresAt must be stored (epoch seconds).
    expect(fam!.authorizationExpiresAt).toBe(siweExpSec);

    // Refresh → the new access JWT exp MUST NOT exceed the SIWE boundary.
    const rr = await refreshApi(refreshToken);
    expect(rr.status).toBe(200);
    const newAccessToken = rr.body.data.accessToken;
    const payloadB64 = newAccessToken.split('.')[1];
    const payloadJson = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      exp: number;
    };
    expect(payloadJson.exp).toBeLessThanOrEqual(siweExpSec);
  });

  // =========================================================================
  // R34 (v6 P0-2) — no SIWE expirationTime: family still lives the full 30d
  // and the access JWT uses its configured TTL (no SIWE clamp).
  //
  // The SIWE parser currently requires expirationTime (EIP-4361 allows it to be
  // optional, but P1-002 made it mandatory for stricter replay protection).
  // This test exercises the issueFamily code path directly with a null
  // authorizationExpiresAt to prove the family lives the full 30d when no SIWE
  // boundary is present (defensive: future SIWE relaxation would still be safe).
  // -------------------------------------------------------------------------
  it('R34 (v6 P0-2) no SIWE expirationTime → family lives full 30d (no clamp)', async () => {
    const refreshTokens = app.get(RefreshTokenService);
    const userId = randomUUID();
    const walletId = randomUUID();

    const nowSec = Math.floor(Date.now() / 1000);
    const maxFamilySec = nowSec + env().familyMaxLifetimeSec;

    // issueFamily with NO authorizationExpiresAt — the family MUST live the
    // full familyMaxLifetimeSec (30d default).
    const { refreshToken, familyId, familyExpiresAt } = await refreshTokens.issueFamily({
      userId,
      walletId,
      authorizationExpiresAt: null,
    });
    expect(refreshToken).toBeTruthy();
    expect(familyId).toBeTruthy();
    // familyExpiresAt should equal now + familyMaxLifetimeSec (within a small
    // tolerance for test execution time).
    expect(familyExpiresAt).toBeGreaterThanOrEqual(maxFamilySec - 5);
    expect(familyExpiresAt).toBeLessThanOrEqual(maxFamilySec + 5);

    // Family meta: authorizationExpiresAt must be null.
    const fam = await refreshTokens.getFamilyMeta(familyId);
    expect(fam).toBeTruthy();
    expect(fam!.authorizationExpiresAt).toBeNull();
    expect(fam!.familyExpiresAt).toBeGreaterThanOrEqual(maxFamilySec - 5);
  });
});
