// ============================================================================
// T16 / T17 / T18 — normalizeBasename unit tests
//
// T16 (dev basename guard):  normalizeBasename('/') === '/' (NOT '/admin')
// T17 (prod basename guard): normalizeBasename('/admin/') === '/admin'
// T18 (unsupported throw):  4 inputs → '' / '/admin' / '/console' / '/app/' all throw
//      Fallback prohibition grep: '|| '/admin'' non-test code 0 matches (verified via T10)
// ============================================================================

import { normalizeBasename } from './basename';

describe('normalizeBasename — T16 dev guard', () => {
  it('T16: normalizeBasename("/") returns exactly "/" (bug regression fix)', () => {
    // Critical: dev basename MUST be '/' so localhost:3001 routes work.
    // The previous bug: BASE_URL.replace(/\/$/,'') || '/admin' collapsed '/' → '/admin'
    expect(normalizeBasename('/')).toBe('/');
  });
});

describe('normalizeBasename — T17 prod guard', () => {
  it('T17: normalizeBasename("/admin/") returns exactly "/admin" (Router basename)', () => {
    expect(normalizeBasename('/admin/')).toBe('/admin');
  });
});

describe('normalizeBasename — T18 unsupported throw on 4 inputs', () => {
  const cases: Array<[string, string]> = [
    ["'' empty string", ''],
    ["'/admin' (no trailing slash)", '/admin'],
    ["'/console' (unknown subpath)", '/console'],
    ["'/app/' (unknown with trailing slash)", '/app/'],
  ];
  it.each(cases)('T18 throw: %s', (_label, input) => {
    expect(() => normalizeBasename(input)).toThrow(Error);
    expect(() => normalizeBasename(input)).toThrow(/Unsupported Vite base/);
  });

  it('T18: never silently coerces to "/admin" fallback', () => {
    // Ensure all unsupported inputs throw rather than returning '/admin'.
    const unsupported = ['', '/admin', '/console', '/app/', '/dashboard', '//admin'];
    for (const u of unsupported) {
      expect(() => normalizeBasename(u)).toThrow();
    }
  });
});
