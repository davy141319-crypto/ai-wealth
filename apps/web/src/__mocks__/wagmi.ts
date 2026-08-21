// Mock for wagmi in tests (avoid jsdom / real wallet dependency).
//
// P1-005 修订（connect 竞态测试）：connectAsync 返回 { accounts, chainId }，
// 与 wagmi ConnectReturnType 一致。测试通过 __setConnectResult 注入不同场景。
export interface MockConnectResult {
  accounts: `0x${string}`[];
  chainId: number;
}

let mockConnectResult: MockConnectResult = {
  accounts: ['0xfeedfeed'],
  chainId: 11155111,
};

let mockAccountState: { address?: `0x${string}`; chainId?: number; isConnected: boolean } = {
  address: undefined,
  chainId: undefined,
  isConnected: false,
};

/** 测试用：设置 connectAsync 的返回值。 */
export function __setConnectResult(result: MockConnectResult): void {
  mockConnectResult = result;
}

/** 测试用：设置 useAccount 的当前状态（模拟已连接/未连接）。 */
export function __setAccountState(state: {
  address?: `0x${string}`;
  chainId?: number;
  isConnected: boolean;
}): void {
  mockAccountState = state;
}

/** 测试用：重置所有 mock 状态到默认（未连接）。 */
export function __resetWagmiMock(): void {
  mockConnectResult = { accounts: ['0xfeedfeed'], chainId: 11155111 };
  mockAccountState = { address: undefined, chainId: undefined, isConnected: false };
}

export function useAccount() {
  return {
    address: mockAccountState.address,
    chainId: mockAccountState.chainId,
    isConnected: mockAccountState.isConnected,
  };
}

export function useConnect() {
  return {
    connectAsync: async () => ({ ...mockConnectResult }),
    connectors: [{ id: 'mock', name: 'Mock Wallet' }],
    isPending: false,
  };
}

export function useSignMessage() {
  return { signMessageAsync: async () => '0xdeadbeef' as `0x${string}` };
}
