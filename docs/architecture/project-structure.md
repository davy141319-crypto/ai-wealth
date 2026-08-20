# AI Wealth DApp — Project Structure

> Status: P0. The directory layout below is enforced by CI checks; do not
> silently relocate packages — update this doc and `pnpm-workspace.yaml`
> together.

## Repository layout

```
ai-wealth/
├── apps/
│   ├── web/                       Next.js 14 (user-facing DApp)
│   │   ├── src/
│   │   │   ├── app/               App router pages (/, /dashboard, /login)
│   │   │   ├── components/        Client providers (wagmi / react-query)
│   │   │   └── lib/               api client, wagmi config, utils
│   │   ├── next.config.js         output: 'standalone' (Docker)
│   │   └── package.json           @ai-wealth/{shared,config,ui}
│   └── admin/                     Vite + React 18 + AntD Pro
│       ├── src/
│       │   ├── pages/             Login, Dashboard
│       │   ├── layouts/           AdminLayout
│       │   ├── components/        DashboardChart (ECharts)
│       │   └── lib/               api client, utils
│       └── package.json           @ai-wealth/{shared,config,ui}
├── services/
│   ├── api/                       NestJS 11
│   │   ├── src/
│   │   │   ├── common/            filters/, interceptors/, middleware/, redis/
│   │   │   ├── health/            HealthController, HealthService, DTO
│   │   │   ├── app.module.ts
│   │   │   └── main.ts            Swagger, Helmet, Throttler, CORS, Logger
│   │   ├── nest-cli.json
│   │   ├── tsconfig.build.json
│   │   └── package.json           @ai-wealth/{shared,config,database}
│   ├── worker/                    BullMQ worker
│   │   ├── src/
│   │   │   ├── queue.ts           Queue + Worker registration
│   │   │   ├── health.ts          HTTP /health probe
│   │   │   └── main.ts
│   │   └── package.json           @ai-wealth/{shared,config}
│   └── blockchain/                P0 placeholder
│       ├── src/{health,main}.ts
│       └── package.json
├── packages/
│   ├── shared/                    error-codes, api-response, logger, types
│   ├── config/                    env loader (loadEnv, env, ConfigError)
│   ├── database/                  prisma schema + client singleton + DB health
│   │   ├── prisma/schema.prisma   SystemMeta (P0), created_at/updated_at convention
│   │   └── src/{client,health,index}.ts
│   └── ui/                        shared UI primitives
├── infrastructure/
│   ├── docker/
│   │   ├── Dockerfile.api         multi-stage, pnpm deploy --prod
│   │   ├── Dockerfile.worker
│   │   ├── Dockerfile.blockchain
│   │   ├── Dockerfile.web         Next standalone
│   │   ├── Dockerfile.admin       nginx-served static build
│   │   └── Dockerfile.nginx       edge proxy
│   ├── nginx/
│   │   ├── nginx.conf             production edge (TLS, routing, rate limits)
│   │   └── admin-nginx.conf       SPA fallback served inside admin image
│   └── scripts/
│       ├── dev-up.{ps1,sh}        bring up stack + prisma migrate
│       ├── health-check.{ps1,sh}  probe every /health endpoint
│       ├── teardown.{ps1,sh}      stop / wipe stack
│       └── README.md
├── docs/
│   ├── architecture/              system.md, project-structure.md
│   ├── security/                  security-baseline.md
│   ├── testing/                   test-strategy.md
│   └── development/               development-rules.md
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                  install → lint → typecheck → test → build → docker → gate
│   │   └── codeql.yml              weekly + PR security scan
│   ├── CODEOWNERS
│   └── pull_request_template.md
├── .env.example                   template; never commit real .env
├── .gitignore                     secrets + build outputs
├── .dockerignore                  slim Docker contexts, no secrets in layers
├── .editorconfig
├── .eslintrc.base.cjs
├── .prettierrc
├── .npmrc                         pnpm store / cache paths (sandbox-friendly)
├── pnpm-workspace.yaml            apps/*, services/*, packages/*
├── package.json                   root scripts: lint / typecheck / test / build
├── tsconfig.base.json             strict TS shared by all workspaces
├── docker-compose.yml             postgres + redis + api + worker + blockchain + web + admin
├── docker-compose.override.yml.example
└── README.md                      onboarding guide
```

## Why this layout

- **`apps/` vs `services/` vs `packages/`** keeps UI, runtime processes and
  shared code cleanly separated. CI can build each independently.
- **`infrastructure/`** is a sibling of the code so ops engineers can review
  Dockerfiles / Nginx / scripts without scanning TS.
- **`docs/`** mirrors the runtime topology: architecture, security, testing,
  development rules. Each doc is small and focused.
- **Root config files are intentionally minimal** — strict rules live in
  `tsconfig.base.json`, `.eslintrc.base.cjs`, `.prettierrc`, `.editorconfig`,
  and per-package configs extend them.

## Allowed adjustments

If a sound technical reason forces a structural change (e.g. extracting
`packages/database` into a separate repo), do **all** of:

1. Update this doc.
2. Update `pnpm-workspace.yaml`.
3. Update `.dockerignore` if build contexts change.
4. Update CI workflows if paths change.
5. Explain the trade-off in the PR description.

## Forbidden adjustments

- Collapsing `services/api` and `services/worker` into one process — they
  must remain separately deployable.
- Inlining business logic into `apps/*` or controllers.
- Removing the `infrastructure/` separation.
