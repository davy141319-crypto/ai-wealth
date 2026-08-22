# Domain Services — Money-Path Foundation

This document defines the **domain service contracts** introduced by P1-008
(Money-Path Foundation). All future fund-related business (deposit,
withdrawal, yield, referral, treasury ops, etc.) **MUST** go through the
contracts described here. Direct persistence access from controllers is
explicitly forbidden (see §9).

---

## 1. Goals / Non-Goals

### Goals

- Provide an **immutable**, append-only double-entry ledger.
- Standardize **audit metadata envelope** (`before/after/reason/source/correlation`)
  for every sensitive mutation.
- Enforce **fail-closed feature flag governance** for every money-path flow.
- Split processing into a deterministic **two-phase model** (Phase A
  preflight with allowed I/O → Phase B serializable DB-only transaction),
  eliminating TOCTOU.
- Standardize locking, idempotency, serialization-retry, and crash recovery.

### Non-Goals (out of scope for P1-008)

- Implementing any concrete real-money business (deposit / withdraw / yield
  / treasury balance / USDT balance / chain custody).
- Creating balance, available-balance, or frozen-balance tables.
- Any on-chain broadcast / hot-wallet / private-key handling.
- Admin four-eyes / multi-signer approval workflow.

---

## 2. Layered Architecture

```
┌──────────────────────────────────────────────────────────┐
│                   HTTP Controller                        │
│  (must NOT import PrismaService / Ledger persistence)    │
└──────────────────────────────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────┐
│              TwoPhaseOrchestrator (Domain Facade)        │
│  ┌──────── A (preflight, I/O allowed) ────────┐          │
│  │  auth·validation·flag-check·risk·hash      │          │
│  └────────────────────────────────────────────┘          │
│  ┌──────── B (SERIALIZABLE, NO external I/O) ───────┐    │
│  │  flag-recheck · locks · idempotency-claim        │    │
│  │  state-mutation · LedgerEngine.write · Audit     │    │
│  │  idempotency → COMPLETED                         │    │
│  └──────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
   Settlement          Commission             Risk
   Engine              Engine                 Engine
  (contract)          (contract)            (contract)
       │                    │                    │
       └────────────────────┼────────────────────┘
                            ▼
                 ┌─────────────────────┐
                 │    LedgerEngine     │
                 │  double-entry,      │
                 │  reversal, replay   │
                 └─────────────────────┘
                            │
                            ▼
                 ┌─────────────────────┐
                 │ LedgerRepository    │
                 │  (schema.prisma)    │
                 │  ledger_transactions│
                 │  ledger_postings    │
                 └─────────────────────┘
```

---

## 3. Ledger Model (immutable, append-only)

### Tables

#### `ledger_transactions`

One row per logical value-transfer event.

| Field                      | Type                            | Notes                                                                        |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `id`                       | `uuid PK`                       |                                                                              |
| `scope, txnIdempotencyKey` | `varchar(64), varchar(128)`     | **UNIQUE** (replay guard)                                                    |
| `txnType`                  | `LedgerTxnType` enum            | `GENERIC · REVERSAL · MOCK` (P1-008)                                         |
| `currency, unit, decimals` | `varchar(16), varchar(16), int` | All postings inside one txn share identical values                           |
| `source, reference`        | `varchar(32), varchar(256)?`    | provenance                                                                   |
| `reversesTxnId`            | `uuid?`                         | **UNIQUE** → prevents double-reversal of same txn                            |
| `actorUserId`              | `uuid? + INDEX`                 | **NO FK to users** (immutable history must not be affected by user deletion) |
| `requestId`                | `varchar(64)?`                  | request correlation                                                          |
| `metadata`                 | `json?`                         |                                                                              |
| `createdAt`                | `timestamptz`                   |                                                                              |

#### `ledger_postings`

One row per debit/credit leg. `Σ DEBIT == Σ CREDIT` per transaction.

| Field                    | Type                                          | Notes                                                                 |
| ------------------------ | --------------------------------------------- | --------------------------------------------------------------------- |
| `id`                     | `uuid PK`                                     |                                                                       |
| `ledgerTxnId`            | `uuid FK → ledger_transactions.id (RESTRICT)` |                                                                       |
| `accountType, accountId` | `varchar(32), varchar(128)`                   | canonical account reference; INDEX on tuple                           |
| `sign`                   | `LedgerAmountSign` enum: `DEBIT · CREDIT`     |                                                                       |
| `amount`                 | `NUMERIC(38,0)`                               | **CHECK amount > 0**; atomic integer units; no JS `number` arithmetic |
| `reversesPostingId`      | `uuid?`                                       | **UNIQUE** → prevents double-reversal of same posting                 |

### Append-only enforcement (PostgreSQL trigger)

Both tables are protected by `BEFORE UPDATE OR DELETE` triggers that
raise the exception label `[P1-008 APPEND-ONLY]`. Reversals **must**
create a **new** balanced transaction with `reversesTxnId` and
per-posting `reversesPostingId` links.

