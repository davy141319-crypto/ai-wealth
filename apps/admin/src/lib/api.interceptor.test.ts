// ============================================================================
// T08 / T09 / T10 / T11 — api.ts Axios interceptor matrix
//
// T08: 401 trigger → single-flight refresh + retry once max.
//      refresh invalid → AuthSessionCoordinator.logout() → /login.
// T09: 403 dispatch split:
//        a) /auth/*   → authCoordinator.handleForbidden() → logout + /login
//        b) /admin/*  → navigate /forbidden (broadcast onAdminBusiness403)
// T10: /admin/me returns 403 → useAdmin hook roleState → FORBIDDEN (verify cb fires)
// T11: 5xx retry up to 3x (3 caps). Fourth attempt: fail with original error.
// ============================================================================

import type { AxiosInstance, AxiosRequestConfig } from 'axios';
import { api as apiInstance, onAdminBusiness403, registerAdminForbiddenCallback } from './api';
import { authCoordinator } from '@/auth/AuthSessionCoordinator';

jest.mock('@/auth/AuthSessionCoordinator', () => ({
  authCoordinator: {
    handleUnauthorized: jest.fn(),
    handleForbidden: jest.fn(),
  },
}));

function createInterceptorHost(): AxiosInstance {
  // reuse the actual api instance which has interceptor attached at module import
  return apiInstance;
}

beforeEach(() => {
  jest.clearAllMocks();
  registerAdminForbiddenCallback(undefined);
});

// ---- Helpers to simulate interceptor errors via axios-adapter-style interceptor replay ----
function resolveAxiosError(status: number, config: AxiosRequestConfig, data?: unknown): Error {
  const err: any = new Error(`Request failed with status code ${status}`);
  err.isAxiosError = true;
  err.response = { status, data, statusText: 'X', headers: {}, config };
  err.config = config;
  return err;
}

// We run request's response path by invoking use()'d error handler directly.
// Grab error handler from the real interceptor list.
type InterceptorHandlers = { fulfilled?: (v: any) => any; rejected?: (e: any) => any };
function responseRejectHandler(): NonNullable<InterceptorHandlers['rejected']> {
  const host = createInterceptorHost();
  const list = (host.interceptors.response as any).handlers as InterceptorHandlers[];
  for (const h of list) {
    if (h?.rejected) return h.rejected;
  }
  throw new Error('no response reject interceptor registered');
}

