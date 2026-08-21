// ============================================================================
// P1-005 修订 — 403 会话失效原因判定（Fix 2）
//
// 业务请求（via api.ts）收到 403 时，不能一律清会话：普通业务 403（如权限不足、
// 资源禁止访问）应原样 reject 并保持 authenticated。仅当服务端返回的 error.details.reason
// 明确属于"会话已失效、必须重新登录"的原因时，才清客户端状态并回登录页。
//
// 原因字符串来自 packages/shared/src/error-codes.ts::AuthFailReason（值跨版本不可变，
// 注释明确 "Keep values immutable across releases"）。这里以字面量常量收录，避免把
// @ai-wealth/shared 拉进浏览器 bundle（耦合 + 体积）。新增原因时同步更新本集合即可。
//
// Spec 明确列出的会话失效 403 原因（AC-6 / 状态机规则 13）：
//   - AUTH_REFRESH_TOKEN_REUSED   令牌家族被盗用，整族吊销
//   - AUTH_REFRESH_TOKEN_REVOKED  令牌家族被吊销
//   - AUTH_REFRESH_TOKEN_INVALID   refresh 令牌无效/过期（族已死）
//   - AUTH_TOKEN_REVOKED           access 令牌被显式吊销
//   - AUTH_TOKEN_INVALID           access 令牌无效
//   - AUTH_NOT_AUTHENTICATED       无有效会话
//
// 不在此集合的 403（如 CSRF 失败、transport/origin 冲突、业务权限拒绝）不清会话：
//   - AUTH_CSRF_TOKEN_INVALID：CSRF cookie/token 不匹配，多为前端配置问题，不必然代表会话失效
//   - AUTH_TRANSPORT_* / AUTH_ORIGIN_NOT_ALLOWED：传输模式/源不匹配，配置问题
//   - 无 reason 的业务 403：权限/资源禁止，保持登录态
// ============================================================================

/** 会话失效原因集合（仅这些触发清会话）。 */
export const SESSION_INVALIDATION_REASONS: ReadonlySet<string> = new Set<string>([
  'AUTH_REFRESH_TOKEN_REUSED',
  'AUTH_REFRESH_TOKEN_REVOKED',
  'AUTH_REFRESH_TOKEN_INVALID',
  'AUTH_TOKEN_REVOKED',
  'AUTH_TOKEN_INVALID',
  'AUTH_NOT_AUTHENTICATED',
]);

/**
 * 从 axios 错误里提取 error.details.reason。
 * 后端统一响应体（packages/shared/src/api-response.ts::fail）：
 *   { success:false, error:{ code, message, details:{ reason } }, timestamp }
 *   —— details 为 { reason } 对象；也兼容 details 本身是字符串的边缘情形。
 */
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

/** 判断 reason 是否属于会话失效原因。 */
export function isSessionInvalidationReason(reason: string | undefined): boolean {
  return typeof reason === 'string' && SESSION_INVALIDATION_REASONS.has(reason);
}
