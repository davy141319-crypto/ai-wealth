// ============================================================================
// P1-006 — RolesGuard unit tests.
//
// Pure unit tests (no Nest app, no DB): Repositories / Reflector / AuditService
// are jest mocks. Covers the full authorization decision matrix:
//   - no auth context → 403 AUTHZ_NO_AUTH_CONTEXT
//   - @Roles metadata missing / empty → 403 AUTHZ_ROLE_METADATA_MISSING (default-deny)
//   - DB lookup throws → 500 AUTHZ_ROLE_LOOKUP_FAILED (NOT 403) + audit DENIED
//   - user not found (null) → 403 AUTHZ_USER_NOT_FOUND
//   - inactive → 403 AUTHZ_USER_INACTIVE
//   - role insufficient → 403 AUTHZ_ROLE_INSUFFICIENT
//   - ADMIN allowed → true + req.authz attached (typed AuthzContext) + audit ALLOWED
//   - forged role inputs (header/body) ignored — only DB role decides
//   - method @Roles overrides class @Roles; both empty → 403
//   - getAuthorizationContext called exactly ONCE per request
//   - audit write failure is non-blocking (guard still throws / allows)
//   - 403 reasons are NOT leaked to the thrown AppError.code (stays FORBIDDEN);
//     reason lives only on the error (server-side / audit), matching the filter
// ============================================================================

import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError, AppErrorCode, AuthzFailReason } from '@ai-wealth/shared';
import { Repositories, UserStatus, type UserRole } from '@ai-wealth/database';
import { RolesGuard } from './roles.guard';
import { AuditService } from './audit.service';
import { ROLES_KEY } from './roles.decorator';

// ---------------------------------------------------------------------------
// Minimal fake builder. A real ExecutionContext exposes getHandler/getClass
// for Reflector.getAllAndOverride; we stub Reflector directly instead so the
// test does not depend on real metadata reflection mechanics.
// ---------------------------------------------------------------------------

type AuthzReq = {
  auth?: { userId: string; walletId?: string; jti: string; token: string };
  authz?: unknown;
  id?: string;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

function makeCtx(req: AuthzReq, handler = 'getMe', classRef = 'AdminController'): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}) as never }),
    getHandler: () => handler as never,
    getClass: () => classRef as never,
    getType: () => 'http',
    getArgs: () => [],
    getArgByIndex: () => undefined as never,
    switchToRpc: () => ({}) as never,
    switchToWs: () => ({}) as never,
  } as unknown as ExecutionContext;
}

