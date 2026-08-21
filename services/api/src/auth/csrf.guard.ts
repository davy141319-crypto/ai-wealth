// ============================================================================
// CsrfGuard — Double Submit Cookie enforcement for state-changing requests.
//
// Rules (P1-003 + P1-004):
//   - Only applies to POST / PUT / PATCH / DELETE (state-changing verbs).
//   - GET / HEAD / OPTIONS are always exempt.
//   - Path exemptions (no CSRF required even on POST): /api/auth/nonce,
//     /api/auth/verify (login, pre-session), /api/auth/csrf-token (issue).
//   - Bearer/api-only clients are NOT subject to CSRF: if the request carries
//     NO auth cookie at all, the guard passes through. P1-004 extends the
//     trigger condition: CSRF is enforced when an access cookie OR a refresh
//     cookie is present (previously access-only). This is required so that
//     /refresh (which uses the refresh cookie, access may be expired) and
//     /logout (access OR refresh) are CSRF-protected in cookie mode.
//   - When enforced: header[X-CSRF-TOKEN] must be non-empty AND equal to the
//     csrf cookie value. Mismatch/absence → 403 CSRF_TOKEN_INVALID + audit.
//
// P1-004 ordering: TransportMiddleware runs BEFORE this guard and rejects
// transport=api requests that carry a cookie (TRANSPORT_COOKIE_CONFLICT), so by
// the time CsrfGuard runs, an api-transport request genuinely has no cookie
// and is correctly exempt; a cookie-transport request with a cookie present is
// enforced.
//
// Comparison is plain string equality (no regex) — tokens are opaque random
// bytes, not user input that needs pattern validation.
// ============================================================================

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { env } from '@ai-wealth/config';
import { AppError, AuthFailReason } from '@ai-wealth/shared';
import { AuditService } from './audit.service';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Normalised path without the global /api prefix; lowercase for compare. */
function normalisePath(originalUrl: string, apiPrefix: string): string {
  let p = originalUrl.split('?')[0] as string;
  // Strip the leading /api prefix when present.
  const prefix = apiPrefix.startsWith('/') ? apiPrefix : `/${apiPrefix}`;
  if (p.startsWith(prefix)) p = p.slice(prefix.length);
  if (!p.startsWith('/')) p = `/${p}`;
  return p.toLowerCase();
}

/** Exempt auth paths that are reachable before a session exists. */
const EXEMPT_PATHS = new Set<string>(['/auth/nonce', '/auth/verify', '/auth/csrf-token']);

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly cfg = env();

  constructor(private readonly audit: AuditService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<ExpressRequest & { headers: Record<string, string | string[] | undefined> }>();

    const method = req.method.toUpperCase();
    // Only state-changing verbs are subject to CSRF.
    if (!STATE_CHANGING_METHODS.has(method)) return true;

    const path = normalisePath(req.originalUrl || req.url, this.cfg.apiPrefix);
    // Exempt pre-session auth endpoints (nonce / verify / csrf-token issue).
    if (EXEMPT_PATHS.has(path)) return true;

    // P1-004: enforce CSRF whenever ANY auth cookie credential is present
    // (access OR refresh). Previously this was access-only, which left
    // /refresh (refresh cookie, access may be expired) and /logout (refresh
    // cookie) unprotected in cookie mode.
    const accessCookie = (req.cookies ?? {})[this.cfg.cookieName] as string | undefined;
    const refreshCookie = (req.cookies ?? {})[this.cfg.refreshCookieName] as string | undefined;
    if (!accessCookie && !refreshCookie) return true; // Bearer/api-only → exempt

    // Cookie-based session present → enforce DSC.
    const headerName = this.cfg.csrfHeaderName.toLowerCase();
    const rawHeader = req.headers[headerName] ?? req.headers[this.cfg.csrfHeaderName];
    const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const csrfCookie = (req.cookies ?? {})[this.cfg.csrfCookieName] as string | undefined;

    // Constant-ish comparison: opaque random tokens, no secret. We compare
    // for equality of two strings the server just produced — timing leakage
    // would reveal at most token length, which is fixed (32 bytes base64url).
    if (!headerValue || !csrfCookie || headerValue !== csrfCookie) {
      const requestId = (req.headers['x-request-id'] as string | string[] | undefined) ?? undefined;
      await this.audit.recordCsrfFailure({
        requestId: Array.isArray(requestId) ? requestId[0] : requestId,
      });
      throw AppError.forbidden('CSRF token invalid', { reason: AuthFailReason.CSRF_TOKEN_INVALID });
    }
    return true;
  }
}
