// ============================================================================
// TEST-ONLY SEED — inserts deterministic, non-sensitive sample rows so
// integration tests and local dev have something to query.
//
// SAFETY GUARDS (do not remove):
//   1. Refuses to run unless DATABASE_URL contains "localhost" or "127.0.0.1"
//      OR NODE_ENV !== 'production'. This makes it impossible to seed a real
//      production database by accident.
//   2. Idempotent: uses upsert / deleteMany so re-running is safe.
//   3. Inserts ONLY identity/audit/config rows. No fund, balance, product, or
//      any real-money data. Uses obviously fake test addresses.
//   4. The wallet addresses below are random 0x... strings — they are NOT
//      real wallet keys and hold no funds on any chain.
//
// Run: pnpm --filter @ai-wealth/database run db:seed
//      (or) prisma db seed --schema packages/database/prisma/schema.prisma
// ============================================================================

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function assertTestOnly(): void {
  const url = process.env.DATABASE_URL ?? '';
  const isLocal =
    url.includes('localhost') ||
    url.includes('127.0.0.1') ||
    url.includes('postgres:5432'); // docker-compose internal host (local dev)
  const isTestEnv =
    process.env.NODE_ENV !== 'production' &&
    process.env.NODE_ENV !== 'staging';

  if (!isLocal && !isTestEnv) {
    throw new Error(
      'REFUSING TO SEED: DATABASE_URL does not look like a local/test ' +
        'database and NODE_ENV is production/staging. Seed is TEST ONLY.',
    );
  }
  if (process.env.ALLOW_REAL_SEED === 'true') {
    throw new Error(
      'REFUSING TO SEED: ALLOW_REAL_SEED is set. This flag is forbidden by ' +
        'project policy; the seed must never run against real data.',
    );
  }
}

async function main(): Promise<void> {
  assertTestOnly();
  console.warn('[seed] TEST-ONLY seed starting…');

  // ---- SystemConfig: typed key/value defaults ----------------------------
  await prisma.systemConfig.upsert({
    where: { key: 'auth.nonce.ttlSeconds' },
    create: {
      key: 'auth.nonce.ttlSeconds',
      value: '300',
      valueType: 'NUMBER',
      description: 'TTL in seconds for a wallet sign-in nonce.',
    },
    update: { value: '300' },
  });
  await prisma.systemConfig.upsert({
    where: { key: 'auth.rateLimit.perMinute' },
    create: {
      key: 'auth.rateLimit.perMinute',
      value: '10',
      valueType: 'NUMBER',
      description: 'Max sign-in attempts per wallet per minute.',
    },
    update: {},
  });
  await prisma.systemConfig.upsert({
    where: { key: 'feature.siwep.enabled' },
    create: {
      key: 'feature.siwep.enabled',
      value: 'false',
      valueType: 'BOOLEAN',
      description: 'Master switch for SIWE primary auth (P1+).',
    },
    update: {},
  });

  // ---- User + Wallet + WalletIdentity + AuthNonce ------------------------
  // NOTE: these addresses are random-looking 0x strings, NOT real keys.
  // Fixed UUIDs are reserved test UUIDs (00000000-0000-0000-0000-00000000000X)
  // so the seed is idempotent across re-runs.
  const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
  const TEST_WALLET_ID = '00000000-0000-0000-0000-000000000002';

  const user = await prisma.user.upsert({
    where: { id: TEST_USER_ID },
    create: { id: TEST_USER_ID, status: 'ACTIVE' },
    update: {},
  });

  const wallet = await prisma.wallet.upsert({
    where: {
      address_chain_network: {
        address: '0xTestSeedAddress000000000000000000000000Dead',
        chain: 'ETH',
        network: 'sepolia',
      },
    },
    create: {
      id: TEST_WALLET_ID,
      userId: user.id,
      address: '0xTestSeedAddress000000000000000000000000Dead',
      chain: 'ETH',
      network: 'sepolia',
      status: 'CONNECTED',
      isPrimary: true,
    },
    update: {},
  });

  await prisma.walletIdentity.upsert({
    where: {
      walletId_identityType: { walletId: wallet.id, identityType: 'SIWE' },
    },
    create: { walletId: wallet.id, identityType: 'SIWE' },
    update: {},
  });

  await prisma.authNonce.deleteMany({
    where: { nonce: 'test-seed-nonce-do-not-use' },
  });
  await prisma.authNonce.create({
    data: {
      walletId: wallet.id,
      nonce: 'test-seed-nonce-do-not-use',
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    },
  });

  // ---- AuditLog: a sample row -------------------------------------------
  await prisma.auditLog.deleteMany({
    where: { action: 'seed.test-sample' },
  });
  await prisma.auditLog.create({
    data: {
      actor: user.id,
      action: 'seed.test-sample',
      resource: 'system',
      requestId: 'seed-req-0001',
      ip: '127.0.0.1',
      userAgent: 'ai-wealth-seed-script/test',
      metadata: { source: 'seed', note: 'TEST ONLY' },
    },
  });

  // ---- IdempotencyKey: a sample (expired) row ---------------------------
  await prisma.idempotencyKey.deleteMany({
    where: { scope: 'seed-test', key: 'sample-0001' },
  });
  await prisma.idempotencyKey.create({
    data: {
      scope: 'seed-test',
      key: 'sample-0001',
      status: 'COMPLETED',
      responseCode: 200,
      responseBody: { ok: true },
      expiresAt: new Date(Date.now() - 60_000), // already expired
    },
  });

  console.warn('[seed] TEST-ONLY seed complete.');
}

main()
  .catch((e) => {
    console.error('[seed] FAILED:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
