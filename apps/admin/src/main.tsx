import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { normalizeBasename } from '@/lib/basename';
import { wagmiConfig } from '@/lib/wagmi';
import { AuthProvider } from '@/auth/AuthProvider';
import App from './App';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found');
}

const queryClient = new QueryClient();
const basename = normalizeBasename(import.meta.env.BASE_URL);

createRoot(rootEl).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <App />
            </AuthProvider>
          </QueryClientProvider>
        </WagmiProvider>
      </ConfigProvider>
    </BrowserRouter>
  </StrictMode>,
);
