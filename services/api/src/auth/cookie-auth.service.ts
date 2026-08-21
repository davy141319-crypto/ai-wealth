// ============================================================================
// CookieAuthService — sets and clears the auth/CSRF cookies used by the
// Bearer/Cookie dual-mode session layer (P1-003).
//
// Rules:
//   - The access-token cookie carries the SAME JWT that Bearer clients send in
//     the Authorization header — it is never a second, independent credential.
//   - Always HttpOnly (JS cannot read it) + SameSite=Lax + Path=/.
//   - Production uses the `__Host-` prefix (forces Secure + Path=/ + no Domain)
//     over HTTPS; dev/test fall back to a plain name with Secure=false so
//     localhost HTTP works.
//   - The CSRF cookie is NON HttpOnly (the browser must read it to echo the
//     value back in the X-CSRF-TOKEN header) but carries no secret material.
//   - Access-cookie Max-Age is derived from the SIGNED JWT's real `exp` claim
//     (decoded from the token payload) — NEVER from the configured
//     `jwtExpiresIn` TTL. This keeps the cookie in lock-step with the token's
//     true lifetime, including when JwtAuthService clamps exp to a shorter
//     SIWE expirationTime. JwtAuthService itself is NOT modified.
//   - On logout, cookies are cleared EXPLICITLY: BOTH Max-Age=0 and
//     Expires=epoch are emitted (via a hand-built Set-Cookie header) so
//     deletion is unambiguous across browsers — Express's res.clearCookie /
//     res.cookie cannot emit both at once (its maxAge branch overwrites
//     expires, and omitting maxAge skips Max-Age entirely).
//   - JWT raw value is never logged.
// ============================================================================

import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { env, SERVICE_NAMES } from '@ai-wealth/config';
import { createLogger } from '@ai-wealth/shared';

interface DecodedJwtPayload {
  exp?: number;
  sub?: string;
  jti?: string;
}

@Injectable()
export class CookieAuthService {
  private readonly cfg = env();
  private readonly logger = createLogger(SERVICE_NAMES.API);

  /**
   * Decode the `exp` claim (seconds since epoch) from a signed JWT WITHOUT
   * verifying its signature. The token has just been issued by
   * JwtAuthService.sign() upstream of this call, so it is trusted; signature
   * verification remains JwtAuthGuard's responsibility. Returns null if the
   * payload cannot be decoded or lacks a numeric `exp`.
   */
  private decodeJwtExp(token: string): number | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8'),
      ) as DecodedJwtPayload;
      return typeof payload.exp === 'number' ? payload.exp : null;
    } catch {
      return null;
    }
  }

  /**
   * Set the access-token cookie on the outgoing response. Called after a
   * successful SIWE verify, alongside the existing `accessToken` body field
   * (kept for Bearer-mode backward compatibility).
   *
   * Max-Age is computed from the JWT's REAL `exp` claim (decoded from the
   * token), NOT from the configured `jwtExpiresIn`. This guarantees the cookie
   * never outlives the token — including when JwtAuthService clamps exp to a
   * shorter SIWE expirationTime. JwtAuthService is NOT modified.
   */
  setAuthCookie(res: Response, token: string): void {
    const expSec = this.decodeJwtExp(token);
    let maxAgeMs: number;
    if (expSec === null) {
      // Defensive: the token was just signed by JwtAuthService, so decode
      // should not fail. If it ever does, FAIL CLOSED — emit an
      // immediately-expiring cookie rather than guessing a TTL from config
      // (a long-lived cookie could outlive the real token).
      this.logger.warn('cookie_auth_exp_decode_failed', {
        message: 'jwt exp could not be decoded; cookie set with Max-Age=0',
      });
      maxAgeMs = 0;
    } else {
      maxAgeMs = Math.max(0, expSec * 1000 - Date.now());
    }
    res.cookie(this.cfg.cookieName, token, {
      httpOnly: true,
      secure: this.cfg.cookieSecure,
      sameSite: this.cfg.cookieSameSite,
      path: this.cfg.cookiePath,
      // Empty domain means host-only cookie — do not emit the attribute
      // (required for the `__Host-` prefix).
      ...(this.cfg.cookieDomain ? { domain: this.cfg.cookieDomain } : {}),
      maxAge: maxAgeMs,
    });
  }

  /**
   * Set the CSRF cookie. Non-HttpOnly so the browser can read it and echo the
   * value in the X-CSRF-TOKEN header (Double Submit Cookie pattern).
   */
  setCsrfCookie(res: Response, token: string): void {
    res.cookie(this.cfg.csrfCookieName, token, {
      httpOnly: false,
      secure: this.cfg.cookieSecure,
      sameSite: this.cfg.cookieSameSite,
      path: this.cfg.cookiePath,
      ...(this.cfg.cookieDomain ? { domain: this.cfg.cookieDomain } : {}),
    });
  }

  /**
   * Clear both the access-token and CSRF cookies on logout. Deletion is made
   * EXPLICIT by emitting BOTH `Max-Age=0` and `Expires=<epoch>` (plus the same
   * Path/Domain/Secure/SameSite/HttpOnly used when setting the cookie) via a
   * hand-built Set-Cookie header. Express's `res.clearCookie` / `res.cookie`
   * cannot emit both Max-Age=0 and Expires=epoch at once — when `maxAge` is
   * provided it overwrites `expires` with `now+maxAge`, and when `maxAge` is
   * omitted the serialiser skips `Max-Age` entirely. Building the header
   * directly avoids that mutual exclusion so deletion is unconditional across
   * browsers.
   */
  clearAuthCookies(res: Response): void {
    res.append('Set-Cookie', this.buildDeleteCookie(this.cfg.cookieName, true));
    res.append('Set-Cookie', this.buildDeleteCookie(this.cfg.csrfCookieName, false));
  }

  /**
   * Build a Set-Cookie header value that deletes `name`. Emits both Max-Age=0
   * and Expires=epoch alongside the cookie's normal scoping attributes so the
   * browser matches and removes the exact cookie that was set.
   */
  private buildDeleteCookie(name: string, httpOnly: boolean): string {
    const parts: string[] = [`${name}=`];
    if (this.cfg.cookiePath) parts.push(`Path=${this.cfg.cookiePath}`);
    if (this.cfg.cookieDomain) parts.push(`Domain=${this.cfg.cookieDomain}`);
    if (this.cfg.cookieSecure) parts.push('Secure');
    parts.push(`SameSite=${this.cfg.cookieSameSite}`);
    if (httpOnly) parts.push('HttpOnly');
    // Explicit deletion signals — BOTH Max-Age=0 and Expires=epoch so the
    // browser unambiguously removes the cookie regardless of attribute order.
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    parts.push('Max-Age=0');
    return parts.join('; ');
  }
}
