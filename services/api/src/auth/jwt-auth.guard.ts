// ============================================================================
// JwtAuthGuard — validates JWT on protected routes from Bearer header OR
// HttpOnly cookie (P1-003 dual-mode, Bearer takes priority).
//
// No Passport strategy required (P1-002 prefers the simpler, traceable
// JwtAuthService). A thin CanActivate guard:
//   1) strips token from Authorization: Bearer <jwt>  (Bearer, takes priority)
//   2) else reads it from the access-token cookie       (Cookie fallback)
//   3) calls JwtAuthService.verify()
//   4) attaches { userId, walletId, jti, token } to request.auth
//
// When both Bearer and Cookie are present, Bearer wins (the Cookie token is
// left untouched — not revoked — to avoid invalidating a still-valid session
// from a mixed-source request). A debug log records the choice; the raw token
// value is NEVER logged.
//
// Controllers read `@AuthUser()` via a decorator defined alongside this file.
// ============================================================================

import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { env, SERVICE_NAMES } from '@ai-wealth/config';
import { AppError, AuthFailReason, createLogger } from '@ai-wealth/shared';
import { JwtAuthService } from './jwt-auth.service';

export interface AuthContext {
  userId: string;
  walletId?: string;
  jti: string;
  token: string;
}

type AuthRequest = ExpressRequest & {
  auth?: AuthContext;
  cookies?: Record<string, string | undefined>;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly cfg = env();
  private readonly logger = createLogger(SERVICE_NAMES.API);

  constructor(private readonly jwtAuth: JwtAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const header = req.headers?.authorization;

    let token: string | undefined;
    let source: 'bearer' | 'cookie' = 'bearer';

    if (header && header.startsWith('Bearer ')) {
      token = header.slice(7);
      source = 'bearer';
    } else {
      const cookieToken = req.cookies?.[this.cfg.cookieName];
      if (cookieToken) {
        token = cookieToken;
        source = 'cookie';
      }
    }

    if (!token) {
      throw AppError.unauthorized('Unauthorized', { reason: AuthFailReason.NOT_AUTHENTICATED });
    }

    // If both sources were present, Bearer already won above. Log the choice
    // at debug level for operational tracing; the token itself is never logged.
    if (header && header.startsWith('Bearer ') && req.cookies?.[this.cfg.cookieName]) {
      this.logger.debug('auth_dual_source_using_bearer', { source });
    } else {
      this.logger.debug('auth_token_source', { source });
    }

    let payload: Awaited<ReturnType<JwtAuthService['verify']>>;
    try {
      payload = await this.jwtAuth.verify(token);
    } catch (err) {
      let reason = AuthFailReason.TOKEN_INVALID;
      if (err && typeof err === 'object' && 'reason' in err) {
        const maybe = (err as { reason?: unknown }).reason;
        if (typeof maybe === 'string' && Object.values<string>(AuthFailReason).includes(maybe)) {
          reason = maybe as AuthFailReason;
        }
      }
      throw AppError.unauthorized('Unauthorized', { reason });
    }
    req.auth = {
      userId: payload.sub,
      walletId: payload.walletId,
      jti: payload.jti,
      token,
    };
    return true;
  }
}

export const AuthUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthContext | undefined => {
    const req = ctx.switchToHttp().getRequest<AuthRequest>();
    return req.auth;
  },
);
