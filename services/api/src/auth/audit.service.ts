// ============================================================================
// AuditService — best-effort audit logging for authentication events.
//
// Rules:
//   - Append-only; no update/delete exposed.
//   - Fire-and-forget so DB connectivity issues never block login flow; the
//     write error is logged server-side.
//   - Sensitive data (signatures, the SIWE message body, secrets) is NEVER
//     written. Only reason codes + a short address hash are persisted.
// ============================================================================

import { Injectable } from '@nestjs/common';
import { keccak256, toHex } from 'viem';
import { AuditAction, AuthFailReason, AuthzFailReason, createLogger } from '@ai-wealth/shared';
import { Repositories } from '@ai-wealth/database';
import { SERVICE_NAMES } from '@ai-wealth/config';

@Injectable()
export class AuditService {
  private readonly logger = createLogger(SERVICE_NAMES.API);
  constructor(private readonly repos: Repositories = new Repositories()) {}

  /** 8-char short hash of the address used for audit correlation only. */
  static addressHash(address: string): string {
    try {
      const h = keccak256(toHex(address.toLowerCase()));
      return h.slice(2, 10);
    } catch {
      return '________';
    }
  }

  recordLoginSuccess(params: {
    userId: string;
    walletId: string;
    chain: string;
    address: string;
    requestId?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    const metadata = {
      chain: params.chain,
      walletId: params.walletId,
      addressHash: AuditService.addressHash(params.address),
    };
    return this.write(AuditAction.AUTH_LOGIN_SUCCESS, {
      actor: params.userId,
      requestId: params.requestId,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata,
    });
  }

  recordLoginFailure(params: {
    reason: AuthFailReason | string;
    chain?: string;
    address?: string;
    requestId?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    const metadata: Record<string, unknown> = { reason: params.reason };
    if (params.chain) metadata.chain = params.chain;
    if (params.address) metadata.addressHash = AuditService.addressHash(params.address);
    return this.write(AuditAction.AUTH_LOGIN_FAILURE, {
      actor: null,
      requestId: params.requestId,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata,
    });
  }

  recordLogout(params: {
    userId: string;
    requestId?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    return this.write(AuditAction.AUTH_LOGOUT, {
      actor: params.userId,
      requestId: params.requestId,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata: { via: 'POST /api/auth/logout' },
    });
  }

  recordCsrfFailure(params: {
    requestId?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    return this.write(AuditAction.AUTH_CSRF_FAILURE, {
      actor: null,
      requestId: params.requestId,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata: { reason: AuthFailReason.CSRF_TOKEN_INVALID },
      // A CSRF rejection is a security FAILURE event — record success=false so
      // audit consumers can filter failed security events. (The AuditService
      // `write` default only treats AUTH_LOGIN_FAILURE as failure; pass it
      // explicitly here because AUTH_CSRF_FAILURE is also a failure action.)
      success: false,
    });
  }

  // --------------------------------------------------------------------------
  // P1-004 — refresh-token rotation audit methods (ADDITIVE only).
  // Per the P1-003 narrow exemption carried into P1-004, existing AuditService
  // methods and the `write()` default semantics are NOT modified. These new
  // methods reuse `write()` verbatim; reuse / failure events pass `success:false`
  // explicitly so audit consumers can filter failed security events.
  // --------------------------------------------------------------------------

  recordRefreshSuccess(params: {
    userId: string;
    familyId: string;
    requestId?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    return this.write(AuditAction.AUTH_REFRESH_SUCCESS, {
      actor: params.userId,
      requestId: params.requestId,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata: { familyId: params.familyId, rotatedAt: Date.now() },
    });
  }

  recordRefreshFailure(params: {
    reason: AuthFailReason | string;
    userId?: string | null;
    requestId?: string;
    ip?: string;
    userAgent?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const metadata: Record<string, unknown> = { reason: params.reason };
    if (params.metadata) Object.assign(metadata, params.metadata);
    return this.write(AuditAction.AUTH_REFRESH_FAILURE, {
      actor: params.userId ?? null,
      requestId: params.requestId,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata,
      success: false,
    });
  }

  /** Reuse detected → entire family revoked. Always success=false. */
  recordRefreshReuse(params: {
    userId?: string | null;
    familyId: string;
    tokenHashPrefix: string;
    requestId?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    return this.write(AuditAction.AUTH_REFRESH_REUSE, {
      actor: params.userId ?? null,
      requestId: params.requestId,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata: {
        familyId: params.familyId,
        tokenHashPrefix: params.tokenHashPrefix,
        reason: AuthFailReason.REFRESH_TOKEN_REUSED,
      },
      success: false,
    });
  }

  recordSessionRevoked(params: {
    userId: string;
    familyId?: string;
    requestId?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    return this.write(AuditAction.AUTH_SESSION_REVOKED, {
      actor: params.userId,
      requestId: params.requestId,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata: { familyId: params.familyId ?? null, via: 'logout' },
    });
  }

  /** Cookie + body both present in cookie mode — body ignored, cookie used. */
  recordRefreshBodyIgnored(params: {
    userId?: string | null;
    requestId?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    return this.write(AuditAction.AUTH_REFRESH_BODY_IGNORED, {
      actor: params.userId ?? null,
      requestId: params.requestId,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata: { reason: 'cookie_over_body' },
    });
  }

  /** transport=api while carrying an auth cookie — blocked before CSRF. */
  recordTransportConflict(params: {
    requestId?: string;
    ip?: string;
    userAgent?: string;
  }): Promise<void> {
    return this.write(AuditAction.AUTH_TRANSPORT_CONFLICT, {
      actor: null,
      requestId: params.requestId,
      ip: params.ip,
      userAgent: params.userAgent,
      metadata: { reason: AuthFailReason.TRANSPORT_COOKIE_CONFLICT },
      success: false,
    });
  }

  // --------------------------------------------------------------------------
  // P1-006 — Backend RBAC decision audit (ADDITIVE only).
  // Existing methods and write() default semantics are NOT modified. The
  // write() `resource` field defaults to 'auth' so all pre-existing auth
  // audit rows keep resource='auth' (zero behavior change); RBAC decisions
  // pass an explicit resource (e.g. 'admin/me').
  // --------------------------------------------------------------------------

  /**
   * Record a per-request RBAC decision. `reason` (AuthzFailReason) is the only
   * metadata — resource is a top-level AuditLog column, NOT duplicated into
   * metadata. Sensitive values (token/cookie/wallet) are never written.
   * As with all audit writes, failure is non-blocking: RolesGuard wraps calls
   * in `.catch(() => {})` so an audit DB outage cannot change the authz result.
   */
  recordAuthzDecision(params: {
    userId?: string | null;
    decision: 'ALLOWED' | 'DENIED';
    reason?: AuthzFailReason | string;
    resource: string;
    requestId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    const action =
      params.decision === 'ALLOWED'
        ? AuditAction.AUTHZ_DECISION_ALLOWED
        : AuditAction.AUTHZ_DECISION_DENIED;
    return this.write(action, {
      actor: params.userId ?? null,
      resource: params.resource,
      requestId: params.requestId ?? null,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      // Minimal metadata: ONLY the reasonCode. No resource duplication, no
      // token/cookie/wallet/private data.
      metadata: { reasonCode: params.reason ?? null },
      // DENIED is a security failure event; ALLOWED is informational.
      success: params.decision === 'ALLOWED',
    });
  }

  /**
   * Append an audit row and await it. Authentication / audit events are
   * always-on by policy so we treat write failure as a logged warning but
   * never throw (login flow must not be impacted).
   *
   * P1-006: `resource` is now an optional param (default 'auth') so RBAC
   * decisions can record their true resource (e.g. 'admin/me') while every
   * pre-existing auth audit call keeps resource='auth' unchanged.
   *
   * P1-008: visibility elevated from private → public so the money-path
   * AuditSensitiveMutation wrapper (in services/api) can directly reuse
   * the same single AuditService sink for audit writes instead of
   * introducing a second write path. No behaviour change.
   */
  async write(
    action: AuditAction,
    params: {
      actor?: string | null;
      requestId?: string | null;
      ip?: string | null;
      userAgent?: string | null;
      metadata?: unknown;
      success?: boolean;
      resource?: string;
    },
  ): Promise<void> {
    const input = {
      action,
      resource: params.resource ?? 'auth',
      actor: params.actor ?? null,
      requestId: params.requestId ?? null,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      metadata: (params.metadata ?? null) as never,
      success: params.success ?? action !== AuditAction.AUTH_LOGIN_FAILURE,
    };
    try {
      await this.repos.auditLog.create(input);
    } catch (err: unknown) {
      this.logger.warn('audit_write_failed', {
        action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
