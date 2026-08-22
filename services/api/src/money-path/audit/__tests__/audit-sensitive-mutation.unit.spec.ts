// AuditService / envelope unit tests (AC-AUD-11..13).
import { validateAuditMetadataEnvelope } from '../audit-metadata.types';

const good = {
  before: { x: 1 },
  after: { x: 2 },
  reason: 'reversal',
  source: 'ledger',
  correlation: 'abc',
};

describe('Audit metadata envelope contract (T10)', () => {
  it('AC-AUD-12: accepts envelope with exactly 5 keys, values nullable', () => {
    const v = validateAuditMetadataEnvelope({ ...good, before: null, after: null });
    expect(v.ok).toBe(true);
  });

  it('AC-AUD-13: missing "before" key → INVALID', () => {
    const { before: _removed, ...rest } = good;
    const v = validateAuditMetadataEnvelope(rest);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues).toContain('MISSING:before');
  });

  it('AC-AUD-13: extra unknown key → EXTRANEOUS', () => {
    const v = validateAuditMetadataEnvelope({ ...good, bonus: 'oops' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues.some((i: string) => i.includes('EXTRANEOUS:bonus'))).toBe(true);
  });

  it('AC-AUD-13: reason non-string non-null → INVALID_REASON_TYPE', () => {
    const v = validateAuditMetadataEnvelope({
      ...good,
      reason: 12345 as unknown as string | null,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues).toContain('INVALID_REASON_TYPE');
  });
});
