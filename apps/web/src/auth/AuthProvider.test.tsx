/**
 * @jest-environment jsdom
 */
// ============================================================================
// P1-005 修订（Fix 1 + Fix 4）— 真实 React 集成测试
//
// 不再只读源码正则：实际渲染 <AuthProvider><ProtectedRoute><div>SECRET</div></ProtectedRoute></AuthProvider>
// 并用 jsdom + @testing-library/react 验证：
//   - Fix 1：应用启动（AuthProvider mount）立即具备可调用的默认 auth session client
//     （单例已注册默认 SiweWalletClient，无需先连接钱包）。
//       · 已有有效 session → /auth/me 200 → authenticated（SECRET 出现）
//       · /auth/me 401 → refresh 200 → authenticated（SECRET 出现）
//   - Fix 4：initializing 期间渲染 loading，不闪现受保护内容（SECRET 不可见）；
//            restore 完成后才渲染 children 或 redirect /login。
//   - AC-9：全程不向 localStorage / sessionStorage 写 token。
//
// authApi 被 mock（真实 Coordinator 单例 + 真实默认 SiweWalletClient 命中 mock HTTP），
// 这样验证的是真实 AuthProvider → 真实 Coordinator → 真实默认 client 的端到端状态流，
// 而非注入 fake client。
// ============================================================================

import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { AuthProvider } from './AuthProvider';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { authCoordinator } from './AuthSessionCoordinator';
import { mockRouter, __resetMockRouter } from '@/__mocks__/next-navigation';

// ----------------------------------------------------------------------------
// Mock authApi：用工厂内创建的 jest.fn，通过 __mockGet/__mockPost 暴露给测试。
// 真实默认 SiweWalletClient（单例注册）会命中这些 mock，不发真实网络请求。
// ----------------------------------------------------------------------------
jest.mock('@/lib/authApi', () => {
  const mockGet = jest.fn();
  const mockPost = jest.fn();
  return {
    authApi: {
      get: mockGet,
      post: mockPost,
      defaults: { baseURL: 'http://localhost:4000/api' },
      interceptors: { response: { handlers: [], use: () => {} } },
    },
    API_BASE_URL: 'http://localhost:4000/api',
    __mockGet: mockGet,
    __mockPost: mockPost,
  };
});

// Mock antd：只渲染 Spin 占位，避免 antd 在 jsdom 的 matchMedia 等副作用。
// 工厂内用 require('react')（jest.mock 工厂不得引用外部变量）。
jest.mock('antd', () => {
  const React = require('react');
  const Spin = (props: { tip?: string }) =>
    React.createElement('div', { 'data-testid': 'spin' }, props.tip ?? 'Loading session...');
  return { Spin };
});

import * as authApiModule from '@/lib/authApi';
const mockGet = (authApiModule as unknown as { __mockGet: jest.Mock }).__mockGet;
const mockPost = (authApiModule as unknown as { __mockPost: jest.Mock }).__mockPost;

// ----------------------------------------------------------------------------
// 辅助
// ----------------------------------------------------------------------------
function makeUser(id = 'u-1') {
  return {
    id,
    status: 'ACTIVE',
    lastLoginAt: null,
    wallets: [
      {
        id: 'w-1',
        address: '0xabc',
        chain: 'ETH',
        network: 'mainnet',
        status: 'ACTIVE',
        isPrimary: true,
      },
    ],
  };
}

function okEnvelope<T>(data: T) {
  return { data: { success: true, data, timestamp: new Date().toISOString() } };
}

function errAxios(status: number, reason?: string) {
  const e = new Error(`HTTP ${status}`) as Error & {
    response: { status: number; data: { error: { code: string; details?: { reason: string } } } };
  };
  e.response = {
    status,
    data: {
      error: {
        code: status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
        ...(reason ? { details: { reason } } : {}),
      },
    },
  };
  return e;
}

type MeResult = 'ok' | '401';
type RefreshResult = 'ok' | '401' | '403';

