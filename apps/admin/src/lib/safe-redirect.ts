// ============================================================================
// P1-007 Admin — 安全重定向目标校验
// ============================================================================

export const DEFAULT_REDIRECT_TARGET = '/dashboard';

export function safeRedirectTarget(
  raw: string | null | undefined,
  fallback: string = DEFAULT_REDIRECT_TARGET,
): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;

  const target = raw;

  if (!target.startsWith('/')) return fallback;
  if (target.startsWith('//') || target.startsWith('/\\')) return fallback;
  if (target.includes('\\') || /[\t\n\r]/.test(target)) return fallback;

  const rest = target.slice(1);
  const delimIdx = rest.search(/[/?#]/);
  const firstSegment = delimIdx === -1 ? rest : rest.slice(0, delimIdx);
  if (firstSegment.includes(':')) return fallback;

  return target;
}
