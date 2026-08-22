// ============================================================================
// T12 — safeRedirectTarget 7 input vectors
// Vectors (per AC-25):
//   1. '//evil.com'            protocol-relative → fallback /dashboard
//   2. '/\\evil.com'          backslash bypass   → fallback /dashboard
//   3. 'javascript:alert(1)'  pseudo-protocol    → fallback /dashboard (not start with /)
//   4. 'https://evil.com'     absolute URL other → fallback (not start with /)
//   5. 'data:text/html,...'   data: pseudo      → fallback (not start with /)
//   6. '/dashboard'           valid internal     → /dashboard
//   7. '/foo?x=1'             valid query        → /foo?x=1
// Additional edge:
//   8. null / undefined / ''  → /dashboard fallback
//   9. '/javascript:alert(1)' first segment has ':' → fallback
// ============================================================================

import { DEFAULT_REDIRECT_TARGET, safeRedirectTarget } from './safe-redirect';

describe('T12 — safeRedirectTarget 7+ vectors', () => {
  it('T12.1: rejects protocol-relative "//evil.com" → /dashboard', () => {
    expect(safeRedirectTarget('//evil.com')).toBe(DEFAULT_REDIRECT_TARGET);
  });

  it('T12.2: rejects backslash bypass "/\\\\evil.com" → /dashboard', () => {
    expect(safeRedirectTarget('/\\evil.com')).toBe(DEFAULT_REDIRECT_TARGET);
  });

  it('T12.3: rejects pseudo-protocol "javascript:alert(1)" → /dashboard', () => {
    expect(safeRedirectTarget('javascript:alert(1)')).toBe(DEFAULT_REDIRECT_TARGET);
  });

  it('T12.4: rejects absolute URL "https://evil.com" → /dashboard', () => {
    expect(safeRedirectTarget('https://evil.com')).toBe(DEFAULT_REDIRECT_TARGET);
  });

  it('T12.5: rejects "data:" pseudo protocol → /dashboard', () => {
    expect(safeRedirectTarget('data:text/html,<h1>hi</h1>')).toBe(DEFAULT_REDIRECT_TARGET);
  });

  it('T12.6: accepts valid internal "/dashboard" → /dashboard', () => {
    expect(safeRedirectTarget('/dashboard')).toBe('/dashboard');
  });

  it('T12.7: accepts "/foo?x=1" with query → /foo?x=1', () => {
    expect(safeRedirectTarget('/foo?x=1')).toBe('/foo?x=1');
  });

  it('T12.8: null/undefined/empty all fall back', () => {
    expect(safeRedirectTarget(null)).toBe('/dashboard');
    expect(safeRedirectTarget(undefined)).toBe('/dashboard');
    expect(safeRedirectTarget('')).toBe('/dashboard');
  });

  it('T12.9: first segment colon → pseudo-protocol rejected', () => {
    expect(safeRedirectTarget('/javascript:alert(1)')).toBe('/dashboard');
  });

  it('T12.10: custom fallback honored for invalid input', () => {
    expect(safeRedirectTarget('//evil.com', '/home')).toBe('/home');
  });
});
