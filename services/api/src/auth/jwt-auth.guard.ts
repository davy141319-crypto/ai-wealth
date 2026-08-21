// ============================================================================
// JwtAuthGuard — validates bearer JWT on protected routes.
//
// No Passport strategy required (P1-002 prefers the simpler, traceable
// JwtAuthService). A thin CanActivate guard simply:
//   1) strips token from Authorization: Bearer <jwt>
//   2) calls JwtAuthService.verify()
//   3) attaches { userId, walletId } to request.auth
//
// Controllers read `@AuthUser()` via a decorator defined alongside this file.
// ============================================================================

import { CanActivate, createParamDecorator, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request as ExpressRequest } from 'express';
import { AppError, AuthFailReason } from '@ai-wealth/shared';
import { JwtAuthService } from './jwt-auth.service';

export interface AuthContext {
  userId: string;
  walletId?: string;
  jti: string;
  token: string;
}

type AuthRequest = ExpressRequest & { auth?: AuthContext };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtAuth: JwtAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const header = req.headers?.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw AppError.unauthorized('Unauthorized', { reason: AuthFailReason.NOT_AUTHENTICATED });
    }
    const token = header.slice(7);
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
