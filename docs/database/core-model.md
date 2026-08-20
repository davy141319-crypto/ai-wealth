# Core Database Model (P1-001)

> Scope: identity / auth-nonce / audit / idempotency / system-config ONLY.
> **Hard constraint**: NO real fund fields anywhere in this schema. No USDT
> balance, deposit, withdrawal, product, income, points, or any money-related
> column. Fund logic arrives in later phases and must be testnet-verified first.

## 1. Conventions

| Concern          | Rule                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Primary keys     | UUID v4 (`@default(uuid()) @db.Uuid`). Opaque, non-enumerable.                                                                                                                                                                                         |
| Timestamps       | `createdAt DateTime @default(now()) @map("created_at")` (set once by Postgres, UTC) and `updatedAt DateTime @updatedAt @map("updated_at")` (auto-refreshed by Prisma trigger, UTC). **Never set these in app code.**                                   |
| Column naming    | DB columns are `snake_case` (`@map`); TS fields stay `camelCase`.                                                                                                                                                                                      |
| Table naming     | `snake_case`, plural (`@@map("users")`, `@@map("wallets")`, …).                                                                                                                                                                                        |
| Enums            | PostgreSQL native `ENUM` types via Prisma `enum`.                                                                                                                                                                                                      |
| FK delete policy | `Restrict` by default (parent cannot be deleted while children exist). Children that are owned by a parent (e.g. `WalletIdentity`, `AuthNonce` to `Wallet`) use `Cascade`. `AuditLog.actor` uses `SetNull` so historical audits survive user deletion. |
| Indexes          | Every FK column is indexed; every uniqueness constraint is named `<table>_<cols>_uq`; hot query paths (expiresAt, status, createdAt, requestId) indexed explicitly.                                                                                    |

## 2. Models

### 2.1 User — `users`

The human actor. No credentials stored here (auth is wallet-based).

| Column                      | Type                   | Notes                                                           |
| --------------------------- | ---------------------- | --------------------------------------------------------------- |
| `id`                        | UUID PK                | `@default(uuid())`                                              |
| `status`                    | `UserStatus` enum      | `ACTIVE` / `SUSPENDED` / `BANNED` / `CLOSED`. Default `ACTIVE`. |
| `last_login_at`             | TIMESTAMP(3), nullable | Updated on successful sign-in.                                  |
| `created_at` / `updated_at` | TIMESTAMP(3)           | UTC convention.                                                 |

Relations: `1 User → N Wallet`, `1 User → N AuditLog` (loose, `SetNull`).

### 2.2 Wallet — `wallets`

A blockchain address bound to a user. **Identity only — no balance/asset column and never will be in P1.**

| Column       | Type                  | Notes                                                                                               |
| ------------ | --------------------- | --------------------------------------------------------------------------------------------------- |
| `id`         | UUID PK               |                                                                                                     |
| `user_id`    | UUID FK → `users(id)` | `onDelete: Restrict`.                                                                               |
| `address`    | VARCHAR(64)           | EIP-55 / TRON base58 both fit.                                                                      |
| `chain`      | `Chain` enum          | `ETH` / `BSC` / `TRON` / `POLYGON` / `ARBITRUM`.                                                    |
| `network`    | VARCHAR(32)           | e.g. `mainnet`, `sepolia`, `trc20-main`. The same address on a different network is a distinct row. |
| `status`     | `WalletStatus` enum   | `CONNECTED` / `DISCONNECTED` / `REVOKED`.                                                           |
| `is_primary` | BOOLEAN               | Default `false`.                                                                                    |

**Unique**: `(address, chain, network)` — `wallet_address_chain_network_uq`.
**Indexes**: `wallet_user_id_idx (user_id)`.

### 2.3 WalletIdentity — `wallet_identities`

A verified proof-of-ownership attached to a wallet. A wallet may have multiple identity types (e.g. SIWE + a raw signature).

