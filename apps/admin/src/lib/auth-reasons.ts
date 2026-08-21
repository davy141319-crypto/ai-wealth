// ============================================================================
// P1-007 Admin — 403 会话失效原因判定
// ============================================================================

export const SESSION_INVALIDATION_REASONS: ReadonlySet<string> = new Set<string>([
  'AUTH_REFRESH_TOKEN_REUSED',
  'AUTH_REFRESH_TOKEN_REVOKED',
  'AUTH_REFRESH_TOKEN_INVALID',
  'AUTH_TOKEN_REVOKED',
  'AUTH_TOKEN_INVALID',
  'AUTH_NOT_AUTHENTICATED',
]);

export function extractReason(error: unknown): string | undefined {
  const e = error as {
    response?: { data?: { error?: { details?: { reason?: string } | string } } };
  };
  const details = e?.response?.data?.error?.details;
  if (typeof details === 'string') return details;
  if (details && typeof details === 'object' && 'reason' in details) {
    const r = (details as { reason?: unknown }).reason;
    return typeof r === 'string' ? r : undefined;
  }
  return undefined;
}

export function isSessionInvalidationReason(reason: string | undefined): boolean {
  return typeof reason === 'string' && SESSION_INVALIDATION_REASONS.has(reason);
}