function makeGuard(opts: {
  required?: UserRole[] | undefined;
  role?: UserRole | null;
  status?: UserStatus;
  lookupThrows?: boolean;
  auditThrows?: boolean;
}): {
  guard: RolesGuard;
  repos: jest.Mocked<Repositories>;
  audit: jest.Mocked<Pick<AuditService, 'recordAuthzDecision'>>;
} {
  const userRepo = {
    getAuthorizationContext: jest.fn(async () => {
      if (opts.lookupThrows) throw new Error('prisma connection refused');
      if (opts.role === null) return null;
      return { role: opts.role ?? ('ADMIN' as UserRole), status: opts.status ?? UserStatus.ACTIVE };
    }),
  };
  const repos = { user: userRepo } as unknown as jest.Mocked<Repositories>;

  const audit = {
    recordAuthzDecision: opts.auditThrows
      ? jest.fn().mockRejectedValue(new Error('audit db down'))
      : jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<Pick<AuditService, 'recordAuthzDecision'>>;

  const reflector = { getAllAndOverride: jest.fn(() => opts.required) } as unknown as Reflector;
  const guard = new RolesGuard(repos, reflector, audit as unknown as AuditService);
  return { guard, repos, audit };
}

const ADMIN_ID = '00000000-0000-0000-0000-000000000001';

function authedReq(): AuthzReq {
  return {
    auth: { userId: ADMIN_ID, jti: 'jti-1', token: 'tok' },
    id: 'req-1',
    ip: '127.0.0.1',
    headers: { 'user-agent': 'jest' },
  };
}

describe('P1-006 RolesGuard', () => {
  // ---------- (1) no auth context ----------
  it('throws 403 AUTHZ_NO_AUTH_CONTEXT when req.auth is missing (never 401)', async () => {
    const { guard } = makeGuard({ required: ['ADMIN' as UserRole] });
    const req: AuthzReq = {};
    let caught: unknown;
    try {
      await guard.canActivate(makeCtx(req));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(403);
    expect((caught as AppError).code).toBe(AppErrorCode.FORBIDDEN);
    expect((caught as AppError).reason).toBe(AuthzFailReason.AUTHZ_NO_AUTH_CONTEXT);
  });

  // ---------- (8) metadata missing ----------
  it('throws 403 AUTHZ_ROLE_METADATA_MISSING when @Roles metadata is missing (default-deny)', async () => {
    const { guard, audit } = makeGuard({ required: undefined, role: 'ADMIN' as UserRole });
    const req = authedReq();
    let caught: unknown;
    try {
      await guard.canActivate(makeCtx(req));
    } catch (e) {
      caught = e;
    }
    expect((caught as AppError).statusCode).toBe(403);
    expect((caught as AppError).reason).toBe(AuthzFailReason.AUTHZ_ROLE_METADATA_MISSING);
    expect(audit.recordAuthzDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'DENIED',
        reason: AuthzFailReason.AUTHZ_ROLE_METADATA_MISSING,
        resource: 'admin/me',
      }),
    );
  });

  // ---------- (8) empty @Roles() array ----------
  it('throws 403 AUTHZ_ROLE_METADATA_MISSING when @Roles() is an empty array', async () => {
    const { guard } = makeGuard({ required: [], role: 'ADMIN' as UserRole });
    let caught: unknown;
    try {
      await guard.canActivate(makeCtx(authedReq()));
    } catch (e) {
      caught = e;
    }
    expect((caught as AppError).reason).toBe(AuthzFailReason.AUTHZ_ROLE_METADATA_MISSING);
  });

  // ---------- (9) DB lookup error → 500, not 403 ----------
  it('throws 500 AUTHZ_ROLE_LOOKUP_FAILED when getAuthorizationContext throws (not 403)', async () => {
    const { guard, audit, repos } = makeGuard({
      required: ['ADMIN' as UserRole],
      lookupThrows: true,
    });
    let caught: unknown;
    try {
      await guard.canActivate(makeCtx(authedReq()));
    } catch (e) {
      caught = e;
    }
    expect(repos.user.getAuthorizationContext).toHaveBeenCalledTimes(1);
    expect((caught as AppError).statusCode).toBe(500);
    expect((caught as AppError).code).toBe(AppErrorCode.INTERNAL_ERROR);
    expect((caught as AppError).reason).toBe(AuthzFailReason.AUTHZ_ROLE_LOOKUP_FAILED);
    expect(audit.recordAuthzDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'DENIED',
        reason: AuthzFailReason.AUTHZ_ROLE_LOOKUP_FAILED,
        resource: 'admin/me',
      }),
    );
  });

  // ---------- user not found ----------
  it('throws 403 AUTHZ_USER_NOT_FOUND when user does not exist (null)', async () => {
    const { guard } = makeGuard({ required: ['ADMIN' as UserRole], role: null });
    let caught: unknown;
    try {
      await guard.canActivate(makeCtx(authedReq()));
    } catch (e) {
      caught = e;
    }
    expect((caught as AppError).reason).toBe(AuthzFailReason.AUTHZ_USER_NOT_FOUND);
  });

  // ---------- (7) inactive ----------
  it('throws 403 AUTHZ_USER_INACTIVE when status !== ACTIVE', async () => {
    const { guard } = makeGuard({
      required: ['ADMIN' as UserRole],
      role: 'ADMIN' as UserRole,
      status: UserStatus.SUSPENDED,
    });
    let caught: unknown;
    try {
      await guard.canActivate(makeCtx(authedReq()));
    } catch (e) {
      caught = e;
    }
    expect((caught as AppError).reason).toBe(AuthzFailReason.AUTHZ_USER_INACTIVE);
  });

  // ---------- (2) role insufficient ----------
  it('throws 403 AUTHZ_ROLE_INSUFFICIENT when USER accesses @Roles(ADMIN)', async () => {
    const { guard, audit } = makeGuard({
      required: ['ADMIN' as UserRole],
      role: 'USER' as UserRole,
    });
    const req = authedReq();
    // (4) forged inputs must be ignored — only DB role decides
    req.headers = { 'x-role': 'ADMIN', 'user-agent': 'jest' };
    (req as unknown as Record<string, unknown>).body = { role: 'ADMIN' };
    let caught: unknown;
    try {
      await guard.canActivate(makeCtx(req));
    } catch (e) {
      caught = e;
    }
    expect((caught as AppError).reason).toBe(AuthzFailReason.AUTHZ_ROLE_INSUFFICIENT);
    expect(audit.recordAuthzDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'DENIED',
        reason: AuthzFailReason.AUTHZ_ROLE_INSUFFICIENT,
        resource: 'admin/me',
      }),
    );
  });

  // ---------- (3) ADMIN allowed ----------
  it('returns true and attaches typed req.authz + audits ALLOWED for ADMIN', async () => {
    const { guard, audit, repos } = makeGuard({
      required: ['ADMIN' as UserRole],
      role: 'ADMIN' as UserRole,
    });
    const req = authedReq();
    req.auth!.walletId = '00000000-0000-0000-0000-00000000000w';
    // (4) forged header must NOT change the decision (already ADMIN, but proves
    // the guard never reads client role fields)
    req.headers = { 'x-role': 'USER', 'user-agent': 'jest' };
    const ok = await guard.canActivate(makeCtx(req));
    expect(ok).toBe(true);
    expect(repos.user.getAuthorizationContext).toHaveBeenCalledTimes(1);
    expect(req.authz).toEqual({
      userId: ADMIN_ID,
      role: 'ADMIN',
      walletId: '00000000-0000-0000-0000-00000000000w',
    });
    expect(audit.recordAuthzDecision).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'ALLOWED', resource: 'admin/me' }),
    );
  });

  // ---------- (10) single DB query per request ----------
  it('calls getAuthorizationContext exactly once per request', async () => {
    const { guard, repos } = makeGuard({
      required: ['ADMIN' as UserRole],
      role: 'ADMIN' as UserRole,
    });
    await guard.canActivate(makeCtx(authedReq()));
    expect(repos.user.getAuthorizationContext).toHaveBeenCalledTimes(1);
  });

  // ---------- (16) audit failure non-blocking (DENIED path) ----------
  it('still throws 403 when AuditService rejects (non-blocking audit) — DENIED path', async () => {
    const { guard } = makeGuard({
      required: ['ADMIN' as UserRole],
      role: 'USER' as UserRole,
      auditThrows: true,
    });
    let caught: unknown;
    try {
      await guard.canActivate(makeCtx(authedReq()));
    } catch (e) {
      caught = e;
    }
    expect((caught as AppError).reason).toBe(AuthzFailReason.AUTHZ_ROLE_INSUFFICIENT);
  });

  // ---------- (16) audit failure non-blocking (500 path) ----------
  it('still throws 500 when AuditService rejects (non-blocking audit) — lookup failure path', async () => {
    const { guard } = makeGuard({
      required: ['ADMIN' as UserRole],
      lookupThrows: true,
      auditThrows: true,
    });
    let caught: unknown;
    try {
      await guard.canActivate(makeCtx(authedReq()));
    } catch (e) {
      caught = e;
    }
    expect((caught as AppError).statusCode).toBe(500);
    expect((caught as AppError).reason).toBe(AuthzFailReason.AUTHZ_ROLE_LOOKUP_FAILED);
  });

  // ---------- (16) audit failure non-blocking (ALLOWED path) ----------
  it('still returns true when AuditService rejects (non-blocking audit) — ALLOWED path', async () => {
    const { guard } = makeGuard({
      required: ['ADMIN' as UserRole],
      role: 'ADMIN' as UserRole,
      auditThrows: true,
    });
    const ok = await guard.canActivate(makeCtx(authedReq()));
    expect(ok).toBe(true);
  });

  // ---------- (15) reasonCode correctness: ALLOWED audit has no reason ----------
  it('ALLOWED audit call omits reason; DENIED audits carry the AuthzFailReason', async () => {
    const { guard, audit } = makeGuard({
      required: ['ADMIN' as UserRole],
      role: 'ADMIN' as UserRole,
    });
    await guard.canActivate(makeCtx(authedReq()));
    const allowedCall = audit.recordAuthzDecision.mock.calls[0][0];
    expect(allowedCall.decision).toBe('ALLOWED');
    expect(allowedCall.reason).toBeUndefined();
  });

  // ---------- resource is always admin/me ----------
  it('every audit call records resource = admin/me', async () => {
    const { guard, audit } = makeGuard({
      required: ['ADMIN' as UserRole],
      role: 'USER' as UserRole,
    });
    try {
      await guard.canActivate(makeCtx(authedReq()));
    } catch {
      /* expected */
    }
    expect(audit.recordAuthzDecision.mock.calls[0][0].resource).toBe('admin/me');
  });

  // ---------- (R) method overrides class: covered by reflector stub returning required ----------
  it('uses reflector.getAllAndOverride with [handler, class] (method overrides class)', async () => {
    const reflector = {
      getAllAndOverride: jest.fn(() => ['ADMIN' as UserRole]),
    } as unknown as Reflector;
    const userRepo = {
      getAuthorizationContext: jest.fn(async () => ({
        role: 'ADMIN' as UserRole,
        status: UserStatus.ACTIVE,
      })),
    };
    const repos = { user: userRepo } as unknown as Repositories;
    const audit = {
      recordAuthzDecision: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
    const guard = new RolesGuard(repos, reflector, audit);
    const ctx = makeCtx(authedReq());
    await guard.canActivate(ctx);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
  });

  // ---------- (5) USER→ADMIN live: old JWT still valid, DB role ADMIN → allowed ----------
  // (role source is DB, not JWT — modeled by returning ADMIN from the lookup)
  it('allows when DB role is ADMIN even if JWT carried no role claim (live DB authorization)', async () => {
    // JWT (req.auth) never carries role; only DB role (getAuthorizationContext) decides.
    const { guard } = makeGuard({ required: ['ADMIN' as UserRole], role: 'ADMIN' as UserRole });
    const ok = await guard.canActivate(makeCtx(authedReq()));
    expect(ok).toBe(true);
  });

  // ---------- (6) ADMIN→USER live: DB role USER → denied even with valid JWT ----------
  it('denies when DB role is USER even though JWT is still valid (stale-role protection)', async () => {
    const { guard } = makeGuard({ required: ['ADMIN' as UserRole], role: 'USER' as UserRole });
    let caught: unknown;
    try {
      await guard.canActivate(makeCtx(authedReq()));
    } catch (e) {
      caught = e;
    }
    expect((caught as AppError).reason).toBe(AuthzFailReason.AUTHZ_ROLE_INSUFFICIENT);
  });
});
