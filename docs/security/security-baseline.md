# AI Wealth DApp — Security Baseline

> Status: P0. These rules are non-negotiable. Every later phase inherits them
> and adds more. Violations should fail CI and code review.

## 1. Secrets management

- **No secrets in code.** Every secret (DB password, JWT secret, wallet key,
  mnemonic, API token) lives in `.env` or the platform secret manager.
- `.env`, `.env.*.local`, `.env.production`, `*.pem`, `*.key`, `*.seed`,
  `seed-phrase*`, `wallet-*`, `keystore.json`, `mnemonic*` are in
  `.gitignore`. CI's `secret-scan` job verifies no `.env` is tracked.
- `.env.example` is the only env file that may be committed, and it must
  contain **only** placeholder values.

## 2. Transport

- Local dev uses HTTP on per-service ports. Production terminates TLS at the
  Nginx edge (`infrastructure/nginx/nginx.conf`) and forwards `X-Forwarded-Proto`.
- HSTS is enforced at the edge: `Strict-Transport-Security:
max-age=31536000; includeSubDomains; preload`.

## 3. CORS

- Allowed origins are configured from `WEB_APP_URL` and `ADMIN_APP_URL` env
  vars only.
- **`Access-Control-Allow-Origin: *` is forbidden in production.** The API
  reads origins from env; misconfiguration fails fast at boot via
  `loadEnv()`.

## 4. HTTP hardening (NestJS API)

P0 enables all of the following — see `services/api/src/main.ts`:

- `Helmet` — secure headers (CSP, no-sniff, frame-deny).
- `Throttler` — per-IP rate limit (default 60 req / 60s, tunable per route).
- `ValidationPipe` — global DTO validation with `class-validator`; rejects
  unknown properties (`whitelist`, `forbidNonWhitelisted`).
- `Request-id` middleware — every request gets a `request_id`, propagated to
  logs and downstream services.
- `AllExceptionsFilter` — every thrown error is converted to the
  `AppResponse` error envelope before leaving the process.

## 5. Error responses

Production responses must **never** include:

- raw SQL or Prisma error messages,
- stack traces,
- secrets / private keys / mnemonics,
- internal file paths.

The `AllExceptionsFilter` (`services/api/src/common/filters/`) only emits:
`success: false`, `error.code` (from `error-codes.ts`), `error.message`
(human-readable), and `request_id`. Stack traces are written to the logger,
never returned.

## 6. Input validation

- Every Controller DTO uses `class-validator` decorators.
- `ValidationPipe` is registered globally with `whitelist: true` and
  `forbidNonWhitelisted: true` — unknown fields are rejected, not ignored.
- Prisma is the last line of defence: column types and constraints enforce
  data shape regardless of API bugs.

## 7. Authentication & sessions (P0 plumbing only)

- `JWT_SECRET` and `JWT_EXPIRES_IN` are validated at boot.
- P0 ships **no** real auth endpoints — these arrive in P1 with refresh
  tokens, rotation, and revocation. Refresh tokens will be stored in Redis
  with TTL.
- Wallet signing (Wagmi/Viem) is wired into the DApp layout but **does not
  execute** in P0.

## 8. Money path safety (critical)

The following are **forbidden** until explicitly enabled in a P1+ ticket
gated behind testnet validation:

- real USDT deposit / withdraw,
- real settlement / commission / treasury operations,
- real internal-points ↔ fiat ↔ crypto conversion,
- any code path that signs or broadcasts a real chain transaction,
- access to a real hot-wallet private key.

Future money paths must:

1. Live in their own domain service (`LedgerEngine`, `SettlementEngine`,
   `CommissionEngine`, `RiskEngine`).
2. Be feature-flagged (`system_meta` or a dedicated flag table).
3. Write an immutable `Ledger` entry for every state change.
4. Emit an `Audit` row capturing `actor`, `action`, `before`, `after`,
   `request_id`.

## 9. Rate limiting & abuse

- API: 60 req / 60s per IP default; auth endpoints (P1) get 5 / 60s.
- Worker: BullMQ concurrency bounded by `WORKER_CONCURRENCY`.
- Edge: Nginx `limit_req_zone` zones for `/api/` and `/auth/`.

## 10. Dependency hygiene

- `pnpm audit --prod` runs in CI on schedule (planned).
- Renovate / Dependabot is enabled on the repo to surface CVEs.
- `onlyBuiltDependencies` in root `package.json` limits which packages may
  run postinstall scripts.

## 11. Logging

- Structured JSON logs: `{ timestamp, level, service, request_id, message }`.
- PII (email, phone, wallet address) is hashed at the logger boundary in
  later phases; P0 logs only metadata.
- Logs never contain secrets — the logger does not pretty-print env vars.

## 12. Audit & traceability

Every state-changing API call writes:

- a `request_id` (propagated end-to-end),
- a structured log line at INFO with `service`, `request_id`, `route`,
  `method`, `status`, `latency_ms`,
- (future) an `Audit` row in PostgreSQL with `request_id` as correlation
  key.

## 13. CI security gates

A PR may not merge unless **all** pass:

- `lint`, `typecheck`, `test`, `build`,
- `secret-scan` (gitleaks + tracked-`.env` check + plaintext-key scan),
- `docker-build` (verifies images build),
- `CodeQL` (security-extended queries).

## 14. Incident response (placeholder)

P0 introduces the plumbing (`request_id`, structured logs, audit hooks). The
runbook for incident response (rotation, key revocation, fund freeze) is a
P1 deliverable and must be linked here once written.