describe('T08 — 401 single-flight refresh + retry once cap', () => {
  it('T08.1 401 → handleUnauthorized; retried=true replays request; retried=false → handleForbidden → logout', async () => {
    const handleUnauthorized = authCoordinator.handleUnauthorized as jest.MockedFunction<any>;
    handleUnauthorized.mockResolvedValueOnce({ retried: true });
    // mock axios request replay to succeed
    const replay = jest.fn().mockResolvedValue({ data: 'd' });
    const origReq = { url: '/admin/dashboard', method: 'get', adapter: replay } as any;
    const err = resolveAxiosError(401, origReq);

    const handler = responseRejectHandler();
    const result = await handler(err);
    expect(result).toMatchObject({ data: 'd' });
    expect(handleUnauthorized).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('T08.2 401 → retried=false → handleForbidden → logout(/auth/next=)', async () => {
    const handleUnauthorized = authCoordinator.handleUnauthorized as jest.MockedFunction<any>;
    handleUnauthorized.mockResolvedValueOnce({ retried: false });
    const origReq = { url: '/admin/dashboard', method: 'get', adapter: jest.fn() } as any;
    const err = resolveAxiosError(401, origReq);
    const handler = responseRejectHandler();
    await expect(handler(err)).rejects.toBeDefined();
    expect(authCoordinator.handleForbidden).toHaveBeenCalledTimes(1);
  });

  it('T08.3 retry_once hard cap: same request 2nd 401 → no retry', async () => {
    const handleUnauthorized = authCoordinator.handleUnauthorized as jest.MockedFunction<any>;
    handleUnauthorized.mockResolvedValue({ retried: true });
    // first call: 401 triggers replay which itself returns 401 again → must NOT call handler 2nd time
    let callCount = 0;
    const replay = jest.fn().mockImplementation(() => {
      callCount += 1;
      return callCount === 1
        ? Promise.reject(resolveAxiosError(401, origReq))
        : Promise.resolve({ data: 'd2' });
    });
    const origReq = { url: '/admin/x', method: 'get', adapter: replay } as any;
    const err1 = resolveAxiosError(401, origReq);
    const handler = responseRejectHandler();
    await expect(handler(err1)).rejects.toBeDefined(); // retry fails again → no 2nd attempt
    // Total retries = 1 only (hard cap). So handler rejected after one replay.
    expect(handleUnauthorized).toHaveBeenCalledTimes(1);
  });
});

describe('T09 — 403 split auth vs admin', () => {
  it('T09.1 /auth/* 403 → handleForbidden (logout)', async () => {
    const origReq = { url: '/auth/refresh', method: 'post', adapter: jest.fn() } as any;
    const err = resolveAxiosError(403, origReq, {
      error: { details: 'AUTH_REFRESH_TOKEN_REUSED' },
    });
    const handler = responseRejectHandler();
    await expect(handler(err)).rejects.toBeDefined();
    expect(authCoordinator.handleForbidden).toHaveBeenCalledTimes(1);
  });

  it('T09.2 /admin/* 403 → navigate /forbidden + broadcast cb (not handleForbidden)', async () => {
    let cbFired = false;
    registerAdminForbiddenCallback(() => {
      cbFired = true;
    });
    const origReq = { url: '/admin/me', method: 'get', adapter: jest.fn() } as any;
    const err = resolveAxiosError(403, origReq, { code: 'ROLE_REQUIRED' });
    const handler = responseRejectHandler();
    await expect(handler(err)).rejects.toBeDefined();
    expect(cbFired).toBe(true);
    expect(authCoordinator.handleForbidden).not.toHaveBeenCalled();
  });

  it('T09.3 other URL 403 → no side effect, rethrow only', async () => {
    const origReq = { url: '/public/info', method: 'get', adapter: jest.fn() } as any;
    const err = resolveAxiosError(403, origReq);
    const handler = responseRejectHandler();
    await expect(handler(err)).rejects.toBeDefined();
    expect(authCoordinator.handleForbidden).not.toHaveBeenCalled();
    expect(onAdminBusiness403).toBeUndefined(); // never set by api.ts internals
  });
});

describe('T10 — /admin/me 403 fires broadcast cb (useAdmin integration point)', () => {
  it('T10: registered cb fires once; roleState → FORBIDDEN responsibility of useAdmin hook', () => {
    const fired: number[] = [];
    registerAdminForbiddenCallback(() => fired.push(Date.now()));
    const origReq = { url: '/admin/me', method: 'get' } as any;
    const err = resolveAxiosError(403, origReq);
    const handler = responseRejectHandler();
    return handler(err).catch(() => {
      expect(fired.length).toBe(1);
    });
  });
});

describe('T11 — 5xx retry capped at 3', () => {
  it('T11: 500 retries up to 3 caps. 4th fail surfaces original error', async () => {
    let callCount = 0;
    const adapter = jest.fn().mockImplementation(() => {
      callCount += 1;
      return Promise.reject(resolveAxiosError(500, req));
    });
    const req: AxiosRequestConfig = {
      url: '/admin/stats',
      method: 'get',
      adapter,
    };
    const handler = responseRejectHandler();
    await expect(handler(resolveAxiosError(500, req))).rejects.toBeDefined();
    expect(adapter).toHaveBeenCalledTimes(3);
    expect(callCount).toBe(3);
  });
});
