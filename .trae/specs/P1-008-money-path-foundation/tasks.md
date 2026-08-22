# P1-008 — Money-Path Foundation · Tasks (Plan)

> Spec: `.trae/specs/P1-008-money-path-foundation/spec.md` (APPROVED v0.2, frozen)
> Plan revision: **`1.0`**
> Frozen Baseline: **`develop@13326d9a0ffe879a8e56f4f584100fa14c0ef948`**
> Branch rule: NO feature branch in Plan phase; this document is the ONLY deliverable of Plan phase.
> Implement-phase allowed change set: see §3 File-level change map / §4 Schema-level change map (whitelist only).

---

## 1. Scope / Non-Goals / Frozen Decisions (16 items, exactly mirror Spec kickoff)

### 1.1 Scope delivered in Implement phase

P1-008 is pure infrastructure — no money features, no endpoints, no UI:

- Exactly **1** Prisma migration delivering generic accounting kernel only:
  `enum LedgerTxnType / enum LedgerAmountSign / model LedgerTransaction / model LedgerPosting`
  - indexes + constraints + PostgreSQL append-only guard SQL.
- Shared money-path TS foundation inside `services/api/src/money-path/`:
  `LedgerEngine` (journals only, mandatory double-entry, reversal = new balanced tx),
  `AuditService.sensitiveMutation` envelope contract,
  `FeatureFlagService` money governance (default OFF / fail-closed / audit-on-write / never-ledger),
  typed `SettlementEngine / CommissionEngine / RiskEngine` (Preflight + Commit split),
  2-phase orchestrator (Phase A I/O OK + Phase B short Serializable with TOCTOU flag re-check).
- Tests: Unit + Postgres integration + Migration/append-only constraint tests +
  Controller bypass static architecture tests + regressions.
- Docs: `docs/architecture/domain-services.md` typed contracts for engines.

### 1.2 Non-Goals (Implement phase FORBIDDEN)

- No balance / available_balance / frozen_balance / USDT_balance fields or views anywhere.
- No deposit / withdrawal / on-chain tx / tx_hash / chain / network / wallet_custody /
  private_key / hot_wallet / treasury_balance tables or columns.
- No real fund endpoints; no money business state mutation beyond test fixtures.
- No four-eyes / multi-admin / two-signature policy.
- No apps/web, apps/admin, Docker, Nginx, services/blockchain changes.
- No modifications to baseline Prisma migrations / models / enums (additive only).

### 1.3 FROZEN decisions (NOT re-negotiable in Plan / Implement)

1. Migration **Option A = APPROVED**.
2. Ledger **mandatory double-entry**.
3. Core models: `LedgerTransaction` (journal) + `LedgerPosting[]` (legs).
4. Each LedgerTransaction has `postings.length >= 2`.
5. Same txn: `currency / unit / decimals` consistent.
6. `Σ DEBIT == Σ CREDIT` per txn.
7. Amount: PostgreSQL NUMERIC(scale=0) / Prisma Decimal, atomic integer units; JS `number` forbidden for amount arithmetic.
8. Audit before/after: reuse **existing** `AuditLog.metadata Json?`; no new DB columns.
9. Audit metadata envelope: `{before, after, reason, source, correlation}`.
10. Transaction model: **Phase A (Preflight, I/O OK) → Phase B (Serializable DB tx, NO I/O)**.
11. Phase B forbids external network I/O.
12. IdempotencyStatus: **PENDING / COMPLETED / FAILED only**; literal `DONE` is never written as status.
13. Feature-flag mutation: **MUST Audit; MUST NOT write Ledger** (0 rows in both ledger tables).
14. Ledger reversal: **NEW balanced REVERSAL LedgerTransaction + balanced reversed postings**; original rows immutable.
15. Controllers **MUST NOT** directly operate `LedgerTransaction / LedgerPosting / AuditLog / SystemConfig` persistence; only via Domain Services.
16. Multi-admin / four-eyes approval is **not P1-008**.

---

## 2. Task dependency DAG (25 tasks, 3 tracks + audit)

```
                          (baseline)
                              │
                      ┌───────T1 Boundary Guard (anchor, prereq for ALL)
                      │        │
     Track A (DB)     │  T2 Schema design → T3 Migration draft → T4 Append-only SQL → T21 Migration & Append-only tests
                      │        │
     Track B (Domain) │  T5 Domain types → T6 LedgerEngine → T7 Double-entry validator → T8 Reversal
                      │        │
     Track C (Cross)  │  T9 Audit envelope types → T10 AuditSensitiveMutation → T11 FeatureFlagService
                      │        │
                      │  T12 Engine Contracts (Settlement/Commission/Risk)
                      │        │
                      │  T13 Phase A Preflight contract → T14 Phase B Orchestrator → T15 Idempotency integration
                      │        │
                      │  T16 Locking / concurrency → T17 Failure+Retry+Crash recovery → T18 Controller bypass guard
                      │        │
                      │  T19 Unit tests (depends T5..T18)
                      │  T20 Postgres integration tests (depends T3,T4,T6..T18)
                      │  T22 Regression tests (depends any other task outputs touching baseline)
                      │  T23 Security / Secret / CodeQL compat (depends T3,T6,T10,T11)
                      │  T24 Docs (depends T5,T6,T10,T11,T12)
                      │        │
                      └───► T25 Final boundary audit (depends EVERY T1..T24 complete)
```

- Parallelizable: T2/T5/T9/T12 once T1 passes; T13/T16 once T12 passes.
- Serial gates: T3 needs T2; T6 needs T5; T7, T8 depend T6; T10 needs T9; T14 depends T13 + T11 + T10 + T6 + T15 (idempotency integration done earlier in T15; T15 depends T11/T6); T19..T24 fan in; T25 is last.
- **Stop-gates**: after T3 no schema changes; after T21 no migration/append-only SQL changes; after T25 nothing enters PR without re-audit.

---

## 3. File-level change map (Implement-Phase WHITELIST — additions only)

### 3.1 Allowed new / modified files