| Column          | Type                    | Notes                         |
| --------------- | ----------------------- | ----------------------------- |
| `wallet_id`     | UUID FK → `wallets(id)` | `onDelete: Cascade`.          |
| `identity_type` | `IdentityType` enum     | `SIWE` / `MESSAGE_SIGNATURE`. |
| `verified_at`   | TIMESTAMP(3)            | Default now().                |

**Unique**: `(wallet_id, identity_type)` — `wallet_identity_wallet_type_uq`.

### 2.4 AuthNonce — `auth_nonces`

Single-use challenge nonce for wallet sign-in.

| Column       | Type                             | Notes                                       |
| ------------ | -------------------------------- | ------------------------------------------- |
| `wallet_id`  | UUID FK → `wallets(id)`          | `onDelete: Cascade`.                        |
| `nonce`      | VARCHAR(64), **globally UNIQUE** | Cryptographically random; not enumerable.   |
| `issued_at`  | TIMESTAMP(3)                     | Default now().                              |
| `expires_at` | TIMESTAMP(3)                     | Expiry; service MUST reject expired nonces. |
| `used_at`    | TIMESTAMP(3), nullable           | `null` = unused. Set on consume.            |

**Unique**: `auth_nonce_nonce_uq (nonce)`.
**Indexes**: `wallet_id`, `expires_at`, `used_at` (the last two speed up worker cleanup).

Lifecycle: `issue → (valid window) → consume` (single-use). Expired or used nonces are rejected; the worker purges expired rows via `AuthNonceRepository.purgeExpired()`.

### 2.5 AuditLog — `audit_logs` (append-only)

Immutable audit trail. **No `update` / `delete` is exposed by the repository** — by contract, audit rows are write-once.

| Column          | Type                            | Notes                                                                                       |
| --------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| `actor_user_id` | UUID, nullable FK → `users(id)` | `onDelete: SetNull` so audits survive user deletion. Nullable for system/anonymous actions. |
| `action`        | VARCHAR(128)                    | e.g. `user.login`, `wallet.connect`.                                                        |
| `resource`      | VARCHAR(128)                    | e.g. `user`, `wallet`, `system`.                                                            |
| `request_id`    | VARCHAR(64), nullable           | Cross-references the API request_id.                                                        |
| `ip`            | VARCHAR(45)                     | IPv4 or IPv6.                                                                               |
| `user_agent`    | VARCHAR(512)                    |                                                                                             |
| `metadata`      | JSONB                           | Structured context. **Never put secrets/tokens/PII here.**                                  |
| `created_at`    | TIMESTAMP(3)                    | Only timestamp (no updated_at — append-only).                                               |

**Indexes**: `actor`, `action`, `resource`, `created_at`, `request_id`.

### 2.6 IdempotencyKey — `idempotency_keys`

Replay cache for safe client retries.

| Column          | Type                     | Notes                                                         |
| --------------- | ------------------------ | ------------------------------------------------------------- |
| `key`           | VARCHAR(128)             |                                                               |
| `scope`         | VARCHAR(64)              | Logical operation namespace.                                  |
| `request_hash`  | VARCHAR(64), nullable    | Optional SHA-256 of the request body to detect payload drift. |
| `status`        | `IdempotencyStatus` enum | `PENDING` / `COMPLETED` / `FAILED`.                           |
| `response_code` | INTEGER, nullable        | Cached HTTP status to replay.                                 |
| `response_body` | JSONB, nullable          | Cached body to replay.                                        |
| `expires_at`    | TIMESTAMP(3)             | TTL; worker purges past rows.                                 |

**Unique**: `idempotency_scope_key_uq (scope, key)`.
**Indexes**: `expires_at`, `status`.

Lifecycle: `tryAcquire (PENDING) → complete (COMPLETED) | fail (FAILED)`. A repeated request with the same `(scope, key)` reads the existing row; if `COMPLETED`, the cached response is replayed.

### 2.7 SystemConfig — `system_configs`

Typed key/value configuration store.

