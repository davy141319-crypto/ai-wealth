// Mock for wagmi in tests (avoid jsdom / real wallet dependency)
export function useAccount() {
  return { address: undefined, chainId: 1, isConnected: false };
}
export function useConnect() {
  return { connectAsync: async () => {}, connectors: [], isPending: false };
}
export function useSignMessage() {
  return { signMessageAsync: async () => '0x' };
}
