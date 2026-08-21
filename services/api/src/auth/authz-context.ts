// ============================================================================
// AuthzContext + @AuthzUser() — P1-006 Backend RBAC authorization context.
//
// RolesGuard attaches the resolved authorization context to `req.authz` AFTER
// a successful authorization decision (authenticated + role + status verified
// against the required @Roles metadata). Controllers MUST read it via the
// @AuthzUser() param decorator — they MUST NOT re-query the database for the
// role (getAuthorizationContext already ran once inside RolesGuard) and MUST
// NOT reach into other req properties.
//
// This is a TypeScript SOURCE export only (not a Nest @Module exports entry):
// interfaces and param decorators are compile-time symbols, not injectable
// providers, so they are imported directly from this file by consumers.
// ============================================================================

import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { UserRole } from '@ai-wealth/database';

/**
 * Resolved per-request authorization context. `role` is the live DB value
 * (never the JWT), so privilege changes (USER↔ADMIN) take effect immediately
 * without re-issuing the access token.
 */
export interface AuthzContext {
  userId: string;
  role: UserRole;
  /** Wallet id from the authenticated session, if any (Bearer-only clients may omit). */
  walletId?: string;
}

/**
 * Param decorator that reads the AuthzContext attached by RolesGuard.
 * Returns `undefined` if RolesGuard did not run (e.g. route missing the guard) —
 * controllers should rely on the guard having run, not handle undefined here.
 */
export const AuthzUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthzContext | undefined => {
    const req = ctx.switchToHttp().getRequest();
    return req.authz as AuthzContext | undefined;
  },
);
