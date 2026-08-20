# AI Wealth DApp — System Architecture

> Status: P0 (foundation). This document is the single source of truth for
> what the system is composed of, how the pieces talk to each other, and
> which constraints apply in every later phase.

## 1. Goals

A production-grade, monorepo-hosted fintech / Web3 DApp foundation that:

- ships a user-facing DApp and a separate Admin console,
- exposes a NestJS HTTP API with Swagger,
- offloads long-running work to a BullMQ worker,
- keeps money-touching logic isolated and **never executes real fund flows
  before testnet validation**,
- runs entirely inside Docker Compose locally and inside an Ubuntu-based
  production topology,
- enforces CI gates so no PR merges without passing lint / typecheck /
  test / build.

## 2. High-level topology

```
                 ┌─────────────┐         ┌─────────────┐
                 │   DApp Web  │         │   Admin     │
                 │ (Next.js)   │         │ (Vite+AntD) │
                 └──────┬──────┘         └──────┬──────┘
                        │                       │
                        └───────────┬───────────┘
                                    ▼
                        ┌───────────────────────┐
                        │   Edge Nginx (TLS)    │
                        └───────────┬───────────┘
                                    ▼
                        ┌───────────────────────┐
                        │   NestJS API (4000)   │
                        │  /api  /api/docs      │
                        └───┬────────┬──────────┘
                            │        │
            enqueue jobs ───┘        └─── Prisma ──→ PostgreSQL (5432)
                                  │                          ▲
                                  └─── ioredis ──→ Redis ────┘ (cache, rate-limit, idempotency)
                                                       ▲
                                                       │
                                       ┌───────────────┴───────────────┐
                                       │                               │
                                  BullMQ Worker                  Blockchain Listener
                                   (health-check)                  (P0 placeholder)
```

## 3. Component responsibilities

| Component             | Stack                                               | Responsibility                                           |
| --------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| `apps/web`            | Next.js 14 + React 18 + AntD + Wagmi                | User DApp (P0: `/`, `/dashboard`, `/login`).             |
| `apps/admin`          | Vite + React 18 + AntD Pro + React Router + ECharts | Admin console (P0: `/login`, `/dashboard`).              |
| `services/api`        | NestJS 11 + Prisma + ioredis + Swagger              | HTTP API. `/api` prefix, `/api/health`, `/api/docs`.     |
| `services/worker`     | BullMQ + ioredis                                    | Long-running jobs. P0 ships a `health-check` job.        |
| `services/blockchain` | NestJS-style standalone TS                          | P0 placeholder. Future: chain listener, event ingestion. |
| `packages/shared`     | TS                                                  | Error codes, API response envelope, logger, types.       |
| `packages/config`     | TS                                                  | Validated env loader (`loadEnv()` / `env()`).            |
| `packages/database`   | Prisma + `@prisma/client`                           | Schema + client singleton + DB health check.             |
| `packages/ui`         | TS + React                                          | Shared UI primitives reused by web/admin.                |
| `infrastructure/`     | Docker, Nginx, scripts                              | Dockerfiles, edge proxy, dev/up scripts.                 |

## 4. Request lifecycle

1. Edge Nginx terminates TLS, forwards to `api:4000` injecting `X-Request-Id`.
2. NestJS `Request-id` middleware assigns / propagates `request_id`.
3. `LoggingInterceptor` logs `{ timestamp, level, service, request_id, message }`.
4. Controller delegates to a Service; Service uses Prisma or ioredis.
5. Long work is **never done inline** — it is enqueued to BullMQ.
6. Errors are caught by the global `AllExceptionsFilter` and rendered as
   the standard `AppResponse` error envelope; never exposing SQL / stack /
   secrets in production.

## 5. Boundary contracts

- **Frontend → DB:** forbidden. Frontend talks only to the API over HTTP.
- **Controller → DB:** forbidden. Controllers orchestrate; Services own Prisma.
- **Worker ↔ DB:** allowed through `@ai-wealth/database`.
- **API ↔ Worker:** only through BullMQ (Redis). API never calls Worker HTTP.
- **Domain services** (Ledger, Settlement, Commission, Risk) must be
  standalone modules in later phases — do **not** bury their logic inside a
  `UserService`.

## 6. Data persistence

PostgreSQL is the system of record for every business state. Redis is used
for cache, rate-limit counters, BullMQ queues, session, distributed locks and
idempotency keys. The `system_meta` table exists in P0 to demonstrate the
unified `created_at` / `updated_at` convention that every future model must
follow.

## 7. Environments

| Env     | Stack                              | Notes                                                                              |
| ------- | ---------------------------------- | ---------------------------------------------------------------------------------- |
| local   | `docker compose up` + pnpm dev     | Per-service ports exposed; Redis/Postgres in containers.                           |
| CI      | GitHub Actions runner              | `pnpm install --frozen-lockfile` → lint → typecheck → test → build → docker build. |
| testnet | docker compose with testnet `.env` | First place any money path is exercised.                                           |
| prod    | Ubuntu host(s) + Nginx edge + TLS  | Secrets via env / secret manager, never in Git.                                    |

## 8. Branch & release strategy

- `main` — always green, deployable. **Direct commits forbidden.**
- `develop` — integration branch.
- Feature branches: `feature/*`, `fix/*`, `chore/*` (e.g. `feature/p0-project-init`).
- Branch protection on GitHub:
  - Require status checks: `CI passed (gate)`, `lint`, `typecheck`, `test`, `build`, `secret-scan`, `docker-build`.
  - Require CODEOWNERS review.
  - Require linear history (rebase merges).

## 9. What P0 deliberately does **not** include

- Real USDT deposit / withdraw / settlement / commission / treasury logic.
- Real wallet signing, KYC/AML, risk engine, task hall, team rewards.
- Anything that touches real funds. These arrive in P1+ behind testnet
  validation, feature flags and dedicated domain services.
