// ============================================================================
// LogoutGuard — P1-004 logout credential resolver.
//
// Constraint B (spec v5+): the guard MUST NOT throw 401 when both credentials
// are invalid. Instead it attaches a `logoutCredentials` summary to the request
// and returns true, so the controller can ALWAYS clear the three cookies (in
// cookie mode) and THEN decide whether to 200 (at least one valid credential)
// or 401 (both invalid). Throwing here would skip cookie-clearing in the
// controller, leaving the user stuck with dead cookies they cannot remove.
//
// Credential sources (transport-aware, decided by TransportMiddleware upstream):
//   - access: `Authorization: Bearer …` header OR access cookie
//   - refresh: body `{refreshToken}` (api) OR refresh cookie (cookie mode)
//
// Validation is best-effort: an invalid/expired credential yields `valid:false`
// rather than throwing. The JwtAuthGuard and RefreshTokenService verify logic
// are reused read-only; no JwtAuthService internals are touched.
// ============================================================================

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { AuthFailReason } from '@ai-wealth/shared';
import { env } from '@ai-wealth/config';
import { JwtAuthService, JwtAuthError } from './jwt-auth.service';
import { RefreshTokenService } from './refresh-token.service';
import { CookieAuthService } from './cookie-auth.service';

/** Credential validation summary attached to the request for the controller. */
export interface LogoutCredentials {
  access: { valid: boolean; token?: string; userId?: string; jti?: string; reason?: string } | null;
  refresh: { valid: boolean; familyId?: string; userId?: string; reason?: string } | null;
}

/** Request augmented with logout credential summary (intersection type). */
export type LogoutRequest = ExpressRequest & {
  logoutCredentials?: LogoutCredentials;
};

@Injectable()
export class LogoutGuard implements CanActivate {
  private readonly cfg = env();
  constructor(
    private readonly jwtAuth: JwtAuthService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly cookieAuth: CookieAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<LogoutRequest>();
    const creds = await this.resolve(req);
    // Constraint B: NEVER throw here. Attach + return true so the controller
    // always runs (to clear cookies first, then decide the response code).
    req.logoutCredentials = creds;
    return true;
  }

  private async resolve(req: ExpressRequest): Promise<LogoutCredentials> {
    // Access: Bearer header OR access cookie.
    const access = await this.resolveAccess(req);
    // Refresh: body (api) OR refresh cookie (cookie mode).
    const refresh = await this.resolveRefresh(req);
    return { access, refresh };
  }

  private async resolveAccess(req: ExpressRequest) {
    const header = req.headers['authorization'];
    let token: string | undefined;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      token = header.slice(7);
    } else {
      const cookieToken = (req.cookies ?? {})[this.cfg.cookieName] as string | undefined;
      token = cookieToken;
    }
    if (!token) return null; // no access credential presented at all
    try {
      const payload = await this.jwtAuth.verify(token);
      return { valid: true, token, userId: payload.sub, jti: payload.jti };
    } catch (err) {
      const reason = err instanceof JwtAuthError ? err.reason : AuthFailReason.TOKEN_INVALID;
      return { valid: false, reason };
    }
  }

  private async resolveRefresh(req: ExpressRequest) {
    const bodyToken = (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    const cookieToken = this.cookieAuth.readRefreshCookie(req);
    const token = bodyToken ?? cookieToken;
    if (!token) return null; // no refresh credential presented at all
    const familyId = await this.refreshTokens.verifyRefreshToken(token);
    if (!familyId) {
      return { valid: false, reason: AuthFailReason.REFRESH_TOKEN_INVALID };
    }
    const fam = await this.refreshTokens.getFamilyMeta(familyId);
    if (!fam || fam.status === 'REVOKED') {
      return { valid: false, reason: AuthFailReason.REFRESH_TOKEN_REVOKED, familyId };
    }
    return { valid: true, familyId, userId: fam.userId };
  }
}
