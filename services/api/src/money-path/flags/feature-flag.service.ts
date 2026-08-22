// ============================================================================
// Money-path Feature-Flag governance (P1-008).
//
// Design principles:
//   * Reuses the existing `SystemConfig` table. NEVER introduces a new
//     FeatureFlag table.
//   * Keys follow: money.flags.<scope>.<feature>.
//   * Default OFF: missing key → OFF; isActive=false → OFF; parse-error
//     → OFF (fail closed).
//   * Infrastructure failures → OFF (isEnabledSafe).
//   * Mutations (setFlag) require ADMIN role TWICE:
//       (1) HTTP layer via @Roles(ADMIN)/JWT guard.
//       (2) INSIDE the service before writing: live re-read the user
//           role from the DB.
//   * Mutations write Audit (SYSTEM_CONFIG_UPDATED) + never write Ledger.
//   * For mainnet flags (<scope> = mainnet.<x>), setFlag requires a
//     matching testnet.<scope>.<feature>=true testnet gate, otherwise
//     TESTNET_GATE_MISSING and the update is rolled back.
//   * Phase A (quick gate) + Phase B (Serializable re-check) are both
//     required — orchestrator calls isEnabled/ isEnabled in B1 to prevent
//     TOCTOU.
// ============================================================================

import { Injectable } from '@nestjs/common';
import { AppError, AuthzFailReason, MoneyPathErrorCode } from '@ai-wealth/shared';
import { Repositories, UserRole } from '@ai-wealth/database';
import type { SystemConfigValueType } from '@ai-wealth/database';
import {
  AuditSensitiveMutationService,
  type AuditSensitiveMutationArgs,
} from '../audit/audit-sensitive-mutation.service';

const FLAG_KEY_PREFIX = 'money.flags.';
const MAINNET_SCOPE_PREFIX = `${FLAG_KEY_PREFIX}mainnet.`;
const TESTNET_SCOPE_PREFIX = `${FLAG_KEY_PREFIX}testnet.`;

@Injectable()
export class FeatureFlagService {
  constructor(
    private readonly audit: AuditSensitiveMutationService = new AuditSensitiveMutationService(),
  ) {}

  /** Stable key helper: returns the SystemConfig key used for a flag. */
  static key(scope: string, feature: string): string {
    return `${FLAG_KEY_PREFIX}${scope}.${feature}`;
  }

  /**
   * Return true if the flag is enabled. Fail-closed: any DB error returns
   * false instead of throwing. Used by Phase A gate.
   */
  async isEnabledSafe(repos: Repositories, scope: string, feature: string): Promise<boolean> {
    try {
      return await this.isEnabled(repos, scope, feature);
    } catch {
      return false;
    }
  }

  /** Strict check: throws if the repository has an infrastructure error.
   *  Used inside Phase B (TOCTOU check) so infrastructure faults produce
   *  clear rollback instead of silently OFF. */
  async isEnabled(repos: Repositories, scope: string, feature: string): Promise<boolean> {
    const row = await repos.systemConfig.findByKey(FeatureFlagService.key(scope, feature));
    if (!row || !row.isActive) return false;
    if (row.valueType !== 'BOOLEAN') return false;
    return row.value === 'true';
  }

