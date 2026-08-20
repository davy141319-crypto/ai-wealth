'use client';

import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConfigProvider } from 'antd';
import type { ReactNode } from 'react';
import { wagmiConfig } from '@/lib/wagmi';

const queryClient = new QueryClient();

/**
 * Client-side providers: Wagmi (wallet), React Query (server state), Ant Design
 * theme. Real wallet SIGNING is intentionally disabled in P0 — the config and
 * provider are wired so later phases only add connection/signature logic.
 */
export function Providers({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>{children}</ConfigProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
