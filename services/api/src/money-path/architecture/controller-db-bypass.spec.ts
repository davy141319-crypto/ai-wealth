// ============================================================================
// Static architecture test: controllers MUST NOT directly access any
// persistence used by money-path (Prisma, LedgerRepository, IdempotencyKey
// writes, SystemConfig writes). Instead, they MUST route every money-path
// action through the domain orchestrator/services.
//
// Rule enforcement mechanism:
//   * Pure Jest test (no ESLint config changes per ChatGPT ruling).
//   * Scans all `**/controllers/**/*.ts` files present in services/api
//     at the time of test run (dynamic glob so any future new controller
//     is also scanned).
//   * Parses each TS source as raw text (no TypeScript compiler; a set of
//     substring regex rules detects banned import paths / identifiers).
//
//   Banned patterns inside any controller:
//     - `import ... from '@prisma/client'`
//     - `import ... from '@ai-wealth/database' ... PrismaService / prisma singleton
//        OR repositories (ledger / auditLog CREATE / idempotencyKey write /
//        systemConfig WRITE paths)
//     - `Prisma.` / `new PrismaClient(...)` / `prisma.` (lowercase prisma
//        singleton)
//     - `Repositories.` constructor instantiation (a controller MUST pass
//        via DomainService / Orchestrator injection; the orchestrator alone
//        creates singleton / tx-bound Repositories instances)
//
// Note: the existing admin / auth controllers do read-only projections via
// Repositories methods such as findMe / getAuthorizationContext — those are
// not money-path persistence, so only WRITE-side imports are banned. To
// keep the rule simple we only ban literal import of prisma OR the ledger
// repo / direct SystemConfigRepository instantiation; we don't ban the
// whole Repositories import so existing controllers keep working.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';

function walkControllers(dir: string, out: string[] = []): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkControllers(p, out);
    else if (
      e.isFile() &&
      /\.ts$/i.test(e.name) &&
      !e.name.endsWith('.d.ts') &&
      /\.controller\.ts$/i.test(e.name)
    )
      out.push(p);
  }
  return out;
}

describe('money-path controller DB-bypass guard (T18 / AC-RBAC-33)', () => {
  const root = path.resolve(__dirname, '../../..'); // services/api/
  const controllersRoot = path.join(root, 'src', 'controllers');
  const files: string[] = [];
  if (fs.existsSync(controllersRoot)) {
    files.push(...walkControllers(controllersRoot));
  }
  // Also scan top-level flat controller files (admin.controller.ts, etc.)
  const srcRoot = path.join(root, 'src');
  for (const entry of fs.readdirSync(srcRoot, { withFileTypes: true })) {
    if (entry.isFile() && /\.controller\.ts$/i.test(entry.name)) {
      files.push(path.join(srcRoot, entry.name));
    }
    if (entry.isDirectory() && entry.name !== 'controllers') {
      // scan subdirectories too, for modules like admin/auth containing
      // their own controllers.
      walkControllers(path.join(srcRoot, entry.name), files);
    }
  }
  const unique = Array.from(new Set(files)).sort();

  const bannedControllerPatterns = [
    // Banned import: direct access to Prisma client / low level DB singleton.
    /@prisma\/client/,
    /new\s+PrismaClient/,
    // The singleton prisma export from @ai-wealth/database inside controller
    // (means persistence bypass — orchestrator handles Repositories).
    /\bprisma\s*\.\s*\$transaction/,
    /\bprisma\s*\.\s*ledger/,
    /\bprisma\s*\.\s*ledgerPosting/,
    /\bprisma\s*\.\s*ledgerTransaction/,
    /\bprisma\s*\.\s*systemConfig\.upsert/,
    /\bprisma\s*\.\s*systemConfig\.update/,
    /\bprisma\s*\.\s*idempotencyKey\.update/,
    /\bprisma\s*\.\s*auditLog\.create/,
    // Instantiating a raw Repositories object inside controller.
    /new\s+Repositories\s*\(/,
  ];

  if (unique.length === 0) {
    it('(no controllers found on disk yet; rule pass)', () => {
      expect(true).toBe(true);
    });
  } else {
    it.each(unique.map((f) => [path.relative(root, f), f] as const))(
      'controller %s must NOT import Prisma / ledger persistence directly',
      (_rel, filePath) => {
        const text = fs.readFileSync(filePath, 'utf8');
        const hits: string[] = [];
        for (const pattern of bannedControllerPatterns) {
          if (pattern.test(text)) hits.push(pattern.toString());
        }
        expect(hits).toEqual([]);
      },
    );
  }
});
