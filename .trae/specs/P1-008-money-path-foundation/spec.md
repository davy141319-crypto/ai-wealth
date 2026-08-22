# P1-008 — Money-Path Foundation（资金路径基础层）

> Status: **SPECIFY REVISION — RESUBMITTED TO CHATGPT FOR APPROVAL.**
> Baseline: `develop@13326d9a0ffe879a8e56f4f584100fa14c0ef948`
> Doc revision: `0.2` (addresses 7 review blockers from v0.1)
> Migration decision: **Option A = APPROVED** (ChatGPT kickoff decision: P1-008 Implement
> may ship exactly 1 Prisma migration adding a generic ledger infrastructure
> schema. No real-fund fields allowed.)
> Hard boundary (THIS SPEC DOCUMENT ONLY): **0 migrations. 0 API. 0 frontend. 0 Docker. 0 commit.**
>
> This spec is **INFRASTRUCTURE-ONLY**. It defines shared contracts every future
> Deposit / Withdraw / Settlement / Commission / Treasury / Testnet fund feature
> MUST depend on. It explicitly **does NOT implement any real fund flow**.

---

## 1. Problem Statement / Users / Goal / Non-Goals

### 1.1 Problem Statement

P1-001…P1-007 have delivered a strict identity, authentication, session, CSRF,
refresh-rotation, live-RBAC and Admin-entry stack. The next phase — any future
money feature — is currently **unbounded**:

1. There is **no immutable append-only double-entry Ledger model / invariant /
   engine** (README + security-baseline §8 require one before any
   USDT/deposit/withdraw).
2. The existing `AuditLog` has **no enforceable contract** for sensitive
   state-changes, no standard before/after/reason/source/correlation metadata
   schema, and no requirement that Admin config mutations must write an audit
   row (security-baseline §9.4 & §11).
