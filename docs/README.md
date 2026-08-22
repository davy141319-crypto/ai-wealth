# AI Wealth DApp — Documentation Index

| Document                                                               | Purpose                                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [architecture/system.md](architecture/system.md)                       | Component topology, request lifecycle, environments, branch strategy.    |
| [architecture/project-structure.md](architecture/project-structure.md) | Directory layout, why each part exists, allowed / forbidden adjustments. |
| [security/security-baseline.md](security/security-baseline.md)         | Secrets, CORS, hardening, error responses, money-path safety, CI gates.  |
| [testing/test-strategy.md](testing/test-strategy.md)                   | Test pyramid, frameworks, per-package scope, coverage targets.           |
| [development/development-rules.md](development/development-rules.md)   | TS, lint, architecture, API design, DB, config, logging, errors, git.    |

| [architecture/domain-services.md](architecture/domain-services.md) | Money-Path domain contracts: Ledger, Settlement, Commission, Risk engines, two-phase orchestrator, locking, flag governance, audit envelope. |

Future docs (added in later P1+ phases):

- `docs/api/openapi.json` — generated OpenAPI snapshot.
- `docs/operations/runbook.md` — incident response, key rotation, fund freeze.
- `docs/security/threat-model.md` — per-domain threat model.
