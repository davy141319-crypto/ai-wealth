// ============================================================================
// Static rule: JS `number` must never participate in amount arithmetic in
// money-path modules. Enforcement: regex AST-ish text scan of every TS
// source in services/api/src/money-path/** — detect:
//   * (number) -> amount conversion (passing raw `number` literal to amount
//     wire params: new Decimal(42) instead of string)
//   * binary arithmetic operators on amount fields: `amount1 + amount2`
//     when `amount1`/`amount2` would be TS `number`.
//
// To avoid false positives the scanner is conservative: it forbids ANY
// occurrence of the following patterns inside a function/class body that
// references `amount` fields:
//   - `new Prisma.Decimal(number)`  NOT STRING argument.
//   - binary `+` `-` `*` `/` next to an identifier that contains
//     `Amount`/`amount`/`debitSum`/`creditSum`/`balance` when the left/right
//     side is NOT preceded by a `Decimal` method call (exact engine code
//     uses `plus`/`minus`/`times`/`dividedBy`).
//
// In other words, all amount math must be done via the Prisma.Decimal
// method API. This pattern catches accidental numeric drift.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';

describe('money-path: JS number forbidden in amount arithmetic (NFR-09 / AC-LED-09)', () => {
  const root = path.resolve(__dirname, '..');
  const walk = (dir: string, out: string[] = []): string[] => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== '__tests__') walk(p, out);
      else if (e.isFile() && /\.ts$/i.test(e.name)) out.push(p);
    }
    return out;
  };
  const files = walk(root);
  const bannedPatterns: Array<[RegExp, string]> = [
    // Raw number literal passed as a wire amount / Prisma.Decimal constructor.
    [
      /new\s+Prisma\.Decimal\s*\(\s*[-+]?\d+(\.\d+)?\s*\)/,
      'Prisma.Decimal(number literal) — pass a string instead.',
    ],
    // Binary arithmetic with amount identifiers
    [
      /(amount[A-Za-z_]*|debitSum|creditSum|netBalance|postings\[[^\]]+\]\.amount)\s*[+\-*/]/,
      'Arithmetic operator next to amount-like identifier — use Prisma.Decimal methods (plus/minus/times/dividedBy).',
    ],
  ];

  it.each(files.map((f) => [path.relative(root, f), f] as const))(
    'source %s uses Decimal API only for amounts (no JS number math)',
    (_rel, file) => {
      const text = fs.readFileSync(file, 'utf8');
      const failures: string[] = [];
      for (const [pat, note] of bannedPatterns) {
        const matches = text.match(pat);
        if (matches) failures.push(`${note} — match: ${matches[0]}`);
      }
      expect(failures).toEqual([]);
    },
  );
});