  /**
   * Enable / disable a money-path flag. Always writes Audit and NEVER
   * writes Ledger (verified by integration tests row counts).
   *
   * Preconditions:
   *   1. `actorUserId` resolves to a user with role=ADMIN (live re-read).
   *   2. If enabling a mainnet scope feature, the matching testnet gate
   *      must also be active=true/value="true" OR operation=disable (which
   *      is always allowed).
   *
   * Mutates `SystemConfig` via upsert; updates description to include
   * a P1-008 trace so auditors know who introduced the flag.
   */
  async setFlag(
    repos: Repositories,
    opts: {
      scope: string;
      feature: string;
      enabled: boolean;
      actorUserId: string | null;
      requestId?: string | null;
      ip?: string | null;
      userAgent?: string | null;
    },
  ): Promise<{ before: boolean | null; after: boolean | null }> {
    if (opts.actorUserId) {
      const ctx = await repos.user.getAuthorizationContext(opts.actorUserId);
      if (!ctx)
        throw AppError.forbidden('Actor user not found', {
          reason: AuthzFailReason.AUTHZ_USER_NOT_FOUND,
        });
      if (ctx.status !== 'ACTIVE')
        throw AppError.forbidden('Actor user inactive', {
          reason: AuthzFailReason.AUTHZ_USER_INACTIVE,
        });
      if (ctx.role !== UserRole.ADMIN) {
        throw AppError.forbidden('Only ADMIN users may set money-path feature flags.', {
          reason: AuthzFailReason.AUTHZ_ROLE_INSUFFICIENT,
        });
      }
    } else {
      throw AppError.forbidden(
        'Setting a money-path feature flag requires a signed-in admin actor.',
        { reason: AuthzFailReason.AUTHZ_ROLE_INSUFFICIENT },
      );
    }
    const key = FeatureFlagService.key(opts.scope, opts.feature);
    const existing = await repos.systemConfig.findByKey(key);
    const before: boolean | null =
      existing && existing.valueType === 'BOOLEAN' ? existing.value === 'true' : null;

    if (opts.enabled && key.startsWith(MAINNET_SCOPE_PREFIX)) {
      // testnet gate: strip mainnet. prefix, prepend testnet., look for enabled.
      const suffix = key.slice(MAINNET_SCOPE_PREFIX.length);
      const testnetGate = TESTNET_SCOPE_PREFIX + suffix;
      const gateRow = await repos.systemConfig.findByKey(testnetGate);
      if (
        !gateRow ||
        !gateRow.isActive ||
        gateRow.valueType !== 'BOOLEAN' ||
        gateRow.value !== 'true'
      ) {
        throw AppError.forbidden(
          `Testnet gate "${testnetGate}" is not enabled. Mainnet flag "${key}" cannot be enabled until the matching testnet feature has been approved.`,
          { reason: MoneyPathErrorCode.TESTNET_GATE_MISSING },
        );
      }
    }

    const valueType: SystemConfigValueType = 'BOOLEAN';
    const description =
      existing?.description ??
      `P1-008 money-path feature flag. scope=${opts.scope}, feature=${opts.feature}.`;
    const updated = await repos.systemConfig.upsert({
      key,
      value: opts.enabled ? 'true' : 'false',
      valueType,
      isActive: true,
      description,
    });
    const after: boolean | null = updated.valueType === 'BOOLEAN' ? updated.value === 'true' : null;

    const auditArgs: AuditSensitiveMutationArgs = {
      action: 'SYSTEM_CONFIG_UPDATED',
      resource: 'flags',
      actorUserId: opts.actorUserId,
      requestId: opts.requestId ?? null,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
      envelope: {
        before,
        after,
        reason: `setFlag: ${opts.enabled ? 'ON' : 'OFF'} (key=${key})`,
        source: 'flags',
        correlation: key,
      },
      success: true,
    };
    await this.audit.recordTxBound(repos, auditArgs);
    return { before, after };
  }

  /** Fixture helper: seed flags in tests (does NOT audit). Used ONLY by
   *  integration-test setup; never exposed to production code. */
  async __testOnlyUpsert(repos: Repositories, key: string, enabled: boolean): Promise<void> {
    await repos.systemConfig.upsert({
      key,
      value: enabled ? 'true' : 'false',
      valueType: 'BOOLEAN',
      isActive: true,
      description: 'P1-008 test fixture',
    });
  }
}

export { FLAG_KEY_PREFIX, MAINNET_SCOPE_PREFIX, TESTNET_SCOPE_PREFIX };
