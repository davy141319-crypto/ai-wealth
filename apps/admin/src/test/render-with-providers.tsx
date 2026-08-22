// P1-007 Admin: test helper — render components with providers
// wagmi hooks are globally mocked via __mocks__/wagmi.ts; we simply do NOT mount
// WagmiProvider in tests (they don't need real connectors).

import type { ReactElement, ReactNode } from 'react';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/auth/AuthProvider';

export function renderWithAdminProviders(
  ui: ReactElement,
  options?: Omit<RenderOptions, 'queries'> & {
    initialEntries?: string[];
    initialIndex?: number;
    includeAuth?: boolean;
  },
): RenderResult {
  const { initialEntries, initialIndex, includeAuth = true, ...rest } = options ?? {};
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const wrapped: ReactNode = (
    <MemoryRouter initialEntries={initialEntries ?? ['/']} initialIndex={initialIndex ?? 0}>
      <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
        <QueryClientProvider client={queryClient}>
          {includeAuth ? <AuthProvider>{ui}</AuthProvider> : ui}
        </QueryClientProvider>
      </ConfigProvider>
    </MemoryRouter>
  );

  return render(wrapped, rest);
}
