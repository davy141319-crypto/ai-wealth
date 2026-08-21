// ============================================================================
// P1-002 hotfix — wallets.status DB default regression guard.
//
// Verifies the additive migration `20260821141034_p1_002_wallet_status_default`
// actually repairs the drift between the Prisma schema
// (`Wallet.status @default(DISCONNECTED)`) and the database (which P1-001 had
// set to DEFAULT 'CONNECTED' and P1-002's SQL omitted the ALTER its own header
// promised). After the hotfix:
//   * the DB column default is 'DISCONNECTED'
//   * a wallet row inserted WITHOUT an explicit status lands as DISCONNECTED
//   * an explicit status is still honored (default only fills omissions)
//
// Real-DB only: gated on DATABASE_URL looking local, mirroring
// repositories.integration.test.ts so it can NEVER run against production and
// auto-skips in CI (no local DB) — which keeps CI green without a Postgres
// service while still guarding the default whenever a developer runs the suite
// against a local DB.
//
// NOTE on the unrelated pre-existing FK cascade test: repositories.integration
// .test.ts:378 ('a user with a wallet cannot be deleted (RESTRICT)') expects
// RESTRICT but the wallets.user_id FK is ON DELETE SET NULL by design since
// P1-002 (unbound wallets for nonce issuance). That test is a pre-existing
// latent develop bug (exposed only when integration tests run against a real
// DB; skipped in CI) and is OUT OF SCOPE for this wallets.status hotfix.
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

let createdWallets: string[] = [];
let createdUsers: string[] = [];

beforeEach(() => {
  createdWallets = [];
  createdUsers = [];
});

afterEach(async () => {
  await prisma.authNonce
    .deleteMany({ where: { walletId: { in: createdWallets } } })
    .catch(() => {});
  await prisma.walletIdentity
    .deleteMany({ where: { walletId: { in: createdWallets } } })
    .catch(() => {});
  await prisma.wallet.deleteMany({ where: { id: { in: createdWallets } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } }).catch(() => {});
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makeUser(status: Prisma.UserCreateInput['status'] = 'ACTIVE') {
  const user = await prisma.user.create({ data: { id: randomUUID(), status } });
  createdUsers.push(user.id);
  return user;
}

describeIntegration('P1-002 hotfix — wallets.status DB default is DISCONNECTED', () => {
  it('column default in information_schema is DISCONNECTED (migration applied)', async () => {
    const rows: Array<{ column_default: string }> = await prisma.$queryRaw`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'wallets' AND column_name = 'status'
    `;
    expect(rows.length).toBe(1);
    // Postgres renders the default as 'DISCONNECTED'::"WalletStatus". Use a
    // precise regex rather than a naive substring: 'CONNECTED' is a suffix of
    // 'DISCONNECTED', so a contains/not-contains pair would self-contradict.
    expect(rows[0].column_default).toMatch(/^'DISCONNECTED'::"WalletStatus"$/);
    expect(rows[0].column_default).not.toMatch(/^'CONNECTED'::/);
  });

  it('wallet.create() omitting status lands as DISCONNECTED (the drift fix)', async () => {
    const user = await makeUser();
    // No status passed -> relies on the DB column default (the hotfix target).
    const w = await repos.wallet.create({
      userId: user.id,
      address: '0xDef' + randomUUID().replace(/-/g, ''),
      chain: 'ETH',
      network: 'sepolia',
    });
    createdWallets.push(w.id);

    expect(w.status).toBe('DISCONNECTED');
  });

  it('raw INSERT omitting status yields DISCONNECTED (proves DB-level default, not app)', async () => {
    const user = await makeUser();
    // Bypass the repository entirely to prove the default is enforced by the
    // DB column definition, not by Prisma/client-side fallback.
    const inserted: Array<{ id: string; status: string }> = await prisma.$queryRaw`
      INSERT INTO "wallets" (id, user_id, address, chain, network, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${user.id}::uuid, ${'0xRaw' + randomUUID().replace(/-/g, '')},
              'ETH', 'mainnet', NOW(), NOW())
      RETURNING id, status
    `;
    createdWallets.push(...inserted.map((r) => r.id));

    expect(inserted.length).toBe(1);
    expect(inserted[0].status).toBe('DISCONNECTED');
  });

  it('explicit status is still honored (default only fills omissions)', async () => {
    const user = await makeUser();
    const w = await repos.wallet.create({
      userId: user.id,
      address: '0xCon' + randomUUID().replace(/-/g, ''),
      chain: 'ETH',
      network: 'mainnet',
      status: 'CONNECTED', // explicit — must NOT be overridden by the default
    });
    createdWallets.push(w.id);

    expect(w.status).toBe('CONNECTED');
  });

  it('NonceService contract: wallet.create with status DISCONNECTED is unaffected (explicit wins)', async () => {
    // NonceService.issue() passes status:'DISCONNECTED' explicitly. This test
    // pins that an explicit DISCONNECTED insert is returned as DISCONNECTED
    // regardless of the DB default — the hotfix does not change NonceService
    // semantics because NonceService never relied on the default.
    const user = await makeUser();
    const w = await repos.wallet.create({
      userId: user.id,
      address: '0xNon' + randomUUID().replace(/-/g, ''),
      chain: 'ETH',
      network: 'sepolia',
      status: 'DISCONNECTED',
    });
    createdWallets.push(w.id);

    expect(w.status).toBe('DISCONNECTED');
  });
});
