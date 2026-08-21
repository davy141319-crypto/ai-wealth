'use client';

import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { wagmiConfig } from '@/lib/wagmi';
import { AuthProvider } from '@/auth/AuthProvider';

const queryClient = new QueryClient();

/**
 * Client-side providers:
 *   WagmiProvider (wallet)
 *     > QueryClientProvider (server state)
 *       > AuthProvider (session state, subscribes AuthSessionCoordinator)
 *         > ConfigProvider (antd theme)
 *           > children
 *
 * P1-005: AuthProvider 在最内层（antd ConfigProvider 内），这样业务组件可以通过
 * useAuth() 读取会话状态。AuthProvider 不依赖 wagmi/antd，它只订阅 Coordinator。
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>{children}</ConfigProvider>
        </AuthProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