/** 配置 mock authApi 的响应。 */
function setupHttpMocks(opts: { me: MeResult; refresh?: RefreshResult }) {
  mockGet.mockReset();
  mockPost.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url === '/auth/me') {
      return opts.me === 'ok'
        ? Promise.resolve(okEnvelope(makeUser('me-user')))
        : Promise.reject(errAxios(401));
    }
    if (url === '/auth/csrf-token') {
      return Promise.resolve(okEnvelope({ csrfToken: 'csrf-token' }));
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  mockPost.mockImplementation((url: string) => {
    if (url === '/auth/refresh') {
      if (opts.refresh === '401')
        return Promise.reject(errAxios(401, 'AUTH_REFRESH_TOKEN_INVALID'));
      if (opts.refresh === '403') return Promise.reject(errAxios(403, 'AUTH_REFRESH_TOKEN_REUSED'));
      return Promise.resolve(okEnvelope({ user: makeUser('refresh-user') }));
    }
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
}

function renderProtected() {
  return render(
    <AuthProvider>
      <ProtectedRoute>
        <div>SECRET</div>
      </ProtectedRoute>
    </AuthProvider>,
  );
}

// AC-9：localStorage / sessionStorage 共享 Storage.prototype.setItem，spy 一次即可监控两者。
const setItemSpy = jest.spyOn(Storage.prototype, 'setItem');

beforeEach(() => {
  __resetMockRouter();
  setItemSpy.mockClear();
  // reset 单例：restoreStarted=false，状态回 initializing（render 前，无 listener）
  authCoordinator.reset();
});

afterEach(() => {
  cleanup();
});

// ============================================================================
// Fix 1 + Fix 4：真实 React 集成测试
// ============================================================================

describe('P1-005 Fix 1 + Fix 4: AuthProvider 真实渲染状态流', () => {
  it('RT01 已有有效 session → mount → /me 200 → authenticated；initializing 不闪现 SECRET', async () => {
    setupHttpMocks({ me: 'ok' });

    renderProtected();

    // initializing 期间：渲染 loading，SECRET 不可见（不闪现受保护内容）
    expect(screen.queryByText('SECRET')).toBeNull();

    // restore 完成 → authenticated → SECRET 出现
    const secret = await screen.findByText('SECRET');
    expect(secret).not.toBeNull();

    // Fix 1：默认 client 在无钱包连接/无 registerClient 的情况下已调用 /auth/me
    const meCalls = mockGet.mock.calls.filter((c) => c[0] === '/auth/me');
    expect(meCalls.length).toBe(1);
    // 已认证 → 不 redirect
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('RT02 /me 401 → refresh 200 → authenticated；全程 initializing→authenticated 不闪现', async () => {
    setupHttpMocks({ me: '401', refresh: 'ok' });

    renderProtected();

    // initializing 期间不闪现受保护内容
    expect(screen.queryByText('SECRET')).toBeNull();

    // restore：me 401 → refresh 200 → authenticated
    const secret = await screen.findByText('SECRET');
    expect(secret).not.toBeNull();

    expect(mockGet.mock.calls.some((c) => c[0] === '/auth/me')).toBe(true);
    expect(mockPost.mock.calls.some((c) => c[0] === '/auth/refresh')).toBe(true);
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  it('RT03 /me 401 → refresh 401 → unauthenticated → redirect /login；SECRET 永不出现', async () => {
    setupHttpMocks({ me: '401', refresh: '401' });

    renderProtected();

    // 等待 redirect 被触发（unauthenticated → ProtectedRoute 跳 /login?next=）
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled());
    expect(mockRouter.replace).toHaveBeenCalledWith(expect.stringContaining('/login'));

    // SECRET 全程未渲染
    expect(screen.queryByText('SECRET')).toBeNull();
  });

  it('RT04 /me 401 → refresh 403 REUSED → unauthenticated → redirect /login', async () => {
    setupHttpMocks({ me: '401', refresh: '403' });

    renderProtected();

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalled());
    expect(mockRouter.replace).toHaveBeenCalledWith(expect.stringContaining('/login'));
    expect(screen.queryByText('SECRET')).toBeNull();
  });

  it('RT05 AC-9：全程不向 localStorage/sessionStorage 写 token', async () => {
    setupHttpMocks({ me: 'ok' });
    renderProtected();
    await screen.findByText('SECRET');

    // 任何 setItem 调用的 key 都不得包含 token 类敏感字样
    for (const call of setItemSpy.mock.calls) {
      const key = String(call[0] ?? '');
      expect(key.toLowerCase()).not.toMatch(/token|access|refresh|jwt|secret/);
    }
  });
});
