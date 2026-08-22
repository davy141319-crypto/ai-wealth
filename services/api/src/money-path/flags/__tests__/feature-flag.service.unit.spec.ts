// FeatureFlagService unit tests (AC-FLG-16..22).
// Prisma repository layer mocked.
import { Repositories, UserRole } from '@ai-wealth/database';
import { AppError, AuthzFailReason, MoneyPathErrorCode } from '@ai-wealth/shared';
import { FeatureFlagService } from '../feature-flag.service';
import { AuditSensitiveMutationService } from '../../audit/audit-sensitive-mutation.service';

const fakeSysCfg = (
  enabled: boolean | null,
  opts: Partial<{ valueType: string; isActive: boolean }> = {},
) => ({
  key: '',
  value: enabled === null ? '' : enabled ? 'true' : 'false',
  valueType: opts.valueType ?? 'BOOLEAN',
  isActive: opts.isActive ?? true,
  id: 'x',
  description: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const mkRepos = (
  overrides: {
    systemConfig?: Partial<Repositories['systemConfig']>;
    user?: Partial<Repositories['user']>;
    auditLog?: Partial<Repositories['auditLog']>;
  } = {},
): Repositories => {
  const auditMock = { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
  return {
    systemConfig: {
      findByKey: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockImplementation((i) =>
        Promise.resolve({
          ...fakeSysCfg(i.value === 'true'),
          ...i,
          key: i.key,
          value: i.value,
          id: 'k',
        }),
      ),
      ...(overrides.systemConfig ?? {}),
    } as unknown as Repositories['systemConfig'],
    user: {
      getAuthorizationContext: jest
        .fn()
        .mockResolvedValue({ role: UserRole.ADMIN, status: 'ACTIVE' }),
      ...(overrides.user ?? {}),
    } as unknown as Repositories['user'],
    auditLog: overrides.auditLog ?? (auditMock as unknown as Repositories['auditLog']),
    ledger: {
      createTxnWithPostings: jest.fn(),
      countTxns: jest.fn().mockResolvedValue(0),
      countPostings: jest.fn().mockResolvedValue(0),
    } as unknown as Repositories['ledger'],
  } as unknown as Repositories;
};

describe('FeatureFlagService (T11)', () => {
  it('AC-FLG-16 default OFF: missing key → false', async () => {
    const r = mkRepos();
    const svc = new FeatureFlagService(new AuditSensitiveMutationService());
    expect(await svc.isEnabledSafe(r, 'mainnet', 'withdraw')).toBe(false);
  });

  it('AC-FLG-16 default OFF: isActive=false → false', async () => {
    const r = mkRepos({
      systemConfig: {
        findByKey: jest.fn().mockResolvedValue({
          ...fakeSysCfg(true, { isActive: false }),
          key: 'money.flags.mainnet.withdraw',
        }),
      },
    });
    const svc = new FeatureFlagService(new AuditSensitiveMutationService());
    expect(await svc.isEnabled(r, 'mainnet', 'withdraw')).toBe(false);
  });

  it('AC-FLG-17: DB throws → isEnabledSafe returns OFF (closed)', async () => {
    const r = mkRepos({
      systemConfig: { findByKey: jest.fn().mockRejectedValue(new Error('boom')) },
    });
    const svc = new FeatureFlagService(new AuditSensitiveMutationService());
    expect(await svc.isEnabledSafe(r, 'x', 'y')).toBe(false);
  });

  it('AC-FLG-19: non ADMIN actor throws AUTHZ_ROLE_INSUFFICIENT', async () => {
    const r = mkRepos({
      user: {
        getAuthorizationContext: jest
          .fn()
          .mockResolvedValue({ role: UserRole.USER, status: 'ACTIVE' }),
      },
    });
    const svc = new FeatureFlagService(new AuditSensitiveMutationService());
    await expect(
      svc.setFlag(r, { scope: 'mainnet', feature: 'withdraw', enabled: true, actorUserId: 'u1' }),
    ).rejects.toHaveProperty('reason', AuthzFailReason.AUTHZ_ROLE_INSUFFICIENT);
  });

  it('AC-FLG-20: enable mainnet flag without matching testnet gate → TESTNET_GATE_MISSING + rollback (no persisted upsert)', async () => {
    const upsert = jest.fn().mockResolvedValue({ ...fakeSysCfg(true), id: 'x', key: 'k' });
    const r = mkRepos({
      systemConfig: {
        findByKey: jest.fn((k: string) =>
          Promise.resolve(
            k.endsWith('.withdraw') && !k.includes('testnet')
              ? { ...fakeSysCfg(false), key: k }
              : null,
          ),
        ),
        upsert,
      } as unknown as Repositories['systemConfig'],
    });
    const svc = new FeatureFlagService(new AuditSensitiveMutationService());
    const err = await svc
      .setFlag(r, { scope: 'mainnet', feature: 'withdraw', enabled: true, actorUserId: 'u1' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).reason).toBe(MoneyPathErrorCode.TESTNET_GATE_MISSING);
    expect(upsert).not.toHaveBeenCalled(); // rollback: flag not written.
  });

  it('AC-FLG-18: setFlag ON (ADMIN, testnet gate already ON) writes 1 Audit row, 0 Ledger rows', async () => {
    const findByKey = jest.fn(async (k: string) => {
      if (k.endsWith('testnet.withdraw')) return { ...fakeSysCfg(true), key: k };
      return null;
    });
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-ok' });
    const ledgerCreate = jest.fn();
    const ledgerTxnCount = jest.fn().mockResolvedValue(0);
    const ledgerPostCount = jest.fn().mockResolvedValue(0);
    const r: Repositories = {
      ...mkRepos(),
      systemConfig: {
        findByKey,
        upsert: jest.fn().mockImplementation((i) =>
          Promise.resolve({
            ...fakeSysCfg(i.value === 'true'),
            key: i.key,
            id: 'x',
            value: i.value,
          }),
        ),
      } as unknown as Repositories['systemConfig'],
      auditLog: { create: auditCreate } as unknown as Repositories['auditLog'],
      ledger: {
        createTxnWithPostings: ledgerCreate,
        countTxns: ledgerTxnCount,
        countPostings: ledgerPostCount,
      } as unknown as Repositories['ledger'],
    } as unknown as Repositories;
    const svc = new FeatureFlagService(new AuditSensitiveMutationService());
    await svc.setFlag(r, {
      scope: 'mainnet',
      feature: 'withdraw',
      enabled: true,
      actorUserId: 'u1',
    });
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(ledgerCreate).not.toHaveBeenCalled();
    expect(await r.ledger.countTxns()).toBe(0);
    expect(await r.ledger.countPostings()).toBe(0);
  });
});
