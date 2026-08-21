// ============================================================================
// P1-005 修订 — 安全重定向目标校验（Fix 3）
//
// login 页面的 ?next= 参数来自用户可控的 URL，直接用作 router.replace(next) 会引入
// open-redirect 风险（如 //evil.com 协议相对跳转、javascript: 伪协议、反斜杠绕过等）。
// 本函数仅放行"本站安全相对路径"：
//   - 必须以单个 '/' 开头
//   - 不得以 '//' 或 '/\\' 开头（协议相对 / 反斜杠绕过）
//   - 不得含反斜杠或控制字符
//   - 不得以 scheme 形式出现（http: / javascript: / data: 等已被"必须以 / 开头"拦截，
//     这里再做一层防御：路径首段不得含 ':'，避免 '/javascript:alert(1)' 这类边缘写法
//     被某些客户端当作伪协议）
// 非法值统一 fallback 到 /dashboard。
// ============================================================================

export const DEFAULT_REDIRECT_TARGET = '/dashboard';

/**
 * 校验重定向目标是否为安全的本站相对路径；非法则返回 fallback（默认 /dashboard）。
 */
export function safeRedirectTarget(
  raw: string | null | undefined,
  fallback: string = DEFAULT_REDIRECT_TARGET,
): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;

  const target = raw;

  // 必须以单个 '/' 开头（拒绝绝对 URL、scheme、相对片段等）
  if (!target.startsWith('/')) return fallback;
  // 拒绝协议相对 '//evil.com' 与反斜杠绕过 '/\\evil.com'
  if (target.startsWith('//') || target.startsWith('/\\')) return fallback;
  // 路径中不得出现反斜杠或控制字符
  if (target.includes('\\') || /[\t\n\r]/.test(target)) return fallback;

  // 路径首段（去掉前导 '/' 后，到下一个 '/' / '?' / '#' 之前）不得含 ':'，
  // 否则视为伪协议（如 '/javascript:alert(1)'）。
  const rest = target.slice(1);
  const delimIdx = rest.search(/[/?#]/);
  const firstSegment = delimIdx === -1 ? rest : rest.slice(0, delimIdx);
  if (firstSegment.includes(':')) return fallback;

  return target;
}
