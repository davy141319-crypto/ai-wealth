'use client';

// ============================================================================
// P1-005 — Login 页面接入真实 SIWE
//
// 使用 wagmi useAccount / useSignMessage + SiweWalletClient connector。
// 调 useAuth().login(connector)，成功后 redirect（?next= 经安全校验，非法 fallback /dashboard）。
//
// 注意：useSearchParams() 在 Next.js 14 静态预渲染时必须位于 <Suspense> 边界内，
// 否则 build 会报 "useSearchParams() should be wrapped in a suspense boundary"。
// 因此本文件拆为 LoginPage（默认导出，提供 Suspense 外壳）+ LoginContent（实际表单）。
//
// P1-005 修订（Fix 1 + Fix 3 + wallet connect 竞态修复）：
//   - 登录不再调用 registerClient；Coordinator 单例已持默认 client，login(connector) 注入 connector。
//   - ?next= 经 safeRedirectTarget 校验，仅放行本站安全相对路径（Fix 3）。
//   - 首次 connect 竞态修复：禁止 connectAsync 后 setTimeout 读 useAccount ref。
//     未连接时直接用 connectAsync 返回值（result.accounts[0] + result.chainId）构造 connector；
//     已连接时才用当前 useAccount 的 address+chainId。chainId 不得 undefined 回退 1。
// ============================================================================

import { Suspense, useState } from 'react';
import { Alert, Button, Card, Space, Spin, Typography } from 'antd';
import { WalletOutlined } from '@ant-design/icons';
import { useAccount, useSignMessage, useConnect } from 'wagmi';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/auth/AuthProvider';
import { safeRedirectTarget } from '@/lib/safe-redirect';
import type { Address } from 'viem';
import type { LoginConnector } from '@/lib/siwe-client';

const { Title, Text } = Typography;

/** Chain ID → backend Chain enum + network name（与 siwe-client.ts 的 CHAIN_TO_BACKEND 一致）。 */
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

function LoginContent() {
  const { login, status } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const { address, chainId, isConnected } = useAccount();
  const { connectAsync, connectors, isPending: isConnecting } = useConnect();
  const { signMessageAsync } = useSignMessage();
  const [error, setError] = useState<string | null>(null);

  // Fix 3：?next= 安全校验，非法值 fallback /dashboard
  const next = safeRedirectTarget(params.get('next'));

  /**
   * 构造 LoginConnector，桥接 wagmi → SiweWalletClient。
   *
   * 首次 connect 竞态修复（验收要求）：
   *   - 未连接时：必须 `await connectAsync(...)`，从其返回值 `result.accounts[0]` + `result.chainId`
   *     读取本次连接结果。禁止 connectAsync 后 setTimeout 读 useAccount ref——wagmi 的 useAccount
   *     状态更新有微任务延迟，ref 闭包是渲染快照，会读到旧值（undefined 或错误的 chainId=1）。
   *   - 已连接时：直接使用当前 useAccount 的 address + chainId（连接已稳定）。
   *   - accounts 为空必须明确报错；chainId 不得 undefined 回退 1（否则会误用 mainnet 触发错误的 SIWE 域）。
   */
  function buildConnector(): LoginConnector {
    return {
      connect: async () => {
        if (isConnected) {
          // 已连接：用当前 useAccount 的 address + chainId（连接已稳定，不存在竞态）
          if (!address) throw new Error('Connected wallet address unavailable');
          if (chainId === undefined || chainId === null) {
            throw new Error('Connected wallet chainId unavailable');
          }
          return { address, chainId };
        }
        // 未连接：connectAsync 返回本次连接结果，直接读取，不依赖 useAccount ref
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
      router.replace(next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  }

  return (
    <main style={{ maxWidth: 480, margin: '64px auto', padding: '0 16px' }}>
      <Card>
        <Title level={3}>Wallet Login</Title>

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
          message="Sign in with Ethereum"
          description="Connect your wallet and sign a message to authenticate. No real funds are involved in P0."
          style={{ marginBottom: 16 }}
        />

        <Space style={{ marginTop: 8 }}>
          <Button
            type="primary"
            icon={<WalletOutlined />}
            loading={status === 'authenticating' || isConnecting}
            onClick={handleLogin}
          >
            {isConnected ? 'Sign In' : 'Connect Wallet & Sign'}
          </Button>
        </Space>

        <div style={{ marginTop: 12 }}>
          <Text type="secondary">
            By signing, you agree to authenticate with your wallet. Session is carried by HttpOnly
            cookies; no tokens are stored in localStorage.
          </Text>
        </div>
      </Card>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            minHeight: '60vh',
          }}
        >
          <Spin size="large" tip="Loading login..." />
        </main>
      }
    >
      <LoginContent />
    </Suspense>
  );
}
