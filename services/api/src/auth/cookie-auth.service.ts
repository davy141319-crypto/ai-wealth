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
//   - JWT raw value is never logged.
// ============================================================================

import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { env } from '@ai-wealth/config';

@Injectable()
export class CookieAuthService {
  private readonly cfg = env();

  /**
   * Set the access-token cookie on the outgoing response. Called after a
   * successful SIWE verify, alongside the existing `accessToken` body field
   * (kept for Bearer-mode backward compatibility).
   *
   * @param expSec cookie Max-Age in seconds — must match the JWT `exp` claim.
   */
  setAuthCookie(res: Response, token: string, expSec: number): void {
    res.cookie(this.cfg.cookieName, token, {
      httpOnly: true,
      secure: this.cfg.cookieSecure,
      sameSite: this.cfg.cookieSameSite,
      path: this.cfg.cookiePath,
      // Empty domain means host-only cookie — do not emit the attribute
      // (required for the `__Host-` prefix).
      ...(this.cfg.cookieDomain ? { domain: this.cfg.cookieDomain } : {}),
      maxAge: Math.max(0, Math.floor(expSec)) * 1000,
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
   * Clear both the access-token and CSRF cookies on logout. Uses Max-Age=0 and
   * the same Path/Domain so the browser deletes the exact cookie that was set.
   */
  clearAuthCookies(res: Response): void {
    const base = {
      httpOnly: true,
      secure: this.cfg.cookieSecure,
      sameSite: this.cfg.cookieSameSite,
      path: this.cfg.cookiePath,
      ...(this.cfg.cookieDomain ? { domain: this.cfg.cookieDomain } : {}),
      maxAge: 0,
    } as const;
    res.clearCookie(this.cfg.cookieName, base);
    // CSRF cookie is non-HttpOnly; clear with matching attributes.
    res.clearCookie(this.cfg.csrfCookieName, {
      httpOnly: false,
      secure: this.cfg.cookieSecure,
      sameSite: this.cfg.cookieSameSite,
      path: this.cfg.cookiePath,
      ...(this.cfg.cookieDomain ? { domain: this.cfg.cookieDomain } : {}),
      maxAge: 0,
    });
  }
}
