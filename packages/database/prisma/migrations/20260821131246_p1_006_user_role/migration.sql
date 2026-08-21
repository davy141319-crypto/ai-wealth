-- P1-006 — Backend RBAC foundation
-- Additive, drift-free:
--   1) CREATE TYPE "UserRole" (USER, ADMIN) — Prisma default physical name
--      (no @@map), matching the existing UserStatus convention.
--   2) ALTER TABLE "users" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER'.
--      NOT NULL DEFAULT backfills all existing rows to USER (AC-3/17).
--
-- SCOPE NOTE: This migration is intentionally scoped to RBAC only. A pre-existing
-- drift in the `wallets.status` default (the P1-002 migration.sql omitted the
-- ALTER its own header describes: CONNECTED→DISCONNECTED) is NOT bundled here —
-- it belongs to a separate P1-002 hotfix and is out of P1-006 scope.

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER';
