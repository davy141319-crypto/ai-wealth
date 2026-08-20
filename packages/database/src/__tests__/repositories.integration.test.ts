// ============================================================================
// Integration tests for the P1-001 repository layer against a real Postgres.
//
// These tests hit the actual database pointed at by DATABASE_URL. They are
// gated on the URL looking local (localhost/127.0.0.1/postgres:5432) so they
// can NEVER run against a production database — if the env is not local, the
// suite is skipped (not failed). This mirrors the seed's safety guard.
//
// Each test creates its own rows with random UUIDs and cleans them up in
// afterEach so the suite is order-independent and re-runnable.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { Repositories } from '../repositories';

const dbUrl = process.env.DATABASE_URL ?? '';
const isLocalDb =
  dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1') || dbUrl.includes('postgres:5432');

const describeIntegration = isLocalDb ? describe : describe.skip;

const prisma = new PrismaClient();
const repos = new Repositories();

// Track row ids created during a test so afterEach can clean them up.
let createdUsers: string[] = [];
let createdWallets: string[] = [];
let createdAuditLogs: string[] = [];
let createdIdempotency: { scope: string; key: string }[] = [];
let createdSystemConfigs: string[] = [];

beforeEach(() => {
  createdUsers = [];
  createdWallets = [];
  createdAuditLogs = [];
  createdIdempotency = [];
  createdSystemConfigs = [];
});

afterEach(async () => {
  // Delete in dependency order; failures are tolerated (best-effort cleanup).
  for (const { scope, key } of createdIdempotency) {
    await prisma.idempotencyKey.deleteMany({ where: { scope, key } }).catch(() => {});
  }
  for (const id of createdSystemConfigs) {
    await prisma.systemConfig.deleteMany({ where: { id } }).catch(() => {});
  }
  for (const id of createdAuditLogs) {
    await prisma.auditLog.deleteMany({ where: { id } }).catch(() => {});
  }
  // auth_nonces / wallet_identities cascade with their wallet.
  await prisma.authNonce
    .deleteMany({ where: { walletId: { in: createdWallets } } })
    .catch(() => {});
  await prisma.walletIdentity
    .deleteMany({ where: { walletId: { in: createdWallets } } })
    .catch(() => {});
  await prisma.wallet.deleteMany({ where: { id: { in: createdWallets } } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { actor: { in: createdUsers } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } }).catch(() => {});
});

afterAll(async () => {
  await prisma.$disconnect();
});

// Helper: create a user and register it for cleanup.
async function makeUser(status: Prisma.UserCreateInput['status'] = 'ACTIVE') {
  const user = await prisma.user.create({ data: { id: randomUUID(), status } });
  createdUsers.push(user.id);
  return user;
}

