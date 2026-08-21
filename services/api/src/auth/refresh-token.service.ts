// ============================================================================
// RefreshTokenService — P1-004 rotating refresh tokens with token-family reuse
// detection.
//
// Design (see .trae/specs/P1-004-refresh-rotation/spec.md):
//   - Opaque tokens: 48 random bytes, base64url-encoded (384-bit entropy). The
//     server NEVER stores plaintext — only SHA-256 hashes + metadata in Redis.
//   - Token family: created on SIWE login; rotation happens inside the family;
//     reuse detection revokes the WHOLE family atomically (Lua).
//   - Fixed family lifetime: familyExpiresAt is set at creation and never
//     extended by rotation. Every Redis key uses TTL = familyExpiresAt - now.
//   - Old lookup keys are KEPT (not deleted) so a replayed used token can still
//     resolve to the family and be classified RETRY vs REUSED via the tombstone.
//   - No DB / migration: pure Redis + TTL. Redis failure → /refresh returns 503;
//     access JWT still works until expiry; client re-authenticates via SIWE.
//
// This service does NOT touch JwtAuthService internals — it only calls
// jwtAuth.sign() to mint a fresh access JWT after a successful rotation.
// ============================================================================

import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, createLogger } from '@ai-wealth/shared';
import { env, SERVICE_NAMES } from '@ai-wealth/config';
import { RedisService } from '../common/redis/redis.service';

/** Result of a refresh attempt. The caller maps these to HTTP responses. */
export type RotateOutcome =
  | { kind: 'rotated'; familyId: string; newRefreshToken: string }
  | { kind: 'retry' }
  | { kind: 'reused'; familyId: string }
  | { kind: 'revoked'; familyId: string }
  | { kind: 'invalid' };

interface FamilyMeta {
  userId: string;
  walletId: string;
  status: 'ACTIVE' | 'REVOKED';
  createdAt: number;
  familyExpiresAt: number;
}

interface ActiveMeta {
  tokenHash: string;
  issuedAt: number;
}

const KEY_LOOKUP = (hash: string) => `refresh:lookup:${hash}`;
const KEY_FAMILY = (familyId: string) => `refresh:family:${familyId}`;
const KEY_ACTIVE = (familyId: string) => `refresh:active:${familyId}`;
const KEY_REVOKED = (familyId: string) => `refresh:revoked:${familyId}`;

@Injectable()
export class RefreshTokenService {
  private readonly logger = createLogger(SERVICE_NAMES.API);
  private scriptSha: string | null = null;
  private readonly luaSource: Promise<string>;

