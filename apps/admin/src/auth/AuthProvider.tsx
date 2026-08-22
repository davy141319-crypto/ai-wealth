// ============================================================================
// P1-007 Admin — AuthProvider / useAuth
//
// React Context 层，订阅 AuthSessionCoordinator 的状态变化并派生 UI 状态：
//   status ∈ 'initializing' | 'authenticating' | 'authenticated' | 'refreshing' | 'unauthenticated'
//
// 禁止：在 localStorage / sessionStorage 存储 token
// ============================================================================

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authCoordinator, type SessionState } from './AuthSessionCoordinator';
import type { VerifyResponseUser, LoginConnector } from '@/lib/siwe-client';

export type AuthStatus =
  'initializing' | 'authenticating' | 'authenticated' | 'refreshing' | 'unauthenticated';

export interface AuthContextValue {
  status: AuthStatus;
  user: VerifyResponseUser | null;
  login: (connector: LoginConnector, requestId?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function deriveStatus(session: SessionState, uiOverride: AuthStatus | null): AuthStatus {
  if (uiOverride) return uiOverride;
  switch (session.status) {
    case 'initializing':
      return 'initializing';
    case 'authenticated':
      return 'authenticated';
    case 'refreshing':
      return 'refreshing';
    case 'unauthenticated':
      return 'unauthenticated';
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>({ status: 'initializing', user: null });
  const [uiOverride, setUiOverride] = useState<AuthStatus | null>(null);

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
