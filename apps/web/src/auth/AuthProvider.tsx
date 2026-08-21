'use client';

// ============================================================================
// P1-005 — AuthProvider / useAuth
//
// React Context 层，订阅 AuthSessionCoordinator 的状态变化并派生 UI 状态：
//   status ∈ 'initializing' | 'authenticating' | 'authenticated' | 'refreshing' | 'unauthenticated'
//
// 关键规则（spec v3）：
//   - mount 时调 Coordinator.restore()（仅一次）
//   - restore 全程状态保持 initializing，即使内部执行 refresh 也不广播 refreshing
//   - 'refreshing' 仅用于已 authenticated 后运行时请求 401（由 Coordinator 在
//     handleUnauthorized 中触发，Coordinator 广播 authenticated 后即恢复）
//   - login() 前设置 'authenticating'；logout() 不改 UI 状态（Coordinator 广播 unauthenticated）
//
// 禁止：在 localStorage / sessionStorage 存储 token（强制约束 + AC-9）
// ============================================================================

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { authCoordinator, type SessionState } from './AuthSessionCoordinator';
import { SiweWalletClient, type VerifyResponseUser, type LoginConnector } from '@/lib/siwe-client';

/** UI 可见的状态（5 态，spec v3）。 */
export type AuthStatus =
  'initializing' | 'authenticating' | 'authenticated' | 'refreshing' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: VerifyResponseUser | null;
  login: (connector: LoginConnector, requestId?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * 从 Coordinator 的 SessionState 派生 UI AuthStatus。
 *
 * Coordinator 只广播 3 态（initializing/authenticated/unauthenticated）+ user。
 * 'authenticating' / 'refreshing' 是 UI 层的瞬时态，由 AuthProvider 在
 * login()/logout() 调用前后设置。
 *
 * spec v3 AC-21：初始化期 restore 即使执行 refresh，状态始终 initializing。
 * 这里我们直接用 Coordinator 的 status，因此初始化期 refresh 不会产生 refreshing。
 */
function deriveStatus(session: SessionState, uiOverride: AuthStatus | null): AuthStatus {
  if (uiOverride) return uiOverride;
  // Coordinator 没有 refreshing 态；运行时 401 的 refreshing 是短暂的，
  // 由 api.ts 拦截器 await handleUnauthorized 期间阻塞请求，UI 保持当前视图。
  switch (session.status) {
    case 'initializing':
      return 'initializing';
    case 'authenticated':
      return 'authenticated';
    case 'unauthenticated':
      return 'unauthenticated';
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: 'initializing', user: null });
  const [uiOverride, setUiOverride] = useState<AuthStatus | null>(null);
  const clientRef = useRef<SiweWalletClient | null>(null);

  // mount 时：注册 SiweWalletClient（默认 connector 由调用方注入或延迟注册），
  // 订阅 Coordinator，执行 restore（仅一次）。
  useEffect(() => {
    const unsubscribe = authCoordinator.subscribe(setSession);

    // 若已注册 client（例如在 Providers 外部注入），则 restore；否则等待 registerClient。
    // P1-005 默认实现：不在此处创建 SiweWalletClient（需要 wagmi connector），
    // 由 Login 页面在用户点击登录时创建并注册。restore 仅尝试 /auth/me。
    authCoordinator.restore().catch(() => {
      // restore 失败 → Coordinator 已处理 unauthenticated
    });

    return () => {
      unsubscribe();
    };
  }, []);

  /**
   * 注入 SiweWalletClient（由需要登录的组件调用，如 Login 页面）。
   * 必须用 authApi（强制约束 B）。
   */
  function registerClient(connector: LoginConnector): SiweWalletClient {
    // 动态 import 避免循环依赖（authApi 不依赖本文件）
    // 实际实现：直接 new SiweWalletClient（其默认 http 参数即 authApi）
    const client = new SiweWalletClient(connector);
    clientRef.current = client;
    authCoordinator.registerClient(client);
    return client;
  }

  const value = useMemo<AuthContextValue>(
    () => ({
      status: deriveStatus(session, uiOverride),
      user: session.user,
      login: async (connector: LoginConnector, requestId?: string) => {
        // 确保 client 已注册
        if (!clientRef.current) {
          registerClient(connector);
        }
        setUiOverride('authenticating');
        try {
          await authCoordinator.login(requestId);
          setUiOverride(null);
        } catch (err) {
          setUiOverride(null);
          throw err;
        }
      },
      logout: async () => {
        setUiOverride(null);
        await authCoordinator.logout();
      },
    }),
    [session, uiOverride],
  );

  // 暴露 registerClient 给需要的组件（如 Login 页面）
  // 通过 context value 暴露是不合适的（它不是 hook 返回值），
  // 改为模块级导出一个 helper：
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** 给 Login 页面用的辅助：注册 SiweWalletClient 并返回它。 */
export function useRegisterAuthClient() {
  const ref = useRef<SiweWalletClient | null>(null);
  return (connector: LoginConnector): SiweWalletClient => {
    if (!ref.current) {
      ref.current = new SiweWalletClient(connector);
      authCoordinator.registerClient(ref.current);
    }
    return ref.current;
  };
}
