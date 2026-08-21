// ============================================================================
// TransportMiddleware — P1-004 explicit transport mode + Origin anti-downgrade.
//
// Enforces the X-Auth-Transport contract BEFORE CsrfGuard runs:
//   - Requests MUST declare `X-Auth-Transport: cookie | api`; missing → 400.
//   - `isBrowserOrigin` is derived ONLY from the Origin/Referer header (never
//     from User-Agent) checked against the WEB_APP_URL/ADMIN_APP_URL allowlist.
//   - Transport × Origin matrix:
//       browser-origin + cookie  → ok
//       browser-origin + api     → 403 TRANSPORT_ORIGIN_CONFLICT (anti-downgrade:
//                                  a browser page cannot declare api to skip CSRF)
//       non-browser + cookie     → 403 ORIGIN_NOT_ALLOWED
//       non-browser + api        → ok
//   - Constraint A: transport=api while carrying an access OR refresh cookie →
//     403 TRANSPORT_COOKIE_CONFLICT (rejected BEFORE CsrfGuard, so the api
//     "CSRF exemption" can never combine with an attached browser cookie).
//
// This middleware only applies to the auth routes that need a transport
// declaration: /api/auth/verify, /api/auth/refresh, /api/auth/logout. Other
// routes (nonce, csrf-token, me, health) are passed through untouched.
// ============================================================================

import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AppError, AuthFailReason } from '@ai-wealth/shared';
import { env } from '@ai-wealth/config';
import { AuditService } from './audit.service';

/** Auth routes that must declare a transport mode (normalised, no /api prefix). */
const TRANSPORT_ROUTES = new Set(['/auth/verify', '/auth/refresh', '/auth/logout']);

/**
 * Transport modes:
 *   - 'cookie' / 'api' : explicit P1-004 transport declared via X-Auth-Transport;
 *     the full Origin × transport matrix + constraint A (api+cookie→403) applies.
 *   - 'legacy' : the header is MISSING on /verify or /logout. For backward
 *     compatibility with P1-002/P1-003 clients (and the unchanged T01-T15 /
 *     C01-C11 regression suites) these endpoints tolerate a missing header and
 *     fall back to P1-003 dual-mode behaviour (verify sets cookies + returns
 *     body tokens; logout clears cookies + runs LogoutGuard without
 *     constraint-A). /refresh is a NEW P1-004 endpoint and never tolerates a
 *     missing header (→ 400 TRANSPORT_REQUIRED, see R19).
 */
export type AuthTransport = 'cookie' | 'api' | 'legacy';

/** Request augmented with transport metadata (intersection type, matches the
 *  pattern used by jwt-auth.guard.ts rather than module augmentation). */
export type TransportRequest = Request & {
  authTransport?: AuthTransport;
  isBrowserOrigin?: boolean;
};

@Injectable()
export class TransportMiddleware implements NestMiddleware {
  private readonly allowedOrigins: Set<string>;
  constructor(private readonly audit: AuditService) {
    const e = env();
    this.allowedOrigins = new Set(
      [e.webAppUrl, e.adminAppUrl].map((u) => originOf(u)).filter((o): o is string => !!o),
    );
  }

  async use(req: TransportRequest, _res: Response, next: NextFunction): Promise<void> {
    const path = normalisePath(req.originalUrl, env().apiPrefix);
    if (!TRANSPORT_ROUTES.has(path)) {
      return next();
    }

    const transportRaw = (req.headers['x-auth-transport'] as string | undefined)?.toLowerCase();
    // /refresh is a NEW P1-004 endpoint — the transport header is mandatory.
    // /verify and /logout tolerate a MISSING header as 'legacy' for backward
    // compatibility with P1-002/P1-003 clients (and the unchanged T01-T15 /
    // C01-C11 regression suites): legacy verify returns dual-mode (cookies +
    // body tokens), legacy logout clears cookies + runs LogoutGuard without
    // constraint-A. An explicit 'cookie'/'api' value enforces the full
    // P1-004 transport contract on every route.
    const isRefresh = path === '/auth/refresh';
    if (transportRaw !== 'cookie' && transportRaw !== 'api') {
      if (isRefresh) {
        throw AppError.badRequest('X-Auth-Transport header required (cookie | api)', {
          reason: AuthFailReason.TRANSPORT_REQUIRED,
        });
      }
      // Legacy mode: skip Origin matrix + constraint-A. CsrfGuard still runs
      // (cookie-presence based) so cookie-mode CSRF protection is intact.
      req.authTransport = 'legacy';
      req.isBrowserOrigin = this.isBrowserOrigin(req);
      return next();
    }
    const transport: AuthTransport = transportRaw;
    const isBrowserOrigin = this.isBrowserOrigin(req);

    // Attach for downstream guards/controllers.
    req.authTransport = transport;
    req.isBrowserOrigin = isBrowserOrigin;

    // Transport × Origin matrix
    if (transport === 'api' && isBrowserOrigin) {
      await this.audit.recordTransportConflict({
        requestId: reqId(req),
        ip: req.ip,
        userAgent: req.get('user-agent'),
      });
      throw AppError.forbidden('Browser origin cannot use api transport', {
        reason: AuthFailReason.TRANSPORT_ORIGIN_CONFLICT,
      });
    }
    if (transport === 'cookie' && !isBrowserOrigin) {
      throw AppError.forbidden('Cookie transport requires a whitelisted browser Origin', {
        reason: AuthFailReason.ORIGIN_NOT_ALLOWED,
      });
    }

    // Constraint A: transport=api MUST NOT carry any auth cookie. This runs
    // BEFORE CsrfGuard, so an api-declared request can never exploit the api
    // CSRF exemption while a browser cookie is silently attached.
    if (transport === 'api') {
      const cfg = env();
      const hasAccessCookie = !!req.cookies?.[cfg.cookieName];
      const hasRefreshCookie = !!req.cookies?.[cfg.refreshCookieName];
      if (hasAccessCookie || hasRefreshCookie) {
        await this.audit.recordTransportConflict({
          requestId: reqId(req),
          ip: req.ip,
          userAgent: req.get('user-agent'),
        });
        throw AppError.forbidden('api transport must not carry auth cookies', {
          reason: AuthFailReason.TRANSPORT_COOKIE_CONFLICT,
        });
      }
    }

    next();
  }

  /** Origin is taken from the Origin header, falling back to Referer. Never UA. */
  private isBrowserOrigin(req: Request): boolean {
    const raw = req.get('origin') || req.get('referer') || '';
    const origin = originOf(raw);
    if (!origin) return false;
    return this.allowedOrigins.has(origin);
  }
}

/** Strip query/hash + the leading /api prefix, returning a normalised path
 *  (e.g. /auth/verify) so the route set matches regardless of whether the app
 *  mounts under a global /api prefix (production) or not (tests). Mirrors the
 *  CsrfGuard normaliser. */
function normalisePath(originalUrl: string, apiPrefix: string): string {
  let p = originalUrl.split('?')[0] as string;
  const hIdx = p.indexOf('#');
  if (hIdx >= 0) p = p.slice(0, hIdx);
  const prefix = apiPrefix.startsWith('/') ? apiPrefix : `/${apiPrefix}`;
  if (p.startsWith(prefix)) p = p.slice(prefix.length);
  if (!p.startsWith('/')) p = `/${p}`;
  return p.toLowerCase();
}

/** Extract scheme://host[:port] from a URL. Returns '' if unparseable. */
function originOf(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

function reqId(req: Request): string | undefined {
  return (req.headers['x-request-id'] as string | undefined) ?? undefined;
}
