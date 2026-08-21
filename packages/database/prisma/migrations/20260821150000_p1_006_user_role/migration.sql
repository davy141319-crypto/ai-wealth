-- P1-006 — Backend RBAC foundation (migration renamed 20260821131246 -> 20260821150000
-- after the P1-002 wallets.status hotfix 20260821141034 was squash-merged to develop,
-- so this migration sorts strictly after it. SQL body unchanged.)
-- Additive, drift-free:
--   1) CREATE TYPE "UserRole" (USER, ADMIN) — Prisma default physical name
--      (no @@map), matching the existing UserStatus convention.
--   2) ALTER TABLE "users" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER'.
--      NOT NULL DEFAULT backfills all existing rows to USER (AC-3/17).
--
-- SCOPE NOTE: This migration is intentionally scoped to RBAC only. The pre-existing
-- drift in the `wallets.status` default was repaired by the separate P1-002 hotfix
-- migration 20260821141034_p1_002_wallet_status_default (squash-merged to develop as
-- PR #8), which runs BEFORE this migration. This migration MUST NOT duplicate that
-- wallets.status ALTER.

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER';
