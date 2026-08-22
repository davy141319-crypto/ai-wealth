-- ============================================================================
-- P1-008 Money-Path Foundation — Option A APPROVED.
-- SINGLE additive migration only. Do NOT touch earlier migrations.
--
-- FORBIDDEN fields (hard boundary of this migration):
--   real balance, available_balance, frozen_balance, USDT_balance, deposit,
--   withdrawal, tx_hash, chain transaction, network, wallet_custody,
--   hot_wallet, private_key, treasury_balance, any real fund column/table.
--
-- Append-only enforcement:
--   TWO PostgreSQL BEFORE UPDATE OR DELETE triggers on both ledger tables.
--   Role privilege statement is NOT performed here on purpose (see P1-008 ChatGPT ruling:
--   don't guess production app DB role). Role hardening happens in a later
--   deployment-only hardening task. Trigger layer protects all DB roles,
--   including superusers — so it is the authoritative DB append-only guard.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Enums
-- ----------------------------------------------------------------------------
-- CreateType
DO $$ BEGIN
    CREATE TYPE "LedgerTxnType" AS ENUM ('SETTLEMENT', 'COMMISSION', 'TREASURY_MOVE', 'TRANSFER', 'REVERSAL', 'MANUAL_ADMIN', 'OPENING_BALANCE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "LedgerAmountSign" AS ENUM ('DEBIT', 'CREDIT');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ----------------------------------------------------------------------------
-- 2. ledger_transactions (journal header, immutable — no updatedAt)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ledger_transactions" (
    "id" UUID NOT NULL,
    "scope" VARCHAR(64) NOT NULL,
    "txn_idempotency_key" VARCHAR(128) NOT NULL,
    "txn_type" "LedgerTxnType" NOT NULL,
    "currency" VARCHAR(16) NOT NULL,
    "unit" VARCHAR(16) NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 6,
    "source" VARCHAR(32) NOT NULL,
    "reference" VARCHAR(256),
    "reverses_txn_id" UUID,
    "actor_user_id" UUID,
    "request_id" VARCHAR(64),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ledger_txn_scope_not_empty CHECK" CHECK (char_length("scope") > 0),
    CONSTRAINT "ledger_txn_currency_unit_not_empty CHECK" CHECK (
      char_length("currency") > 0 AND char_length("unit") > 0
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "ledger_txn_scope_idempotency_uq"
  ON "ledger_transactions"("scope", "txn_idempotency_key");

-- Prevent double-reversal of the SAME original transaction. Undo of a
-- reversal is performed by reversing the reversal txn itself, NOT by
-- writing a second reversal that targets the original again.
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_txn_reverses_unique_uq"
  ON "ledger_transactions"("reverses_txn_id") WHERE "reverses_txn_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "ledger_txn_type_created_idx"
  ON "ledger_transactions"("txn_type", "created_at");
CREATE INDEX IF NOT EXISTS "ledger_txn_source_idx"
  ON "ledger_transactions"("source");
CREATE INDEX IF NOT EXISTS "ledger_txn_actor_idx"
  ON "ledger_transactions"("actor_user_id", "created_at");

-- FK: reverses_txn_id → self (RESTRICT prevents deleting the original txn
-- while a reversal points at it; ON UPDATE cascade on PK change only).
ALTER TABLE "ledger_transactions"
  ADD CONSTRAINT "ledger_transactions_reverses_txn_id_fkey"
  FOREIGN KEY ("reverses_txn_id") REFERENCES "ledger_transactions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- NOTE: actor_user_id has NO FK to users.id per ChatGPT ruling. Rationale:
-- a user deletion must NOT trigger ANY UPDATE against immutable ledger rows
-- (e.g. an ON DELETE SET NULL FK would UPDATE actor_user_id to NULL). The
-- append-only ledger MUST stay byte-identical for all history.

-- ----------------------------------------------------------------------------
-- 3. ledger_postings (journal legs, immutable — no updatedAt)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ledger_postings" (
    "id" UUID NOT NULL,
    "ledger_txn_id" UUID NOT NULL,
    "account_type" VARCHAR(32) NOT NULL,
    "account_id" VARCHAR(128) NOT NULL,
    "sign" "LedgerAmountSign" NOT NULL,
    "amount" NUMERIC(38, 0) NOT NULL,
    "reverses_posting_id" UUID,

    CONSTRAINT "ledger_postings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ledger_postings_amount_positive CHECK" CHECK ("amount" > 0::numeric)
);

CREATE INDEX IF NOT EXISTS "ledger_posting_txn_idx"
  ON "ledger_postings"("ledger_txn_id");
CREATE INDEX IF NOT EXISTS "ledger_posting_account_idx"
  ON "ledger_postings"("account_type", "account_id");

-- Prevent double reversal of a single original posting (paired with the
-- transaction-level UNIQUE(reverses_txn_id) above).
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_posting_reverses_unique_uq"
  ON "ledger_postings"("reverses_posting_id") WHERE "reverses_posting_id" IS NOT NULL;

ALTER TABLE "ledger_postings"
  ADD CONSTRAINT "ledger_postings_ledger_txn_id_fkey"
  FOREIGN KEY ("ledger_txn_id") REFERENCES "ledger_transactions"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ledger_postings"
  ADD CONSTRAINT "ledger_postings_reverses_posting_id_fkey"
  FOREIGN KEY ("reverses_posting_id") REFERENCES "ledger_postings"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ----------------------------------------------------------------------------
-- 4. Append-only enforcement — Trigger functions + per-table triggers.
--    These triggers raise EXCEPTION on ANY UPDATE / DELETE of the two
--    ledger tables. ALL DB roles (including superusers) pass through this
--    code path — triggers are the authoritative immutability guard for
--    P1-008. Correctness tests:
--      * T21 — UPDATE / DELETE both tables → DB error + full tx rollback.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION p1008_ledger_no_update_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '[P1-008 APPEND-ONLY] % on "ledger_transactions" is forbidden. Ledger history is immutable — reversals create NEW balanced transactions/postings.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION p1008_ledger_postings_no_update_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '[P1-008 APPEND-ONLY] % on "ledger_postings" is forbidden. Ledger history is immutable — reversals create NEW balanced transactions/postings.',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS p1008_ledger_txn_no_mut ON "ledger_transactions";
CREATE TRIGGER p1008_ledger_txn_no_mut
BEFORE UPDATE OR DELETE ON "ledger_transactions"
FOR EACH ROW EXECUTE FUNCTION p1008_ledger_no_update_delete();

DROP TRIGGER IF EXISTS p1008_ledger_postings_no_mut ON "ledger_postings";
CREATE TRIGGER p1008_ledger_postings_no_mut
BEFORE UPDATE OR DELETE ON "ledger_postings"
FOR EACH ROW EXECUTE FUNCTION p1008_ledger_postings_no_update_delete();
