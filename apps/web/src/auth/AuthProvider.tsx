'use client';

// ============================================================================
// P1-005 — AuthProvider / useAuth
//
// React Context 层，订阅 AuthSessionCoordinator 的状态变化并派生 UI 状态：
//   status ∈ 'initializing' | 'authenticating' | 'authenticated' | 'refreshing' | 'unauthenticated'
//
// 关键规则（spec v3 + 修订）：
//   - mount 时调 Coordinator.restore()（仅一次）。单例已注册默认 SiweWalletClient（无 connector），
//     因此 restore 立即可调用 /auth/me——不再依赖用户先连接钱包（Fix 1）。
//   - restore 全程状态保持 initializing，即使内部执行 refresh 也不广播 refreshing
//   - 'refreshing' 仅用于已 authenticated 后运行时请求 401（由 Coordinator 在
//     handleUnauthorized 中触发，Coordinator 广播 authenticated 后即恢复）
//   - login(connector) 前设置 'authenticating'；connector 仅签名时需要，由 login() 注入
//   - logout() 不改 UI 状态（Coordinator 广播 unauthenticated）
//
// 禁止：在 localStorage / sessionStorage 存储 token（强制约束 + AC-9）
// ============================================================================

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authCoordinator, type SessionState } from './AuthSessionCoordinator';
import type { VerifyResponseUser, LoginConnector } from '@/lib/siwe-client';

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

  // mount 时：订阅 Coordinator，执行 restore（仅一次）。
  // 单例已注册默认 SiweWalletClient（无 connector），restore 立即调用 /auth/me。
  useEffect(() => {
    const unsubscribe = authCoordinator.subscribe(setSession);
    authCoordinator.restore().catch(() => {
      // restore 失败 → Coordinator 已处理 unauthenticated
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status: deriveStatus(session, uiOverride),
      user: session.user,
      login: async (connector: LoginConnector, requestId?: string) => {
        setUiOverride('authenticating');
        try {
          await authCoordinator.login(connector, requestId);
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

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