| Area                          | Path                                                                                                                     | Kind                                                                             | Purpose                                                                                                                                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| DB schema                     | `packages/database/prisma/schema.prisma`                                                                                 | Modify, additive-only                                                            | Append 2 enums + 2 models + indexes. Existing text byte-stable.                                                                                                                                                                                                                            |
| DB migration                  | `packages/database/prisma/migrations/YYYYMMDDHHMMSS_p1_008_ledger_foundation/migration.sql`                              | New, single file                                                                 | Exactly 1 migration; additive.                                                                                                                                                                                                                                                             |
| DB types/re-exports           | `packages/database/src/index.ts`                                                                                         | Modify, additive                                                                 | Ensure new enums/models re-exported through `@ai-wealth/database`.                                                                                                                                                                                                                         |
| Money-path ledger             | `services/api/src/money-path/ledger/types.ts`                                                                            | New                                                                              | Domain types: `LedgerJournalRequest`, `LedgerPostingPlan`, `LedgerAmountSign` alias imports, `LedgerTxnType` aliases, engine response types.                                                                                                                                               |
| Money-path ledger             | `services/api/src/money-path/ledger/double-entry.validator.ts`                                                           | New                                                                              | Pure validator Σ DEBIT == Σ CREDIT, consistent currency/unit/decimals, amount > 0, postings ≥ 2. (Separated from Engine for tests.)                                                                                                                                                        |
| Money-path ledger             | `services/api/src/money-path/ledger/ledger.engine.ts`                                                                    | New                                                                              | `LedgerEngine` implementation (write / reverseTxn / balance).                                                                                                                                                                                                                              |
| Money-path audit              | `services/api/src/money-path/audit/audit-metadata.types.ts`                                                              | New                                                                              | `AuditMetadataEnvelope` interface + runtime shape validator (5 keys required, values nullable).                                                                                                                                                                                            |
| Money-path audit              | `services/api/src/money-path/audit/audit-sensitive-mutation.service.ts`                                                  | New                                                                              | Service that consumes §4.4 `AuditSensitiveMutationArgs`, builds envelope, calls existing `AuditService.write(...)`.                                                                                                                                                                        |
| Money-path flags              | `services/api/src/money-path/flags/feature-flag.service.ts`                                                              | New                                                                              | `isEnabled / isEnabledSafe / setFlag`; ADMIN double-check; audit; NO ledger; TESTNET gate.                                                                                                                                                                                                 |
| Money-path domain contracts   | `services/api/src/money-path/domain/settlement.engine.ts`                                                                | New                                                                              | Interface + `SettlementPreflight` plan DTO; no implementation.                                                                                                                                                                                                                             |
| Money-path domain contracts   | `services/api/src/money-path/domain/commission.engine.ts`                                                                | New                                                                              | Interface + `CommissionPreflight` DTO; no implementation.                                                                                                                                                                                                                                  |
| Money-path domain contracts   | `services/api/src/money-path/domain/risk.engine.ts`                                                                      | New                                                                              | `RiskEngine.evaluatePreflight` interface; no implementation.                                                                                                                                                                                                                               |
| Money-path domain shared      | `services/api/src/money-path/domain/money-domain.types.ts`                                                               | New                                                                              | `MoneyDomainPreflightCtx / MoneyDomainCommitCtx`; enums for `source`; `RiskResult / SettleResult / CommissionResult` placeholder shapes.                                                                                                                                                   |
| Orchestrator                  | `services/api/src/money-path/orchestrator/types.ts`                                                                      | New                                                                              | `CommitPlan`, `PhaseAContext`, `PhaseBResult`, error code enum.                                                                                                                                                                                                                            |
| Orchestrator                  | `services/api/src/money-path/orchestrator/two-phase.orchestrator.ts`                                                     | New                                                                              | Abstraction that runs Phase A + Phase B Serializable tx; flag re-check; retry 1×; crash-safe idempotency.                                                                                                                                                                                  |
| Orchestrator locking          | `services/api/src/money-path/orchestrator/locking.strategy.ts`                                                           | New                                                                              | `FOR UPDATE row-level` helper + pg advisory lock helper; policy selector (default recommendation).                                                                                                                                                                                         |
| Orchestrator idempotency      | `services/api/src/money-path/orchestrator/idempotency.integration.ts`                                                    | New                                                                              | Adapter on top of **existing** `IdempotencyKey` repo: claim PENDING, mark COMPLETED/FAILED, replay lookup, hash compare, inflight response.                                                                                                                                                |
| Controller bypass guard       | `services/api/src/money-path/architecture/controller-db-bypass.guard.ts` **(meta-guard for tests only)**                 | New                                                                              | Not a Nest HTTP guard; an AST / moduleNameMapper rule provider used by Jest + ESLint config; exports a "banned imports" list for controllers.                                                                                                                                              |
| Unit tests (ledger)           | `services/api/src/money-path/ledger/__tests__/ledger.engine.unit.spec.ts`                                                | New                                                                              | Mocked Prisma; idempotency replayed; Σ check fail; amount numeric safety via string→Decimal AST rule test file lives alongside here or §3.2 static rules path.                                                                                                                             |
| Unit tests (validator)        | `services/api/src/money-path/ledger/__tests__/double-entry.validator.unit.spec.ts`                                       | New                                                                              | 12 concrete double-entry / currency mix cases.                                                                                                                                                                                                                                             |
| Unit tests (flag)             | `services/api/src/money-path/flags/__tests__/feature-flag.service.unit.spec.ts`                                          | New                                                                              | Default OFF; fail-closed; setFlag ADMIN gate; setFlag 0 Ledger; TESTNET_GATE_MISSING.                                                                                                                                                                                                      |
| Unit tests (audit)            | `services/api/src/money-path/audit/__tests__/audit-sensitive-mutation.unit.spec.ts`                                      | New                                                                              | Envelope shape valid; before/after/reason/source/correlation; rollback on fail.                                                                                                                                                                                                            |
| Integration tests (live DB)   | `services/api/src/money-path/__tests__/postgres.integration.spec.ts`                                                     | New                                                                              | Containerized Postgres; full roundtrip; reversal; UPDATE/DELETE fails; setFlag counts; idempotency COMPLETED replay; serialization retry count; crash-after-commit replay.                                                                                                                 |
| Migration tests               | `services/api/src/money-path/__tests__/migration-appendonly.spec.ts`                                                     | New                                                                              | Migrate up; run UPDATE/DELETE → fail; rollback behavior; schema preamble FORBIDDEN comment text exists.                                                                                                                                                                                    |
| Regression tests              | `services/api/src/__tests__/p1-008-regression.spec.ts`                                                                   | New                                                                              | Runs existing auth / admin / user / wallet / idempotency / audit suites select scenarios; asserts 0 drift.                                                                                                                                                                                 |
| Controller bypass static rule | `services/api/.eslintrc.js` (or root ESLint overrides: `overrides: [{files: ['**/controllers/**/*.ts'], rules: {...}}]`) | _Modify additive only if existing override pattern doesn’t fit; else Jest rule._ | **PLAN QUESTION (§21 #1)**: pick Jest moduleNameMapper block (preferred, zero ESLint config surface) vs ESLint rule. Default: Jest only.                                                                                                                                                   |
| Shared error codes additive   | `packages/shared/src/error-codes.ts`                                                                                     | Modify additive                                                                  | New codes: FLAG_RACE_FLIPPED / IDEMPOTENCY_CONFLICT / IDEMPOTENCY_INFLIGHT / TESTNET_GATE_MISSING / LEDGER_DOUBLE_ENTRY_VIOLATION / LEDGER_AMOUNT_INVALID / MANUAL_ADMIN_DISABLED / AUTHZ_ROLE_INSUFFICIENT (reuse if already exported) / PHASE_B_IO_FORBIDDEN (dev-mode internal assert). |
| Architecture docs             | `docs/architecture/domain-services.md`                                                                                   | New or modify additive                                                           | §Ledger/Settlement/Commission/Risk/Flag/Audit contracts; links back to spec §3–7.                                                                                                                                                                                                          |

### 3.2 FORBIDDEN file changes (hard boundary)

- `apps/web/**` — FORBIDDEN
- `apps/admin/**` — FORBIDDEN
- `services/blockchain/**` — FORBIDDEN
- `infrastructure/docker/**`, `docker-compose.yml`, Dockerfiles — FORBIDDEN
- `packages/database/prisma/migrations/*.sql` EXCEPT the single new `p1_008_ledger_foundation` — FORBIDDEN
- Any file creating real deposit/withdrawal/treasury/balance/chain tables — FORBIDDEN
- `.env*` / secrets / nginx — FORBIDDEN
- Git operations: branch, commit, push — FORBIDDEN during Plan; only Implement + PR window will allow under T25 audit.

### 3.3 PLAN QUESTIONS (file-level)

- **PLAN Q1**: Controller bypass enforcement — prefer pure Jest moduleNameMapper (no ESLint config diff) vs ESLint override. **Plan default: Jest-only** (zero ESLint surface). If coverage needed in IDE, raise to ChatGPT before changing ESLint.
- **PLAN Q2**: `packages/shared/src/error-codes.ts` additive codes — Implement team writes a single PR additive-only block; should we declare a `MoneyPathErrorCode` namespace (recommended) to avoid enum merge conflicts? **Plan default: new additive enum `MoneyPathErrorCode` exported alongside existing, not merged into `AuthzFailReason`.** Not a blocker; defaulted.

---

## 4. Schema-level change map (1 migration, additive-only)

### 4.1 Expected enums added

1. `LedgerTxnType` — values: `SETTLEMENT, COMMISSION, TREASURY_MOVE, TRANSFER, REVERSAL, MANUAL_ADMIN, OPENING_BALANCE` (Prisma enum; physical name follows Prisma default)
2. `LedgerAmountSign` — values: `DEBIT, CREDIT`

### 4.2 LedgerTransaction field design (journal header)

| #   | 字段名              | Prisma type                                           | nullable           | default                                                                                                                                                                    | 索引 / unique / FK                                                                                              | 用途                                                                      | 安全原因 |
| --- | ------------------- | ----------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| 1   | `id`                | `String @id @default(uuid()) @db.Uuid`                | NOT NULL           | PK                                                                                                                                                                         | Stable ledger txn id used as reversesTxnId target.                                                              | UUIDv4 避免预测 + 全局跨表引用。                                          |
| 2   | `scope`             | `String @db.VarChar(64)`                              | NOT NULL           | 复合 UNIQUE（与下一列）                                                                                                                                                    | 操作作用域，例如 `commission/2026-08`、`treasury/batch-42`。与 idempotency key 一起保证同一业务动作只写一本账。 | 与 idempotency key 共同构成"按业务维度幂等"，避免跨范围误重放攻击。       |
| 3   | `txnIdempotencyKey` | `String @db.VarChar(128) @map("txn_idempotency_key")` | NOT NULL           | `@@unique([scope, txnIdempotencyKey], map: "ledger_txn_scope_idempotency_uq")`                                                                                             | 客户端/引擎生成的确定性幂等键。                                                                                 | 防双重记账；UNIQUE 在 DB 层兜底，即使 Engine race 也不可能双写。          |
| 4   | `txnType`           | `LedgerTxnType @map("txn_type")`                      | NOT NULL           | `@@index([txnType, createdAt], map: "ledger_txn_type_created_idx")`                                                                                                        | 分类：结算/返佣/资金划拨/转账/冲销/管理员手工/开账。                                                            | 决定审计与权限路径；OPENING_BALANCE 未来单独 mainnet 禁入 flag。          |
| 5   | `currency`          | `String @db.VarChar(16)`                              | NOT NULL           | (隐含：与 leg 比较但不是单独索引)                                                                                                                                          | 例如 "USDT"、"POINT"。和 unit / decimals 一起构成"本账本同币种"。                                               | 防止 Σ DEBIT/CREDIT 跨币种假平衡。强制单币种一账本；跨币种必须拆 txn。    |
| 6   | `unit`              | `String @db.VarChar(16)`                              | NOT NULL           | —                                                                                                                                                                          | "MINOR_UNIT"（推荐）/ "TOKEN"。                                                                                 | 与 currency 配合区分同种资产的记账粒度。                                  |
| 7   | `decimals`          | `Int @default(6)`                                     | NOT NULL default=6 | —                                                                                                                                                                          | 原子整数换算位数。                                                                                              | 定死在账本层；单一 txn 内所有 legs 共享同一 decimals。                    |
| 8   | `source`            | `String @db.VarChar(32)`                              | NOT NULL           | `@@index([source], map: "ledger_txn_source_idx")`                                                                                                                          | 哪个领域服务产生：ledger/settlement/commission/risk/treasury/manual_admin。                                     | 审计追溯；manual_admin 需额外 flag 门控。                                 |
| 9   | `reference`         | `String? @db.VarChar(256)`                            | NULLABLE           | —                                                                                                                                                                          | 外部 opaque id：结算批次号/操作 id。                                                                            | 与未来 Settlement/Treasury 表关联，不在 P1-008 实现。                     |
| 10  | `reversesTxnId`     | `String? @map("reverses_txn_id") @db.Uuid`            | NULLABLE           | `@@index([reversesTxnId], map: "ledger_txn_reverses_idx")` **+ FK → LedgerTransaction.id ON DELETE RESTRICT, ON UPDATE Cascade**（relation: reversesTxn / reversedByTxns） | REVERSAL 类型账本：指向原始账本。                                                                               | ON DELETE RESTRICT 防止原始账本被删但冲销留存；从架构上保障 append-only。 |
| 11  | `actorUserId`       | `String? @map("actor_user_id") @db.Uuid`              | NULLABLE           | `@@index([actorUserId, createdAt], map: "ledger_txn_actor_idx")` + **可加 FK 到 User.id ON DELETE SetNull**（推荐加上以与 AuditLog 对齐）。                                | 发起者；system/job 为 null。                                                                                    | FK SetNull 为合规保留历史；不级联删除保留账本。                           |
| 12  | `requestId`         | `String? @map("request_id") @db.VarChar(64)`          | NULLABLE           | —                                                                                                                                                                          | HTTP request id / job id。                                                                                      | 跨系统链路追踪。                                                          |
| 13  | `metadata`          | `Json?`                                               | NULLABLE           | —                                                                                                                                                                          | 额外信息（如 reversal reason、引擎版本、rate ref）。                                                            | **禁存密钥/签名/cookie**；严格 secret scan。                              |
| 14  | `createdAt`         | `DateTime @default(now()) @map("created_at")`         | NOT NULL           | 复用在 type/created_at 复合索引。                                                                                                                                          | 只写时间；禁止 updatedAt 字段。                                                                                 | 账本不允许修改，无 updatedAt；配合 append-only 防线。                     |

> **PLAN QUESTION Q3**: 是否给 actorUserId 显式 FK 到 users.id? 推荐 YES(ON DELETE SetNull, ON UPDATE Cascade) 与 AuditLog 一致。不影响 P1-008 功能。默认 YES。

### 4.3 LedgerPosting field design (分录)

| #   | 字段名              | Prisma type                                    | nullable | default                                                                                                                              | 索引 / unique / FK                                        | 用途                                                                       | 安全原因 |
| --- | ------------------- | ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------- | -------- |
| 1   | `id`                | `String @id @default(uuid()) @db.Uuid`         | NOT NULL | PK                                                                                                                                   | 分录 PK。                                                 | UUID。                                                                     |
| 2   | `ledgerTxnId`       | `String @map("ledger_txn_id") @db.Uuid`        | NOT NULL | `@@index([ledgerTxnId], map: "ledger_posting_txn_idx")` + **FK → LedgerTransaction.id ON DELETE RESTRICT, ON UPDATE Cascade**        | 父账本。                                                  | RESTRICT: 防止删 txn 留下 orphan legs；强制 append-only。                  |
| 3   | `accountType`       | `String @map("account_type") @db.VarChar(32)`  | NOT NULL | `@@index([accountType, accountId], map: "ledger_posting_account_idx")` (复合索引)                                                    | USER / PLATFORM / TREASURY / REFERRER / RESERVE。         | 纯记账桶，不存钱包地址。                                                   |
| 4   | `accountId`         | `String @map("account_id") @db.VarChar(128)`   | NOT NULL | 同上复合索引                                                                                                                         | user_id / "platform" / treasury-id。                      | 不 FK 到 User（因为 TREASURY/PLATFORM 等不是用户）；纯字符串。             |
| 5   | `sign`              | `LedgerAmountSign`                             | NOT NULL | —                                                                                                                                    | DEBIT 减少账户衍生余额；CREDIT 增加。                     | 统一与 parent txn amount (正数) × sign 算平衡。                            |
| 6   | `amount`            | `Decimal @db.Decimal(38, 0)`                   | NOT NULL | 建议 CHECK (amount >= 0)                                                                                                             | 非负原子整数；由 parent txn currency/unit/decimals 解释。 | **scale=0** 避免浮点；正数 × sign 统一 Σ；CHECK amount >= 0 防止符号混淆。 |
| 7   | `reversesPostingId` | `String? @map("reverses_posting_id") @db.Uuid` | NULLABLE | `@@index([reversesPostingId], map: "ledger_posting_reverses_idx")` + **FK → LedgerPosting.id ON DELETE RESTRICT, ON UPDATE Cascade** | REVERSAL txn 中每笔 leg 回指原始 leg。                    | RESTRICT：防止原始分录被删除/篡改。                                        |

> **PLAN QUESTION Q4**: amount 精度 38 是否足够？Spec 默认 `Decimal(38, 0)`。Plan 默认 38。Plan 阶段不改；若 Treasury 需 128-bit → 未来 additive migration ALTER COLUMN 扩到 64，0 回归风险。

### 4.4 Unique constraints, foreign keys, CHECK constraints (summary)

- Unique: `LedgerTransaction(scope, txnIdempotencyKey)` → DB-level idempotency.
- FKs:
  - `LedgerTransaction.reversesTxnId → LedgerTransaction.id` (Restrict)
  - `LedgerPosting.ledgerTxnId → LedgerTransaction.id` (Restrict)
  - `LedgerPosting.reversesPostingId → LedgerPosting.id` (Restrict)
  - (Q3 默认 YES) `LedgerTransaction.actorUserId → User.id` (SetNull)
- CHECK constraints (add via `-- <P1-008 append-only SQL>` block inside migration):
  1. `ledger_postings CHECK (amount >= 0)` (Postgres `amount >= 0::numeric`)
  2. `ledger_transactions CHECK (char_length(scope) > 0)`
  3. `ledger_transactions CHECK (char_length(currency) > 0 AND char_length(unit) > 0)`
  4. (可选纯 DB double-entry) 触发函数在 COMMIT 前对同 txn 校验 Σ(DEBIT)==Σ(CREDIT)；默认用 Engine 校验；可选 DB 触发器作为 belt-and-braces。
- **Append-only SQL**: 见 §6。

---

## 5. Task dependency DAG（与 §2 一致；同时给出 Task ID → Pre-require 列表）

| ID  | Task                                                                                   | Requires before start                                                                   |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| T1  | Baseline & Boundary Guard                                                              | None (runs first; verifies baseline frozen before any write)                            |
| T2  | Prisma Ledger Enums / Schema Design                                                    | T1                                                                                      |
| T3  | Ledger Migration (1 file, additive)                                                    | T2                                                                                      |
| T4  | DB Append-only Enforcement SQL                                                         | T3                                                                                      |
| T5  | Ledger Domain Types                                                                    | T1                                                                                      |
| T6  | LedgerEngine (wire + Decimal conversion + write / reverseTxn / balance)                | T2, T5                                                                                  |
| T7  | Ledger Double-entry Validator (pure fn + spec rules 1-6)                               | T5                                                                                      |
| T8  | Ledger Reversal (new balanced REVERSAL txn + reverses linkage)                         | T6, T7                                                                                  |
| T9  | Audit Metadata Contract (envelope TS type + validator)                                 | T1                                                                                      |
| T10 | AuditService Sensitive Mutation Contract wrapper                                       | T9 + T1(known AuditLog columns)                                                         |
| T11 | FeatureFlagService Money-path Governance                                               | T1 + T10 (because writes Audit)                                                         |
| T12 | Domain Service Contracts (Settlement/Commission/Risk Preflight+Commit)                 | T5 + T10                                                                                |
| T13 | Phase A Preflight Contract (types + orchestrator hooks)                                | T12 + T11                                                                               |
| T14 | Phase B Serializable Transaction Orchestrator                                          | T13 + T11 + T10 + T6 + (T15 can be same PR after T13 draft; see T15)                    |
| T15 | Idempotency Integration (reuse existing IdempotencyKey)                                | T14 design draft + baseline IdempotencyStatus enum                                      |
| T16 | Concurrency / Locking Strategy implementation helpers                                  | T14 design draft                                                                        |
| T17 | Failure / Retry / Crash Recovery orchestrator paths                                    | T14 + T15 + T16                                                                         |
| T18 | Controller DB-bypass Guard (Jest rule / ESLint per Q1)                                 | T1 (boundary white-list)                                                                |
| T19 | Unit Tests — Track B+C services (covers T6,T7,T8,T10,T11,T12,T13 part, T17 fail paths) | T6..T11, T13, T17                                                                       |
| T20 | PostgreSQL Integration Tests (depends migrated DB)                                     | T3, T4, T6, T10, T11, T14, T15, T16, T17                                                |
| T21 | Migration / Append-only Tests (UPDATE/DELETE fails + rollback)                         | T3, T4                                                                                  |
| T22 | Regression Tests (ensure existing suites 0 failures)                                   | All tasks that add new exports touching shared code (T5, T9, T11, T15 additive exports) |
| T23 | Security / Secret / CodeQL Compatibility                                               | T3, T6, T10, T11 + any new fixture                                                      |
| T24 | Documentation (`domain-services.md`)                                                   | T5, T6, T10, T11, T12                                                                   |
| T25 | Final Boundary Audit                                                                   | T1..T24 completed                                                                       |

---

## 6. Migration strategy

### 6.1 New migration count

Exactly **1 migration**: `packages/database/prisma/migrations/<TS>_p1_008_ledger_foundation/migration.sql`
with naming pattern `YYYYMMDDHHMMSS_p1_008_ledger_foundation` (timestamp generated by `prisma migrate dev` the moment Implement begins; Plan does NOT generate timestamps now).

### 6.2 Migration content (ordered blocks)

1. `enum LedgerTxnType` create
2. `enum LedgerAmountSign` create
3. `CREATE TABLE ledger_transactions ...` (fields per §4.2 + PK + UNIQUE(scope, txn_idempotency_key) + indexes)
4. `CREATE TABLE ledger_postings ...` (fields per §4.3 + PK + FKs + indexes)
5. `ALTER TABLE ledger_postings ADD CONSTRAINT ledger_postings_amount_positive CHECK (amount >= 0::numeric)`
6. `ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_txn_scope_not_empty CHECK (char_length(scope) > 0)`
7. `ALTER TABLE ledger_transactions ADD CONSTRAINT ledger_txn_currency_unit_not_empty CHECK (char_length(currency) > 0 AND char_length(unit) > 0)`
8. **Append-only enforcement block (§6.4).**
9. Comments block: `-- P1-008 FORBIDDEN real-fund fields (baseline header comment preserved in schema.prisma as source of truth): balance, deposit, withdrawal, tx_hash, chain, network, wallet_custody, private_key, hot_wallet, treasury_balance.` (No functional SQL.)

### 6.3 Migration rules

- **Additive only.** Never DROP existing objects. Never RENAME existing columns/enums/tables.
- Prisma `prisma migrate dev` to auto-generate skeleton; then hand-add CHECK + append-only enforcement via `-- custom SQL blocks` (post-migration-step or manual append). After drift check: `prisma migrate diff --from-migrations --to-schema` 必须 empty。
- Migration names sort strictly after existing latest migration in baseline.
- Existing `FORBIDDEN ANY real fund field` preamble comment in `schema.prisma` kept byte-stable.

### 6.4 Append-only enforcement SQL (recommended default = A+B combined)

Plan compares 3 approaches:

| 方案                         | 实现                                                                                                                                                                                                       | 优点                                                  | 缺点                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| A. Trigger-based             | `CREATE OR REPLACE FUNCTION p1008_no_update_delete() ... RAISE EXCEPTION 'APPEND ONLY'`; `CREATE TRIGGER ... BEFORE UPDATE OR DELETE ON ledger_transactions ... EXECUTE`; same for `ledger_postings`.      | 所有 DB 角色命中，包括超级用户误操作；与 GRANT 无关。 | Trigger 代码在 migration.sql 内维护；`DROP TRIGGER` 需 DBA 流程；仍需 CI 验证。 |
| B. Role-based GRANT / REVOKE | App user `app_rw` 之外另建 `app_ledger_no_mut`？No — simpler: `REVOKE UPDATE, DELETE ON ledger_transactions, ledger_postings FROM <app-db-user>` (若 Prisma 连接使用的角色拥有默认 CREATE 权限则 REVOKE)。 | 标准；性能好。                                        | 若 app 使用超级用户连接则无效；需要部署配置保证。                               |
| C. A + B 组合                | Trigger 作为最强防线 + REVOKE 作为日常权限最小化。                                                                                                                                                         | 双层；任一命中都保护。                                | 两份维护（可接受）。                                                            |

**Plan 最终推荐 = C (A + B combined)**:

- 先在 migration 中 `REVOKE UPDATE, DELETE ON ... FROM <app-user>`；若运行环境不支持（PLAN QUESTION Q5: 具体 DB 用户名?），Implement 将 app-user 名作为 deploy-time 变量，migration SQL 用 `DO $$ ... current_user ... $$` 形式处理兜底。
- 然后加 BEFORE UPDATE/DELETE triggers 对两张表无条件抛异常。
- Integration tests T21:
  - `UPDATE ledger_transactions SET metadata = ... WHERE id = ...` → 测试断言 DB 异常；事务回滚；SELECT 原 row 未变。
  - `DELETE FROM ledger_postings WHERE id = ...` → 同样失败；回滚行为验证。

---

## 7. Double-entry strategy & 12 concrete tests

### 7.1 Engine validation order

1. `postings.length >= 2` → else `LEDGER_DOUBLE_ENTRY_VIOLATION:TOO_FEW_POSTINGS`.
2. All legs have same `currency === parentTxn.currency` → else `LEDGER_DOUBLE_ENTRY_VIOLATION:MIXED_CURRENCY`.
3. All legs have same `unit === parentTxn.unit` → else `MIXED_UNIT`.
4. All legs inherit `decimals === parentTxn.decimals` (enforced at write path; decimals is parent-only column → mixed decimals structurally impossible by design).
5. Each leg `amount >= 1` + Prisma.Decimal integer check (no fractional) → else `LEDGER_AMOUNT_INVALID:NON_INTEGER_OR_NON_POSITIVE`.
6. `Σ amount(where DEBIT) === Σ amount(where CREDIT)` using Prisma.Decimal exact compare → else `LEDGER_DOUBLE_ENTRY_VIOLATION:BALANCE_MISMATCH`.

### 7.2 12 项复式记账具体测试（T7 + T19 单元测试，T20 集成测试重复）

| Test ID | 场景                                                                                                                                       | 期望                                                                                | 对应 AC                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------- |
| DET-01  | 2 postings: 1 DEBIT 100, 1 CREDIT 100                                                                                                      | PASS；write 成功；idempotency replay 成功。                                         | AC-LED-02/03                                 |
| DET-02  | 1 DEBIT 100, 1 CREDIT 99                                                                                                                   | 抛 BALANCE_MISMATCH；0 写行；回滚。                                                 | AC-LED-03                                    |
| DET-03  | postings.length = 1                                                                                                                        | 抛 TOO_FEW_POSTINGS；0 写行。                                                       | AC-LED-03                                    |
| DET-04  | currency mismatch（一条腿 USDT，一条腿 POINT）                                                                                             | 抛 MIXED_CURRENCY；不写。                                                           | AC-LED-03                                    |
| DET-05  | unit mismatch（MINOR_UNIT vs TOKEN）                                                                                                       | 抛 MIXED_UNIT；不写。                                                               | AC-LED-03                                    |
| DET-06  | mixed decimals（结构性：decimals 在 txn 不在 posting；仅可通过 wire 不一致）→ validator 检查 postings.wireDecimals 一致并与 parent 一致    | 抛 MIXED_DECIMALS；不写。                                                           | AC-LED-03（spec 同币种同单位延伸；显式测试） |
| DET-07  | zero amount leg → 抛 AMOUNT_NON_POSITIVE                                                                                                   | 0 写行。                                                                            | 零负边界（对应 §六 7）                       |
| DET-08  | negative amount string ("-100") 或 Decimal("-100") 传入 wire → validator 拒绝                                                              | AMOUNT_NON_POSITIVE；不写。                                                         | 零负边界（§六 7）                            |
| DET-09  | duplicate `(scope, txnIdempotencyKey)` 二次 write                                                                                          | 返回 `replayed=true`；行计数 Δ=0。                                                  | AC-LED-02（对应 §六 8）                      |
| DET-10  | `reverseTxn(originalTxnId)` → 新 REVERSAL txn + per-leg reversed；`SELECT original.*` 前后逐字段对比（含 createdAt）完全一致。             | Byte-identical。                                                                    | AC-LED-04（§六 10）                          |
| DET-11  | 同一 reversal 请求再次执行（相同 scope/idempotencyKey）→ 账本幂等回重放，不新增第二笔反向。                                                | 回重放成功；0 新行；Audit reverseTxn 重复则 Idempotency COMPLETED replay 相同响应。 | §六 11                                       |
| DET-12  | 并发创建同一 idempotency key（两个 Jest worker 同时或串行抢占 PENDING）→ 其中一个 409 IDEMPOTENCY_INFLIGHT 或抢到后另一人 COMPLETED 重放。 | 行 Δ= 1 账本，无双写。                                                              | §六 12 / AC-TXN-28                           |

FX/Cross-currency implementation FORBIDDEN in P1-008; only reject (DET-04).

---

## 8. Two-Phase Transaction strategy (step-by-step, inputs/outputs/errors/rollback)

### 8.1 Phase A — Preflight (no DB tx; I/O allowed)

| 步骤                        | 输入                                                              | 输出                                                                                                                                                | 可能失败                                            | Error code                                                             | Rollback / Retry                                             |
| --------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| A1 Auth/RBAC                | `req.auth`, requiredRoles list                                    | `authzCtx: {userId, role, walletId?}`                                                                                                               | 401 no auth; 403 role insuff; 500 role lookup fail  | `UNAUTHENTICATED / AUTHZ_ROLE_INSUFFICIENT / AUTHZ_ROLE_LOOKUP_FAILED` | No writes; retry meaningless.                                |
| A2 Validation               | `req.body`, schema (Zod/class-validator)                          | `parsedInput: InputT`                                                                                                                               | 400 validation                                      | `VALIDATION_ERROR`                                                     | No writes; fix payload retry ok (new idempotency hash).      |
| A3 Canonical hash           | `parsedInput + idempotencyKey + scope + actor + timestamp? (NOT)` | `requestHash: string (SHA-256 hex 64)`                                                                                                              | 无直接失败                                          | —                                                                      | Deterministic (no timestamp), same payload always same hash. |
| A4 Initial flag check       | `requiredFlags[]`, FeatureFlagService                             | `{ allEnabled: boolean }`                                                                                                                           | 403 disabled / 503 infrastructure → fail closed OFF | `MONEY_FEATURE_DISABLED / MONEY_FEATURE_UNAVAILABLE`                   | No writes; operator flips flag then retry.                   |
| A5 Risk preflight           | `RiskPreflightInput(parsedInput, authzCtx)`                       | `RiskResult = PASS                                                                                                                                  | BLOCK + reasons[]`                                  | BLOCK 403；外部调用超时 504（网关超时报错，非 DB）                     | `RISK_BLOCKED / RISK_PREFLIGHT_TIMEOUT`                      | No writes; BLOCK 不重试；外部超时最多外层 1 次总重试（§8.3）。 |
| A6 Deterministic plan build | `parsedInput + authzCtx`                                          | `CommitPlan: { stateMutation, balancedLedgerPlan, auditEnvelope, idempotency: {scope,key}, requiredFlags, source, actorUserId, requestId, ip, ua }` | 400/500 plan build fail                             | `PLAN_BUILD_INVALID`                                                   | No writes; retry 顶层总重试走 A1→A6 新鲜。                   |

### 8.2 Phase B — Very short Serializable DB tx (no I/O)

| 步骤                      | 输入                                                                  | 输出                                               | 可能失败                               | Error code                                                                                                     | Rollback                                                                                   |
| ------------------------- | --------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| B1 Flag re-check (TOCTOU) | `requiredFlags`, tx `Prisma.TransactionClient`                        | bool allEnabled                                    | 若 A4→B1 间 flag 关 → ROLLBACK         | `FLAG_RACE_FLIPPED` (409)                                                                                      | FULL ROLLBACK                                                                              |
| B2 Concurrency locks      | plan.lockTargets (account triples / operation keys), tx               | locked Rows/Nothing                                | lock timeout > setting                 | `CONCURRENCY_LOCK_TIMEOUT`                                                                                     | ROLLBACK；外层 1× 自动重试（重走 Phase A + B）                                             |
| B3 Idempotency claim      | scope, key, requestHash, tx                                           | claim: NEW/REPLAY_COMPLETED/INFLIGHT/HASH_MISMATCH | 见 §9 状态机                           | 409 IDEMPOTENCY_INFLIGHT / 409 IDEMPOTENCY_CONFLICT / (REPLAY_COMPLETED: skip rest, return cached body)        | INFLIGHT/CONFLICT ROLLBACK；REPLAY 不改 DB                                                 |
| B4 Domain state mutation  | plan.stateMutation, tx                                                | stateRecord                                        | DB constraint / FK violation           | `STATE_MUTATION_FAILED`                                                                                        | FULL ROLLBACK + B3 idempotency → FAILED                                                    |
| B5 Ledger write           | plan.balancedLedgerPlan + actor/request/source + T6 LedgerEngine + tx | txnId, postingIds                                  | 引擎校验 Σ/币种/幂等 UNIQUE            | `LEDGER_DOUBLE_ENTRY_VIOLATION / LEDGER_AMOUNT_INVALID / LEDGER_IDEMPOTENCY_UNIQUE (should not happen due B3)` | FULL ROLLBACK + B3→FAILED                                                                  |
| B6 Audit write            | plan.auditEnvelope + T10 service + tx                                 | auditId                                            | Audit envelope invalid / DB err        | `AUDIT_ENVELOPE_INVALID / AUDIT_WRITE_FAILED`                                                                  | FULL ROLLBACK（state+ledger 同撤）→ B3→FAILED                                              |
| B7 Idempotency COMPLETED  | scope, key, response snapshot, tx                                     | rowsAffected=1                                     | 0 rows updated (another worker won)    | 无错误；转为 REPLAY_COMPLETED 读缓存返回                                                                       | 若其它 worker 赢则无 rollback；否则 commit。                                               |
| B8 Commit                 | —                                                                     | commit ts                                          | PostgreSQL serialization_failure 40001 | `SERIALIZATION_FAILURE`（503 顶层）                                                                            | ROLLBACK；外层 1× 完整自动重试（PhaseA→PhaseB）；第二次 serialization fail 抛 503 不重试。 |

### 8.3 Top-level retry matrix

| Trigger                                              | Retry count                                   | Behavior                                                                                 |
| ---------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Phase A network failure (Risk external, 504)         | 0 (用户/网关 retry with same idempotency key) | Not retried automatically inside orchestrator (no lock held but 幂等 already protects)。 |
| Phase B2 lock timeout / Phase B8 serialization 40001 | 1 (auto)                                      | Rerun full A + B with same idempotency key.                                              |
| B7 0 rows update (someone else won race)             | 0                                             | Replay cached response。                                                                 |
| B3 COMPLETED 重放                                    | 0                                             | Return cached。                                                                          |
| Other 5xx                                            | 0                                             | Fail fast 500/503; client retries。                                                      |

---

## 9. Locking strategy (FOR UPDATE row / advisory lock — final recommendation)

### 9.1 Analysis

| 方案                                                                       | 什么时候合适                                                                                                                                                                                                                                                                                         | 优点                                                                | 缺点                                        |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------- |
| **Row-level `SELECT ... FOR UPDATE`**                                      | 当我们能把并发热点映射到数据库中已存在的"账户行"时最适合。P1-008 无真实账户表；**但可复用 `User` / `SystemConfig` / 新建一个"空" `LedgerAccountLock` 行？No.** — 推荐：锁 `User` 行（当 `accountType=USER` & `accountId` 是真实 user_id）；对 PLATFORM/TREASURY/RESERVE 采用 advisory lock（见右）。 | 精确到账户；Deadlock 检测由 Postgres 做；与 Serializable 组合良好。 | 无真实 user 行时不可用。                    |
| **PostgreSQL advisory lock (`pg_advisory_xact_lock(bigint)` / session级)** | PLATFORM/TREASURY/RESERVE/跨多账户聚合操作。将 `(accountType, accountId)` 哈希为 64-bit key。                                                                                                                                                                                                        | 不依赖真表；极快；事务结束自动释放。                                | 64-bit 哈希冲突极小但非零；需稳定哈希函数。 |

### 9.2 Plan 最终推荐（Implement 不得临时切换）

**Hybrid locking policy by `accountType`:**

- **`accountType = USER` 且 `accountId` 为合法 UUID** → `SELECT id FROM users WHERE id = ? FOR UPDATE` 加行锁（并检查存在性；若不存在则直接抛错，不锁假账户）。
- **所有非 USER 账户类型 + 用户账户不存在/跨多账户批处理** → `pg_advisory_xact_lock` with stable `bigint = fnv1a_64("p1008:" + accountType + ":" + accountId)`。
- Orchestrator 在 B2 对 plan 涉及的每个 account triple 去重后逐个加锁，**按稳定字典序排序** 防死锁。
- Serializable failure 外层 1× 重试（与 §8.3 一致）；第二次失败 → 503 明确错误 `SERIALIZATION_FAILURE_AFTER_RETRY`。
- Fallback: RepeatableRead 仅在 Plan/Implement 期间有压测报告证明并显式提交 PR 评论；默认 **Serializable**，不降级。

---

## 10. Idempotency strategy (reuse existing `IdempotencyKey`; status machine)

### 10.1 Statuses (strictly baseline enum)

Existing: `PENDING | COMPLETED | FAILED`. Spec v0.2/Plan never add `DONE`.

### 10.2 State machine behaviors

| 场景                                                                  | Step                    | Behavior                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New request, no row                                                   | B3                      | `INSERT idempotency_keys(scope,key,requestHash,status=PENDING,expiresAt=now+TTL)`. Success → proceed B4..B8. TTL 默认 24h（可配，避免永久悬挂 PENDING）。                                                                                                                                                                                                                    |
| Repeat same `requestHash`, status=COMPLETED                           | B3                      | SELECT hit. Return cached `responseCode + responseBody`. Skip B4..B7. Commit no new rows.                                                                                                                                                                                                                                                                                    |
| Repeat different `requestHash`, status=COMPLETED or PENDING or FAILED | B3                      | Hash mismatch → **409 IDEMPOTENCY_CONFLICT**。必须失败，防止攻击者篡改 payload 复用同一幂等键。                                                                                                                                                                                                                                                                              |
| Repeat same hash, status=PENDING                                      | B3                      | 第二个请求看到 **PENDING**；立刻返回 **409 IDEMPOTENCY_INFLIGHT**（避免两个请求同时跑 B4..B7）。可选短暂自旋最多 50ms。                                                                                                                                                                                                                                                      |
| Status=FAILED retry 同 hash                                           | B3                      | 分策略：对"可重试业务错误"（如 STATE_MUTATION_FAILED）允许覆盖重入（UPDATE status=PENDING where scope+key+status=FAILED 竞争行）；成功覆盖 → 正常进入 B4；失败覆盖 → 视为 INFLIGHT/CONFLICT。对"业务永久拒绝"（RISK_BLOCKED）直接 FAILED 不重入；客户端改 payload 才能重跑。策略枚举在 T15/T17 代码中落地并配测试。                                                          |
| Transaction rollback                                                  | Any B failure           | 所有变更回滚；`idempotency_keys` 若为 INSERT 得到的 PENDING 行同样回滚；若已到 B7 之前更新 FAILED 则 rollback 也会消去 FAILED，因此规范：**在 B 中失败的处理路径**：执行 `UPDATE idempotency_keys SET status=FAILED, responseBody = {error}` **作为单独的短事务**（在 Phase B ROLLBACK 之后执行一次，尽力而为）。失败路径写不进 FAILED，不阻塞主错误返回；TTL 清理 PENDING。 |
| Commit after crash (B8 commit OK 但未发送响应前死亡)                  | client retry + B3 again | 再次请求 → B3 读 COMPLETED + hash 相同 → 回缓存响应。账本零重复；Audit 零重复。                                                                                                                                                                                                                                                                                              |

### 10.3 Adapter implementation (T15)

- Reuse repos provided by `@ai-wealth/database` which already include IdempotencyKey.
- Implement methods: `claimPending(scope,key,hash,expiresAt)`, `markCompleted(scope,key,code,body): rowsAffected`, `markFailedOutsideTx(scope,key,errBody)`, `readReplay(scope,key)`, `checkHashConflict(scope,key,hash)`.
- 绝对禁止：新增第二张幂等表或修改 IdempotencyStatus enum。

---

## 11. Audit strategy

- **Table**: existing `AuditLog`. **No schema changes.** No before/after columns added.
- **Envelope** inside `metadata Json?`: `{before, after, reason, source, correlation}` — 5 keys required; null values allowed but keys must be present (T9 validator + AC-AUD-12/13).
- **Every sensitive write goes through T10 wrapper**: AuditSensitiveMutationService.sensitiveMutation → builds envelope, calls existing AuditService.write(action, resource, actor, requestId, ip, ua, metadata=envelope).
- **Audit is NOT Ledger**: wrapper never touches Ledger; FeatureFlag.setFlag must prove Δ(Ledger)=0 (AC-FLG-18).
- **Ledger reverseTxn**: action=`LEDGER_REVERSAL`; envelope.reason=reverseTxn reason param; source='ledger'; correlation=reversesTxnId (AC-AUD-15).
- **Flag flips**: action=`SYSTEM_CONFIG_UPDATED`; envelope before=old row, after=new row, source='flags', correlation=<flag key 或 update id>.
- **non-blocking policy**: Ledger audit failure in Phase B rolls back full tx (AI-01; FS-06 / AC-AUD-14). Audit never partial.

---

## 12. Feature flag strategy

- **Table**: existing `SystemConfig`. No new table (unless blocker encountered → PLAN QUESTION before any code change).
- **Convention**: keys match `money.flags.<scope>.<feature>`.
- **Default OFF**: missing → OFF; isActive=false → OFF; parse fail → OFF (FI-01/02 → AC-FLG-16).
- **Fail closed**: DB fault/swallow → OFF (AC-FLG-17).
- **ADMIN double-check mutation**: (1) HTTP @Roles(ADMIN); (2) FeatureFlagService.setFlag 内部 `repos.user.getAuthorizationContext(actorUserId)` 再查一次 live role；非 ADMIN → 抛 AUTHZ_ROLE_INSUFFICIENT + tx rollback (AC-FLG-19).
- **Mutation writes Audit, NO Ledger**: SystemConfig UPDATE + AuditLog insert in same tx. Integration counts: SystemConfig+1, Audit+1, LedgerTransaction+0, LedgerPosting+0 (FI-05/06, AC-FLG-18).
- **Phase A + Phase B double check**: Phase A isEnabledSafe quick gate; Phase B B1 Serializable re-read prevents TOCTOU (AC-FLG-21).
- **Testnet gate**: setFlag(mainnet___enabled=true) checks matching testnet___enabled exists + isActive=true + value==true; else TESTNET_GATE_MISSING rollback (FR-09, AC-FLG-20).
- **Fixture flags only**: Implement tests create `money.flags.test_fixture_enabled`, `money.flags.mainnet_fixture_enabled` exclusively; never touch production flags.

---

## 13. 详细任务 T1..T25

### T1 — Baseline & Boundary Guard (anchor)

- **Inputs:** frozen baseline SHA, white-list §3 file map, §4 schema map.
- **Files:** none (build scripts/checklist in PR description only).
- **Implementation:** (1) Open Implement PR checklist template: baseline SHA, branch = feature/p1-008-money-path-foundation. (2) `git diff develop -- apps/web apps/admin services/blockchain infrastructure/docker docker-compose.yml` empty in CI job (新增 GitHub Actions step，or local `pnpm --filter api run test:boundary:p1008` 脚本). (3) Verify schema.prisma preamble comment exists.
- **Tests:** boundary test script asserts 0 changes to forbidden paths.
- **Stop conditions:** any forbidden diff present → PR BLOCKED, no further task work starts.

### T2 — Prisma Ledger Enums / Schema Design

- **Inputs:** §4 schema-level map (fields + FKs/indexes/CHECK)
- **Files:** `packages/database/prisma/schema.prisma` additive edits
- **Implementation:** (a) add enums; (b) add models; (c) run `prisma validate`; (d) assert preamble FORBIDDEN comment byte-identical.
- **Tests:** prisma validate passes; schema diff vs baseline contains ONLY additions; no rename/drop.
- **Stop cond:** any field removal/rename detected → revert T2.

### T3 — Ledger Migration (1 additive file)

- **Inputs:** T2 + §6 migration blocks
- **Files:** one new `migration.sql` file (timestamped by `prisma migrate dev`)
- **Implementation:** `prisma migrate dev --name p1_008_ledger_foundation`; edit generated file with CHECK blocks & §6.4 append-only enforcement custom SQL blocks; `prisma migrate resolve --applied` if needed; `prisma migrate diff` vs schema 空 diff proof.
- **Tests:** migrate deploy against empty test container success; T21 runs.
- **Stop cond:** more than 1 migration file created; delete both and retry.

### T4 — DB Append-only Enforcement SQL

- **Inputs:** §6.4 option C (triggers + REVOKE both)
- **Files:** migration.sql custom block (hand appended to T3 migration)
- **Implementation:** REVOKE UPDATE/DELETE on both tables from `<app-user>` (use PL/pgSQL `current_user` when username unknown — PLAN Q5 default); triggers `p1008_no_update_delete()` for UPDATE/DELETE.
- **Tests:** T21 UPDATE/DELETE fail + rollback.
- **Stop cond:** trigger does not execute or REVOKE leaves superuser unprotected → add another layer (RLS/second trigger).

### T5 — Ledger Domain Types

- **Files:** `money-path/ledger/types.ts` + `domain/money-domain.types.ts`
- **Implementation:** `LedgerJournalRequest`/`LedgerPostingPlan`/source enums/`LedgerAmountSign`/`LedgerTxnType` aliases from `@ai-wealth/database`; `MoneyDomainPreflight/CommitCtx`, plan DTOs, Risk/Settle/Commission result shapes.
- **Tests:** TS compile; no runtime.
- **Stop cond:** any JS `number` appears in amount type signatures → replace with `string` wire.

### T6 — LedgerEngine

- **Files:** `ledger/ledger.engine.ts`
- **Implementation:** (a) amount string → Decimal conversion + integer&positive precheck; (b) unique scope/idempotency replay; (c) write LedgerTransaction + N postings; (d) reverseTxn builds balanced REVERSAL; (e) balance aggregation.
- **Tests:** T19 Unit + T20 integration; AC-LED-01..06, 09.
- **Stop cond:** Engine bypasses T7 validator → wire back validator into write() path.

### T7 — Ledger Double-entry Validator

- **Files:** `ledger/double-entry.validator.ts`
- **Implementation:** pure function 12 tests DET-01..12; see §7.2.
- **Tests:** T19 unit 中的 DET cases; AC-LED-03, amount safety.
- **Stop cond:** 任何 DET 用例未通过。

### T8 — Ledger Reversal

- **Files:** continues within ledger.engine.ts + tests
- **Implementation:** reverseTxn reads original, clones legs with sign flipped + reversesPostingId each + reversesTxnId parent + metadata.reason; calls T7 validator; writes new transaction.
- **Tests:** DET-10/11; AC-LED-04/05; Audit → LEDGER_REVERSAL.
- **Stop cond:** original rows updated (test spy catches).

### T9 — Audit Metadata Envelope Contract & validator

- **Files:** `audit/audit-metadata.types.ts`
- **Implementation:** TS interface + runtime shape check (5 keys present; before/after free; reason/source/correlation nullable-string).
- **Tests:** missing key → invalid (AC-AUD-13).

### T10 — AuditService Sensitive Mutation wrapper

- **Files:** `audit/audit-sensitive-mutation.service.ts`
- **Implementation:** composes envelope → calls existing AuditService.write → inserts into DB inside Phase B tx. Throws on envelope invalid → rollback.
- **Tests:** AC-AUD-11/14.

### T11 — FeatureFlagService

- **Files:** `flags/feature-flag.service.ts`
- **Implementation:** isEnabled / isEnabledSafe (try/catch false) / setFlag (ADMIN double-check + Audit + TESTNET gate + Ledger=0 invariant).
- **Tests:** AC-FLG-16..22.
- **Stop cond:** setFlag writes any Ledger row → fix + add integration test counts.

### T12 — Domain Service Contracts

- **Files:** `domain/settlement.engine.ts`, `commission.engine.ts`, `risk.engine.ts`
- **Implementation:** interfaces + DTO types only. NO implementation bodies (throw new Error("not implemented / not P1-008") 或纯 abstract). No chain calls, no business logic.
- **Tests:** compile + documentation generator; AC-LED/Domain indirectly covered by orchestrator types.

### T13 — Phase A Preflight Contract

- **Files:** orchestrator/types.ts + two-phase.orchestrator.ts 中的 Phase A 段
- **Implementation:** typed A1..A6 pipeline hook points; A5 Risk evaluatePreflight runs; deterministic plan build outputs CommitPlan (fully serializable so that retries yield same plan for same input).
- **Tests:** plan determinism test (same input → plan deepEqual twice).

### T14 — Phase B Serializable Transaction Orchestrator

- **Files:** `orchestrator/two-phase.orchestrator.ts`
- **Implementation:** execute(twoPhaseInput) runs PhaseA → PhaseB (Serializable timeout 2s inside Prisma.$transaction(options.isolationLevel=Serializable)), steps B1..B8; external network calls forbidden (dev-mode helper can monkey-patch fetch to throw PHASE_B_IO_FORBIDDEN for tests).
- **Tests:** AC-TXN-23/24/32; serialization retry exactly once (AC-TXN-29).

### T15 — Idempotency Integration

- **Files:** orchestrator/idempotency.integration.ts; reuse repos.IdempotencyKey;
- **Implementation:** §10 状态机方法；markFailedOutsideTx（small separate tx）。
- **Tests:** AC-TXN-25..28/31; crash-after-commit simulation AC-TXN-30.

### T16 — Concurrency / Locking Strategy

- **Files:** orchestrator/locking.strategy.ts
- **Implementation:** Hybrid per §9: user=USER → FOR UPDATE users.id; other → advisory lock bigint FNV-1a 64. Sort before lock.
- **Tests:** deadlock test (two interleaved locks in reverse order → deadlock error from Postgres，证明排序生效后同测试不得死锁).

### T17 — Failure / Retry / Crash Recovery paths

- **Files:** orchestrator code + idempotency integration
- **Implementation:** §8 matrix error code handling; 1× auto retry serialization/lock timeout; FAILED 可重试覆盖 / 不可重入拒绝策略.
- **Tests:** AC-TXN-29, 30, FS matrix.

### T18 — Controller DB bypass Guard

- **Files:** (Default Jest rule) a new Jest setup file under `services/api/test/setup-p1008-bypass.ts` that registers a moduleNameMapper block throwing `BYPASS_VIOLATION` whenever controllers import Prisma for the 4 models; alternatively ESLint override per PLAN Q1.
- **Tests:** AC-RBAC-33 + one positive test.

### T19 — Unit Tests

- **Files:** listed in §3.1 unit test paths.
- **Coverage target:** money-path modules ≥80% line, ≥90% decision (NFR-05, AC-CI-37).
- **Covers ACs:** see §17 Traceability.

### T20 — PostgreSQL Integration Tests (container)

- **Tooling:** docker-compose Postgres service OR testcontainers (match repo existing integration pattern — **PLAN QUESTION Q6**: repo uses docker-compose-only? 默认跟随 repo existing live-DB pattern；若现有无 testcontainers 则用 compose 避免加新依赖).
- **Tests:** full round-trip; UPDATE/DELETE fail; setFlag counts (SystemConfig+1, Audit+1, Ledger+0, Posting+0); mainnet_gate_missing; serialization retry exactly 1; crash-after-commit replay → 0 duplicate; COMPLETED replay.

### T21 — Migration / Append-only Tests

- **UPDATE ledger_transactions → DB error; rollback → original rows untouched.**
- **DELETE ledger_postings → DB error; same rollback check.**
- **Migration only 1 file; schema.prisma FORBIDDEN comment present (grep test).** AC-MIG-40.

### T22 — Regression Tests

- Run: existing auth/admin RBAC suite + idempotency tests + user/wallet CRUD + existing Prisma migrate + existing Jest API unit suites.
- apps/web build typecheck + apps/admin build typecheck unchanged passes (NFR-06/AC-CI-38).

### T23 — Security / Secret / CodeQL

- Secret scan: all new fixture/metadata 0 PK/mnemonic/JWT/sig matches (AC-CI-39).
- CodeQL: no new injection sinks; SQL params only via Prisma parameterized queries / Decimal types.
- SR-01..11 satisfied (reviews checklist + unit/integration coverage).

### T24 — Documentation

- `docs/architecture/domain-services.md` (if exists: append new section; else create). Sections: Ledger / Settlement / Commission / Risk / Audit / Feature-Flag / 2-Phase Transaction. Links to spec.md sections.

### T25 — Final Boundary Audit

- Final `git diff` vs baseline: files exactly §3 whitelist (plus test fixtures/docs). schema.prisma 仅 §4 加法对象。Migration count = 1。apps/web/admin/docker/compose/services/blockchain 0 changes。所有 AC passing。如果任何超限 → 必须在 PR 中 revert 后重新审计。

---

## 14. Rollback strategy (Implement-phase safety)

- **Code rollback:** if a bug found in PR before merge → revert commits inside feature branch; no DB ops required.
- **Migration rollback after merge but pre-prod deploy:** roll forward with a new additive-only "undo bad migration" migration (e.g. DROP TRIGGER if trigger bug; add missing CHECK). NEVER DROP tables/enums.
- **Post-deploy ledger bug:** append-only prevents mutation via SQL UPDATE/DELETE. Fix = new REVERSAL txns via administrative future task; ledger state repaired purely by append.
- **Feature flag issue:** turn flag OFF. Fail-closed guarantees no more writes. Audit trail captured for every flip.

---

## 15. Security boundary summary

- Append-only SQL + REVOKE at DB; LedgerEngine at app; jest/eslint rule against controller direct writes.
- No private keys / chain info anywhere.
- JS `number` 禁用于金额 (AST 测试, NFR-09, AC-LED-09).
- Phase B NO network (dev guard).
- Idempotency hash mismatches fail fast.
- TOCTOU flag 双重检查 (A + B1).
- ADMIN setFlag 双次 live role check; USER → 403 guard + service throw second path.

---

## 16. Final verification commands (Implement-phase checklist)

Implemented task T1 CI job must run (local mirror commands shown here) before PR submission:

```bash
# 1. Baseline commit
git rev-parse HEAD
# must equal or descendant of develop@13326d9... at PR time

# 2. No forbidden-tree changes (empty exit 0)
git diff --name-only develop -- apps/web apps/admin services/blockchain infrastructure/docker docker-compose.yml

# 3. Exactly 1 new migration
find packages/database/prisma/migrations -mindepth 1 -maxdepth 1 -newer packages/database/prisma/migrations/<LATEST_EXISTING_DIRNAME> -type d | wc -l
# => expect 1

# 4. Prisma drift proof
pnpm --filter @ai-wealth/database exec prisma migrate diff \
  --from-migrations packages/database/prisma/migrations \
  --to-schema-datamodel packages/database/prisma/schema.prisma \
  --script /tmp/drift.sql && test \! -s /tmp/drift.sql

# 5. Unit + integration
pnpm --filter api test
pnpm --filter api test:integration

# 6. Typecheck + lint
pnpm --filter api typecheck
pnpm --filter api lint

# 7. Admin/web regressions (no diff builds)
pnpm --filter @ai-wealth/admin build
pnpm --filter @ai-wealth/web build
```

---

## 17. Test Matrix + AC Traceability Matrix (42 AC 全对应)

| AC ID      | Task ID                                  | Primary Test ID(s)                                                                                        | Test Type                         |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------- |
| AC-LED-01  | T5, T6                                   | T19 engine signatures unit                                                                                | Unit                              |
| AC-LED-02  | T6, T15                                  | DET-09(unit) + T20 idempotency replay                                                                     | Unit + Integration                |
| AC-LED-03  | T6, T7                                   | DET-01..06(unit)                                                                                          | Unit                              |
| AC-LED-04  | T6, T8                                   | DET-10(unit + integration byte compare)                                                                   | Unit + Integration                |
| AC-LED-05  | T8                                       | T19 spy on Prisma update/delete                                                                           | Static + Unit                     |
| AC-LED-06  | T6 + T20 integration                     | T20 100-journal seed balance aggregation                                                                  | Integration                       |
| AC-LED-07  | T2, T3 + T21 migration test              | T21 + grep schema.prisma additions                                                                        | Migration test                    |
| AC-LED-08  | T4 + T21                                 | UPDATE ledger_transaction + DELETE ledger_postings each throw                                             | DB constraint                     |
| AC-LED-09  | T5, T6 + NFR-09 rule                     | T19 AST/lint money-path amount math                                                                       | Static architecture test          |
| AC-LED-10  | T15 + RI-01 grep rule                    | New TS files grep 'status=DONE' empty + CI                                                                | Static + Security                 |
| —          | —                                        | —                                                                                                         | —                                 |
| AC-AUD-11  | T9, T10                                  | T19 unit sensitive-mutation path                                                                          | Unit                              |
| AC-AUD-12  | T10                                      | envelope key-presence validation unit                                                                     | Unit                              |
| AC-AUD-13  | T9 validator                             | invalid envelope → throw + rollback unit                                                                  | Unit + Transaction                |
| AC-AUD-14  | T10 + T19                                | mock Audit throw → state+ledger rows 0 post-test                                                          | Transaction + Unit                |
| AC-AUD-15  | T8 + T10                                 | reverseTxn reason/correlation assertion in Audit row                                                      | Unit + Integration                |
| —          | —                                        | —                                                                                                         | —                                 |
| AC-FLG-16  | T11                                      | default OFF unit cases                                                                                    | Unit                              |
| AC-FLG-17  | T11                                      | DB throw → isEnabledSafe → false                                                                          | Unit (mocked Prisma)              |
| AC-FLG-18  | T11 + T20                                | setFlag row counts Δ= +1System/+1Audit/0LedgerT/0Postings                                                 | Integration                       |
| AC-FLG-19  | T11                                      | non-ADMIN actorUserId → AUTHZ_ROLE_INSUFFICIENT + rollback                                                | Unit + RBAC                       |
| AC-FLG-20  | T11                                      | mainnet_ON without testnet → TESTNET_GATE_MISSING + rollback                                              | Unit + Integration                |
| AC-FLG-21  | T14 + T11 + concurrent flag flip harness | Phase A ON → B1 flipped OFF in another tx → FLAG_RACE_FLIPPED 409                                         | Concurrency integration           |
| AC-FLG-22  | T6/T11 + PhaseA/B gate tests             | manual_admin OFF → engine throws MANUAL_ADMIN_DISABLED 两次 gate                                          | Unit                              |
| —          | —                                        | —                                                                                                         | —                                 |
| AC-TXN-23  | T14                                      | T19: inject network call in Phase B → PHASE_B_IO_FORBIDDEN dev-guard trigger                              | Static/Unit architecture          |
| AC-TXN-24  | T14                                      | options object inspection + Serializable mode                                                             | Unit                              |
| AC-TXN-25  | T15                                      | full codebase new TS files grep "\bDONE\b" = 0 + IdempotencyStatus.COMPLETED used at B7                   | Static + Unit                     |
| AC-TXN-26  | T15 + T20                                | COMPLETED replay returns same response + 0 side rows                                                      | Integration                       |
| AC-TXN-27  | T15                                      | same key diff hash → 409 IDEMPOTENCY_CONFLICT; rows 0                                                     | Unit                              |
| AC-TXN-28  | T15 + concurrent harness                 | explicit PENDING insert → second call returns 409 IDEMPOTENCY_INFLIGHT                                    | Integration                       |
| AC-TXN-29  | T14 + T17                                | serialization failure injection → reruns exactly 1 A+B; second fail → 503                                 | Integration failure injection     |
| AC-TXN-30  | T15/T17                                  | commit phase B, suppress response delivery, re-run → cached replay + 0 Δ                                  | Integration crash harness         |
| AC-TXN-31  | T15/B7                                   | B7 update 0 rows → cached response read; no error                                                         | Unit                              |
| AC-TXN-32  | T14 end-to-end orchestrator skeleton     | state 1 Δ + ledger balanced 2 leg + audit 1 all inside one tx; throw at B6 → all Δ 0 post                 | Integration transaction atomicity |
| —          | —                                        | —                                                                                                         | —                                 |
| AC-RBAC-33 | T18                                      | Jest moduleNameMapper / ESLint rule → controller importing Prisma.write models throws                     | Static architecture test          |
| AC-RBAC-34 | T11 + mocked future controller           | USER @Roles → 403 before setFlag; 0 SystemConfig Δ                                                        | RBAC Unit                         |
| AC-RBAC-35 | T6 + T11 + T14 orchestrator fixture      | ADMIN flag ON → manual_admin journal writes; USER on same flow → 403                                      | RBAC Integration                  |
| —          | —                                        | —                                                                                                         | —                                 |
| AC-CI-36   | T19/T20 suite build                      | lint + typecheck in CI                                                                                    | CI                                |
| AC-CI-37   | T19 + coverage reporter                  | line≥80 / decision≥90 money-path                                                                          | CI Coverage                       |
| AC-CI-38   | T22 regression                           | existing apps web/admin build typecheck + baseline API suite re-run pass                                  | Regression                        |
| AC-CI-39   | T23 secret scan                          | new fixtures 0 PK/mnemonic/signature regex hits; CodeQL clean                                             | Security                          |
| AC-MIG-40  | T3 + T21                                 | exactly 1 new migration file; additions only; preamble comment preserved; balance/deposit/... absent grep | Migration                         |
| AC-BLD-41  | T1 boundary guard                        | `git diff develop -- Docker* compose* infra*` empty                                                       | Build/Boundary                    |
| AC-DOC-42  | T24                                      | docs/architecture/domain-services.md contains sections                                                    | Documentation                     |

Result: **42/42 ACs covered by Task + explicit Test ID + Type**. No "manual only". Documentation AC (DOC-42) is the single non-runtime category; all others are Unit/Integration/DB/Migration/Regression/Security/Static architecture tests.

---

## 18. PLAN QUESTIONS（默认值均给出；仅 ChatGPT 可推翻）

| #   | 问题                                                                           | Plan 默认                                                                                                                      |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Controller bypass: Jest moduleNameMapper vs ESLint override rule.              | **Jest only** (minimize new config surface)                                                                                    |
| Q2  | Error codes: 合并现有 AuthzFailReason enum vs additive 新 MoneyPathErrorCode。 | **新 MoneyPathErrorCode enum（additive 无冲突）**。                                                                            |
| Q3  | LedgerTransaction.actorUserId FK → User (SetNull) 是否加?                      | **加**，与 AuditLog 一致性最佳。                                                                                               |
| Q4  | amount precision 38/24/64?                                                     | **Spec 默认 Decimal(38, 0)，Plan 不推翻；Implement 验证；可加性改大。**                                                        |
| Q5  | Append-only REVOKE: 应用 DB 用户名未知?                                        | **Migration 使用 PL/pgSQL DO block：current_user 动态拼接 REVOKE；同时保留 Trigger 作为 C 方案兜底。**                         |
| Q6  | Integration tests: docker-compose vs testcontainers?                           | **跟随 repo existing live-DB 模式（优先 compose；若目前已用 testcontainers 则沿用）**；若冲突 raise blocker 前不得添加新依赖。 |
| Q7  | `docs/architecture/domain-services.md` 文件当前不存在还是已有?                 | **Plan 默认新建；若文件已存在则在文件尾部 append 新章节，不得重写原文。**（本 Plan 不做实际变更，此为 Implement 指引）         |

---

## 19. PLAN BLOCKERS

**None detected in current Plan revision.**

Potential blockers that would stop Implement immediately if confirmed during early T1:

- Baseline drift (develop HEAD changes) — PR rebase then re-freeze baseline SHA.
- P1-007 Admin auth regression unexpectedly caused by shared additive exports (T5/T9) — resolve additive export collision or version exports.
- DB user pattern unknown preventing REVOKE script — resolve Q5 with concrete deployment info (not a blocker as long as Trigger path exists in combo C).
- Any Spec v0.2 revision needed → raise as BLOCKER immediately, do not mutate approved spec.

---

## 20. Plan 阶段最终产物 & 状态

- **唯一产物**: `c:\Users\hp\Desktop\ai-wealth\.trae\specs\P1-008-money-path-foundation\tasks.md` (本文件).
- Implement phase尚未开始；所有 §3/§4/§5/§6/§9 规划仅在本文件声明。
