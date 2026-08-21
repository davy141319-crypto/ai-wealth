// ============================================================================
// P1-007 Admin — Login Page
//
// Vite SPA version: use react-router-dom useNavigate + useSearchParams
// (no Next useRouter/useSearchParams).
// No username/password form — pure SIWE Connect + Sign button.
// ============================================================================

import { useState } from 'react';
import { Alert, Button, Card, Space, Typography } from 'antd';
import { WalletOutlined } from '@ant-design/icons';
import { useAccount, useSignMessage, useConnect } from 'wagmi';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';
import { safeRedirectTarget } from '@/lib/safe-redirect';
import type { Address } from 'viem';
import type { LoginConnector } from '@/lib/siwe-client';

const { Title, Text } = Typography;

const CHAIN_TO_BACKEND: Record<number, { chain: string; network: string }> = {
  1: { chain: 'ETH', network: 'mainnet' },
  11155111: { chain: 'ETH', network: 'sepolia' },
  56: { chain: 'BSC', network: 'mainnet' },
  97: { chain: 'BSC', network: 'testnet' },
  137: { chain: 'POLYGON', network: 'mainnet' },
  80001: { chain: 'POLYGON', network: 'mumbai' },
  42161: { chain: 'ARBITRUM', network: 'mainnet' },
  421613: { chain: 'ARBITRUM', network: 'goerli' },
};

export function Login() {
  const { login, status: authStatus } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { address, chainId, isConnected } = useAccount();
  const { connectAsync, connectors, isPending: isConnecting } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const [error, setError] = useState<string | null>(null);

  const next = safeRedirectTarget(params.get('next'));

  function buildConnector(): LoginConnector {
    return {
      connect: async () => {
        if (isConnected) {
          if (!address) throw new Error('Connected wallet address unavailable');
          if (chainId === undefined || chainId === null) {
            throw new Error('Connected wallet chainId unavailable');
          }
          return { address, chainId };
        }
        if (connectors.length === 0) {
          throw new Error('No wallet connector available');
        }
        const result = await connectAsync({ connector: connectors[0] });
        const connectedAddress = result.accounts[0];
        if (!connectedAddress) {
          throw new Error('connectAsync returned empty accounts');
        }
        const connectedChainId = result.chainId;
        if (connectedChainId === undefined || connectedChainId === null) {
          throw new Error('connectAsync returned undefined chainId');
        }
        return { address: connectedAddress as Address, chainId: connectedChainId };
      },
      signMessage: (message: string) => signMessageAsync({ message }) as Promise<`0x${string}`>,
      resolveChain: (cid: number) => CHAIN_TO_BACKEND[cid] ?? null,
    };
  }

  async function handleLogin() {
    setError(null);
    try {
      const connector = buildConnector();
      await login(connector);
      navigate(next, { replace: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  }

  const isLoading = authStatus === 'authenticating' || isConnecting;

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        background: '#f0f2f5',
      }}
    >
      <Card style={{ width: 420 }}>
        <Title level={3} style={{ marginBottom: 8 }}>
          AI Wealth Admin
        </Title>
        <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          Sign in with your Ethereum wallet to access the admin console.
        </Text>

        {error && (
          <Alert
            type="error"
            showIcon
            message="Login failed"
            description={error}
            style={{ marginBottom: 16 }}
            closable
            onClose={() => setError(null)}
          />
        )}

        <Alert
          type="info"
          showIcon
          message="Wallet Authentication"
          description="Connect your wallet and sign a message. No real funds are involved in signing."
          style={{ marginBottom: 16 }}
        />

        <Space style={{ marginTop: 8 }}>
          <Button
            type="primary"
            icon={<WalletOutlined />}
            loading={isLoading}
            onClick={handleLogin}
            size="large"
          >
            {isConnected ? 'Sign Message & Sign In' : 'Connect Wallet & Sign In'}
          </Button>
        </Space>

        <div style={{ marginTop: 16 }}>
          <Text type="secondary">
            Session is carried by HttpOnly cookies; no tokens are stored in localStorage.
          </Text>
        </div>
      </Card>
    </div>
  );
}
