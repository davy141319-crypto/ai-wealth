# AI Wealth DApp

> **Status: P0 (foundation).** This repo ships the production-grade
> monorepo skeleton for the AI Wealth DApp: a user-facing DApp, an Admin
> console, a NestJS API, a BullMQ worker, a blockchain-listener placeholder,
> Postgres + Redis, Docker Compose, and a CI pipeline. **P0 deliberately
> contains no real money / wallet / settlement logic** — that arrives in
> later phases gated behind testnet validation.

---

## What's inside

| Piece               | Stack                                                       | Where                                        |
| ------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| User DApp           | Next.js 14 + React 18 + Ant Design + Wagmi + React Query    | [`apps/web`](apps/web)                       |
| Admin console       | Vite + React 18 + Ant Design Pro + React Router + ECharts   | [`apps/admin`](apps/admin)                   |
| API                 | NestJS 11 + Prisma + ioredis + Swagger + Helmet + Throttler | [`services/api`](services/api)               |
| Worker              | BullMQ + ioredis (P0 ships a `health-check` job)            | [`services/worker`](services/worker)         |
| Blockchain listener | TypeScript placeholder (P0: health only)                    | [`services/blockchain`](services/blockchain) |
| Shared packages     | shared / config / database / ui                             | [`packages/*`](packages)                     |
| Infra               | Docker, Nginx, PowerShell + Bash scripts                    | [`infrastructure`](infrastructure)           |
| Docs                | architecture / security / testing / development rules       | [`docs`](docs)                               |

---

## Prerequisites

| Tool           | Version                  | Why                                                                      |
| -------------- | ------------------------ | ------------------------------------------------------------------------ |
| Node.js        | 20.18+                   | Runtime + toolchain.                                                     |
| pnpm           | 10.23.0                  | Workspace package manager (`corepack enable` to use the pinned version). |
| Docker Desktop | latest (with Compose v2) | Postgres + Redis + service containers.                                   |
| Git            | 2.40+                    | Source control.                                                          |

Optional, only if you need a local Postgres/Redis without Docker:

- PostgreSQL 16, Redis 7 — but the Docker path is the supported default.

---

## Quick start (5 minutes)

### 1. Clone & install

```bash
git clone <repo-url> ai-wealth
cd ai-wealth
corepack enable
corepack prepare pnpm@10.23.0 --activate
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env: at minimum set a strong JWT_SECRET (32+ random bytes).
```

`.env.example` documents every variable. **Never** commit `.env` (CI will
fail the build if a `.env` file is tracked).

### 3. Bring up the stack

Pick the script for your shell:

```bash
# Bash (Linux / macOS / Git Bash)
./infrastructure/scripts/dev-up.sh

# PowerShell (Windows)
./infrastructure/scripts/dev-up.ps1
```

This starts `postgres` + `redis`, waits for health, runs `prisma migrate
deploy`, then starts `api`, `worker`, `blockchain`.

### 4. Verify health

```bash
./infrastructure/scripts/health-check.sh   # or .ps1 on Windows
```

You should see `[PASS]` for every service.

### 5. Run the apps (local dev mode, hot reload)

```bash
# User DApp — http://localhost:3000
pnpm --filter @ai-wealth/web dev

# Admin — http://localhost:3001
pnpm --filter @ai-wealth/admin dev
```

### 6. Stop everything

```bash
./infrastructure/scripts/teardown.sh              # keep data
./infrastructure/scripts/teardown.sh --volumes    # wipe data (DESTRUCTIVE)
```

---

## Endpoints (local)

| Service           | URL                              |
| ----------------- | -------------------------------- |
| API health        | http://localhost:4000/api/health |
| Swagger docs      | http://localhost:4000/api/docs   |
| Worker health     | http://localhost:4001/health     |
| Blockchain health | http://localhost:4002/health     |
| Postgres          | localhost:5432                   |
| Redis             | localhost:6379                   |
| User DApp         | http://localhost:3000            |
| Admin             | http://localhost:3001            |

---

## Common commands

