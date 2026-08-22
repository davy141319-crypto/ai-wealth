// P1-007 Admin T05-T07: auth-reasons unit tests
import {
  SESSION_INVALIDATION_REASONS,
  extractReason,
  isSessionInvalidationReason,
} from '@/lib/auth-reasons';

describe('SESSION_INVALIDATION_REASONS', () => {
  it('includes the 6 fixed invalidation reasons (values immutable)', () => {
    expect(SESSION_INVALIDATION_REASONS).toContain('AUTH_REFRESH_TOKEN_REUSED');
    expect(SESSION_INVALIDATION_REASONS).toContain('AUTH_REFRESH_TOKEN_REVOKED');
    expect(SESSION_INVALIDATION_REASONS).toContain('AUTH_REFRESH_TOKEN_INVALID');
    expect(SESSION_INVALIDATION_REASONS).toContain('AUTH_TOKEN_REVOKED');
    expect(SESSION_INVALIDATION_REASONS).toContain('AUTH_TOKEN_INVALID');
    expect(SESSION_INVALIDATION_REASONS).toContain('AUTH_NOT_AUTHENTICATED');
    expect(SESSION_INVALIDATION_REASONS.size).toBe(6);
  });
});

describe('extractReason', () => {
  it('extracts reason from nested object details', () => {
    const err = {
      response: {
        data: { error: { details: { reason: 'AUTH_TOKEN_REVOKED' } } },
      },
    };
    expect(extractReason(err)).toBe('AUTH_TOKEN_REVOKED');
  });

  it('extracts reason from string details', () => {
    const err = {
      response: { data: { error: { details: 'AUTH_TOKEN_INVALID' } } },
    };
    expect(extractReason(err)).toBe('AUTH_TOKEN_INVALID');
  });

  it('returns undefined for missing details', () => {
    expect(extractReason({ response: { data: { error: {} } } })).toBeUndefined();
    expect(extractReason({})).toBeUndefined();
    expect(extractReason(null)).toBeUndefined();
  });
});

describe('isSessionInvalidationReason', () => {
  it('returns true for invalidation reasons', () => {
    for (const r of SESSION_INVALIDATION_REASONS) {
      expect(isSessionInvalidationReason(r)).toBe(true);
    }
  });

  it('returns false for non-invalidation 403 reasons (no session clear)', () => {
    expect(isSessionInvalidationReason('AUTH_CSRF_TOKEN_INVALID')).toBe(false);
    expect(isSessionInvalidationReason('AUTH_ORIGIN_NOT_ALLOWED')).toBe(false);
    expect(isSessionInvalidationReason(undefined)).toBe(false);
    expect(isSessionInvalidationReason('RANDOM_BUSINESS_FORBIDDEN')).toBe(false);
  });
});
