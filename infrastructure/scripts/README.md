# AI Wealth — Infrastructure Scripts

Cross-platform helper scripts for the local Docker stack. Both PowerShell
(`.ps1`) and Bash (`.sh`) versions are provided — pick the one matching your
shell. The behaviour of each pair is identical.

| Script                  | Purpose                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `dev-up.{ps1,sh}`       | Start postgres + redis, run `prisma migrate deploy`, then start api/worker/blockchain. |
| `health-check.{ps1,sh}` | Probe every service's `/health` endpoint and report PASS/FAIL.                         |
| `teardown.{ps1,sh}`     | Stop the compose stack. Pass `-IncludeVolumes` / `--volumes` to also wipe data.        |

## Prerequisites

- Docker Desktop (with the Compose v2 plugin)
- pnpm 10+ and Node 20+ (only needed for the `prisma migrate` step in `dev-up`)

## Typical dev flow

```bash
# 1. Copy env template and fill real values
cp .env.example .env

# 2. Bring up the stack
./infrastructure/scripts/dev-up.sh

# 3. Verify health
./infrastructure/scripts/health-check.sh

# 4. Stop the stack (keep data)
./infrastructure/scripts/teardown.sh
```

## Health endpoints

| Service      | URL                                |
| ------------ | ---------------------------------- |
| API          | `http://localhost:4000/api/health` |
| Swagger docs | `http://localhost:4000/api/docs`   |
| Worker       | `http://localhost:4001/health`     |
| Blockchain   | `http://localhost:4002/health`     |
| Postgres     | `localhost:5432`                   |
| Redis        | `localhost:6379`                   |
| Web (DApp)   | `http://localhost:3000/`           |
| Admin        | `http://localhost:3001/`           |
