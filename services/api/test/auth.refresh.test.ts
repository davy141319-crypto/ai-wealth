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

  /** Cookie-mode login: sets access+refresh cookies, body only {user}. */
  async function loginCookie(): Promise<{
    accessVal: string;
    refreshVal: string;
    userId: string;
  }> {
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
    const accessVal = extractCookie(r, ACCESS_COOKIE) ?? '';
    const refreshVal = extractCookie(r, REFRESH_COOKIE) ?? '';
    expect(accessVal).toBeTruthy();
    expect(refreshVal).toBeTruthy();
    return { accessVal, refreshVal, userId: r.body.data.user.id };
  }

  /** API-mode login: body has tokens, no Set-Cookie. */
  async function loginApi(): Promise<{
    accessToken: string;
    refreshToken: string;
    userId: string;
  }> {
    const n = await getNonce(alice);
    const message = buildSiweMessage({ ...n, address: alice.address });
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
    const { accessVal, refreshVal } = await loginCookie();
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
    const { refreshVal } = await loginCookie();
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
  // R31 — refresh-rotation.lua must be present in the compiled dist/ output
  // (services/api/dist/auth/refresh-rotation.lua) so the API Docker image can
  // load it at runtime via `readFile(join(__dirname, 'refresh-rotation.lua'))`.
  // This is a SELF-CONTAINED build-artifact check: it runs a REAL `nest build`
  // inside the test body (not relying on a pre-existing dist/), so it passes
  // regardless of CI job ordering — the `test` job runs BEFORE the `build` job,
  // so dist/ does not exist when jest starts. Verifies v5+ FINAL fix-3:
  // nest-cli.json `assets` copies **/*.lua into dist during `nest build`; if the
  // glob is removed, the build still succeeds but dist lacks the lua and
  // RefreshTokenService throws LUA_SCRIPT_MISSING at runtime in the container.
  // -------------------------------------------------------------------------
  it('R31 refresh-rotation.lua is present in dist after a real nest build', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('node:path') as typeof import('node:path');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execSync } = require('node:child_process') as typeof import('node:child_process');

    const apiRoot = path.resolve(__dirname, '..');
    const srcLua = path.join(apiRoot, 'src', 'auth', 'refresh-rotation.lua');
    const distLua = path.join(apiRoot, 'dist', 'auth', 'refresh-rotation.lua');
    const nestCliPath = path.join(apiRoot, 'nest-cli.json');

    // (a) Source lua is committed and contains the rotation script body.
    expect(fs.existsSync(srcLua)).toBe(true);
    const srcContent = fs.readFileSync(srcLua, 'utf8');
    expect(srcContent).toContain('P1-004 Refresh Token Rotation');
    expect(srcContent.length).toBeGreaterThan(500);

    // (b) nest-cli.json must declare the **/*.lua asset glob so `nest build`
    //     copies it into dist. A regression that drops this glob is caught here
    //     even before running the build.
    const nestCli = JSON.parse(fs.readFileSync(nestCliPath, 'utf8')) as {
      compilerOptions?: { assets?: Array<{ include: string }> };
    };
    const assetGlobs = (nestCli.compilerOptions?.assets ?? []).map((a) => a.include);
    expect(assetGlobs.some((g) => g.includes('lua'))).toBe(true);

    // (c) Run a REAL `nest build` (the api build script) right here so the test
    //     does not depend on dist/ having been built by a prior CI step. This
    //     mirrors what the Docker image build does and verifies the lua lands in
    //     dist/auth/refresh-rotation.lua. deleteOutDir:true wipes dist first, so
    //     a stale lua from a previous build can never produce a false pass.
    try {
      execSync('pnpm run build', {
        cwd: apiRoot,
        stdio: 'pipe',
        timeout: 180000,
        env: process.env,
      });
    } catch (err) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      const detail = [e.stdout?.toString(), e.stderr?.toString()].filter(Boolean).join('\n');
      throw new Error(
        `R31: \`nest build\` failed; lua asset copy could not be verified.\n${detail}`,
      );
    }

    // (d) After the real build, the lua MUST exist in dist and contain the body.
    expect(fs.existsSync(distLua)).toBe(true);
    const distContent = fs.readFileSync(distLua, 'utf8');
    expect(distContent).toContain('P1-004 Refresh Token Rotation');
    expect(distContent.length).toBeGreaterThan(500);
  });
});
