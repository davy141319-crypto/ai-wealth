// ============================================================================
// Money-path Audit — AuditSensitiveMutation wrapper.
//
// Responsibilities:
//   - Builds the canonical AuditMetadataEnvelope {before, after, reason,
//     source, correlation} (reuses EXISTING AuditLog.metadata column).
//   - Calls the single AuditService sink. Throws AUDIT_ENVELOPE_INVALID /
//     AUDIT_WRITE_FAILED so the enclosing Phase B transaction rolls back
//     state + ledger when audit cannot be recorded (invariant AI-01 /
//     FS-06).
//   - recordTxBound MUST run inside an existing Prisma transaction so
//     ledger write + audit write commit atomically.
// ============================================================================

import { Injectable } from '@nestjs/common';
import { SERVICE_NAMES } from '@ai-wealth/config';
import { AuditService } from '../../auth/audit.service';
import { AppError, AuditAction, MoneyPathErrorCode, createLogger } from '@ai-wealth/shared';
import { Repositories } from '@ai-wealth/database';
import {
  validateAuditMetadataEnvelope,
  type AuditMetadataEnvelope,
  type ValidAuditMetadataEnvelope,
} from './audit-metadata.types';

const logger = createLogger(SERVICE_NAMES.API);

/**
 * Arguments passed to the sensitive-mutation wrapper.
 */
export interface AuditSensitiveMutationArgs {
  /** AuditLog.action string (e.g. SYSTEM_CONFIG_UPDATED, LEDGER_REVERSAL). */
  action: string;
  /** AuditLog.resource (e.g. flags, ledger, treasury). */
  resource: string;
  actorUserId: string | null | undefined;
  requestId: string | null | undefined;
  ip?: string | null;
  userAgent?: string | null;
  /** The 5-key envelope that will be stored as metadata. */
  envelope: AuditMetadataEnvelope;
  /** Optional success flag (defaults to true). */
  success?: boolean;
}

@Injectable()
export class AuditSensitiveMutationService {
  constructor(private readonly auditService?: AuditService) {}

  /**
   * Write an audit row inside the SAME transaction as the mutation (ledger
   * write / SystemConfig write / role change, etc.). Uses Repositories
   * bound to the transaction client for the raw insert (bypasses
   * AuditService warning-swallowing — sensitive mutations MUST fail the
   * entire tx on audit write failure).
   */
  async recordTxBound(repos: Repositories, args: AuditSensitiveMutationArgs): Promise<void> {
    const valid = validateAuditMetadataEnvelope(args.envelope);
    if (!valid.ok) {
      throw AppError.internal(`Audit metadata envelope invalid: ${valid.issues.join(',')}`, {
        reason: MoneyPathErrorCode.AUDIT_ENVELOPE_INVALID,
      });
    }
    const envelope = valid.value as ValidAuditMetadataEnvelope;
    try {
      await repos.auditLog.create({
        action: String(args.action),
        resource: args.resource,
        actor: args.actorUserId ?? null,
        requestId: args.requestId ?? null,
        ip: args.ip ?? null,
        userAgent: args.userAgent ?? null,
        metadata: envelope as unknown as Parameters<
          Repositories['auditLog']['create']
        >[0]['metadata'],
      });
    } catch (err: unknown) {
      logger.warn('audit_sensitive_write_failed', {
        action: args.action,
        resource: args.resource,
        error: err instanceof Error ? err.message : String(err),
      });
      throw AppError.internal(
        'Audit write failed on sensitive mutation — entire transaction aborted.',
        {
          reason: MoneyPathErrorCode.AUDIT_WRITE_FAILED,
        },
      );
    }
  }

  /**
   * Non-transactional variant used when the audit write must happen OUTSIDE
   * a running Prisma transaction (currently used only when Phase B rolls
   * back and we attempt to mark idempotency FAILED via a separate small
   * tx). In that case failures are only logged — never crash the caller.
   */
  async recordBestEffort(
    reposOrSingleton: Repositories,
    args: AuditSensitiveMutationArgs,
  ): Promise<void> {
    try {
      await this.recordTxBound(reposOrSingleton, args);
    } catch {
      /* swallow, already logged inside recordTxBound */
    }
  }

  /**
   * Thin compatibility shim to AuditService.write() (now public since
   * P1-008) when callers specifically want the legacy fire-and-forget
   * auth-event path. Not used by the money-path sensitive mutation
   * pipeline — recordTxBound is authoritative here. Exposed primarily for
   * test fixtures.
   */
  async legacyAuthWrite(args: Parameters<AuditService['write']>): Promise<void> {
    if (!this.auditService) return;
    return this.auditService.write(args[0], args[1]);
  }
}

// Re-exported for convenience.
export { validateAuditMetadataEnvelope };
export type { AuditMetadataEnvelope };

// Satisfy unused-import warnings for AuditAction: the enum is used via
// stringly typed `action: string` because AuditLog.action is a free-form
// varchar column. Re-exporting here avoids TS warnings in some strict
// configs.
export type { AuditAction };
