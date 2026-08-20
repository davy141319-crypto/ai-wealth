# AI Wealth DApp — Development Rules

> Status: P0. The conventions every contributor must follow. Reviewers may
> block a PR for violating any rule below.

## 1. Branching

- `main` — always green; deployable; **no direct commits**.
- `develop` — integration branch; PRs merge here first.
- Feature branches: `feature/<slug>`, e.g. `feature/p0-project-init`.
- Bugfix branches: `fix/<slug>`. Chores: `chore/<slug>`.
- Rebase before merging; squash-merge into `develop` / `main`.
- Branch protection requires: `CI passed (gate)`, `lint`, `typecheck`,
  `test`, `build`, `secret-scan`, `docker-build`, plus CODEOWNERS review.

## 2. TypeScript

- **`strict: true`** in `tsconfig.base.json`; never disable per-file with
  `// @ts-ignore`. Use `// @ts-expect-error <reason>` only if truly unavoidable.
- **No `any`.** Use `unknown` + narrowing or a proper interface. Justified
  `any` requires an inline comment explaining why.
- Prefer `interface` for object shapes; `type` for unions / mapped types.
- All shared types live in `packages/shared/src/types.ts` or a dedicated
  module — never duplicated across packages.

## 3. Linting & formatting

- ESLint base config in `.eslintrc.base.cjs`; per-package `.eslintrc.cjs`
  extends it.
- Prettier config in `.prettierrc`; `format:check` runs in CI.
- Husky `pre-commit` runs `lint-staged` (Prettier on staged files).
- `eslint-disable` requires a comment with a reason and a ticket ref:
  `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- P1 ticket XYZ`.

## 4. Architecture

- **Controller → Service → Repository/Prisma.** Controllers do not call
  Prisma directly.
- **Domain services are standalone modules.** When a feature touches money,
  put it in `LedgerEngine`, `SettlementEngine`, `CommissionEngine`,
  `RiskEngine`, etc. Do **not** mix this logic into `UserService`.
- **Long work goes to BullMQ.** If a controller would do > 100 ms of work,
  enqueue a job and return immediately.
- **Frontend never touches the DB.** Frontend talks only to the API over
  HTTP via the typed client in `apps/*/src/lib/api.ts`.

## 5. API design

- Prefix: `/api` (set in `packages/config`).
- Health: `GET /api/health` returns `{ status, dependencies: {...} }`;
  returns HTTP 503 when any dependency is down.
- Swagger: `GET /api/docs`. Every controller must have `@ApiTags`,
  `@ApiOperation`, and DTOs with `@ApiProperty`.
- Every response (success or error) is wrapped in `AppResponse` from
  `packages/shared`. There is no second envelope format.
- Every error carries an `error.code` from `packages/shared/src/error-codes.ts`.
  Add new codes there — never invent ad-hoc strings.

## 6. Database

- Prisma schema is the source of truth: `packages/database/prisma/schema.prisma`.
- **Unified timestamps:** every model has
  `createdAt DateTime @default(now()) @map("created_at")` and
  `updatedAt DateTime @updatedAt @map("updated_at")`. TS field is camelCase,
  DB column is snake_case. Application code never sets these manually.
- Migrations: `pnpm --filter @ai-wealth/database exec prisma migrate dev
--name <slug>`. Every PR that changes `schema.prisma` ships a migration.
- No business tables in P0; only `system_meta` (infrastructure key-value).

## 7. Configuration

- All env access goes through `packages/config`'s `env()` / `loadEnv()`.
  Never call `process.env.X` directly in app code.
- Missing required env throws `ConfigError` at boot — fail fast.
- New env vars: add to `.env.example`, document in this file, and add a
  validation rule in `packages/config/src/env.ts`.

## 8. Logging

- Use the shared logger from `packages/shared/src/logger.ts`.
- Every log entry includes `service`, `request_id` (when in a request
  context), `level`, `timestamp`.
- No `console.log` in app code (tests can use it sparingly).
- Never log secrets, full JWTs, private keys, mnemonics, or raw user PII.

## 9. Errors

- Throw `AppError` from `packages/shared/src/error-codes.ts` for domain
  errors. Pass an `AppErrorCode` and a human-readable message.
- Let the global `AllExceptionsFilter` shape the response — do not catch &
  rethrow in controllers just to log.
- Production never returns SQL, stack traces, secrets, or internal paths.

## 10. Tests

- New logic ships with unit tests. See `docs/testing/test-strategy.md`.
- Tests run in CI: `pnpm run test`. A failing test fails the PR.
- No skipped tests (`it.skip`, `xtest`) without a ticket reference.

## 11. Dependencies

- Add a dependency only if its value outweighs its supply-chain risk.
- Workspace deps use `workspace:*`.
- New postinstall scripts must be allow-listed in root `package.json` under
  `pnpm.onlyBuiltDependencies`.

## 12. Git commits

- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`,
  `test:`, `ci:`, `perf:`. Scope optional: `feat(api):`.
- Subject ≤ 72 chars, imperative mood.
- Body explains **why**, not **what** (the diff shows what).

## 13. Pull requests

- Use `.github/pull_request_template.md`.
- Every PR runs the full CI gate; do not request review until green or
  explicitly marked Draft.
- Linked issue / task ID is mandatory.

## 14. Money-path readiness checklist

Before any code touches real funds (P1+):

- [ ] Logic lives in its own domain service module.
- [ ] Feature flag in `system_meta` (or a dedicated flag table) gates it.
- [ ] Every state change writes a `Ledger` entry.
- [ ] Every state change writes an `Audit` row with `request_id`.
- [ ] Unit + integration tests cover happy + 3 failure paths.
- [ ] Testnet validation plan attached to the ticket.
- [ ] Security review requested (`@ai-wealth/infra`).
