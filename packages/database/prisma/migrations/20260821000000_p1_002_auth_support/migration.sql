-- P1-002 wallet authentication support
-- Drift-free additive migration:
--   1) wallets.user_id becomes nullable for DISCONNECTED / unbound wallets
--      created at nonce-issue time.
--   2) FK policy switches from Restrict → SetNull so user purges (rare) do
--      not drop wallet identities (keeps audit / SIWE proof records intact).
--   3) WalletStatus default switches from CONNECTED → DISCONNECTED so newly
--      issued wallets are not implicitly trusted until SIWE verify binds.

ALTER TABLE wallets
    ALTER COLUMN user_id DROP NOT NULL;

DROP INDEX IF EXISTS wallet_user_id_idx;
CREATE INDEX wallet_user_id_idx ON wallets (user_id);

ALTER TABLE wallets
    DROP CONSTRAINT IF EXISTS wallets_user_id_fkey,
    ADD CONSTRAINT wallets_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users (id)
        ON UPDATE CASCADE ON DELETE SET NULL;