describeIntegration('User + Wallet relationship', () => {
  it('creates a user and links a wallet (1-to-many)', async () => {
    const user = await makeUser();
    const w1 = await repos.wallet.create({
      userId: user.id,
      address: '0x' + randomUUID().replace(/-/g, ''),
      chain: 'ETH',
      network: 'sepolia',
      isPrimary: true,
    });
    const w2 = await repos.wallet.create({
      userId: user.id,
      address: '0x' + randomUUID().replace(/-/g, '').slice(0, 40),
      chain: 'TRON',
      network: 'trc20-main',
    });
    createdWallets.push(w1.id, w2.id);

    const list = await repos.wallet.listByUser(user.id);
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.id).sort()).toEqual([w1.id, w2.id].sort());
  });

  it('rejects a wallet for a non-existent user (FK integrity)', async () => {
    const fakeUserId = randomUUID();
    await expect(
      repos.wallet.create({
        userId: fakeUserId,
        address: '0xRel' + randomUUID().replace(/-/g, ''),
        chain: 'ETH',
        network: 'mainnet',
      }),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

describeIntegration('Wallet unique constraint (address, chain, network)', () => {
  it('rejects a duplicate (address, chain, network) tuple', async () => {
    const user = await makeUser();
    const address = '0xUni' + randomUUID().replace(/-/g, '');
    const w = await repos.wallet.create({
      userId: user.id,
      address,
      chain: 'ETH',
      network: 'sepolia',
    });
    createdWallets.push(w.id);

    await expect(
      repos.wallet.create({
        userId: user.id,
        address, // same
        chain: 'ETH', // same
        network: 'sepolia', // same
      }),
    ).rejects.toThrow(/unique/i);

    // But the same address on a different network is allowed.
    const w2 = await repos.wallet.create({
      userId: user.id,
      address,
      chain: 'ETH',
      network: 'mainnet', // different network
    });
    createdWallets.push(w2.id);
    expect(w2.id).not.toBe(w.id);
  });

  it('findUnique resolves by (address, chain, network)', async () => {
    const user = await makeUser();
    const address = '0xFu' + randomUUID().replace(/-/g, '');
    const w = await repos.wallet.create({
      userId: user.id,
      address,
      chain: 'POLYGON',
      network: 'amoy',
    });
    createdWallets.push(w.id);

    const found = await repos.wallet.findUnique({
      address,
      chain: 'POLYGON',
      network: 'amoy',
    });
    expect(found?.id).toBe(w.id);

    const miss = await repos.wallet.findUnique({
      address,
      chain: 'POLYGON',
      network: 'mainnet',
    });
    expect(miss).toBeNull();
  });
});

describeIntegration('AuthNonce uniqueness, expiry, single-use', () => {
  it('rejects a duplicate nonce (globally unique)', async () => {
    const user = await makeUser();
    const w = await repos.wallet.create({
      userId: user.id,
      address: '0xN' + randomUUID().replace(/-/g, ''),
      chain: 'ETH',
      network: 'sepolia',
    });
    createdWallets.push(w.id);
    const nonce = 'nonce-' + randomUUID();
    const expires = new Date(Date.now() + 60_000);

    await repos.authNonce.create({ walletId: w.id, nonce, expiresAt: expires });
    await expect(
      repos.authNonce.create({ walletId: w.id, nonce, expiresAt: expires }),
    ).rejects.toThrow(/unique/i);
  });

  it('consume() marks a fresh nonce used once; second consume fails', async () => {
    const user = await makeUser();
    const w = await repos.wallet.create({
      userId: user.id,
      address: '0xC' + randomUUID().replace(/-/g, ''),
      chain: 'ETH',
      network: 'sepolia',
    });
    createdWallets.push(w.id);
    const nonce = 'consume-' + randomUUID();
    await repos.authNonce.create({
      walletId: w.id,
      nonce,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const r1 = await repos.authNonce.consume(nonce);
    expect(r1.ok).toBe(true);
    expect(r1.nonce?.usedAt).not.toBeNull();

    const r2 = await repos.authNonce.consume(nonce);
    expect(r2.ok).toBe(false);
    expect(r2.nonce).toBeNull();
  });
});

describeIntegration('AuditLog is append-only', () => {
  it('creates and reads an audit row with JSONB metadata', async () => {
    const user = await makeUser();
    const row = await repos.auditLog.create({
      actor: user.id,
      action: 'test.action',
      resource: 'test-resource',
      requestId: 'req-' + randomUUID(),
      ip: '127.0.0.1',
      userAgent: 'jest/test',
      metadata: { foo: 'bar', n: 42 },
    });
    createdAuditLogs.push(row.id);

    const found = await repos.auditLog.findById(row.id);
    expect(found?.metadata).toMatchObject({ foo: 'bar', n: 42 });
  });

  it('AuditLogRepository exposes NO update/delete methods', () => {
    // Cast to a record to introspect available methods without `any`.
    const r = repos.auditLog as unknown as Record<string, unknown>;
    expect(typeof r.create).toBe('function');
    expect(typeof r.findById).toBe('function');
    expect(typeof r.list).toBe('function');
    expect(typeof r.update).toBe('undefined');
    expect(typeof r.delete).toBe('undefined');
    expect(typeof r.deleteMany).toBe('undefined');
  });
});

describeIntegration('IdempotencyKey (scope, key) uniqueness + lifecycle', () => {
  it('rejects a duplicate (scope, key)', async () => {
    const scope = 'svc-' + randomUUID();
    const key = 'k-' + randomUUID();
    await repos.idempotencyKey.create({
      scope,
      key,
      expiresAt: new Date(Date.now() + 60_000),
    });
    createdIdempotency.push({ scope, key });

    await expect(
      repos.idempotencyKey.create({
        scope,
        key,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow(/unique/i);
  });

  it('complete() transitions PENDING -> COMPLETED and stores response', async () => {
    const scope = 'svc-' + randomUUID();
    const key = 'k-' + randomUUID();
    await repos.idempotencyKey.create({
      scope,
      key,
      expiresAt: new Date(Date.now() + 60_000),
    });
    createdIdempotency.push({ scope, key });

    const completed = await repos.idempotencyKey.complete(scope, key, {
      responseCode: 201,
      responseBody: { ok: true, id: 7 },
    });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.responseCode).toBe(201);
    expect(completed.responseBody).toMatchObject({ ok: true, id: 7 });
  });

  it('purgeExpired removes only rows past expiresAt', async () => {
    const scope = 'purge-' + randomUUID();
    const expiredKey = 'exp-' + randomUUID();
    const liveKey = 'live-' + randomUUID();
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    await repos.idempotencyKey.create({ scope, key: expiredKey, expiresAt: past });
    await repos.idempotencyKey.create({ scope, key: liveKey, expiresAt: future });
    createdIdempotency.push({ scope, key: expiredKey }, { scope, key: liveKey });

    const removed = await repos.idempotencyKey.purgeExpired(new Date());
    expect(removed).toBeGreaterThanOrEqual(1);

    const miss = await repos.idempotencyKey.findUnique(scope, expiredKey);
    const live = await repos.idempotencyKey.findUnique(scope, liveKey);
    expect(miss).toBeNull();
    expect(live?.key).toBe(liveKey);
  });
});

describeIntegration('SystemConfig key uniqueness + typed value', () => {
  it('rejects a duplicate key on create, but upsert updates it', async () => {
    const key = 'test.cfg.' + randomUUID();
    const created = await repos.systemConfig.upsert({
      key,
      value: '10',
      valueType: 'NUMBER',
      description: 'initial',
    });
    createdSystemConfigs.push(created.id);

    await expect(
      prisma.systemConfig.create({
        data: { key, value: '20', valueType: 'NUMBER' },
      }),
    ).rejects.toThrow(/unique/i);

    const updated = await repos.systemConfig.upsert({
      key,
      value: '20',
      valueType: 'NUMBER',
      description: 'updated',
    });
    expect(updated.id).toBe(created.id);
    expect(updated.value).toBe('20');
    expect(updated.description).toBe('updated');
  });

  it('findByKey resolves and list filters by isActive', async () => {
    const key = 'test.flag.' + randomUUID();
    const created = await repos.systemConfig.upsert({
      key,
      value: 'true',
      valueType: 'BOOLEAN',
    });
    createdSystemConfigs.push(created.id);

    const found = await repos.systemConfig.findByKey(key);
    expect(found?.id).toBe(created.id);

    const inactive = await repos.systemConfig.setActive(key, false);
    expect(inactive.isActive).toBe(false);

    const activeList = await repos.systemConfig.list({ isActive: true });
    expect(activeList.find((c) => c.id === created.id)).toBeUndefined();
  });
});

describeIntegration('FK cascade strategy', () => {
  it('deleting a wallet cascades to wallet_identities and auth_nonces', async () => {
    const user = await makeUser();
    const w = await repos.wallet.create({
      userId: user.id,
      address: '0xCas' + randomUUID().replace(/-/g, ''),
      chain: 'ETH',
      network: 'sepolia',
    });
    const wi = await repos.walletIdentity.create({
      walletId: w.id,
      identityType: 'SIWE',
    });
    const an = await repos.authNonce.create({
      walletId: w.id,
      nonce: 'cas-' + randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    });

    // delete the wallet directly via prisma (repos don't expose delete)
    await prisma.wallet.delete({ where: { id: w.id } });

    expect(await prisma.walletIdentity.findUnique({ where: { id: wi.id } })).toBeNull();
    expect(await prisma.authNonce.findUnique({ where: { id: an.id } })).toBeNull();
  });

  it('a user with a wallet cannot be deleted (RESTRICT) until the wallet is removed', async () => {
    const user = await makeUser();
    const w = await repos.wallet.create({
      userId: user.id,
      address: '0xRes' + randomUUID().replace(/-/g, ''),
      chain: 'ETH',
      network: 'sepolia',
    });
    createdWallets.push(w.id);

    await expect(prisma.user.delete({ where: { id: user.id } })).rejects.toThrow(
      /foreign key|restrict/i,
    );

    // After removing the wallet, the user can be deleted.
    await prisma.wallet.delete({ where: { id: w.id } });
    await prisma.user.delete({ where: { id: user.id } });
    createdUsers = createdUsers.filter((id) => id !== user.id);
  });
});

describeIntegration('Repositories.transaction()', () => {
  it('commits when fn resolves, rolls back when fn throws', async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    const walletAddress = '0xTx' + randomUUID().replace(/-/g, '');

    // Rolling-back case: create a wallet then throw.
    await expect(
      Repositories.transaction(async (r) => {
        const w = await r.wallet.create({
          userId: userA.id,
          address: walletAddress,
          chain: 'ETH',
          network: 'sepolia',
        });
        // Don't register for cleanup; the rollback should remove it.
        throw new Error('intentional rollback ' + w.id);
      }),
    ).rejects.toThrow(/intentional rollback/);

    const leaked = await prisma.wallet.findFirst({
      where: { address: walletAddress },
    });
    expect(leaked).toBeNull();

    // Commit case: create a wallet for userB, should persist.
    await Repositories.transaction(async (r) => {
      const w = await r.wallet.create({
        userId: userB.id,
        address: walletAddress,
        chain: 'ETH',
        network: 'sepolia',
      });
      createdWallets.push(w.id);
    });
    const persisted = await prisma.wallet.findFirst({
      where: { address: walletAddress },
    });
    expect(persisted).not.toBeNull();
  });
});
