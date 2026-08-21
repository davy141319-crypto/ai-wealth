import { http, createConfig } from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';

/**
 * Wagmi config for Admin (Vite SPA, CSR-only, ssr:false).
 * mainnet + sepolia chains; http transports.
 */
export const wagmiConfig = createConfig({
  chains: [mainnet, sepolia],
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
  ssr: false,
});
