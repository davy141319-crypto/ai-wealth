// ============================================================================
// RolesGuard — P1-006 Backend RBAC authorization guard.
//
// Runs AFTER JwtAuthGuard (declared left-to-right in @UseGuards). Reads the
// authenticated userId from req.auth, fetches the LIVE role+status from the DB
// in a SINGLE query (getAuthorizationContext), and enforces the @Roles(...)
// requirement set on the handler/class via Reflector.getAllAndOverride
// (method-level overrides class-level).
//
// default-deny: a route with NO @Roles metadata (or an empty @Roles() array)
// is REJECTED with 403 AUTHZ_ROLE_METADATA_MISSING — admin routes MUST declare
// their roles explicitly. We never return true as a fallback.
//
// fail-closed ≠ 403. The DB lookup failure path throws 5xx
// (AppError.internal, reason AUTHZ_ROLE_LOOKUP_FAILED) — an infrastructure
// fault is NOT disguised as a permission denial. All other denial paths
// (no auth context, user missing, inactive, role insufficient, metadata
// missing) are 403. RolesGuard never emits 401 — that is JwtAuthGuard's job.
//
// role is read live from the DB on EVERY request (never from the JWT), so
// privilege changes (USER↔ADMIN) take effect immediately, even with an old
// still-valid access token. No role caching (caching reintroduces stale-priv
// risk and violates default-deny).
//
// Client-supplied role fields (X-Role header, body.role, ?role=) are NEVER read
// — the only source of truth is users.role in the DB.
// ============================================================================

import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request as ExpressRequest } from 'express';
import { AppError, AuthzFailReason } from '@ai-wealth/shared';
import { Repositories } from '@ai-wealth/database';
import { UserStatus, type UserRole } from '@ai-wealth/database';
import { AuditService } from './audit.service';
import { AuthzContext } from './authz-context';
import { ROLES_KEY } from './roles.decorator';
import type { AuthContext } from './jwt-auth.guard';

type AuthzRequest = ExpressRequest & {
  auth?: AuthContext;
  authz?: AuthzContext;
  id?: string;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

/** The admin endpoint resource string recorded in RBAC audit rows. */
const RBAC_AUDIT_RESOURCE = 'admin/me';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly repos: Repositories,
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthzRequest>();
    const auth = req.auth;

    // (1) No authenticated context → fail closed. JwtAuthGuard should already
    // have thrown 401; if we reach here without auth, treat as denial (never
    // 401 — that is the authentication guard's responsibility).
    if (!auth?.userId) {
      throw AppError.forbidden('Forbidden', { reason: AuthzFailReason.AUTHZ_NO_AUTH_CONTEXT });
    }

    const userId = auth.userId;
    const auditCtx = {
      userId,
      requestId: req.id ?? null,
      ip: req.ip ?? null,
      userAgent: req.headers?.['user-agent'] ?? null,
    };

    // (2) Read @Roles metadata. method-level wins over class-level via
    // getAllAndOverride. Missing OR empty array → 403 (default-deny: never
    // return true without an explicit role requirement).
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required || required.length === 0) {
      // Metadata-missing denials are audited; audit write is non-blocking.
      await this.audit
        .recordAuthzDecision({
          ...auditCtx,
          decision: 'DENIED',
          reason: AuthzFailReason.AUTHZ_ROLE_METADATA_MISSING,
          resource: RBAC_AUDIT_RESOURCE,
        })
        .catch(() => {});
      throw AppError.forbidden('Forbidden', {
        reason: AuthzFailReason.AUTHZ_ROLE_METADATA_MISSING,
      });
    }

    // (3) Live authorization context from DB in a SINGLE query (role+status).
    // A DB error is an infrastructure failure → 5xx, NOT 403. The audit write
    // is non-blocking so an audit outage cannot mask the lookup failure.
    let authz: { role: UserRole; status: UserStatus } | null;
    try {
      authz = await this.repos.user.getAuthorizationContext(userId);
    } catch {
      await this.audit
        .recordAuthzDecision({
          ...auditCtx,
          decision: 'DENIED',
          reason: AuthzFailReason.AUTHZ_ROLE_LOOKUP_FAILED,
          resource: RBAC_AUDIT_RESOURCE,
        })
        .catch(() => {});
      throw AppError.internal('Internal Server Error', {
        reason: AuthzFailReason.AUTHZ_ROLE_LOOKUP_FAILED,
      });
    }

    // (4) User does not exist (deleted between authn and authz) → 403.
    if (authz === null) {
      await this.audit
        .recordAuthzDecision({
          ...auditCtx,
          decision: 'DENIED',
          reason: AuthzFailReason.AUTHZ_USER_NOT_FOUND,
          resource: RBAC_AUDIT_RESOURCE,
        })
        .catch(() => {});
      throw AppError.forbidden('Forbidden', { reason: AuthzFailReason.AUTHZ_USER_NOT_FOUND });
    }

    // (5) Inactive user (SUSPENDED/BANNED/CLOSED) → 403.
    if (authz.status !== UserStatus.ACTIVE) {
      await this.audit
        .recordAuthzDecision({
          ...auditCtx,
          decision: 'DENIED',
          reason: AuthzFailReason.AUTHZ_USER_INACTIVE,
          resource: RBAC_AUDIT_RESOURCE,
        })
        .catch(() => {});
      throw AppError.forbidden('Forbidden', { reason: AuthzFailReason.AUTHZ_USER_INACTIVE });
    }

    // (6) Role insufficient → 403.
    if (!required.includes(authz.role)) {
      await this.audit
        .recordAuthzDecision({
          ...auditCtx,
          decision: 'DENIED',
          reason: AuthzFailReason.AUTHZ_ROLE_INSUFFICIENT,
          resource: RBAC_AUDIT_RESOURCE,
        })
        .catch(() => {});
      throw AppError.forbidden('Forbidden', { reason: AuthzFailReason.AUTHZ_ROLE_INSUFFICIENT });
    }

    // (7) Authorized. Attach the resolved context so controllers read it via
    // @AuthzUser() without a second DB query.
    req.authz = {
      userId,
      role: authz.role,
      walletId: auth.walletId,
    };
    await this.audit
      .recordAuthzDecision({
        ...auditCtx,
        decision: 'ALLOWED',
        resource: RBAC_AUDIT_RESOURCE,
      })
      .catch(() => {});
    return true;
  }
}