### Amount semantics

- All amounts are stored as **atomic integer units** in `NUMERIC(38,0)`.
- The `decimals` column on the transaction describes the display unit.
- Business logic is **forbidden** from using JS `number` for any
  monetary arithmetic. Only `Prisma.Decimal`, `BigInt`, and
  database-level aggregates are allowed.

---

## 4. `LedgerEngine` contract

Located at `services/api/src/money-path/ledger/ledger.engine.ts`.

```ts
interface LedgerEngine {
  write(repos: Repositories, input: WriteJournalInput): Promise<WriteJournalResult>;

  reverse(
    repos: Repositories,
    opts: {
      originalTxnId: string;
      scope: string;
      txnIdempotencyKey: string;
      actorUserId: string | null;
      requestId: string | null;
      reason: string;
    },
  ): Promise<WriteJournalResult>;
}
```

### Invariants enforced by `write()`

- `postings.length >= 2`
- All postings share `currency / unit / decimals` (dimensions of the txn)
- All `amount > 0`
- `Σ DEBIT == Σ CREDIT` within the same unit
- If a prior `(scope, txnIdempotencyKey)` exists → replay (existing row
  returned, no write)
- Writes audit row with envelope
  `{ before, after, reason, source, correlation }` in `AuditLog.metadata`

### Reversal (`reverse()`)

- Creates **new** `LedgerTransaction` with `txnType = REVERSAL` and
  `reversesTxnId = originalTxnId`.
- Creates **new** `LedgerPosting`s with `sign` flipped and
  `reversesPostingId` set per original leg.
- Balanced by construction; fails if dimensions mismatch or original
  is already reversed.

---

## 5. Pluggable Domain Engines (contracts only, P1-008)

Located under `services/api/src/money-path/domain/`.

| Engine             | Contract                                       | Purpose                                                                                                            |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `SettlementEngine` | `planPostings(input) → DeterministicPlan`      | Deterministically decides which accounts to debit/credit for a given business event. **Must be pure** (no I/O).    |
| `CommissionEngine` | `computeCommission(input) → CommissionSplit[]` | Derives commission legs for a given transaction. **Must be pure**.                                                 |
| `RiskEngine`       | `preflightChecks(ctx) → Promise<RiskVerdict>`  | Runs in **Phase A** only. Allowed to call external services. Returns pass/fail + reasons. MUST NOT run in Phase B. |

Implementations are deliberately NOT provided in P1-008; only their
contracts. Future business phases supply concrete implementations.

---

## 6. Feature Flag Governance (`FeatureFlagService`)

Prefix: `money.flags.<scope>.<feature>`. Backed by existing
`SystemConfig` (no new table).

### Rules

- **Default OFF**. If the key does not exist → disabled.
- **Fail closed**. Reading / parsing errors → disabled + audit.
- **Testnet gate** (`money.flags.__meta.testnetOnly`): when `true`,
  flags only resolve to enabled in non-PROD environments.
- **ADMIN-only mutation**. Role check enforced before writes.
- **Flag mutation writes `AuditLog`** (action `MONEY_FLAG_SET` /
  `MONEY_FLAG_UNSET`) and **never touches the Ledger**.
- **Phase A checks + Phase B re-check** for TOCTOU protection.

---

## 7. Two-Phase Orchestrator

Located at
`services/api/src/money-path/orchestrator/two-phase.orchestrator.ts`.

### Phase A — Preflight (may do I/O)

1. `A1 Auth / RBAC`
2. `A2 Input validation`
3. `A3 Canonical request hash` (deterministic JSON)
4. `A4 Initial feature flag check`
5. `A5 RiskEngine.preflightChecks` (the only place network I/O is allowed)
6. `A6 Deterministic commit plan` produced by `SettlementEngine.planPostings`

### Phase B — Serializable DB Transaction (no external I/O)

1. `B1 Feature flag re-check` (TOCTOU guard)
2. `B2 Concurrency locks` acquired in canonical account order
3. `B3 Idempotency claim` → `PENDING`
4. `B4 Domain state mutation`
5. `B5 LedgerEngine.write` (balanced journal)
6. `B6 AuditLog` with metadata envelope
7. `B7 Idempotency → COMPLETED`
8. `B8 Commit`

### Serializable retry

If a `serialization_failure` or `deadlock_detected` SQL class is raised
in Phase B, the orchestrator auto-retries **exactly once**. A second
failure returns `503 MONEY_TXN_SERIALIZATION_FAILED` and marks
idempotency `FAILED` (safe for caller retry with a new key).

### Crash recovery

If the process crashes after ledger write but before idempotency
`COMPLETED`: subsequent replay of the same `(scope, idempotencyKey)`
observes the existing `ledger_transactions` row (UNIQUE scope+key) and
marks idempotency `COMPLETED` with the matching `requestHash` only if
hash matches; otherwise `409 IDEMPOTENCY_REQUEST_HASH_MISMATCH`.

