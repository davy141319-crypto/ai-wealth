// ============================================================================
// P1-005 修订（Fix 2）— auth-reasons 单元测试
//
// 覆盖：
//   - SESSION_INVALIDATION_REASONS 集合（仅会话失效原因）
//   - extractReason 从 axios 错误体提取 error.details.reason
//   - isSessionInvalidationReason 判定
//   - Spec 明确的 REUSED/REVOKED 等触发；普通业务 403 reason 不触发
// ============================================================================

import {
  SESSION_INVALIDATION_REASONS,
  extractReason,
  isSessionInvalidationReason,
} from './auth-reasons';

describe('P1-005 Fix 2: SESSION_INVALIDATION_REASONS 集合', () => {
  it('AR01 包含 Spec 明确列出的会话失效原因', () => {
    // AC-6 / 状态机规则 13：REFRESH_TOKEN_REUSED / REFRESH_TOKEN_REVOKED
    expect(SESSION_INVALIDATION_REASONS.has('AUTH_REFRESH_TOKEN_REUSED')).toBe(true);
    expect(SESSION_INVALIDATION_REASONS.has('AUTH_REFRESH_TOKEN_REVOKED')).toBe(true);
    // 其它令牌失效原因
    expect(SESSION_INVALIDATION_REASONS.has('AUTH_REFRESH_TOKEN_INVALID')).toBe(true);
    expect(SESSION_INVALIDATION_REASONS.has('AUTH_TOKEN_REVOKED')).toBe(true);
    expect(SESSION_INVALIDATION_REASONS.has('AUTH_TOKEN_INVALID')).toBe(true);
    expect(SESSION_INVALIDATION_REASONS.has('AUTH_NOT_AUTHENTICATED')).toBe(true);
  });

  it('AR02 不包含普通业务/配置类 403 原因（不应清会话）', () => {
    expect(SESSION_INVALIDATION_REASONS.has('AUTH_CSRF_TOKEN_INVALID')).toBe(false);
    expect(SESSION_INVALIDATION_REASONS.has('AUTH_TRANSPORT_ORIGIN_CONFLICT')).toBe(false);
    expect(SESSION_INVALIDATION_REASONS.has('AUTH_TRANSPORT_COOKIE_CONFLICT')).toBe(false);
    expect(SESSION_INVALIDATION_REASONS.has('AUTH_ORIGIN_NOT_ALLOWED')).toBe(false);
    expect(SESSION_INVALIDATION_REASONS.has('FORBIDDEN')).toBe(false);
    expect(SESSION_INVALIDATION_REASONS.has('')).toBe(false);
  });
});

describe('P1-005 Fix 2: extractReason', () => {
  it('AR03 从标准 error.details.reason 对象提取', () => {
    const err = {
      response: {
        status: 403,
        data: { error: { code: 'FORBIDDEN', details: { reason: 'AUTH_REFRESH_TOKEN_REUSED' } } },
      },
    };
    expect(extractReason(err)).toBe('AUTH_REFRESH_TOKEN_REUSED');
  });

  it('AR04 details 为字符串时直接返回', () => {
    const err = {
      response: { status: 403, data: { error: { details: 'AUTH_TOKEN_REVOKED' } } },
    };
    expect(extractReason(err)).toBe('AUTH_TOKEN_REVOKED');
  });

  it('AR05 无 details / 无 response → undefined', () => {
    expect(extractReason({ response: { status: 403, data: { error: {} } } })).toBeUndefined();
    expect(extractReason({ response: { status: 403 } })).toBeUndefined();
    expect(extractReason({})).toBeUndefined();
    expect(extractReason(null)).toBeUndefined();
    expect(extractReason(undefined)).toBeUndefined();
  });

  it('AR06 reason 非字符串 → undefined', () => {
    const err = {
      response: { status: 403, data: { error: { details: { reason: 123 } } } },
    };
    expect(extractReason(err)).toBeUndefined();
  });
});

describe('P1-005 Fix 2: isSessionInvalidationReason', () => {
  it('AR07 会话失效原因 → true', () => {
    expect(isSessionInvalidationReason('AUTH_REFRESH_TOKEN_REUSED')).toBe(true);
    expect(isSessionInvalidationReason('AUTH_REFRESH_TOKEN_REVOKED')).toBe(true);
    expect(isSessionInvalidationReason('AUTH_TOKEN_INVALID')).toBe(true);
  });

  it('AR08 普通业务 403 reason / 空 → false', () => {
    expect(isSessionInvalidationReason('AUTH_CSRF_TOKEN_INVALID')).toBe(false);
    expect(isSessionInvalidationReason('AUTH_TRANSPORT_ORIGIN_CONFLICT')).toBe(false);
    expect(isSessionInvalidationReason(undefined)).toBe(false);
    expect(isSessionInvalidationReason('')).toBe(false);
    expect(isSessionInvalidationReason('FORBIDDEN')).toBe(false);
  });
});