| Column        | Type                              | Notes                                               |
| ------------- | --------------------------------- | --------------------------------------------------- |
| `key`         | VARCHAR(128), **globally UNIQUE** |                                                     |
| `value`       | TEXT                              | Always stored as text; decoded per `value_type`.    |
| `value_type`  | `SystemConfigValueType` enum      | `STRING` / `NUMBER` / `BOOLEAN` / `JSON`.           |
| `description` | TEXT, nullable                    |                                                     |
| `is_active`   | BOOLEAN                           | Default `true`. Feature-flag / kill-switch support. |

> The P0 `SystemMeta` table is retained for backward compatibility but new
> config should prefer `SystemConfig` for typed values.

## 3. ER diagram (textual)

```
users (1) ──< wallets (N) ──< wallet_identities (N)
                   │
                   └──< auth_nonces (N)

users (1) ──< audit_logs (N)   [SetNull — loose]
idempotency_keys                [standalone]
system_configs                  [standalone, UNIQUE key]
```

## 4. Repository layer (`@ai-wealth/database`)

Architecture: **Controller → Service → Repository → Prisma**.

- Repositories own **only data access** (CRUD + queries). No business rules, no HTTP, no error formatting.
- Repositories may throw Prisma errors; the **Service** maps them to `AppError` (from `@ai-wealth/shared`).
- The `Repositories` aggregate bundles all seven repositories and supports transactions:

```ts
import { Repositories } from '@ai-wealth/database';

const repos = new Repositories();
await repos.user.create({ status: 'ACTIVE' });

// transactional:
await Repositories.transaction(async (r) => {
  const user = await r.user.create({});
  await r.wallet.create({ userId: user.id, address, chain, network });
});
```

### Immutability guarantees enforced in code

- `AuditLogRepository` exposes `create`, `findById`, `list`, `count` — **no** `update` / `delete`. The integration test `AuditLogRepository exposes NO update/delete methods` asserts this.

## 5. Migration

- `20260820093453_init_system_meta` (P0) — `system_meta`.
- `20260820151744_p1_001_core_models` (P1-001) — creates 6 enums + 7 tables + indexes + FKs.

Apply with:

```bash
pnpm --filter @ai-wealth/database exec prisma migrate deploy
```

## 6. Seed (TEST ONLY)

`packages/database/prisma/seed.ts` inserts deterministic, non-sensitive sample rows.

**Safety guards** (do not remove):

1. Refuses to run unless `DATABASE_URL` looks local (`localhost` / `127.0.0.1` / `postgres:5432`) **or** `NODE_ENV` is not production/staging.
2. Hard-aborts if `ALLOW_REAL_SEED=true` is set (this flag is forbidden by policy).
3. Idempotent (upsert / deleteMany).
4. Inserts only identity/audit/config rows — **no fund data**. Wallet addresses are random-looking `0x…` strings that hold no funds on any chain.

Run: `pnpm --filter @ai-wealth/database run db:seed`.

## 7. Testing

- `src/__tests__/types.test.ts` — unit tests for `normalizePagination` (clamping, defaults, flooring).
- `src/__tests__/repositories.integration.test.ts` — integration tests against a real Postgres. **Auto-skipped** when `DATABASE_URL` is not local (so CI without a DB still passes). Covers: User↔Wallet relation, FK integrity, Wallet unique constraint, `findUnique`, AuthNonce uniqueness + single-use consume, AuditLog append-only + JSONB, Idempotency `(scope,key)` uniqueness + `complete` + `purgeExpired`, SystemConfig key uniqueness + `isActive` filter, FK cascade (wallet → identities/nonces) and RESTRICT (user with wallet), `Repositories.transaction()` commit/rollback.

Local run:

```bash
pnpm --filter @ai-wealth/database run test
```

## 8. Out of scope (future phases)

The following are **explicitly NOT** in this schema and must not be added without a new phase + testnet verification: real USDT balance, deposit, withdrawal, wealth product, income, points, tasks, invitation, team, V1-V5, gambling, sports, e-sports, lottery, live entertainment.
