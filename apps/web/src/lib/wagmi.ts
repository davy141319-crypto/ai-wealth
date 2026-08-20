import { http, createConfig } from 'wagmi';
import { mainnet } from 'wagmi/chains';

/**
 * Wagmi config. P0 wires the provider/chain setup only — NO real wallet signing.
 * We deliberately do NOT import from `wagmi/connectors` (that barrel pulls the
 * Coinbase/Base smart-account connectors whose transitive `@x402/evm` dep is
 * absent); wagmi's default injected connector is sufficient for the placeholder.
 * Real connection + signing arrive in a later phase on a test network.
 */
export const wagmiConfig = createConfig({
  chains: [mainnet],
  transports: {
    [mainnet.id]: http(),
  },
  ssr: true,
});
