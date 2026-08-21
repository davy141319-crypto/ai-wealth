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
import { AuditAction, AuthFailReason, createLogger } from '@ai-wealth/shared';
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

  /**
   * Append an audit row and await it. Authentication / audit events are
   * always-on by policy so we treat write failure as a logged warning but
   * never throw (login flow must not be impacted).
   */
  private async write(
    action: AuditAction,
    params: {
      actor?: string | null;
      requestId?: string | null;
      ip?: string | null;
      userAgent?: string | null;
      metadata?: unknown;
      success?: boolean;
    },
  ): Promise<void> {
    const input = {
      action,
      resource: 'auth',
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