---

## 8. Locking Strategy

Implemented in `locking.strategy.ts`.

| Account kind                                                         | Lock primitive                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `USER/<uuid>`                                                        | `SELECT … FOR UPDATE` on `users.id` via `UserRepository.lockForUpdate()` |
| Abstract accounts (`PLATFORM`, `TREASURY`, `RESERVE`, `REFERRER`, …) | `pg_advisory_xact_lock( hashtextextended(canonicalKey, 0xB100D5EED) )`   |

- Locks are always acquired **sorted by canonical account key** to
  avoid deadlock.
- All abstract account hashing is done **inside PostgreSQL** via
  `hashtextextended` — custom JS hash functions (FNV, etc.) are
  explicitly forbidden.

---

## 9. Controller DB-bypass Guard

Controller code under any `money-path` flow **MUST NOT**:

- import `PrismaService` (directly or transitively for persistence)
- import `LedgerRepository`
- write to `LedgerTransaction` / `LedgerPosting` tables

Enforced by the **static Jest architecture test** at
`services/api/src/money-path/architecture/controller-db-bypass.spec.ts`,
which scans relevant sources and fails the build if any forbidden
import or call signature is found. No ESLint rule change required.

Additionally, an AST-based static test (`amount-safety.static.spec.ts`)
forbids JS `number` literals / arithmetic on money values anywhere in
the money-path module.

---

## 10. Audit Metadata Envelope

All sensitive mutations (ledger write, flag mutation, idempotency
lifecycle transition) write to `AuditLog` with a **standard metadata
envelope** in the existing `metadata` JSON column:

```ts
type AuditMetadataEnvelope = {
  before: unknown | null; // snapshot before
  after: unknown | null; // snapshot after
  reason: string | null; // why this mutation occurred
  source: string; // subsystem: ledger / flag / idem / risk / money-path
  correlation: string | null; // idempotency key, request id, txn id
};
```

The validator at
`services/api/src/money-path/audit/audit-metadata.types.ts` rejects
any envelope that does not conform. Storage of envelope is **additive
only** — no new DB columns introduced.

---

## 11. Reusable Errors (`MoneyPathErrorCode`)

Shared types are exported from
`packages/shared/src/money-path-error-codes.ts` (re-exported by
`packages/shared/src/index.ts`). All orchestrator / engine errors
**MUST** use a defined code from this enum so that

- controllers do not leak SQL errors
- browser-side interceptors only clear session on the published
  session-invalidation subset

---

## 12. Change Boundary (what P1-008 added vs. what it intentionally does not)

### Added by P1-008

- `packages/database/prisma/schema.prisma` — Ledger enums + models +
  constraints
- `packages/database/prisma/migrations/20260822120000_p1_008_ledger_foundation/migration.sql`
  — single additive migration (tables, unique/check constraints,
  append-only triggers, functions)
- `packages/database/src/repositories/ledger.repository.ts`
- `packages/database/src/repositories/user.repository.ts` — `lockForUpdate()`
- `packages/shared/src/money-path-error-codes.ts`
- `services/api/src/money-path/**` — Ledger, audit, flags, domain
  contracts, orchestrator, tests, architecture guard
- `docs/architecture/domain-services.md` (this file)

### Intentionally NOT in P1-008

- Real-money tables or fields (balance, deposit, withdrawal, chain
  tx, wallet custody, treasury)
- Changes to `apps/web/**`, `apps/admin/**`, `services/blockchain/**`
- Docker / nginx / infra changes
- `GRANT` / `REVOKE` for hardened DB roles — deferred to deployment
  hardening phase

---

## 13. Test Coverage Commitments

Per P1-008 acceptance criteria (42 ACs), the following categories are
covered by tests in `services/api/src/money-path/**`:

| Category                                          | Where                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Double-entry validator (1–8)                      | `ledger/__tests__/double-entry.validator.unit.spec.ts`                                  |
| Idempotency + replay + concurrency (9, 10, 28–34) | `__tests__/postgres.integration.spec.ts`                                                |
| Reversal + immutability of originals (11–14)      | `__tests__/postgres.integration.spec.ts`, `ledger/__tests__/ledger.engine.unit.spec.ts` |
| Append-only trigger (15–19)                       | `__tests__/migration-appendonly.spec.ts`                                                |
| Audit envelope (20)                               | `audit/__tests__/audit-sensitive-mutation.unit.spec.ts`                                 |
| Feature flag (21–27)                              | `flags/__tests__/feature-flag.service.unit.spec.ts`                                     |
| Idempotency state machine (28–34)                 | `__tests__/postgres.integration.spec.ts`, `__tests__/orchestrator.unit.spec.ts`         |
| Controller DB bypass (35)                         | `architecture/controller-db-bypass.spec.ts`                                             |
| No JS-number monetary arithmetic (36)             | `ledger/__tests__/amount-safety.static.spec.ts`                                         |
| Regression                                        | `__tests__/regression.spec.ts`                                                          |