  constructor(private readonly redis: RedisService) {
    // Load the Lua script source lazily so the service can be instantiated in
    // tests without the file being present on disk immediately.
    this.luaSource = readFile(join(__dirname, 'refresh-rotation.lua'), 'utf8').catch(() => '');
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Create a new family + issue the first refresh token. Called from the SIWE
   * verify flow on successful login. Returns the plaintext token (to set as a
   * cookie or return in the body depending on transport) plus family metadata.
   */
  async issueFamily(params: {
    userId: string;
    walletId: string;
  }): Promise<{ refreshToken: string; familyId: string; familyExpiresAt: number }> {
    const cfg = env();
    const now = Math.floor(Date.now() / 1000);
    const familyId = randomUUID();
    const familyExpiresAt = now + cfg.familyMaxLifetimeSec;
    const ttl = familyExpiresAt - now;

    const refreshToken = this.generateOpaque();
    const tokenHash = this.hashToken(refreshToken);

    const familyMeta: FamilyMeta = {
      userId: params.userId,
      walletId: params.walletId,
      status: 'ACTIVE',
      createdAt: now,
      familyExpiresAt,
    };
    const activeMeta: ActiveMeta = { tokenHash, issuedAt: now };

    // Write atomically: family + active + lookup. All share the same TTL
    // (family remaining lifetime) so they expire together at familyExpiresAt.
    const conn = this.redis.connection;
    await conn
      .multi()
      .set(KEY_FAMILY(familyId), JSON.stringify(familyMeta), 'EX', ttl)
      .set(KEY_ACTIVE(familyId), JSON.stringify(activeMeta), 'EX', ttl)
      .set(KEY_LOOKUP(tokenHash), familyId, 'EX', ttl)
      .exec();

    return { refreshToken, familyId, familyExpiresAt };
  }

  /**
   * Rotate a refresh token. Runs the Lua script for atomicity. The caller is
   * responsible for minting the new access JWT (via jwtAuth.sign) on success
   * and for mapping the outcome to the HTTP response + audit.
   */
  async rotate(refreshToken: string): Promise<RotateOutcome> {
    if (!refreshToken) return { kind: 'invalid' };
    const tokenHash = this.hashToken(refreshToken);
    const cfg = env();
    const now = Math.floor(Date.now() / 1000);

    const newRefreshToken = this.generateOpaque();
    const newTokenHash = this.hashToken(newRefreshToken);
    const newActiveMeta: ActiveMeta = { tokenHash: newTokenHash, issuedAt: now };

    const result = await this.evalRotation({
      tokenHash,
      now,
      graceSec: cfg.reuseGraceSec,
      maxRetry: cfg.maxRefreshRetry,
      newTokenHash,
      newActiveMeta: JSON.stringify(newActiveMeta),
    });

    const code = Number(result[0]);
    if (code === 0) {
      // Need familyId for audit — fetch via the NEW lookup (just written).
      const familyId = await this.redis.connection.get(KEY_LOOKUP(newTokenHash));
      return { kind: 'rotated', familyId: familyId ?? '', newRefreshToken };
    }
    if (code === 1) return { kind: 'retry' };
    if (code === 2) {
      // Family was revoked inside the script; resolve familyId for audit.
      const familyId = await this.resolveFamilyByHash(tokenHash);
      return { kind: 'reused', familyId: familyId ?? '' };
    }
    if (code === 3) {
      const familyId = await this.resolveFamilyByHash(tokenHash);
      return { kind: 'revoked', familyId: familyId ?? '' };
    }
    return { kind: 'invalid' };
  }

  /** Verify a refresh token WITHOUT rotating — used by logout to confirm the
   *  presented token maps to a live family. Returns familyId or null. */
  async verifyRefreshToken(refreshToken: string): Promise<string | null> {
    if (!refreshToken) return null;
    const tokenHash = this.hashToken(refreshToken);
    return this.resolveFamilyByHash(tokenHash);
  }

  /**
   * Revoke an entire family by id (logout / reuse). Idempotent. Uses Redis
   * MULTI so the revoked marker, family status flip, and active-token removal
   * land together.
   */
  async revokeFamily(familyId: string, reason: string = 'LOGOUT'): Promise<void> {
    if (!familyId) return;
    const now = Math.floor(Date.now() / 1000);
    const famRaw = await this.redis.connection.get(KEY_FAMILY(familyId));
    if (!famRaw) return; // already expired/gone — nothing to revoke
    const fam = JSON.parse(famRaw) as FamilyMeta;
    if (fam.status === 'REVOKED') return; // idempotent
    const remainingTtl = Math.max(fam.familyExpiresAt - now, 1);
    fam.status = 'REVOKED';
    const revokedMeta = { revokedAt: now, reason };
    await this.redis.connection
      .multi()
      .set(KEY_REVOKED(familyId), JSON.stringify(revokedMeta), 'EX', remainingTtl)
      .set(KEY_FAMILY(familyId), JSON.stringify(fam), 'EX', remainingTtl)
      .del(KEY_ACTIVE(familyId))
      .exec();
  }

  /** SHA-256 hex of the plaintext token. Never store the plaintext. */
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** 48 random bytes, base64url — 384-bit entropy opaque token. */
  generateOpaque(): string {
    return randomBytes(48).toString('base64url');
  }

  /** Read the family id behind a token hash (lookup kept until family expiry). */
  async resolveFamilyByHash(tokenHash: string): Promise<string | null> {
    const v = await this.redis.connection.get(KEY_LOOKUP(tokenHash));
    return v ?? null;
  }

  /** Read family metadata (used by logout to fetch userId for audit). */
  async getFamilyMeta(familyId: string): Promise<FamilyMeta | null> {
    const raw = await this.redis.connection.get(KEY_FAMILY(familyId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FamilyMeta;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Lua script execution (with evalsha → eval fallback)
  // --------------------------------------------------------------------------

  private async evalRotation(args: {
    tokenHash: string;
    now: number;
    graceSec: number;
    maxRetry: number;
    newTokenHash: string;
    newActiveMeta: string;
  }): Promise<[number, string]> {
    const conn = this.redis.connection;
    const keys = [KEY_LOOKUP(args.tokenHash)];
    const argv = [
      args.tokenHash,
      String(args.now),
      String(args.graceSec),
      String(args.maxRetry),
      args.newTokenHash,
      args.newActiveMeta,
    ];

    // Use EVALSHA when we have a cached digest; fall back to EVAL on NOSCRIPT.
    if (this.scriptSha) {
      try {
        return (await conn.evalsha(this.scriptSha, 1, ...keys, ...argv)) as [number, string];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/NOSCRIPT/i.test(msg)) {
          this.logger.warn('refresh_evalsha_failed', { error: msg });
          throw err;
        }
        this.scriptSha = null; // re-load below
      }
    }
    const src = await this.luaSource;
    if (!src) {
      throw AppError.internal('refresh rotation script not loaded', {
        reason: 'LUA_SCRIPT_MISSING',
      });
    }
    const result = (await conn.eval(src, 1, ...keys, ...argv)) as [number, string];
    // Cache the digest for subsequent calls.
    try {
      const digest = (await conn.script('LOAD', src)) as unknown;
      this.scriptSha = typeof digest === 'string' ? digest : null;
    } catch {
      // non-fatal — next call will re-eval
    }
    return result;
  }
}
