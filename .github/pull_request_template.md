<!--
  AI Wealth — Pull Request template
  Fill in every section. Mark N/A explicitly if a section doesn't apply.
-->

## Summary

<!-- What does this PR change and why? One or two paragraphs. -->

## Related issue / task

- Refs: #<issue>
- Phase: P0 / P1 / P2
- Task ID: (e.g. P0-001)

## What changed

<!-- Bulleted list of notable changes. -->

-
-
-

## How to verify

<!-- Reproducible steps a reviewer can run. -->

1.
2.
3.

## Checklists

### Code quality

- [ ] No `any` introduced without an inline justification comment
- [ ] No hardcoded secrets / production URLs / connection strings
- [ ] No business logic inside Controllers (Controller → Service → Repository)
- [ ] No direct DB access from a Controller or frontend code
- [ ] Public API has Swagger decorators / DTOs with `class-validator`
- [ ] Errors go through the global Exception Filter (no raw SQL/stack returned)
- [ ] Naming follows the repo convention (`error-codes.ts`, `api-response.ts`)

### Tests

- [ ] Unit tests added / updated for new logic
- [ ] `pnpm typecheck` passes locally
- [ ] `pnpm lint` passes locally
- [ ] `pnpm test` passes locally
- [ ] `pnpm build` passes locally

### Security / Safety (if touching money paths)

- [ ] No real USDT deposit / withdraw / settlement / commission / treasury logic
- [ ] Money-related changes are gated behind a feature flag or testnet-only
- [ ] No private keys / mnemonics / wallet secrets in code or env files

### Database (if touching `schema.prisma`)

- [ ] Migration created (`prisma migrate dev --name <slug>`)
- [ ] `created_at` / `updated_at` follow the unified convention
- [ ] Backwards-compatible with the previous deployment

### Docker / Infra (if touching Dockerfile / compose / nginx)

- [ ] `docker compose up` still starts the stack
- [ ] Health endpoints respond 200

## Risk

<!-- What could break? What's the rollback plan? -->
