// ============================================================================
// P1-005 修订（Fix 2）— api.ts response 拦截器行为测试
//
// 直接调用 axios 拦截器的 rejected 处理器，配合 mock 的 Coordinator，验证：
//   - 403 + 会话失效原因（REUSED/REVOKED 等）→ handleForbidden 被调（清会话）
//   - 403 + 普通业务原因 / 无 reason → handleForbidden 不被调（保持 authenticated），原样 reject
//   - 401（非 /auth/*）→ handleUnauthorized 被调
//   - 401（/auth/* 请求）→ 不触发 handleUnauthorized（走 authApi）
//
// 不发起真实网络请求：通过 (api.interceptors.response as any).handlers 取 rejected 处理器直接调用。
// ============================================================================

const mockHandleForbidden = jest.fn();
const mockHandleUnauthorized = jest.fn().mockResolvedValue({ retried: false });
jest.mock('@/auth/AuthSessionCoordinator', () => ({
  authCoordinator: {
    handleForbidden: mockHandleForbidden,
    handleUnauthorized: mockHandleUnauthorized,
  },
}));

import { api } from './api';

/** 取 api 实例上注册的 response rejected 处理器（即 api.ts 里 use 的第二个参数）。 */
function getRejectedHandler(): (e: unknown) => Promise<unknown> {
  const handlers = (
    api.interceptors.response as unknown as {
      handlers: Array<{ rejected?: (e: unknown) => Promise<unknown> }>;
    }
  ).handlers;
  for (const h of handlers) {
    if (typeof h.rejected === 'function') return h.rejected;
  }
  throw new Error('no rejected response handler registered on api');
}

/** 构造 axios 风格的 403 错误。 */
function make403Error(reason?: string): unknown {
  return {
    response: {
      status: 403,
      data: reason
        ? { error: { code: 'FORBIDDEN', details: { reason } } }
        : { error: { code: 'FORBIDDEN', message: 'Forbidden' } },
    },
    config: { url: '/biz/resource' },
  };
}

/** 构造 axios 风格的 401 错误。 */
function make401Error(url: string): unknown {
  return {
    response: { status: 401, data: { error: { code: 'UNAUTHORIZED' } } },
    config: { url },
  };
}

describe('P1-005 Fix 2: api.ts 403 拦截器 — 仅会话失效原因清会话', () => {
  const handler = getRejectedHandler();

  beforeEach(() => {
    mockHandleForbidden.mockClear();
    mockHandleUnauthorized.mockClear();
  });

  it('I01 403 REUSED → handleForbidden 被调', async () => {
    await expect(handler(make403Error('AUTH_REFRESH_TOKEN_REUSED'))).rejects.toBeDefined();
    expect(mockHandleForbidden).toHaveBeenCalledTimes(1);
  });

  it('I02 403 REVOKED → handleForbidden 被调', async () => {
    await expect(handler(make403Error('AUTH_REFRESH_TOKEN_REVOKED'))).rejects.toBeDefined();
    expect(mockHandleForbidden).toHaveBeenCalledTimes(1);
  });

  it('I03 403 TOKEN_REVOKED / TOKEN_INVALID / NOT_AUTHENTICATED → handleForbidden 被调', async () => {
    for (const reason of ['AUTH_TOKEN_REVOKED', 'AUTH_TOKEN_INVALID', 'AUTH_NOT_AUTHENTICATED']) {
      mockHandleForbidden.mockClear();
      await expect(handler(make403Error(reason))).rejects.toBeDefined();
      expect(mockHandleForbidden).toHaveBeenCalledTimes(1);
    }
  });

  it('I04 403 CSRF 失败（非会话失效）→ 不清会话，原样 reject（保持 authenticated）', async () => {
    await expect(handler(make403Error('AUTH_CSRF_TOKEN_INVALID'))).rejects.toBeDefined();
    expect(mockHandleForbidden).not.toHaveBeenCalled();
  });

  it('I05 403 transport/origin 冲突（非会话失效）→ 不清会话', async () => {
    await expect(handler(make403Error('AUTH_TRANSPORT_ORIGIN_CONFLICT'))).rejects.toBeDefined();
    expect(mockHandleForbidden).not.toHaveBeenCalled();
    await expect(handler(make403Error('AUTH_ORIGIN_NOT_ALLOWED'))).rejects.toBeDefined();
    expect(mockHandleForbidden).not.toHaveBeenCalled();
  });

  it('I06 403 无 reason（普通业务 403）→ 不清会话，原样 reject', async () => {
    await expect(handler(make403Error(undefined))).rejects.toBeDefined();
    expect(mockHandleForbidden).not.toHaveBeenCalled();
  });

  it('I07 403 reason 为未知字符串（业务权限拒绝）→ 不清会话', async () => {
    await expect(handler(make403Error('BIZ_PERMISSION_DENIED'))).rejects.toBeDefined();
    expect(mockHandleForbidden).not.toHaveBeenCalled();
  });
});

describe('P1-005 api.ts 401 拦截器', () => {
  const handler = getRejectedHandler();

  beforeEach(() => {
    mockHandleForbidden.mockClear();
    mockHandleUnauthorized.mockClear();
    mockHandleUnauthorized.mockResolvedValue({ retried: false });
  });

  it('I08 401 业务请求（/biz/...）→ handleUnauthorized 被调', async () => {
    await expect(handler(make401Error('/biz/wallets'))).rejects.toBeDefined();
    expect(mockHandleUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('I09 401 /auth/* 请求 → 不触发 handleUnauthorized（走 authApi，无拦截器）', async () => {
    await expect(handler(make401Error('/auth/me'))).rejects.toBeDefined();
    expect(mockHandleUnauthorized).not.toHaveBeenCalled();
  });
});
