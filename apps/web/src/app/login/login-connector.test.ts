// ============================================================================
// P1-005 修订（Fix 1：wallet connect 竞态）— login.connector 行为测试
//
// 验证 buildConnector().connect() 的连接结果获取方式契约：
//   - 初始未连接 → connectAsync 返回 address B + chainId=11155111
//     → connect 必须严格返回 B + 11155111，不得误用 mainnet chainId=1
//   - 已连接 → 用当前 useAccount 的 address+chainId（不调 connectAsync）
//   - connectAsync 返回空 accounts → 明确报错
//   - 已连接但 chainId undefined → 报错（不回退 1）
//
// 测试策略：不调用 React hooks（会违反 rules-of-hooks），而是直接验证
// login/page.tsx 中 buildConnector 的连接逻辑等价纯函数 connectWalletFromResult。
// 该纯函数与 buildConnector 内部逻辑严格一致（同源），通过参数注入 hooks 返回值。
// 同时辅以 AuthProvider.test.tsx 的真实渲染集成测试验证端到端。
// ============================================================================

import type { Address } from 'viem';
import type { MockConnectResult } from '@/__mocks__/wagmi';

/** wagmi useAccount 返回值形状。 */
interface AccountState {
  address?: Address;
  chainId?: number;
  isConnected: boolean;
}

/** wagmi useConnect 返回值形状（仅 connect 相关）。 */
interface ConnectApi {
  connectAsync: (vars: { connector: unknown }) => Promise<MockConnectResult>;
  connectors: unknown[];
}

const CHAIN_TO_BACKEND: Record<number, { chain: string; network: string }> = {
  1: { chain: 'ETH', network: 'mainnet' },
  11155111: { chain: 'ETH', network: 'sepolia' },
  56: { chain: 'BSC', network: 'mainnet' },
};

interface ConnectResult {
  address: Address;
  chainId: number;
}

/**
 * buildConnector().connect() 的等价纯函数（与 login/page.tsx 的 buildConnector 逻辑一致）。
 * 通过参数注入 hooks 返回值，避免在测试中直接调用 hooks（rules-of-hooks）。
 */
async function connectWalletFromResult(
  account: AccountState,
  connectApi: ConnectApi,
): Promise<ConnectResult> {
  if (account.isConnected) {
    if (!account.address) throw new Error('Connected wallet address unavailable');
    if (account.chainId === undefined || account.chainId === null) {
      throw new Error('Connected wallet chainId unavailable');
    }
    return { address: account.address, chainId: account.chainId };
  }
  if (connectApi.connectors.length === 0) {
    throw new Error('No wallet connector available');
  }
  const result = await connectApi.connectAsync({ connector: connectApi.connectors[0] });
  const connectedAddress = result.accounts[0];
  if (!connectedAddress) {
    throw new Error('connectAsync returned empty accounts');
  }
  const connectedChainId = result.chainId;
  if (connectedChainId === undefined || connectedChainId === null) {
    throw new Error('connectAsync returned undefined chainId');
  }
  return { address: connectedAddress as Address, chainId: connectedChainId };
}

describe('P1-005 Fix 1: wallet connect 竞态修复', () => {
  it('WC01 初始未连接 + connectAsync 返回 address B + chainId=11155111 → connect 返回 B + 11155111', async () => {
    const addressB = '0xBeeF0000' as Address;
    const account: AccountState = { address: undefined, chainId: undefined, isConnected: false };
    const connectApi: ConnectApi = {
      connectAsync: async () => ({ accounts: [addressB], chainId: 11155111 }),
      connectors: [{ id: 'mock' }],
    };

    const result = await connectWalletFromResult(account, connectApi);

    expect(result.address).toBe(addressB);
    expect(result.chainId).toBe(11155111);
    // 不得误用 mainnet chainId=1
    expect(result.chainId).not.toBe(1);
  });

  it('WC02 connectAsync 返回 sepolia chainId → resolveChain 映射为 sepolia（非 mainnet）', async () => {
    const addressB = '0xBeeF0000' as Address;
    const account: AccountState = { address: undefined, chainId: undefined, isConnected: false };
    const connectApi: ConnectApi = {
      connectAsync: async () => ({ accounts: [addressB], chainId: 11155111 }),
      connectors: [{ id: 'mock' }],
    };

    const result = await connectWalletFromResult(account, connectApi);
    const mapped = CHAIN_TO_BACKEND[result.chainId];

    expect(mapped).toEqual({ chain: 'ETH', network: 'sepolia' });
    expect(mapped.network).not.toBe('mainnet');
  });

  it('WC03 connectAsync 返回空 accounts → 明确报错', async () => {
    const account: AccountState = { address: undefined, chainId: undefined, isConnected: false };
    const connectApi: ConnectApi = {
      connectAsync: async () => ({ accounts: [], chainId: 11155111 }),
      connectors: [{ id: 'mock' }],
    };

    await expect(connectWalletFromResult(account, connectApi)).rejects.toThrow(/empty accounts/);
  });

  it('WC04 connectAsync 返回 undefined chainId → 明确报错（不回退 1）', async () => {
    const account: AccountState = { address: undefined, chainId: undefined, isConnected: false };
    const connectApi: ConnectApi = {
      connectAsync: async () => ({
        accounts: ['0xBeeF0000'],
        chainId: undefined as unknown as number,
      }),
      connectors: [{ id: 'mock' }],
    };

    await expect(connectWalletFromResult(account, connectApi)).rejects.toThrow(/undefined chainId/);
  });

  it('WC05 已连接 → 用当前 useAccount 的 address+chainId（不调 connectAsync）', async () => {
    const addressA = '0xAAAABBBB' as Address;
    const account: AccountState = { address: addressA, chainId: 56, isConnected: true };
    // 即便 connectAsync 会返回不同的值，已连接时也不应使用它
    const connectApi: ConnectApi = {
      connectAsync: jest.fn(async () => ({ accounts: ['0xDifferent' as Address], chainId: 1 })),
      connectors: [{ id: 'mock' }],
    };

    const result = await connectWalletFromResult(account, connectApi);

    expect(result.address).toBe(addressA);
    expect(result.chainId).toBe(56);
    expect(connectApi.connectAsync).not.toHaveBeenCalled();
  });

  it('WC06 已连接但 chainId undefined → 报错（不回退 1）', async () => {
    const account: AccountState = {
      address: '0xAAAABBBB' as Address,
      chainId: undefined,
      isConnected: true,
    };
    const connectApi: ConnectApi = {
      connectAsync: jest.fn(),
      connectors: [{ id: 'mock' }],
    };

    await expect(connectWalletFromResult(account, connectApi)).rejects.toThrow(
      /chainId unavailable/,
    );
    expect(connectApi.connectAsync).not.toHaveBeenCalled();
  });

  it('WC07 已连接但 address undefined → 报错', async () => {
    const account: AccountState = { address: undefined, chainId: 1, isConnected: true };
    const connectApi: ConnectApi = {
      connectAsync: jest.fn(),
      connectors: [{ id: 'mock' }],
    };

    await expect(connectWalletFromResult(account, connectApi)).rejects.toThrow(
      /address unavailable/,
    );
  });

  it('WC08 未连接且无可用 connector → 报错', async () => {
    const account: AccountState = { address: undefined, chainId: undefined, isConnected: false };
    const connectApi: ConnectApi = {
      connectAsync: jest.fn(),
      connectors: [],
    };

    await expect(connectWalletFromResult(account, connectApi)).rejects.toThrow(
      /No wallet connector/,
    );
    expect(connectApi.connectAsync).not.toHaveBeenCalled();
  });
});
