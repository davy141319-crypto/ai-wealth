// ============================================================================
// P1-006 — users.role DB-level RBAC migration regression guard.
//
// Verifies the additive migration `20260821150000_p1_006_user_role`:
//   * the physical enum type name is "UserRole" (Prisma default, no @@map),
//     matching the UserStatus convention (hardening A)
//   * the DB column default for users.role is 'USER'
//   * a user row inserted WITHOUT an explicit role lands as USER
//   * UserRepository.getAuthorizationContext returns { role, status } in a
//     single query
//
// Real-DB only: gated on DATABASE_URL looking local, mirroring the other
// integration suites so it can NEVER run against production and auto-skips in
// CI (no local DB service) while still guarding the migration whenever a
// developer runs the suite against a local DB.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Repositories } from '../repositories';

const dbUrl = process.env.DATABASE_URL ?? '';
const isLocalDb =
  dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1') || dbUrl.includes('postgres:5432');

const describeIntegration = isLocalDb ? describe : describe.skip;

const prisma = new PrismaClient();
const repos = new Repositories();

let createdUsers: string[] = [];

beforeEach(() => {
  createdUsers = [];
});

afterEach(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUsers } } }).catch(() => {});
});

afterAll(async () => {
  await prisma.$disconnect();
});

describeIntegration('P1-006 — users.role DB default is USER (migration 20260821150000)', () => {
  it('the physical enum type name is "UserRole" (no @@map; hardening A)', async () => {
    const rows: Array<{ typname: string }> = await prisma.$queryRaw`
      SELECT t.typname FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typname IN ('UserRole', 'UserStatus', 'user_role')
        AND n.nspname = 'public'
    `;
    const names = rows.map((r) => r.typname);
    expect(names).toContain('UserRole');
    expect(names).not.toContain('user_role'); // must NOT be snake_case-forced
  });

  it('column default in information_schema is USER (migration applied)', async () => {
    const rows: Array<{ column_default: string }> = await prisma.$queryRaw`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'role'
    `;
    expect(rows.length).toBe(1);
    // Postgres renders the default as 'USER'::"UserRole"
    expect(rows[0].column_default).toMatch(/^'USER'::"UserRole"$/);
  });

  it('user.create() omitting role lands as USER (the RBAC least-privilege default)', async () => {
    const user = await prisma.user.create({ data: { id: randomUUID() } });
    createdUsers.push(user.id);

    expect(user.role).toBe('USER');
  });

  it('raw INSERT omitting role yields USER (proves DB-level default, not app fallback)', async () => {
    const id = randomUUID();
    const inserted: Array<{ id: string; role: string }> = await prisma.$queryRaw`
      INSERT INTO "users" (id, created_at, updated_at)
      VALUES (${id}::uuid, NOW(), NOW())
      RETURNING id, role
    `;
    createdUsers.push(...inserted.map((r) => r.id));

    expect(inserted.length).toBe(1);
    expect(inserted[0].role).toBe('USER');
  });

  it('explicit role ADMIN is honored (default only fills omissions)', async () => {
    const user = await prisma.user.create({
      data: { id: randomUUID(), role: 'ADMIN' },
    });
    createdUsers.push(user.id);

    expect(user.role).toBe('ADMIN');
  });

  it('UserRepository.getAuthorizationContext returns { role, status } for a live user', async () => {
    const created = await prisma.user.create({
      data: { id: randomUUID(), status: 'ACTIVE', role: 'ADMIN' },
    });
    createdUsers.push(created.id);

    const authz = await repos.user.getAuthorizationContext(created.id);
    expect(authz).not.toBeNull();
    expect(authz!.role).toBe('ADMIN');
    expect(authz!.status).toBe('ACTIVE');
  });

  it('getAuthorizationContext returns null for a non-existent user', async () => {
    const authz = await repos.user.getAuthorizationContext(randomUUID());
    expect(authz).toBeNull();
  });
});
