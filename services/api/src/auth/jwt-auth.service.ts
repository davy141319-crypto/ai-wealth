// ============================================================================
// JwtAuthService — issues + verifies HS256 JWTs; maintains a Redis-backed
// session registry and blocklist for fast logout revocation.
//
// Security (NFR-2):
//   - JWT secret comes ONLY from env().jwtSecret (which reads JWT_SECRET).
//   - Tokens are delivered via `Authorization: Bearer …` header; the service
//     never reads a token from a query string or cookie (P1-002 scope).
//   - On logout: jti is added to a Redis blocklist with TTL equal to the
//     remaining exp; the session key is also deleted.
// ============================================================================

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { AuthFailReason } from '@ai-wealth/shared';
import { RedisService } from '../common/redis/redis.service';

export interface AuthJwtPayload {
  sub: string; // userId (UUID)
  jti: string;
  walletId?: string;
  iat: number;
  exp: number;
}

export interface SignOptions {
  userId: string;
  walletId?: string;
  /** ISO string ceiling for exp (SIWE expirationTime wins when shorter). */
  absoluteExpiresAtIso?: string;
}

const SESSION_PREFIX = 'auth:sessions:';
const BLOCK_PREFIX = 'auth:blocked:';

/** Thrown locally; translated to 401 upstream. */
export class JwtAuthError extends Error {
  constructor(
    public readonly reason: AuthFailReason,
    message: string,
  ) {
    super(message);
    this.name = 'JwtAuthError';
  }
}

@Injectable()
export class JwtAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
  ) {}

  /** Sign a short-lived access token. Persists jti in the session registry. */
  async sign(opts: SignOptions): Promise<{ token: string; payload: AuthJwtPayload }> {
    const jti = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    // NestJS JwtModule is configured with env().jwtExpiresIn already; we
    // compute a candidate exp by doing a dry sign so we honour the JWT ttl
    // but still clamp to the SIWE expirationTime when provided.
    const preview = this.jwt.decode(
      this.jwt.sign({ sub: opts.userId, jti, walletId: opts.walletId }),
    ) as { exp: number };
    let exp = preview.exp;
    if (opts.absoluteExpiresAtIso) {
      const siweExpSec = Math.floor(new Date(opts.absoluteExpiresAtIso).getTime() / 1000);
      if (!Number.isNaN(siweExpSec) && siweExpSec < exp) exp = siweExpSec;
    }
    if (exp <= now) {
      throw new JwtAuthError(AuthFailReason.EXPIRED, 'SIWE expiration already passed');
    }

    const token = this.jwt.sign(
      { sub: opts.userId, jti, walletId: opts.walletId },
      { expiresIn: exp - now },
    );
    const payload = (await this.jwt.verifyAsync<AuthJwtPayload>(token)) as AuthJwtPayload;
    const ttlSec = payload.exp - Math.floor(Date.now() / 1000);
    if (ttlSec > 0) {
      await this.redis.connection.setex(
        `${SESSION_PREFIX}${payload.jti}`,
        ttlSec,
        String(payload.sub),
      );
    }
    return { token, payload };
  }

  /** Verify token signature, blocklist, and session registry. */
  async verify(token: string): Promise<AuthJwtPayload> {
    if (!token) {
      throw new JwtAuthError(AuthFailReason.NOT_AUTHENTICATED, 'missing token');
    }
    let payload: AuthJwtPayload;
    try {
      payload = (await this.jwt.verifyAsync<AuthJwtPayload>(token)) as AuthJwtPayload;
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TokenExpiredError') {
        throw new JwtAuthError(AuthFailReason.TOKEN_EXPIRED, 'jwt expired');
      }
      throw new JwtAuthError(AuthFailReason.TOKEN_INVALID, 'jwt verify failed');
    }
    const blocked = await this.redis.connection.exists(`${BLOCK_PREFIX}${payload.jti}`);
    if (blocked > 0) {
      throw new JwtAuthError(AuthFailReason.TOKEN_REVOKED, 'token revoked via logout');
    }
    const session = await this.redis.connection.exists(`${SESSION_PREFIX}${payload.jti}`);
    if (session === 0) {
      throw new JwtAuthError(AuthFailReason.TOKEN_REVOKED, 'session expired or logged out');
    }
    return payload;
  }

  /** Revoke a token: move jti to blocklist + remove session key. Returns ttl used. */
  async revoke(token: string): Promise<number> {
    let payload: AuthJwtPayload;
    try {
      payload = (await this.jwt.verifyAsync<AuthJwtPayload>(token)) as AuthJwtPayload;
    } catch (err) {
      // Allow revoked token to be logged out gracefully when it's still valid.
      // If verification fails, decode without verification to get jti+exp.
      try {
        payload = this.jwt.decode(token) as AuthJwtPayload;
      } catch {
        return 0;
      }
    }
    if (!payload?.jti) return 0;
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(payload.exp - now, 1);
    await Promise.all([
      this.redis.connection.setex(`${BLOCK_PREFIX}${payload.jti}`, ttl, '1'),
      this.redis.connection.del(`${SESSION_PREFIX}${payload.jti}`),
    ]);
    return ttl;
  }
}
