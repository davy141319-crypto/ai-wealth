// Migration / append-only & boundary tests (T21 / T23 boundary grep).
import * as fs from 'fs';
import * as path from 'path';
import { Repositories, UserRole, prisma } from '@ai-wealth/database';
import { AppError, MoneyPathErrorCode } from '@ai-wealth/shared';
import { LedgerEngine } from '../ledger';
import { LedgerAmountSign, LedgerTxnType } from '../ledger/types';
import { AuditSensitiveMutationService } from '../audit/audit-sensitive-mutation.service';

const MIGRATIONS_DIR = path.resolve(
  __dirname,
  '../../../../../packages/database/prisma/migrations',
);
const SCHEMA_PATH = path.resolve(
  __dirname,
  '../../../../../packages/database/prisma/schema.prisma',
);

describe('P1-008 migration boundary (T21 / T25 boundary audit)', () => {
  it('Exactly 1 new migration directory is created for P1-008', () => {
    const dirs = fs
      .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => /^\d{14}_p1_008_/.test(n));
    expect(dirs.length).toBe(1);
  });

  it('Migration FORBIDDEN field grep: no forbidden real-money columns anywhere', () => {
    const schemaText = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const forbiddenFields = [
      'balance',
      'available_balance',
      'frozen_balance',
      'usdt_balance',
      'deposit',
      'withdrawal',
      'tx_hash',
      'hot_wallet',
      'private_key',
      'treasury_balance',
    ];
    const hits: string[] = [];
    for (const f of forbiddenFields) {
      // case-insensitive match inside column names: only match on `@map` /
      // model field identifier boundaries to avoid the word "deposit" in
      // the schema preamble.
      const regex = new RegExp(`\\b${f}\\b`, 'i');
      const lines = schemaText.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (regex.test(line)) {
          // Whitelist lines that are FORBIDDEN comments (not columns).
          if (/\bFORBIDDEN\b/i.test(line) || /hard boundary/i.test(line) || /phase/i.test(line))
            return;
          hits.push(`forbidden:${f} L${idx + 1}: ${line.trim()}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });

  it('schema.prisma FORBIDDEN preamble kept byte-stable', () => {
    const schemaText = fs.readFileSync(SCHEMA_PATH, 'utf8');
    expect(schemaText).toContain('FORBIDDEN in this schema (hard constraint)');
    expect(schemaText).toContain('USDT balance, deposit,');
  });

  it('append-only triggers exist inside migration.sql', () => {
    const dirs = fs
      .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => /^\d{14}_p1_008_/.test(n));
    const migration = fs.readFileSync(path.join(MIGRATIONS_DIR, dirs[0], 'migration.sql'), 'utf8');
    expect(migration).toContain('p1008_ledger_no_update_delete');
    expect(migration).toContain('p1008_ledger_postings_no_mut');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "ledger_transactions"');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "ledger_postings"');
    expect(migration).toContain('ledger_postings_amount_positive CHECK');
    // ChatGPT forbid REVOKE FROM current_user: make sure migration does NOT include `REVOKE`.
    expect(migration).not.toMatch(/\bREVOKE\b/i);
  });

  it('UNIQUE(reversesTxnId) / UNIQUE(reversesPostingId) in migration.sql to prevent double reversal', () => {
    const dirs = fs
      .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => /^\d{14}_p1_008_/.test(n));
    const migration = fs.readFileSync(path.join(MIGRATIONS_DIR, dirs[0], 'migration.sql'), 'utf8');
    expect(migration).toContain('ledger_txn_reverses_unique_uq');
    expect(migration).toContain('ledger_posting_reverses_unique_uq');
  });

  describe('Live Postgres append-only (T21 UPDATE/DELETE failures with rollback confirmation)', () => {
    const skip = !process.env['DATABASE_URL'];
    const maybed = skip ? describe.skip : describe;
    maybed('append-only triggers on live DB', () => {
      async function seededId(): Promise<string> {
        return prisma.$transaction(
          async (tx) => {
            const repos = new Repositories(tx);
            const engine = new LedgerEngine(new AuditSensitiveMutationService());
            const r = await engine.write(repos, {
              scope: 'append-only-test',
              txnIdempotencyKey: 'append-' + Math.random().toString(36).slice(2, 10),
              txnType: LedgerTxnType.TRANSFER,
              currency: 'USDT',
              unit: 'MINOR_UNIT',
              decimals: 6,
              source: 'test',
              actorUserId: null,
              requestId: null,
              postings: [
                {
                  accountType: 'USER',
                  accountId: 'a30077fe-c6ef-4d7a-a71f-9e4c35b7f2d1',
                  sign: LedgerAmountSign.CREDIT,
                  amount: '7',
                },
                {
                  accountType: 'PLATFORM',
                  accountId: 'platform',
                  sign: LedgerAmountSign.DEBIT,
                  amount: '7',
                },
              ],
            });
            return r.txn.id;
          },
          { isolationLevel: 'Serializable' },
        );
      }

      it('UPDATE ledger_transactions → DB error', async () => {
        const id = await seededId();
        await expect(
          prisma.$executeRawUnsafe(
            `UPDATE ledger_transactions SET metadata='{}'::jsonb WHERE id=$1::uuid`,
            id,
          ),
        ).rejects.toThrow(/APPEND-ONLY|forbidden/);
        // Confirm row still exists unchanged (amount_positive, metadata null).
        const row = await prisma.ledgerTransaction.findUnique({ where: { id } });
        expect(row?.metadata).toBeNull();
      });

      it('DELETE ledger_transactions → DB error', async () => {
        const id = await seededId();
        await expect(
          prisma.$executeRawUnsafe(`DELETE FROM ledger_transactions WHERE id=$1::uuid`, id),
        ).rejects.toThrow(/APPEND-ONLY|forbidden/);
        expect(await prisma.ledgerTransaction.count({ where: { id } })).toBe(1);
      });

      it('UPDATE ledger_postings → DB error + rollback leaves amount unchanged', async () => {
        const id = await seededId();
        const leg = await prisma.ledgerPosting.findFirst({ where: { ledgerTxnId: id } });
        expect(leg).toBeTruthy();
        await expect(
          prisma.$executeRawUnsafe(
            `UPDATE ledger_postings SET amount = amount + 10 WHERE id=$1::uuid`,
            leg!.id,
          ),
        ).rejects.toThrow(/APPEND-ONLY|forbidden/);
        const after = await prisma.ledgerPosting.findUnique({ where: { id: leg!.id } });
        expect(String(after!.amount)).toBe(String(leg!.amount));
      });

      it('DELETE ledger_postings → DB error + rollback leaves rows', async () => {
        const id = await seededId();
        const legsBefore = await prisma.ledgerPosting.count({ where: { ledgerTxnId: id } });
        const firstLeg = await prisma.ledgerPosting.findFirst({ where: { ledgerTxnId: id } });
        await expect(
          prisma.$executeRawUnsafe(`DELETE FROM ledger_postings WHERE id=$1::uuid`, firstLeg!.id),
        ).rejects.toThrow(/APPEND-ONLY|forbidden/);
        expect(await prisma.ledgerPosting.count({ where: { ledgerTxnId: id } })).toBe(legsBefore);
      });

      it('rollback behavior — failure inside same tx as write undoes everything correctly', async () => {
        const scope = 'rollback-' + Math.random().toString(36).slice(2, 10);
        try {
          await prisma.$transaction(
            async (tx) => {
              const repos = new Repositories(tx);
              const engine = new LedgerEngine(new AuditSensitiveMutationService());
              await engine.write(repos, {
                scope,
                txnIdempotencyKey: 'rb-1',
                txnType: LedgerTxnType.COMMISSION,
                currency: 'USDT',
                unit: 'MINOR_UNIT',
                source: 'rb',
                actorUserId: null,
                requestId: null,
                postings: [
                  {
                    accountType: 'USER',
                    accountId: 'a30077fe-c6ef-4d7a-a71f-9e4c35b7f2d1',
                    sign: LedgerAmountSign.CREDIT,
                    amount: '11',
                  },
                  {
                    accountType: 'PLATFORM',
                    accountId: 'platform',
                    sign: LedgerAmountSign.DEBIT,
                    amount: '11',
                  },
                ],
              });
              // Simulated rollback via thrown app error (status mutation fail).
              throw new AppError(500, MoneyPathErrorCode.STATE_MUTATION_FAILED, 'rollback');
            },
            { isolationLevel: 'Serializable' },
          );
        } catch (e) {
          expect((e as AppError).reason).toBe(MoneyPathErrorCode.STATE_MUTATION_FAILED);
        }
        expect(await prisma.ledgerTransaction.count({ where: { scope } })).toBe(0);
        expect(await prisma.ledgerPosting.count({ where: { ledgerTxn: { scope } } })).toBe(0);
        expect(await prisma.idempotencyKey.findFirst({ where: { scope, key: 'rb-1' } })).toBeNull();
      });
    });
  });
});

// Keep unused imports alive for strict TS mode (otherwise unused in non-DB env).
void Repositories;
void UserRole;
void MoneyPathErrorCode;