| Command                                                | What it does                                       |
| ------------------------------------------------------ | -------------------------------------------------- |
| `pnpm install`                                         | Install all workspace dependencies.                |
| `pnpm run lint`                                        | ESLint across all packages.                        |
| `pnpm run typecheck`                                   | Build packages then run `tsc --noEmit` everywhere. |
| `pnpm run test`                                        | Jest unit tests across all packages.               |
| `pnpm run build`                                       | Build every package + service + app.               |
| `pnpm run format`                                      | Prettier write across the repo.                    |
| `pnpm run format:check`                                | Prettier check (CI uses this).                     |
| `pnpm --filter @ai-wealth/api dev`                     | Start API in dev mode.                             |
| `pnpm --filter @ai-wealth/database exec prisma studio` | Inspect Postgres.                                  |
| `docker compose up -d`                                 | Start the whole stack in containers.               |
| `docker compose logs -f api`                           | Tail API logs.                                     |

---

## Project structure

See [`docs/architecture/project-structure.md`](docs/architecture/project-structure.md)
for the full layout and the rationale for each directory.

```
ai-wealth/
├── apps/{web,admin}/           # Frontend apps
├── services/{api,worker,blockchain}/  # Backend services
├── packages/{shared,config,database,ui}/  # Shared TS packages
├── infrastructure/{docker,nginx,scripts}/  # Ops artifacts
├── docs/                       # architecture, security, testing, development
├── .github/workflows/          # CI: install/lint/typecheck/test/build/docker/gate
├── docker-compose.yml          # postgres + redis + 5 services
└── .env.example                # Template; copy to .env
```

---

## CI

`.github/workflows/ci.yml` runs on every PR to `main` / `develop`:

```
install → lint → typecheck → test → build → secret-scan → docker-build → ci-passed (gate)
```

A PR **cannot merge** unless every job in the gate succeeds. `CodeQL`
(weekly + on PRs) adds security scanning on top.

Required status checks to configure on `main` and `develop` (GitHub repo
settings → Branches):

- `CI passed (gate)`
- `lint`, `typecheck`, `test`, `build`, `secret-scan`, `docker-build`
- `Analyze (javascript-typescript)` (CodeQL)

---

## Branching

- `main` — production-ready; **no direct commits**.
- `develop` — integration branch.
- Feature: `feature/<slug>` (e.g. `feature/p0-project-init`).
- Fix: `fix/<slug>`. Chore: `chore/<slug>`.
- Squash-merge into `develop` / `main`. Rebase before merge.

---

## P0 scope — what's in and what's out

**In scope (this repo, P0):**

- Monorepo skeleton with strict TypeScript, ESLint, Prettier, Husky.
- Shared packages for error codes, API response envelope, logger, env
  config, Prisma client.
- NestJS API: `/api/health` (checks Postgres + Redis), `/api/docs`
  (Swagger), Helmet, Throttler, CORS, ValidationPipe, Request-id,
  AllExceptionsFilter, structured logging.
- BullMQ worker with a `health-check` job and an HTTP `/health` probe.
- Blockchain listener placeholder with `/health`.
- Next.js DApp with `/`, `/dashboard`, `/login` placeholder pages.
- Vite Admin with `/login`, `/dashboard` and AntD Pro layout.
- Docker Compose for the whole stack, per-service Dockerfiles, Nginx edge.
- GitHub Actions CI with the gate above + CodeQL + secret scan.
- Docs covering architecture, structure, security, testing, dev rules.

**Out of scope (later phases, gated behind testnet):**

- Real USDT deposit / withdraw, real settlement, real commission, real
  treasury, real hot-wallet signing, real KYC/AML, real risk engine, real
  team rewards, real internal points, real task hall.

---

## Where to read next

- New to the codebase? [`docs/architecture/system.md`](docs/architecture/system.md).
- Looking for a specific folder? [`docs/architecture/project-structure.md`](docs/architecture/project-structure.md).
- Writing API code? [`docs/development/development-rules.md`](docs/development/development-rules.md).
- Adding a security-sensitive change? [`docs/security/security-baseline.md`](docs/security/security-baseline.md).
- Adding tests? [`docs/testing/test-strategy.md`](docs/testing/test-strategy.md).
- Need to run the stack locally? [`infrastructure/scripts/README.md`](infrastructure/scripts/README.md).

---

## License

UNLICENSED — internal use only.
