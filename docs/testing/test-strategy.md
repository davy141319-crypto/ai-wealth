# AI Wealth DApp — Test Strategy

> Status: P0. Lays out the framework, scope, and CI integration. Concrete
> coverage targets are added per feature in later phases.

## 1. Test pyramid

```
                    ┌────────────┐
                    │   E2E      │   Playwright (apps/web, apps/admin) — P1+
                    ├────────────┤
                    │ Integration│   supertest + Testcontainers (services/api) — P1+
                    ├────────────┤
                    │  Contract  │   OpenAPI schema assertion — P1+
                    ├────────────┤
                    │   Unit     │   Jest (every package + service) — P0
                    └────────────┘
```

P0 ships the **unit** layer for every package and service. Each subsequent
phase must grow the layer closest to the code it touches.

## 2. Framework

- **Runner:** Jest 29 in every package.
- **TypeScript:** `ts-jest` with isolated modules.
- **Mocking:** `jest.mock` for module boundaries; avoid `any` in mocks.
- **Assertions:** built-in `expect`; `supertest` for Nest controllers (P1).

## 3. Per-package scope (P0)

| Package / Service     | Tests                    | What they cover                                            |
| --------------------- | ------------------------ | ---------------------------------------------------------- |
| `packages/shared`     | `api-response.test.ts`   | Success/error envelope shape and `AppError` mapping.       |
| `packages/config`     | `env.test.ts`            | Missing required vars throw `ConfigError`; numbers parsed. |
| `packages/database`   | `database.test.ts`       | Client singleton, `checkDatabase` shape (mocked Prisma).   |
| `packages/ui`         | `utils.test.ts`          | Shared UI utility pure functions.                          |
| `services/api`        | `health.service.spec.ts` | Health service aggregates Postgres+Redis statuses.         |
| `services/worker`     | (pass-with-no-tests)     | BullMQ job wired and queue name constant.                  |
| `services/blockchain` | (pass-with-no-tests)     | Health endpoint responds ok.                               |
| `apps/web`            | `utils.test.ts`          | Pure helpers.                                              |
| `apps/admin`          | `utils.test.ts`          | Pure helpers.                                              |

## 4. CI integration

`.github/workflows/ci.yml` runs:

```
pnpm install --frozen-lockfile
pnpm --filter @ai-wealth/database exec prisma generate   # client needed for typecheck
pnpm run test
```

- A failing test fails the `test` job, which fails the `CI passed (gate)`
  job, which blocks the merge.
- Coverage artifacts (`**/coverage/`) are uploaded for 7 days.

## 5. Coverage targets

- **P0:** no minimum enforced — focus on critical pure functions.
- **P1+:** ≥ 70 % lines, ≥ 60 % branches for `packages/shared`,
  `packages/config`, `services/api/src/health`, and every new domain
  service (`LedgerEngine`, `SettlementEngine`, `CommissionEngine`,
  `RiskEngine`).
- Money-path code (P1+) requires **100 % branch coverage** of the
  audit / ledger write paths.

## 6. Integration tests (P1)

- `services/api` gains `supertest`-based integration tests against a
  Testcontainers Postgres + Redis pair.
- Each test boots a fresh app instance per file; state is wiped between
  tests via `TRUNCATE`.

## 7. Contract tests

- Swagger (`/api/docs`) is generated from decorators.
- A CI step (P1) diffs the rendered OpenAPI against the committed
  `docs/api/openapi.json`. Drift fails the build.

## 8. E2E tests

- Playwright drives `apps/web` and `apps/admin` against a fully stacked
  `docker compose up`.
- P0 has no E2E; P1 introduces a smoke test (`/` and `/api/health`).
- Money flows (P2+) get dedicated testnet E2E scenarios — these never run
  against mainnet.

## 9. Naming & layout

- Test files live next to the code: `foo.ts` ↔ `foo.test.ts` or
  `__tests__/foo.test.ts`.
- Specs end with `.spec.ts` or `.test.ts`. Both are accepted; pick one per
  package and stay consistent (P0 uses `.test.ts`).
- `describe` block per public function; `it` blocks phrased as
  `should <expected behaviour>`.

## 10. Anti-patterns

- Testing implementation details instead of behaviour.
- Snapshot tests for volatile output (Prisma payloads, ISO timestamps).
- `any` in test fixtures to silence type errors.
- Reaching across package boundaries in a unit test — use the package's
  public `index.ts` only.