3. The existing `SystemConfig` table has **no money-path feature-flag contract**:
   no naming convention, no default-OFF, no fail-closed, no audit-on-flip, no
   explicit rule that flag changes must NOT write a Ledger entry
   (development-rules §13 checklist item #2).
4. There is **no typed Domain Service contract** (`LedgerEngine`,
   `SettlementEngine`, `CommissionEngine`, `RiskEngine`) and no rule forbidding
   Controllers from writing to the DB directly (development-rules §13 checklist
   item #1).
5. There is **no explicit two-phase transaction / consistency contract**
   covering preflight (RBAC+validation+risk I/O) separate from a short
   Serializable DB transaction, rollback semantics, duplicate-request behavior,
   concurrent behavior, retry, and crash-recovery (security-baseline §3, §8;
   development-rules §13).
6. Prisma `schema.prisma` carries a **hard anti-expansion constraint**:
   `FORBIDDEN … ANY real fund field. Those arrive in later phases and must be
testnet-verified first.` — ChatGPT has resolved this in kickoff: P1-008 is
   cleared to add a **generic accounting-only** Ledger data model, because it
   contains zero real-fund columns (no balance, wallet, chain, tx_hash, etc.).

Without P1-008, the next feature that even _touches_ a balance/asset field would
effectively bypass every invariant in §8, §9, §11, §13: append-only,
double-entry balanced, idempotent, reversal-by-new-transaction,
audit-every-mutation, flag-default-off, single-transaction,
single-domain-service-gate, two-phase TOCTOU-safe commit. This spec exists to
close that hole _before_ any balance/deposit/withdraw code is written.

### 1.2 Users / Actors (for ledger / audit / flag contracts)

| Actor                           | Role                                                                    | Allowed / Forbidden                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Authenticated USER**          | end-customer signed in via wallet                                       | May _read_ her own ledger entries only. Must NOT mutate flags or admin-owned domain state.                                    |
| **Authenticated ADMIN**         | operator signed in via Admin P1-007 stack                               | Only operator who may flip money-path flags (via future Admin API, NOT present in P1-008). Every flip writes an AuditLog row. |
| **SYSTEM / WORKER**             | BullMQ worker / scheduled job / callback handler                        | `actor = null`; must still set `source`, `requestId` (or job id).                                                             |
| **Domain Service (internal)**   | `LedgerEngine` / `SettlementEngine` / `CommissionEngine` / `RiskEngine` | Single write-gate for every Ledger transaction. Controllers MUST NOT bypass.                                                  |
| **Anonymous / Unauthenticated** | no session                                                              | All money-path endpoints return 401 or fail-closed (never create ledger entries).                                             |
| **DB migration / DBA**          | schema change                                                           | Manual UPDATE/DELETE on Ledger tables is FORBIDDEN. Reversal/correction = new opposite balanced transaction.                  |

### 1.3 Goal

Define, document, and type every cross-cutting foundation a money-path feature
needs _before_ any concrete fund flow is implemented, including:

1. **Ledger Foundation**: a mandatory double-entry, immutable, append-only,
   idempotent accounting kernel built on `LedgerTransaction` (journal) +
   `LedgerPosting` (entries) with reversal as a brand-new balanced transaction.
2. **Audit Foundation**: a binding contract for every sensitive mutation using
   the _existing columns only_ of `AuditLog`, with a standard
   `{before, after, reason, source, correlation}` metadata schema.
3. **Feature Flag Governance**: default-OFF + fail-closed + audit-on-flip +
   never-a-Ledger-entry for every money-path flag over the existing
   `SystemConfig` table.
4. **Domain Service Contract**: typed `LedgerEngine`, `SettlementEngine`,
   `CommissionEngine`, `RiskEngine` interfaces + a rule forbidding Controllers
   from writing DB directly.
5. **Transaction / Consistency Contract**: explicit two-phase boundaries
   (Phase A preflight for I/O; Phase B short Serializable DB transaction),
   rollback, idempotency, concurrent, retry, crash-recovery behaviors with
   TOCTOU-safe flag re-check inside the DB transaction.
6. **Hard Non-Goals**: a clear list of what P1-008 MUST NOT build, to avoid
   scope drift into real money.

### 1.4 Hard Non-Goals (P1-008 MUST NOT implement any of these)

- USDT deposit, USDT withdraw, or any chain/network transfer;
- Any user "real balance" / "available balance" / "frozen balance" / "USDT
  balance" field / table / view;
- Deposit status; withdrawal status; on-chain transaction; tx_hash; hot wallet;
  wallet custody; private key; chain broadcast;
- Treasury balance (Treasury as an account _type_ is allowed; treasury
  balance-as-a-field is forbidden);
- Wealth products, income / APY / earnings;
- Task hall, invitation commission, team level, V1-V5;
- Gambling, sports, e-sports, lottery, live entertainment;
- Mainnet any-currency flow;
- New public Controller endpoints / routes / REST APIs for money;
- Any Admin frontend page or React component for flags / ledger / audit;
- Any Docker change;
- Any four-eyes / multi-signature / multi-admin-approval policy implementation
  or interface placeholder (that is a future standalone task, not P1-008).

---

## 2. Scope (what P1-008 delivers as contracts + approved migration)

| #   | Module                                 | Deliverable                                                                                                                                                                                                                                                                  | Implemented in P1-008                                                       |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | **Ledger Foundation**                  | Immutable invariants; mandatory double-entry balanced `Σ DEBIT == Σ CREDIT`; idempotency; reversal = new balanced transaction; data model = `LedgerTransaction` + `LedgerPosting[]`; `LedgerEngine` typed interface; **exactly 1 Prisma migration approved under Option A**. | YES (contract only in spec; migration + code delivered later, in Implement) |
| 2   | **Audit Foundation**                   | Reuse _existing columns_ of `AuditLog`; mandatory `metadata = {before, after, reason, source, correlation}` schema for sensitive-state mutations + Admin-flag mutations                                                                                                      | YES                                                                         |
| 3   | **Feature Flag Governance**            | Reuse `SystemConfig`; money-path flag prefix rules; default-OFF; fail-closed; audit-on-write; **ledger entry FORBIDDEN on flag writes**                                                                                                                                      | YES                                                                         |
| 4   | **Domain Service Contract**            | Typed `LedgerEngine` / `SettlementEngine` / `CommissionEngine` / `RiskEngine` interfaces + controller bypass rule                                                                                                                                                            | YES                                                                         |
| 5   | **Transaction / Consistency Contract** | Two-phase (Preflight + short Serializable DB tx), explicit rollback, duplicate, concurrent, retry, crash-recovery rules, TOCTOU flag re-check                                                                                                                                | YES                                                                         |
| 6   | **Hard Non-Goals**                     | Definitive "not P1-008" list blocking 16 classes of scope drift (new: excludes multi-admin approval placeholders)                                                                                                                                                            | YES                                                                         |

Deliverables _in code_ after implement-phase approval: TypeScript interfaces /
abstract classes, a shared `money-path` module, a `FeatureFlagService`, an
upgraded `AuditService` contract, strict unit + live-DB integration tests, a
`docs/architecture/` ledger & audit contract markdown, **one** Prisma migration
for `LedgerTransaction / LedgerPosting` (approved Option A), and zero real-fund
fields. This spec itself writes zero code or migration.

---

## 3. Module 1 — Ledger Foundation

### 3.1 Invariants (Ledger Invariants — formalized)

| ID    | Invariant                                                                                                                                                                                                                                                                                                                                                                                                                                               | Enforcement                                                                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LI-01 | **Append-only across both tables.** No code path, worker, migration, or admin tool is allowed to `UPDATE` or `DELETE` any row in `ledger_transactions` or `ledger_postings`. Reversal = brand-new balanced transaction.                                                                                                                                                                                                                                 | DB-level `REVOKE UPDATE/DELETE` (or equivalent trigger) + CI tests asserting `.update()`/`.delete()` calls against the models throw or are absent.       |
| LI-02 | **Account balance is DERIVED, never stored.** For any `(accountType, accountId, currency, unit)`, the signed `SUM( postings.amount × postings.sign )` across all committed postings — equals the logical "balance" of that account at any moment. No `users.balance`, no `wallets.balance`, no parallel ledger materialized view in P1-008.                                                                                                             | Integration test: seed N balanced transactions, assert derived balance matches sum. Static rule: no `balance` column in any migration PR.                |
| LI-03 | **Double-entry mandatory, per-transaction × per currency × per unit.** Within one `LedgerTransaction`, all postings must share the same `(currency, unit)`, and `SUM( postings.amount where sign=DEBIT ) == SUM( postings.amount where sign=CREDIT )`. No batch, no settlement, no transfer, no commission, no treasury move, no reversal, no manual admin entry — is ever half-balanced. The "optional" / "single-entry" concept from v0.1 is deleted. | Engine-level assertion inside `LedgerEngine.write()` before any DB call; plus a Postgres `CONSTRAINT CHECK` or a commit-time trigger as belt-and-braces. |
| LI-04 | **Per-transaction idempotency.** Every `LedgerTransaction` carries `scope: VarChar` + `txnIdempotencyKey: VarChar`; `UNIQUE(scope, txn_idempotency_key)`. Two writes with the same `(scope, key)` return the existing `txnId` + posting IDs and write zero additional rows. Per-posting idempotency is deleted: idempotency belongs to the journal, not individual legs.                                                                                | DB unique index + `createMany` conflict return of existing IDs.                                                                                          |
| LI-05 | **Reversal = a new balanced LedgerTransaction, never an UPDATE of history.** Reversal/correction creates a new `LedgerTransaction(entryType=REVERSAL, reversesTxnId → originalTxn, FK ON DELETE RESTRICT)`. Inside it, the reversal postings set `reversesPostingId → originalPosting` for each individual leg with opposite sign. The original transaction + its postings are byte-identical after reversal.                                           | FK cascade restriction + integration test selecting original rows after `reverse()` returns and comparing byte-for-byte.                                 |
| LI-06 | **Provenance fields on transaction, not per-posting.** Each `LedgerTransaction` has exactly one: `source` (`ledger`/`settlement`/`commission`/`risk`/`treasury`/`manual_admin`), nullable `reference`, nullable `actorUserId`, nullable `requestId`. Per-posting provenance is not repeated (avoids drift). Postings describe _account+amount+sign_.                                                                                                    | Not-null DB columns + typescript interface.                                                                                                              |
| LI-07 | **Atomic integer units stored as NUMERIC(scale=0) / Prisma Decimal.** JS `number` is FORBIDDEN from any amount arithmentic. All amounts are positive integers in the asset's minor unit (e.g. USDT 6 decimals → `1000000` = 1 USDT). The `currency + unit + decimals` triple on each transaction interprets it.                                                                                                                                         | TypeScript types (no `number` on `amount`); lint rule; runtime assertion before DB write.                                                                |
| LI-08 | **No real-fund field creep.** Both tables are strictly accounting abstractions. FORBIDDEN columns anywhere in P1-008 migration: `wallet_address`, `wallet_id`, `chain`, `network`, `tx_hash`, `on_chain_tx`, `deposit_id`, `withdrawal_id`, `status` (of deposit/withdraw), `balance_available`, `balance_frozen`, `private_key`, `hot_wallet`. Those belong to future Settlement / Treasury domain tables, not the foundational accounting kernel.     | Review gate + static schema rule.                                                                                                                        |
| LI-09 | **Each posting belongs to exactly one account triple** (`accountType`, `accountId`) and inherits `(currency, unit, decimals)` from its parent transaction via construction. Mixing currencies inside one journal transaction is FORBIDDEN. Cross-currency transfers must create two transactions + a rate metadata reference.                                                                                                                           | Engine assert + test.                                                                                                                                    |

### 3.2 Approved Ledger data model (Option A — 1 Prisma migration; contract only — NOT a migration yet)

```prisma
// ============================================================================
// PROPOSED P1-008 PRISMA SCHEMA — Option A APPROVED
//
// Generic accounting infrastructure ONLY. Strictly zero real-fund fields.
// Migration delivers ONE new file in packages/database/prisma/migrations/.
//
// Two enums + two tables:
//   LedgerTxnType     — logical event classification
//   LedgerAmountSign  — DEBIT (decrease on the account) / CREDIT (increase)
//   LedgerTransaction — one journal = one atomic balanced value-move event
//   LedgerPosting     — one leg of the journal, one account, one sign, one amount
//
// Invariants enforced by schema + engine:
//   * UNIQUE(scope, txn_idempotency_key) on LedgerTransaction
//   * reverses_txn_id FK → LedgerTransaction.id ON DELETE RESTRICT
//   * reverses_posting_id FK → LedgerPosting.id ON DELETE RESTRICT (for each leg)
//   * amount @db.Decimal(38,0) — atomic integer units; no floating storage ever
//   * Both tables append-only via DB REVOKE/trigger in migration SQL
// ============================================================================

enum LedgerTxnType {
  SETTLEMENT     // SettlementEngine output (one journal per batch)
  COMMISSION     // CommissionEngine output (user/referrer/platform legs)
  TREASURY_MOVE  // Treasury internal move between treasury accounts
  TRANSFER       // Account-to-account internal atomic move (future)
  REVERSAL       // A reversal of a prior LedgerTransaction (balanced opposite)
  MANUAL_ADMIN   // Admin-initiated journal, gated by flag money.flags.manual_admin_enabled
  OPENING_BALANCE // Reserved for testnet-seed opening ledgers (mainnet FORBIDDEN)
}

enum LedgerAmountSign {
  DEBIT   // decreases the account's derived balance
  CREDIT  // increases the account's derived balance
}

/// Immutable journal header. One balanced value-move event.
/// NO UPDATE / DELETE ever. Append-only.
model LedgerTransaction {
  id                String         @id @default(uuid()) @db.Uuid

  // Exactly-once write per logical operation (engine-level + DB-level unique)
  scope             String         @db.VarChar(64)   // "commission/2026-08" / "treasury/batch-42"
  txnIdempotencyKey String         @map("txn_idempotency_key") @db.VarChar(128)

  // Accounting classification
  txnType           LedgerTxnType  @map("txn_type")

  // Asset dimension — ALL postings under this txn share these three
  currency          String         @db.VarChar(16)   // e.g. "USDT"
  unit              String         @db.VarChar(16)   // e.g. "MINOR_UNIT" / "TOKEN"
  decimals          Int            @default(6)       // how to interpret atomic integers

  // Provenance (set once per journal, not repeated on postings)
  source            String         @db.VarChar(32)   // ledger|settlement|commission|risk|treasury|manual_admin
  reference         String?        @db.VarChar(256)  // e.g. settlement batch id, operation id

  // Reversal linkage at JOURNAL level (ON DELETE RESTRICT so we can never erase the reversed-txn)
  reversesTxnId     String?        @map("reverses_txn_id") @db.Uuid
  reversesTxn       LedgerTransaction? @relation("TxnReversal", fields: [reversesTxnId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  reversedByTxns    LedgerTransaction[] @relation("TxnReversal")

  // Actor + trace
  actorUserId       String?        @map("actor_user_id") @db.Uuid
  requestId         String?        @map("request_id") @db.VarChar(64)

  // Free-form context (reversal reason, engine version, etc). NEVER put secrets.
  metadata          Json?

  createdAt         DateTime       @default(now()) @map("created_at")

  postings          LedgerPosting[]

  @@unique([scope, txnIdempotencyKey], map: "ledger_txn_scope_idempotency_uq")
  @@index([txnType, createdAt], map: "ledger_txn_type_created_idx")
  @@index([source], map: "ledger_txn_source_idx")
  @@index([reversesTxnId], map: "ledger_txn_reverses_idx")
  @@index([actorUserId, createdAt], map: "ledger_txn_actor_idx")
  @@map("ledger_transactions")
}

/// One leg of a journal. Always ≥2 rows per transaction (double-entry balanced).
/// NO UPDATE / DELETE ever. Append-only. amount is a NON-NEGATIVE integer stored
/// as Decimal(38, 0) — atomic minor units. The sign + account triple determine
/// the direction on the derived balance.
model LedgerPosting {
  id                String            @id @default(uuid()) @db.Uuid

  // Parent journal
  ledgerTxnId       String            @map("ledger_txn_id") @db.Uuid
  ledgerTxn         LedgerTransaction @relation(fields: [ledgerTxnId], references: [id], onDelete: Restrict, onUpdate: Cascade)

  // Account triple. Not a wallet address. Not a user row — pure accounting bucket.
  accountType       String            @map("account_type") @db.VarChar(32) // USER | PLATFORM | TREASURY | REFERRER | RESERVE
  accountId         String            @map("account_id")   @db.VarChar(128) // user_id / "platform" / treasury-id

  // Sign: DEBIT / CREDIT. Direction on account balance; amount itself is always positive.
  sign              LedgerAmountSign

  // Amount: non-negative atomic integer.
  // Use Prisma Decimal → BigDecimal. JS number is FORBIDDEN from every path.
  amount            Decimal           @db.Decimal(38, 0)

  // Per-posting reversal linkage (only set inside a REVERSAL-type transaction)
  reversesPostingId String?           @map("reverses_posting_id") @db.Uuid
  reversesPosting   LedgerPosting?    @relation("PostingReversal", fields: [reversesPostingId], references: [id], onDelete: Restrict, onUpdate: Cascade)
  reversedByPosting LedgerPosting[]   @relation("PostingReversal")

  @@index([ledgerTxnId], map: "ledger_posting_txn_idx")
  @@index([accountType, accountId], map: "ledger_posting_account_idx")
  @@index([reversesPostingId], map: "ledger_posting_reverses_idx")
  @@map("ledger_postings")
}
```

**Plan-phase precision decision**: `@db.Decimal(38, 0)` is the Spec default. The
Implement Plan can narrow to `Decimal(24, 0)` or expand to `Decimal(64, 0)` based
on PostgreSQL numeric-storage limits and Treasury max estimates. Scale is
**fixed to 0** — we store integer atomic units only.

### 3.3 LedgerEngine TypeScript Interface (contract only)

```ts
// services/api/src/money-path/ledger/ledger.engine.ts (NOT LANDED — P1-008 spec)
import type { Prisma, LedgerTxnType, LedgerAmountSign } from '@ai-wealth/database';

export interface LedgerJournalRequest {
  scope: string; // e.g. 'commission/month-2026-08'
  txnIdempotencyKey: string; // UNIQUE(scope, this)

  txnType: LedgerTxnType;

  // Asset dimension — identical for ALL postings inside this journal
  currency: string;
  unit: string;
  decimals?: number; // default 6 per schema

  source: 'ledger' | 'settlement' | 'commission' | 'risk' | 'treasury' | 'manual_admin';
  reference?: string;

  postings: Array<{
    accountType: 'USER' | 'PLATFORM' | 'TREASURY' | 'REFERRER' | 'RESERVE';
    accountId: string;
    sign: LedgerAmountSign;
    amount: string; // Decimal string, non-negative integer atomic units.
    // NOTE: string on the wire to avoid any number→Decimal loss;
    // Engine converts via Prisma.Decimal() and validates integer-ness.
    reversesPostingId?: string; // only set inside a REVERSAL journal
  }>;

  // Provenance propagated to parent LedgerTransaction
  actorUserId?: string;
  requestId?: string;
  metadata?: unknown;

  tx: Prisma.TransactionClient; // always Phase B transaction (§7)
}

export interface LedgerEngine {
  /**
   * Append one balanced journal inside the running Phase B Prisma tx.
   *
   * Preconditions enforced inside:
   *   - postings.length >= 2
   *   - Σ DEBIT amount == Σ CREDIT amount (same unit; atomic integer compare)
   *   - all amounts are integer numeric >= 0 (no JS number anywhere)
   *   - each account triple populated
   *
   * @return existing or new txnId + postingIds + `replayed: boolean`
   *         when UNIQUE(scope, txnIdempotencyKey) hit.
   * @throws on invariant failure or DB fault.
   */
  write(
    req: LedgerJournalRequest,
  ): Promise<{ txnId: string; postingIds: string[]; replayed: boolean }>;

  /**
   * Create a brand-new balanced REVERSAL LedgerTransaction referencing
   * `txnId`, with individual postings referencing the original legs via
   * reversesPostingId each and opposite sign.
   *
   * NEVER performs UPDATE/DELETE on the original rows.
   */
  reverseTxn(
    txnId: string,
    reason: string,
    ctx: { actorUserId?: string; requestId?: string; tx: Prisma.TransactionClient },
  ): Promise<{ reversalTxnId: string }>;

  /**
   * Derive balance for an account triple — read-only aggregation,
   * never a stored balance lookup. Returns Decimal-compatible string
   * (atomic integer) + decimals for consumer display.
   */
  balance(args: {
    accountType: string;
    accountId: string;
    currency: string;
    unit: string;
  }): Promise<{ amount: string /* atomic integer */; decimals: number }>;
}
```

---

## 4. Module 2 — Audit Foundation

### 4.1 Audit ≠ Ledger (explicit distinction)

| Concern                                       | `AuditLog` (human / security trace — existing table unchanged)                        | `LedgerTransaction + Postings` (accounting kernel)                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Purpose**                                   | Who changed what state, when, from where, why, correlation id, before/after snapshot. | Atomic balanced value movement.                                               |
| **Immutability**                              | Effective append-only; policy recommendation.                                         | **Hard** immutable: UPDATE/DELETE REVOKEd + tests.                            |
| **Before / After**                            | Mandatory on state changes, but stored inside `metadata Json?` — no new DB columns.   | N/A.                                                                          |
| **Actor**                                     | req.auth.userId / null. Always populated when known.                                  | actorUserId on LedgerTransaction.                                             |
| **Request ID**                                | req.id / job.id.                                                                      | requestId on LedgerTransaction.                                               |
| **Money math**                                | Not required.                                                                         | **Σ DEBIT == Σ CREDIT per txn; Σ(sign×amount) derived balance invariant.**    |
| **Flag flips**                                | **Mandatory row.** action=`SYSTEM_CONFIG_UPDATED`.                                    | **FORBIDDEN.** Flag writes create exactly 0 rows in both ledger tables.       |
| **Manual Admin correction / Ledger reversal** | Audit row required.                                                                   | Creates a new REVERSAL transaction + opposite postings. Never edits old rows. |

### 4.2 Audit invariant contract (5 rules, unchanged enforcement location: existing `AuditLog` columns ONLY)

| ID    | Invariant                                                                                                                                                                                                                          |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI-01 | Every sensitive state mutation MUST insert an `AuditLog` row in the **same DB transaction** (Phase B) as the mutation. Rollback of the Phase B transaction must roll back both the business mutation and its AuditLog row.         |
| AI-02 | Every Admin-initiated `SystemConfig` write targeting a `money.flags.*` key MUST write an `AuditLog` (action=`SYSTEM_CONFIG_UPDATED`, resource=`system_config:{key}`). No exception.                                                |
| AI-03 | Every future User-status / User-role / Wallet-status / any-money-state mutation / any `LedgerEngine.reverseTxn()` / any source=`manual_admin` journal — MUST populate `AuditLog.metadata` per the standard schema defined in §4.3. |
| AI-04 | Column population: `actor_user_id = req.auth.userId                                                                                                                                                                                | null`; `request_id = req.id | job.id`; `ip + user_agent` populated on HTTP routes (system-worker may leave null). These columns exist today — no schema modification. |
| AI-05 | Audit service NEVER writes a LedgerTransaction or LedgerPosting. Ledger journals driven by an operator NEVER skip writing the AuditLog row.                                                                                        |

### 4.3 Standard `AuditLog.metadata` schema (no new DB columns)

All Audit-sensitive writes shall set `AuditLog.metadata` to this JSON envelope
(nested inside the existing `metadata Json?` column). Partial metadata is
FORBIDDEN; if any field is absent, it must be explicitly `null` — never omitted.

```ts
// CONTRACT-ONLY. P1-008 defines it; Implement enforces via typing.
export interface AuditMetadataEnvelope {
  /** Row/config/object as it existed immediately prior to the mutation.
   *  For inserts, before = null. */
  before: unknown | null;
  /** Row/config/object as it exists immediately after the mutation. */
  after: unknown | null;
  /** Free-form explanation. For reversals: the `reason` string passed to
   *  reverseTxn(). For flag flips: admin description (optional). For money
   *  state mutations: operation classification. */
  reason: string | null;
  /** Which module produced it. Matches ledger txn source where applicable. */
  source:
    | 'auth'
    | 'rbac'
    | 'flags'
    | 'settlement'
    | 'commission'
    | 'treasury'
    | 'ledger'
    | 'manual_admin'
    | 'system'
    | string;
  /** Opaque caller correlation id. Same as, or linked to, the parent
   *  idempotency key / request id / ledger reference. */
  correlation: string | null;
}
```

### 4.4 Contract signature for `AuditService` (augments existing `services/api/src/auth/audit.service.ts`)

```ts
// CONTRACT-ONLY. Not landed until implement-phase approved.
export type AuditAction =
  | 'SYSTEM_CONFIG_UPDATED' // flag flips etc
  | 'USER_STATUS_UPDATED'
  | 'USER_ROLE_UPDATED'
  | 'WALLET_STATUS_UPDATED'
  | 'MONEY_STATE_MUTATED' // catch-all for future deposit/withdraw/settlement
  | 'LEDGER_REVERSAL' // every LedgerEngine.reverseTxn emits one
  | 'MANUAL_ADMIN_ENTRY'; // source=manual_admin ledger journal emits one

export interface AuditSensitiveMutationArgs {
  action: AuditAction;
  resource: string; // e.g. "system_config:money.flags.testnet_deposit_enabled"

  // Standard envelope (assembled into AuditLog.metadata by the service)
  envelope: AuditMetadataEnvelope;

  actorUserId?: string;
  requestId?: string;
  ip?: string;
  userAgent?: string;

  /** Must be Phase B same tx as business mutation. */
  tx: Prisma.TransactionClient;
}
```

---

## 5. Module 3 — Feature Flag Governance

### 5.1 Reuse existing `SystemConfig`

No new table. P1-008 defines the contract only.

### 5.2 Feature Flag Invariants (8 rules; 第7,8 条保留明确边界)

| ID    | Invariant                                                                                                                                                                                                                                                                  |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FI-01 | **Naming convention.** Every money-path flag key MUST match the literal template `money.flags.<scope>.<feature>`. All other keys are ignored by the governance contract.                                                                                                   |
| FI-02 | **Default OFF.** Missing row OR `isActive=false` OR value parse failure → treated as OFF. No default-ON anywhere. Ever.                                                                                                                                                    |
| FI-03 | **Fail-closed.** DB connection down, parse failure, unknown flag name → dependent endpoint MUST behave identically to OFF and return 403/503. Never allow through.                                                                                                         |
| FI-04 | **RBAC.** Writing `money.flags.*` rows requires `@Roles(UserRole.ADMIN)` via P1-006 RolesGuard. USER / anonymous MUST receive 403. Additionally, `FeatureFlagService.setFlag` double-checks the actorUserId's live role inside its transaction.                            |
| FI-05 | **Audit-on-write.** Every `money.flags.*` INSERT / UPDATE / soft-deactivate (`isActive=false`) MUST emit an `AuditLog` via `AuditService.sensitiveMutation(action=SYSTEM_CONFIG_UPDATED, envelope = {before, after, reason?, source='flags', correlation=<txn/flag id>})`. |
| FI-06 | **Flag writes ≠ Ledger.** Changing a flag MUST insert exactly 0 rows into both `ledger_transactions` AND `ledger_postings`. Config changes are NOT financial postings. **This boundary is invariant.**                                                                     |
| FI-07 | **Gate at Domain entrypoint, and again inside Phase B DB transaction.** Initial check in Phase A preflight; TOCTOU-safe re-check inside the short Serializable transaction. If the flag was flipped between A and B, Phase B aborts cleanly.                               |
| FI-08 | **Testnet gate mandatory.** For every future money feature `X` the two keys `money.flags.testnet_<X>_enabled` and `money.flags.mainnet_<X>_enabled` exist; both default OFF. Flipping `mainnet_*` requires `testnet_*` to already exist and parse as ON at `setFlag` time. |

### 5.3 Typed contract

```ts
// CONTRACT-ONLY. Not landed until implement-phase approved.
export interface FeatureFlagService {
  /** Lookup a flag using the governance convention. May throw on DB error. */
  isEnabled(flag: `money.flags.${string}`): Promise<boolean>;

  /** Fail-closed wrapper. Returns false on any fault. Never throws. */
  isEnabledSafe(flag: `money.flags.${string}`): Promise<boolean>;

  /**
   * Admin-only mutation.
   * - Always runs inside a transaction.
   * - Writes SystemConfig.
   * - Writes AuditLog (source=flags; before/after; source; correlation).
   * - WRITES EXACTLY ZERO LEDGER ROWS. Violations throw.
   * - Before writing a `mainnet_*_enabled = true`, verifies that
   *   corresponding `testnet_*_enabled` exists, isActive=true, value parses to true.
   */
  setFlag(args: {
    key: `money.flags.${string}`;
    value: string;
    valueType: SystemConfigValueType;
    description?: string;
    isActive: boolean;
    actorUserId: string;
    requestId?: string;
    ip?: string;
    userAgent?: string;
    envelopeReason?: string | null;
    correlation?: string | null;
    tx: Prisma.TransactionClient;
  }): Promise<void>;
}
```

### 5.4 Testnet-gate contract

The first real fund feature (e.g. P1-009+ Testnet Deposit) SHALL define both:

1. `money.flags.testnet_deposit_enabled` (BOOLEAN, default OFF until Admin flips it ON).
2. `money.flags.mainnet_deposit_enabled` (BOOLEAN, default OFF).

Minimum soak / metrics policy for the transition from testnet to mainnet is
NOT specified by P1-008 and SHALL be defined by the concrete Testnet Deposit
spec's own approval gates. P1-008 only enforces existence + current state.

---

## 6. Module 4 — Domain Service Contract

### 6.1 Interfaces (contract only, unlanded)

```ts
// Proposed package layout in Implement:
//   services/api/src/money-path/
//     ledger/ledger.engine.ts
//     settlement/settlement.engine.ts
//     commission/commission.engine.ts
//     risk/risk.engine.ts
//     flags/feature-flag.service.ts
//     audit/audit-sensitive-mutation.service.ts
//
// RULE-CONTROLLER-DB-NO-DIRECT applies to every sub-module.
```

```ts
import type { Prisma } from '@ai-wealth/database';

export interface SettlementEngine {
  /** Phase A: validation + external risk + return a proposed balanced journal
   *  posting plan suitable to hand to LedgerEngine.write inside Phase B.
   *  Preflight ALLOWS external I/O (chain lookups, risk service HTTP calls). */
  preflight(batchId: string, ctx: MoneyDomainPreflightCtx): Promise<SettlementPreflight>;

  /** Phase B: commit plan. MUST NOT perform external I/O — only DB + Engine
   *  calls inside the short Serializable tx. */
  settle(plan: SettlementPreflight, ctx: MoneyDomainCommitCtx): Promise<SettleResult>;
}

export interface CommissionEngine {
  preflight(operationId: string, ctx: MoneyDomainPreflightCtx): Promise<CommissionPreflight>;
  apply(plan: CommissionPreflight, ctx: MoneyDomainCommitCtx): Promise<CommissionResult>;
}

export interface RiskEngine {
  /** Runs in PHASE A ONLY so network/chain calls do not hold DB locks.
   *  Returns PASS / BLOCK + reasons. */
  evaluatePreflight(input: RiskPreflightInput): Promise<RiskResult>;
}

export type MoneyDomainPreflightCtx = {
  actorUserId?: string;
  requestId?: string;
  source: 'settlement' | 'commission' | 'treasury' | 'manual_admin';
  requiredFlags: Array<`money.flags.${string}`>;
};

export type MoneyDomainCommitCtx = {
  actorUserId?: string;
  requestId?: string;
  source: 'settlement' | 'commission' | 'treasury' | 'manual_admin';
  requiredFlags: Array<`money.flags.${string}`>;
  tx: Prisma.TransactionClient;
  idempotencyScope: string;
  idempotencyKey: string;
};
```

Key difference from v0.1: Risk evaluate runs in **Phase A (Preflight)**. The
short Phase B Serializable DB transaction contains NO external I/O.

### 6.2 Controller bypass rule (retained explicitly as audit/engineering invariant)

- **RULE-CONTROLLER-DB-NO-DIRECT**: For every class of money mutation — deposit,
  withdraw, settle, commission, reversal, treasury move, manual_admin entry,
  flag mutation — the Controller layer SHALL ONLY call a Domain Service method.
  It SHALL NEVER call `prisma.ledgerTransaction.create()`,
  `prisma.ledgerPosting.create()`, `prisma.systemConfig.update()`, or
  `prisma.auditLog.create()` directly.
- Enforcement: static ESLint rule + Jest moduleNameMapper block that throws if
  a controller file imports `@ai-wealth/database` Prisma client for money-table
  write paths.

---

## 7. Module 5 — Two-Phase Transaction / Consistency / Idempotency Contract

### 7.1 Why two phases

The v0.1 single-transaction design held **FeatureFlag → Risk → State → Ledger
→ Audit** all inside one Serializable DB tx. That is unsafe because:

- `RiskEngine.evaluate` can legitimately call chain lookups, external risk
  services, 3rd-party KYC — network I/O with unbounded latency.
- Long-running Serializable transactions create contention, serialization
  failures, and idle DB locks.
- TOCTOU: flag can be flipped between a pre-transaction read and commit.

P1-008 therefore splits the lifecycle into **Phase A (Preflight, no DB tx,
permitted to do I/O) + Phase B (very short Serializable DB tx, NO I/O)** with
a flag re-check inside the DB transaction.

### 7.2 Phase A — Preflight (outside any DB transaction)

```
[ HTTP request / BullMQ job handler begins ]
  A1. Authentication + RBAC (JwtAuthGuard + RolesGuard)           — 401/403 fast reject
  A2. Input validation (Zod / class-validator)                    — 400 on bad shape
  A3. Compute requestHash = canonical SHA-256 of the signed body  — stored for idempotency
  A4. Initial Feature Flag check (isEnabledSafe for all declared requiredFlags)
                                                                  — fail → 403/503, NO rows
  A5. RiskEngine.evaluatePreflight(...)                           — BLOCK → 403 + structured reasons
  A6. Build a deterministic commit plan: (state mutation plan, balanced journal posting plan,
      required audit envelope, idempotency scope+key)
  A7. Return plan to orchestrator
```

**Phase A is idempotent-safe to retry.** No DB rows are written. It performs
all slow/IO-heavy work.

### 7.3 Phase B — Serializable DB Transaction (extremely short, NO I/O)

```
[ NEW Prisma.$transaction with isolationLevel = Serializable, timeout ≤ 2s ]
  B1. RE-CHECK requiredFlags via isEnabled inside the transaction.
      If flag changed between A4 and now: abort tx, return 409/FLAG_RACE.    → TOCTOU guard
  B2. Acquire concurrency locks (SELECT FOR UPDATE or advisory locks) where
      required by the concrete money operation TBD in future spec.
  B3. Idempotency CLAIM:
        INSERT INTO idempotency_keys(scope, key, requestHash, status=PENDING)
        IF UNIQUE(scope,key) conflict AND existing.status === COMPLETED:
             → return cached (responseCode, responseBody) and end tx here.
        IF conflict AND existing.status === PENDING:
             → short wait-or-fail with 409 IDEMPOTENCY_INFLIGHT.
        IF conflict AND existing.requestHash !== current.requestHash:
             → throw 409 IDEMPOTENCY_CONFLICT.
  B4. Business state INSERT / UPDATE (concrete fields TBD per-money task).
  B5. LedgerEngine.write( balanced plan from A6 ) → write 1 LedgerTransaction + N postings
        (engine re-asserts Σ DEBIT == Σ CREDIT, UNIQUE(scope+idempotencyKey))
  B6. AuditService.sensitiveMutation( per-contract §4.4 ) → write 1 AuditLog row
  B7. Idempotency COMPLETE:
        UPDATE idempotency_keys
        SET status = COMPLETED, responseCode=…, responseBody=…
        WHERE scope = ? AND key = ? AND status = PENDING        → exactly-one row update
  B8. COMMIT
```

**Rules inside Phase B:**

- **NO network I/O**. No chain RPC, no external API calls, no RiskEngine
  network call inside the transaction.
- `isolationLevel = Serializable` by default. RepeatableRead fallback only
  with documented benchmark proof. ReadCommitted FORBIDDEN for money-path
  commits.
- Rollback on ANY exception in B1..B7. No partial commit.
- If step B7 updates 0 rows (someone else raced PENDING → COMPLETED), treat as
  idempotency replay and fetch the cached response.
- `status` values for `IdempotencyKey` are strictly **`PENDING` / `COMPLETED` /
  `FAILED`** to match existing `IdempotencyStatus` enum in the baseline. P1-008
  does NOT add `DONE` to Prisma enums.

### 7.4 Failure outcome matrix

| Step in Phase B                                                           | Failure                     | Outcome                                                                                        |
| ------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------- |
| B1 flag re-check flipped                                                  | Race between A and B        | Rollback tx entirely. Return 409 FLAG_RACE_Flipped. Caller retries with same idempotency key.  |
| B2 lock timeout                                                           | Contention                  | Tx abort with timeout. Service wrapper retries Phase B **exactly once** automatically.         |
| B3 claim unique conflict vs COMPLETED                                     | Replay                      | Return cached response. Zero side effects. No retry.                                           |
| B3 claim unique conflict vs PENDING                                       | In-flight collision         | Return 409 IDEMPOTENCY_INFLIGHT. Client retries later.                                         |
| B3 hash mismatch                                                          | Same key, different payload | Return 409 IDEMPOTENCY_CONFLICT.                                                               |
| B4 state mutation fail                                                    | Validator/constraint        | Rollback. Idempotency → FAILED.                                                                |
| B5 ledger invariant fail (Σ not balanced / amount<=0 / decimals mismatch) | Engine assert               | Rollback. Idempotency → FAILED.                                                                |
| B6 audit write fail                                                       | DB / constraint             | Rollback together. Both state + ledger vanish.                                                 |
| B7 UPDATE sets 0 rows                                                     | Racer finalized first       | Treat as replay.                                                                               |
| B7 DB exception                                                           | Infrastructure              | Rollback. Idempotency row remains PENDING; cleaned by worker TTL.                              |
| **Post-COMMIT crash, before response delivery**                           | Partial observability       | Retry with same (scope, key) → B3 finds COMPLETED → replays cached response. No double-ledger. |

### 7.5 Retry contract

| Layer                                       | Max auto retries                                  | Trigger                                                           | Behavior                                                        |
| ------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Phase A + Phase B top-level wrapper         | 1                                                 | PostgreSQL `40001 serialization_failure` or Phase B2 lock timeout | Rerun Phase A fresh + Phase B. Reuses the same idempotency key. |
| Idempotency unique conflict on ledger write | 0 — engine returns existing txnId via replay path | `UNIQUE ledger_txn_scope_idempotency_uq` hit in B5                | No-op.                                                          |
| B7 idempotency 0 rows updated               | 0                                                 | Racer wins.                                                       | Lookup cached response.                                         |
| HTTP 5xx upstream callback (not in P1-008)  | N/A                                               | N/A                                                               | Future spec. P1-008 only forbids such I/O from Phase B.         |

### 7.6 Idempotency alignment with baseline IdempotencyStatus

- Baseline frozen schema enum `IdempotencyStatus = PENDING / COMPLETED / FAILED`.
- Spec now uses only these three labels. The word `DONE` is removed from the
  document entirely.
- Crash recovery contract (unchanged but re-stated clearly): Phase B commits
  `(B4 state + B5 ledger + B6 audit + B7 idempotency → COMPLETED)` atomically
  in one tx; therefore an after-commit crash will always have a COMPLETED row
  for the same (scope, idempotencyKey) to replay from.

---

## 8. Migration Decision & Boundary

### 8.1 Decision: Option A = APPROVED

ChatGPT kickoff review formally selected Option A for P1-008.

**What Implement is authorized to deliver:**

- Exactly **1** new Prisma migration.
- It SHALL contain ONLY:
  - `enum LedgerTxnType`;
  - `enum LedgerAmountSign`;
  - `model LedgerTransaction` (per §3.2);
  - `model LedgerPosting` (per §3.2);
  - Any `CREATE EXTENSION` / trigger / `REVOKE UPDATE/DELETE` SQL needed to
    enforce LI-01 on both tables (additive only).

**What Implement SHALL NOT introduce in that migration:**

- `user balance`, `available balance`, `frozen balance`, `USDT balance`;
- `deposit` / `withdrawal` / `on_chain_tx` / `tx_hash` tables or columns;
- `hot_wallet` / `private_key` / `chain` / `network` / `wallet_custody` columns;
- `treasury_balance` (only `accountType=TREASURY` as an account bucket);
- Any new enum value for `UserRole`, `UserStatus`, `WalletStatus`, or any
  modification of NON-ledger P1-001 tables.

### 8.2 (Resolved) Why not Option B

Option B (contract-only + in-memory engine) was considered in v0.1. With the
explicit A approval above, Option B is now WITHDRAWN from this spec. References
are removed. P1-008 Implement produces exactly 1 Prisma migration.

---

## 9. Functional Requirements (FR) / Non-Functional (NFR) / Security Requirements (SR)

### 9.1 Functional Requirements (FR) — revision 0.2

| #     | Requirement                                                                                                                                                                                                                          |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| FR-01 | Expose typed `LedgerEngine` interface: `write / reverseTxn / balance` per §3.3. Journals only. No "single posting" API.                                                                                                              |
| FR-02 | `write()` succeeds inside a Phase B transaction; duplicate `(scope, txnIdempotencyKey)` returns the existing `txnId` + postingIds with `replayed=true` and inserts 0 new rows in either ledger table.                                |
| FR-03 | `write()` enforces double-entry: postings.length ≥ 2; Σ DEBIT == Σ CREDIT; same (currency, unit) across all postings. Throws on violation.                                                                                           |
| FR-04 | `reverseTxn(txnId, reason)` creates a new `LedgerTransaction` of type REVERSAL with reversesTxnId → original, and per-leg `reversesPostingId` with opposite sign; original transaction + posting rows are byte-identical afterwards. |
| FR-05 | `balance()` computes derived balance via aggregation only. Never reads stored balance column or view.                                                                                                                                |
| FR-06 | Provide `FeatureFlagService.isEnabled / isEnabledSafe / setFlag` per §5.3.                                                                                                                                                           |
| FR-07 | `isEnabledSafe()` swallows any DB/runtime exception → returns false.                                                                                                                                                                 |
| FR-08 | `setFlag()` writes exactly 1 `SystemConfig` row + exactly 1 `AuditLog` row in the same tx + 0 ledger rows.                                                                                                                           |
| FR-09 | `setFlag(mainnet_<X>_enabled = true)` aborts unless matching `testnet_<X>_enabled` exists, isActive=true, parses as BOOLEAN true.                                                                                                    |
| FR-10 | Provide `AuditService.sensitiveMutation(args per §4.4)` that writes 1 `AuditLog` with metadata conforming to `AuditMetadataEnvelope {before, after, reason, source, correlation}`.                                                   |
| FR-11 | Define typed `SettlementEngine` interfaces split into Preflight (I/O OK, no tx) + Commit (no I/O, within Phase B tx).                                                                                                                |
| FR-12 | Define typed `CommissionEngine` interfaces split into Preflight + Commit on the same lines.                                                                                                                                          |
| FR-13 | Define typed `RiskEngine.evaluatePreflight` interface that runs in Phase A only, never inside Phase B.                                                                                                                               |
| FR-14 | RULE-CONTROLLER-DB-NO-DIRECT enforceable in tests: money-writing controllers must not import Prisma client for `LedgerTransaction / LedgerPosting / AuditLog / SystemConfig` writes.                                                 |
| FR-15 | Every money commit path implements the Phase A → Phase B two-phase lifecycle per §7.2/§7.3.                                                                                                                                          |
| FR-16 | Phase B transaction defaults to Serializable isolation; RepeatableRead requires benchmark proof.                                                                                                                                     |
| FR-17 | Idempotency lifecycle uses ONLY the baseline values `PENDING / COMPLETED / FAILED` and never adds `DONE`.                                                                                                                            |
| FR-18 | Phase B performs the flag re-check (step B1) inside the DB transaction against committed rows.                                                                                                                                       |

### 9.2 Non-Functional Requirements (NFR) — revision 0.2

| #      | Requirement                                                                                                                                                                                                       |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-01 | Phase B total latency (B1..B8) p95 ≤ 40 ms on baseline Postgres 16 / 2 vCPU for a 4-posting journal.                                                                                                              |
| NFR-02 | `balance()` for an account triple with ≤ 100k postings returns ≤ 150 ms using the posting account index.                                                                                                          |
| NFR-03 | Idempotency replay of an already COMPLETED request adds ≤ 5 ms.                                                                                                                                                   |
| NFR-04 | No private-key-like values appear in any AuditLog.metadata / LedgerTransaction.metadata test fixtures or samples. Secret scan CI red.                                                                             |
| NFR-05 | All new money-path modules: line coverage ≥ 80%, decision coverage ≥ 90%.                                                                                                                                         |
| NFR-06 | 0 regressions: every existing P1-001…P1-007 Jest / RTL / live-DB test passes unchanged. Apps/Web build, apps/Admin build typecheck 0 errors.                                                                      |
| NFR-07 | Apps/Web, Apps/Admin, Docker compose/Dockerfile.* → 0 production diffs.                                                                                                                                           |
| NFR-08 | Prisma migration exactly 1 file added. Existing migration files byte-identical to baseline. schema.prisma additions restricted to §8.1 approved items.                                                            |
| NFR-09 | No JS `number` on any amount arithmetic. TypeScript `amount` fields use `string` wire → `Prisma.Decimal` engine conversion. A lint / AST rule in tests asserts no numeric literal math inside money-path modules. |

### 9.3 Security Requirements (SR) — revision 0.2 (双人签名占位 removed)

| #     | Requirement                                                                                                                                                                                                                                                                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SR-01 | Fail-closed everywhere: DB fault on flag lookup → treated as flag OFF. Both Phase A check + Phase B re-check use `isEnabledSafe`.                                                                                                                                                                                                 |
| SR-02 | RBAC: only ADMIN may mutate `money.flags.*`. Controller guard enforces it first; `setFlag` performs a second live ADMIN check inside the tx. Both paths must deny USER.                                                                                                                                                           |
| SR-03 | No token / signature / private key / chain RPC / wallet custody anywhere in the money-path foundation modules or new ledger tables. Chain interaction is FORBIDDEN in P1-008.                                                                                                                                                     |
| SR-04 | Sensitive mutations (flag flip, role/status, wallet status, money state, reverseTxn, manual_admin journal) each write exactly 1 AuditLog row with a valid envelope per §4.3.                                                                                                                                                      |
| SR-05 | `AuditLog.metadata` SHALL NOT contain JWT, session cookies, raw SIWE messages, raw signatures, mnemonics, or PK patterns.                                                                                                                                                                                                         |
| SR-06 | Ledger rows are NEVER exposed as a user-visible stored balance. Balance is derived-read only. No balance column anywhere.                                                                                                                                                                                                         |
| SR-07 | **Ledger append-only immutable.** UPDATE/DELETE on `LedgerTransaction / LedgerPosting` forbidden at engine + DB layer + CI test. The v0.1 "SR-07 Manual Admin two-signature placeholder" is DELETED; any multi-admin / four-eyes approval policy lives in a future standalone task and is NOT an interface placeholder in P1-008. |
| SR-08 | Testnet-first. `mainnet_<X>_enabled` write = true fails if `testnet_<X>_enabled` missing or OFF.                                                                                                                                                                                                                                  |
| SR-09 | Controller bypass forbidden by SR-09 = RULE-CONTROLLER-DB-NO-DIRECT equivalent to FR-14. Controllers never import Prisma for money writes.                                                                                                                                                                                        |
| SR-10 | Manual Admin journals exist only when `money.flags.manual_admin_enabled` isEnabledSafe=true (Phase A) + true inside Phase B re-check. No code path, test, or engine default bypasses this flag.                                                                                                                                   |
| SR-11 | TOCTOU: Phase A flag check + Phase B re-check. A flip between the two is a hard abort → rollback.                                                                                                                                                                                                                                 |

---

## 10. Failure Scenarios (FS) — revision 0.2 (two-phase model)

| FS    | Scenario                                                                            | Required behavior                                                                                                                                                                                                                                                          |
| ----- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FS-01 | Flag DB connection down in Phase A                                                  | `isEnabledSafe()` returns false → endpoint 403/503, zero rows written.                                                                                                                                                                                                     |
| FS-02 | Risk Preflight BLOCK in Phase A (no DB tx)                                          | Return 403 with structured reasons. No ledger. No audit (because nothing committed). Optionally, a controller CAN write a blocked-attempt audit row in a separate small tx; foundation does NOT require it, because the engine only enforces audit on committed mutations. |
| FS-03 | Phase B1 flag re-check flipped (TOCTOU)                                             | Phase B tx ROLLBACK. Return 409 `FLAG_RACE_FLIPPED`. Caller retries with same idempotency key.                                                                                                                                                                             |
| FS-04 | LedgerEngine.write Σ DEBIT != Σ CREDIT                                              | Engine throws. Phase B rolls back fully. Idempotency → FAILED.                                                                                                                                                                                                             |
| FS-05 | LedgerEngine.write unique(scope, idempotencyKey) collision against existing journal | Return existing txnId + postingIds, treat as replayed, 0 new rows.                                                                                                                                                                                                         |
| FS-06 | Audit write fails AFTER ledger write succeeds (same Phase B tx)                     | Full ROLLBACK of Phase B. state + ledger + audit all vanish together.                                                                                                                                                                                                      |
| FS-07 | Client retries with the same Idempotency-Key after post-commit crash                | B3 detects COMPLETED → cached response replayed. No duplicate journal.                                                                                                                                                                                                     |
| FS-08 | Same Idempotency-Key, different payload → hash mismatch                             | → 409 IDEMPOTENCY_CONFLICT.                                                                                                                                                                                                                                                |
| FS-09 | Same Idempotency-Key, another caller is in Phase B (row status=PENDING)             | → 409 IDEMPOTENCY_INFLIGHT.                                                                                                                                                                                                                                                |
| FS-10 | PostgreSQL serialization_failure (40001) on Phase B commit                          | Service wrapper reruns Phase A + Phase B **once**. Second fail → 503; caller retries via idempotency.                                                                                                                                                                      |
| FS-11 | USER role attempts `setFlag(money.flags.*)`                                         | RolesGuard in Controller → 403 before reaching service. If bypassed, setFlag double-checks live role → AUTHZ_ROLE_INSUFFICIENT thrown + tx rollback. No ledger. Audit logged? No — no state was committed.                                                                 |
| FS-12 | App code attempts UPDATE/DELETE on ledger tables via Prisma client                  | CI static rule + DB REVOKE/trigger block. Pipeline red.                                                                                                                                                                                                                    |
| FS-13 | JS `number` used in amount math (NFR-09 lint)                                       | AST rule catches in tests. CI fails.                                                                                                                                                                                                                                       |
| FS-14 | setFlag(mainnet_deposit_enabled=true) with no testnet_deposit_enabled in DB         | Throws TESTNET_GATE_MISSING in tx; rollback. No audit (because flag row update was rolled back).                                                                                                                                                                           |

---

## 11. RBAC Boundary (revision 0.2)

| Operation                                                                | USER                                        | ADMIN                                                                                             | SYSTEM/Worker          | Anonymous    |
| ------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------- | ------------ |
| Read own ledger entries (future API)                                     | ✅ only `accountType=USER & accountId=self` | ✅ read any                                                                                       | ❌ (not via HTTP)      | ❌ 401       |
| Read audit log (future Admin API)                                        | ❌ 403                                      | ✅                                                                                                | ❌ (internal only)     | ❌ 401       |
| Flip `money.flags.*`                                                     | ❌ 403                                      | ✅ only via Admin endpoint + AuditLog + 0 Ledger                                                  | ❌                     | ❌           |
| Produce ledger journals via Engine (no endpoint yet)                     | ❌ (exposed path = 404/401)                 | ✅ source=manual_admin only if `money.flags.manual_admin_enabled == true` AND double-check in B1. | ✅ for worker job ids. | ❌           |
| Reverse a journal via Engine                                             | ❌                                          | ✅ + AuditLog(action=LEDGER_REVERSAL + envelope.reason + correlation=reversesTxnId)               | ❌                     | ❌           |
| UPDATE/DELETE ledger rows (bypass)                                       | ❌ FORBIDDEN                                | ❌ FORBIDDEN                                                                                      | ❌ FORBIDDEN           | ❌ FORBIDDEN |
| Write any of (balance/deposit/withdraw/chain/tx_hash/…) columns anywhere | ❌ FORBIDDEN                                | ❌ FORBIDDEN                                                                                      | ❌ FORBIDDEN           | ❌ FORBIDDEN |

---

## 12. Test Strategy (Option A = APPROVED; no more "if Option …")

| Class                                                                | Targets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Tooling                                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Unit (no DB)**                                                     | `LedgerEngine` invariants via mocked Prisma: Σ DEBIT=CREDIT, reversal=new balanced tx, amount string→Decimal conversion, forbid JS number math, `isEnabledSafe` fail-closed, `setFlag` → 0 `ledger*` rows, Audit envelope, RiskEngine runs in Phase A only.                                                                                                                                                                                                                                                                                                           | Jest (existing pipeline).                                                                                 |
| **Integration (live Postgres via docker-compose or testcontainers)** | (a) full `Phase A → Phase B` roundtrip: write a 2-leg journal, then reverse it, then `balance()` matches zero; (b) attempt `prisma.ledgerTransaction.update({…})` directly → test MUST fail with DB permission/trigger error; (c) `setFlag` → row counts: SystemConfig +1, AuditLog +1, LedgerTransaction +0, LedgerPosting +0; (d) `mainnet_*_enabled ON` without `testnet_*_enabled` => rejected TESTNET_GATE_MISSING; (e) serialization failure retry count = exactly 1; (f) COMPLETED idempotency replay returns identical response bytes and 0 side-effect rows. | Postgres container matching CI image version, Prisma migrate deploy, raw driver query for REVOKE testing. |
| **RBAC / Controller bypass**                                         | Jest moduleNameMapper that throws on Prisma ledger/audit/config writes inside `*controller*.ts` files; ESLint rule; ADMIN-only setFlag path.                                                                                                                                                                                                                                                                                                                                                                                                                          | ESLint + Jest.                                                                                            |
| **Property-like invariant test**                                     | Randomly generate 2..N posting balanced journals for 1000 iterations → each `Σ DEBIT == Σ CREDIT`. Optionally `fast-check`.                                                                                                                                                                                                                                                                                                                                                                                                                                           | Jest.                                                                                                     |
| **CI gates**                                                         | Must slot into existing 8-check pipeline unchanged: Lint ✅ · Type-check ✅ · Build ✅ · Unit ✅ · CodeQL ✅ · secret scan ✅ · Docker build ✅ · (the existing live-DB test job runs P1-008 integrations if enabled).                                                                                                                                                                                                                                                                                                                                                | Existing CI YAML untouched.                                                                               |

---

## 13. Testnet Gate (P1-008 stance)

- P1-008 itself ships zero testnet/mainnet endpoints and zero default-on flags.
- The `money.flags.testnet_<X>_enabled` / `mainnet_<X>_enabled` pair naming
  contract + setFlag testnet-exists guard are declared in §5.2/§5.3/§9.3.
- Soak / volume / failure criteria for promoting a feature from testnet →
  mainnet is intentionally deferred to each concrete money feature spec. This
  spec only sets the admission hook.

---

## 14. Acceptance Criteria — renumbered & reclassified per category (>= 35 required)

**Total AC count = 42 (≥ 35 ✅).**

### Ledger (10 ACs)

| #         | AC                                                                                                                                                                                                                                                                                                                                                                                                           | Category                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| AC-LED-01 | Typed `LedgerEngine` interface exports `write / reverseTxn / balance` signatures matching §3.3. Journals only.                                                                                                                                                                                                                                                                                               | Ledger                   |
| AC-LED-02 | `write()` with same `(scope, txnIdempotencyKey)` run 2x returns identical `txnId + postingIds` on 2nd call with `replayed=true`; row counts +0 in both ledger tables.                                                                                                                                                                                                                                        | Ledger / Idempotency     |
| AC-LED-03 | `write()` enforces postings.length ≥ 2, Σ DEBIT amount == Σ CREDIT amount atomic integer, same currency/unit across all postings; throws on violation; 0 ledger rows written.                                                                                                                                                                                                                                | Ledger Invariant         |
| AC-LED-04 | `reverseTxn(id, reason)` creates exactly 1 new `LedgerTransaction` with txnType=REVERSAL + reversesTxnId pointing at original, and 1 reversed posting per original leg with opposite sign + reversesPostingId; the original `LedgerTransaction` row + original `LedgerPosting[]` rows are byte-identical after reverse completes; integration test SELECTs originals before/after and asserts full equality. | Ledger Invariant         |
| AC-LED-05 | `reverseTxn(id, reason)` NEVER performs UPDATE/DELETE against any original row. A unit test spies on Prisma: 0 `.update()` / `.delete()` calls on `ledgerTransaction` / `ledgerPosting` models.                                                                                                                                                                                                              | Ledger Invariant         |
| AC-LED-06 | `balance(accountTriple)` equals signed Σ(sign × amount) for that triple; seeded 100-journal set asserts strict equality; implementation path contains no join to any balance table or view.                                                                                                                                                                                                                  | Ledger Sum Invariant     |
| AC-LED-07 | Prisma schema (after 1 Implement migration) exposes models `LedgerTransaction` + `LedgerPosting`; unique index `@@unique([scope, txnIdempotencyKey], map: "ledger_txn_scope_idempotency_uq")` present; no `balance`/`deposit`/`withdraw`/`wallet`/`chain`/`network`/`tx_hash` columns anywhere in the new migration file text.                                                                               | DB Schema / Ledger       |
| AC-LED-08 | A DB-level enforcement (trigger or role-based REVOKE) rejects UPDATE/DELETE against `ledger_transactions` and `ledger_postings`. A test that attempts `prisma.ledgerTransaction.update(...)` and `prisma.ledgerPosting.deleteMany(...)` must throw a DB error.                                                                                                                                               | DB Immutability / Ledger |
| AC-LED-09 | `amount` on both LedgerPosting wire + engine: represented as `string`-decimal → `Prisma.Decimal(38,0)`. No code path in money-path performs arithmetic with JS `number`. AST/lint test catches numeric math on `amount`.                                                                                                                                                                                     | Numeric Safety / Ledger  |
| AC-LED-10 | All new source references in money-path use `IdempotencyStatus.COMPLETED` when marking idempotency success. Literal string `DONE` is absent from new TS files.                                                                                                                                                                                                                                               | Idempotency Enum         |

### Audit (5 ACs)

| #         | AC                                                                                                                                                                                                                                                                   | Category                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| AC-AUD-11 | `AuditService` exports `sensitiveMutation(AuditSensitiveMutationArgs)` typed per §4.4; writes exactly 1 `AuditLog` using existing schema columns only.                                                                                                               | Audit                   |
| AC-AUD-12 | For an `action=SYSTEM_CONFIG_UPDATED` call, the persisted `AuditLog.metadata` JSON contains the standard envelope keys: `before`, `after`, `reason`, `source`, `correlation` (each value may be null but the keys are present).                                      | Audit Metadata Contract |
| AC-AUD-13 | `sensitiveMutation` throws on invalid envelope shape (missing required keys at typescript or runtime level); the enclosing transaction is rolled back when this throws.                                                                                              | Audit                   |
| AC-AUD-14 | Throwing on `sensitiveMutation` during a larger Phase B transaction rolls back: business state + ledger rows + idempotency progress together. No half-committed state.                                                                                               | Transaction / Audit     |
| AC-AUD-15 | `LEDGER_REVERSAL` action calls produce an AuditLog row whose envelope.reason equals the `reason` arg passed to `reverseTxn`, envelope.source='ledger', envelope.correlation=reversalTxnId OR reversesTxnId (deterministic rule: use `reversesTxnId` as correlation). | Audit / Ledger          |

### Feature Flag (7 ACs)

| #         | AC                                                                                                                                                                                                                                                                                    | Category                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| AC-FLG-16 | `FeatureFlagService.isEnabled('money.flags.X')` for missing row / `isActive=false` / parse failure → returns `false`.                                                                                                                                                                 | Flag Default OFF         |
| AC-FLG-17 | `FeatureFlagService.isEnabledSafe('money.flags.X')` when DB throws → returns `false` without propagating any exception.                                                                                                                                                               | Flag Fail-closed         |
| AC-FLG-18 | `setFlag({ key: money.flags.X, actorUserId=<ADMIN>, … })` writes exactly 1 `SystemConfig` row AND exactly 1 `AuditLog` row with action=`SYSTEM_CONFIG_UPDATED` + flags envelope; counts in new migrated DB: SystemConfig Δ=1, AuditLog Δ=1, LedgerTransaction Δ=0, LedgerPosting Δ=0. | Flag Audit & Flag≠Ledger |
| AC-FLG-19 | `setFlag` for `money.flags.*` with non-ADMIN actorUserId → throws `AUTHZ_ROLE_INSUFFICIENT` inside tx; rollback: 0 SystemConfig Δ, 0 AuditLog Δ, 0 Ledger Δ.                                                                                                                          | RBAC / Flag              |
| AC-FLG-20 | setFlag(`mainnet_deposit_enabled`, value="true", isActive=true) WHEN no `testnet_deposit_enabled` row exists or value ≠ true → throws TESTNET_GATE_MISSING; rollback.                                                                                                                 | Testnet Gate             |
| AC-FLG-21 | Phase B step B1 flag re-check happens inside Phase B Serializable transaction. If flag was flipped between Phase A and B (provable via test manipulating the row in a separate concurrent tx), Phase B aborts with FLAG_RACE_FLIPPED + rollback.                                      | TOCTOU / Flag            |
| AC-FLG-22 | Manual Admin entry gate: in Phase A `isEnabledSafe('money.flags.manual_admin_enabled')=false` + Phase B1 re-check=OFF → engine throws MANUAL_ADMIN_DISABLED. No ledger rows.                                                                                                          | Flag Gating              |

### Transaction / Idempotency / Concurrency (10 ACs)

| #         | AC                                                                                                                                                                                                                                                     | Category              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| AC-TXN-23 | Money commit orchestration runs the exact Phase A (I/O OK) + Phase B (no I/O, Serializable tx) split described in §7.2/§7.3. A test injects a slow network call inside Phase B and asserts it fails / throws via runtime sandboxing.                   | Two-phase Transaction |
| AC-TXN-24 | Phase B defaults to `isolationLevel: Serializable`. Fallback RepeatableRead is not used unless a dedicated benchmark proves it; baseline build uses Serializable. A test inspects the orchestrator transaction options object.                         | Isolation Level       |
| AC-TXN-25 | Idempotency lifecycle values inside money-path code use only `PENDING / COMPLETED / FAILED` (matches baseline IdempotencyStatus). The string `DONE` does NOT appear in any new source file.                                                            | Idempotency           |
| AC-TXN-26 | Idempotency replay: run (Phase A + Phase B) successfully once. Run again with same (scope, key) → second invocation returns identical responseCode+responseBody from the idempotency cached row AND inserts 0 state rows, 0 ledger rows, 0 audit rows. | Idempotency Replay    |
| AC-TXN-27 | Same Idempotency-Key, different `requestHash` → 409 IDEMPOTENCY_CONFLICT. 0 side effects.                                                                                                                                                              | Idempotency Conflict  |
| AC-TXN-28 | Same Idempotency-Key, concurrent call when row.status=PENDING → 409 IDEMPOTENCY_INFLIGHT. (Simulated with explicit row insert.)                                                                                                                        | Idempotency Inflight  |
| AC-TXN-29 | Simulated PostgreSQL serialization_failure on Phase B commit triggers exactly 1 automatic retry of (Phase A + Phase B). Second consecutive serialization_failure → 503; no ledger rows, ledger row counter stable.                                     | Retry Contract        |
| AC-TXN-30 | Post-commit crash scenario (commit Phase B successfully; intercept response write; simulate retry) → replay path returns cached response and writes 0 duplicate ledger rows. State row count unchanged.                                                | Crash Recovery        |
| AC-TXN-31 | In a large Phase B that succeeds on B4..B6 but throws at B7 (idempotency update because someone raced PENDING → COMPLETED): the path reads the cached response from idempotency and returns it. No rollback but no duplicates.                         | Idempotency           |
| AC-TXN-32 | Business state mutation that writes a new money-status-like row produces (inside the same Phase B tx) exactly: 1 state row + 1 balanced LedgerTransaction/N postings + 1 AuditLog(row). If ANY step throws: all Δ=0 post-test.                         | Transaction Atomicity |

### RBAC / Controller Bypass (3 ACs)

| #          | AC                                                                                                                                                                                                                                                                  | Category               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| AC-RBAC-33 | Jest import blocker: any file under `services/api/src/**/controllers/**` that imports `@ai-wealth/database` for writeable models `LedgerTransaction/LedgerPosting/AuditLog/SystemConfig` inside a money-writing controller file fails at import time. Pipeline red. | Controller Bypass Rule |
| AC-RBAC-34 | `@Roles(UserRole.USER)` calling an Admin-only flag endpoint (mocked future controller test) → 403 before `setFlag` called. No mutation.                                                                                                                             | RBAC                   |
| AC-RBAC-35 | ADMIN actor can successfully commit `source=manual_admin` journal (when `manual_admin_enabled` flag is ON in both phases) → ledger + audit rows present; USER actor on same call path (mock) → 403. (Pure orchestration test; no HTTP controller actually added.)   | RBAC                   |

### CI / Regression / Migration Boundary / Docs (7 ACs)

| #         | AC                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Category           |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| AC-CI-36  | Lint + Typecheck for `services/api/src/money-path/**` pass. 0 warnings new to P1-008 are allowed.                                                                                                                                                                                                                                                                                                                                                                             | CI                 |
| AC-CI-37  | New modules line coverage ≥ 80%, decision ≥ 90%. Report generated.                                                                                                                                                                                                                                                                                                                                                                                                            | CI Coverage        |
| AC-CI-38  | All pre-existing tests (apps/web + apps/admin typecheck/build/test; API unit + live-DB) pass. 0 new failures. Apps/Web & Admin production build byte-delta analysis against baseline: apps/web 0 changes, apps/admin 0 changes.                                                                                                                                                                                                                                               | CI Regression      |
| AC-CI-39  | Secret scan passes. 0 private-key / mnemonic / raw-signature-looking strings in new test fixtures and new metadata samples.                                                                                                                                                                                                                                                                                                                                                   | CI Secret Scan     |
| AC-MIG-40 | Migration boundary: exactly **1 new Prisma migration file added**. New migration file content (after SQL comments stripped) contains ONLY additions of the 2 enums + 2 models + indexes/constraints/triggers/REVOKE statements explicitly listed in §8.1. No new balance/deposit/withdraw/chain/… columns anywhere. schema.prisma file preamble comment for `FORBIDDEN ANY real fund field` remains present and byte-identical to baseline. Existing migration files 0 diffs. | Migration Boundary |
| AC-BLD-41 | Docker 0 diffs. `git diff -- baseline -- infrastructure/docker/* docker-compose.yml` empty.                                                                                                                                                                                                                                                                                                                                                                                   | Docker Build       |
| AC-DOC-42 | `docs/architecture/domain-services.md` (new or updated) includes a typed contract summary for Ledger/Settlement/Commission/Risk engines and links to this spec.                                                                                                                                                                                                                                                                                                               | Documentation      |

---

## 15. Risks & Open Issues (rev 0.2; Option A resolved; 双人签名 + Option B references removed)

| #     | Risk / Issue                                                                                                                                     | Severity | Mitigation                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RI-01 | Implement team slips one `DONE` literal into idempotency code, breaking IdempotencyStatus enum compatibility.                                    | Medium   | AC-LED-10 + grep test run in CI to fail any new file that writes `status=DONE` string. Runtime enum-only types.                                                                                  |
| RI-02 | PostgreSQL REVOKE UPDATE/DELETE requires DB superuser. CI service user might lack GRANT to run trigger/REVOKE SQL in migration.                  | Medium   | AC-LED-08 requires ONLY that the UPDATE/DELETE test fails against the app user. Implementation can choose trigger, view, or Row-Level Security. Migrations use `IF NOT EXISTS` + idempotent SQL. |
| RI-03 | Exact NUMERIC precision (38 vs 24 vs 64) not frozen; potential wasted bytes vs overflow risk.                                                    | Low      | Spec default `Decimal(38, 0)`. Plan phase can lock to Postgres optimum based on 128-bit integer treasury max. Invariant: scale = 0.                                                              |
| RI-04 | Phase A allowed I/O → if RiskEngine is slow → overall latency still elevated (though no DB locks held). Eventually rate-limit RiskEngine itself. | Low      | Future benchmark + timeout around Phase A network calls. P1-008 only declares location.                                                                                                          |
| RI-05 | Testnet → mainnet soak / metrics policy TBD per feature.                                                                                         | Low      | Per-money-feature spec responsibility. P1-008 only guards flag pair existence + ON state.                                                                                                        |
| RI-06 | No public money HTTP endpoints exist; end-to-end HTTP tests of the commit lifecycle must wait for P1-009+.                                       | Low      | P1-008 covers unit + live-DB integration (orchestrator-only harness), no HTTP.                                                                                                                   |
| RI-07 | Future ledger schema change → additive-only migrations. Deletion of columns is FORBIDDEN.                                                        | Low      | Review checklist item. Enforced by AC-MIG-40.                                                                                                                                                    |

---

## 16. IN / OUT recap after Implementation (Option A APPROVED)

**IN (after approved Implement phase):**

- TypeScript foundation module (`LedgerEngine.write/reverseTxn/balance` double-entry
  journal + `SettlementEngine`/`CommissionEngine`/`RiskEngine` Preflight/Commit
  split + `FeatureFlagService` + `AuditService` envelope upgrade);
- Strict unit tests + live-DB integration tests, double-entry property tests,
  Controller bypass rules;
- Docs update (`docs/architecture/domain-services.md` contract section).
- Exactly **1** Prisma migration (`LedgerTransaction` + `LedgerPosting` + 2
  enums + append-only enforcement SQL) approved under Option A.
- Feature-flag default OFF + fail-closed + audit-on-write + never-ledger.
- Two-phase commit orchestration (Phase A I/O OK + Phase B short Serializable
  DB tx, TOCTOU flag re-check, idempotency using ONLY `PENDING / COMPLETED /
FAILED`).

**OUT:**

- No balance / available / frozen / USDT balance fields or views;
- No deposit / withdrawal / on-chain tx / tx_hash / chain / network / wallet
  custody / private key / hot wallet tables or columns anywhere;
- No mainnet flags turned ON. No money endpoints. No Admin UI. No Docker diffs.
- No four-eyes / multi-admin approval interfaces or logic (future standalone).

---

## 17. Summary

Revision 0.2 resolves all 7 review blockers: (1) marks Option A = APPROVED with
a strict migration boundary, (2) aligns idempotency lifecycle exclusively to
baseline `PENDING / COMPLETED / FAILED`, deleting any usage of `DONE`, (3)
replaces "double-entry optional" with mandatory `LedgerTransaction` (journal)

- `LedgerPosting[]` double-entry model enforcing `Σ DEBIT == Σ CREDIT` per
  currency/unit inside every journal, (4) replaces VARCHAR amount string default
  with PostgreSQL `NUMERIC(38, 0)` + Prisma Decimal storing atomic integer units
- explicit "JS `number` FORBIDDEN" invariant and lint, (5) defines Audit
  before/after/reason/source/correlation as a standard envelope inside the
  existing `AuditLog.metadata Json?` column without adding any DB columns, (6)
  replaces single long Serializable DB tx with two-phase (Phase A I/O + Phase B
  short Serializable + TOCTOU flag recheck inside Phase B + idempotency claim +
  COMPLETED cache), explicitly forbidding network I/O from Phase B, and (7)
  deletes the unjustified Manual Admin two-signature placeholder from both
  interface and Security Requirements. Retained explicitly: flag-write → Audit
  only, NO Ledger; reversal = new balanced transaction + never UPDATE/DELETE
  history; Controller cannot bypass Domain Services to write money tables. AC
  count = 42 across Ledger / Audit / Flag / Transaction+Idempotency / RBAC / CI+
  Migration categories (≥ 35). This spec writes zero code, zero migration, zero
  commit.
