import { http, createConfig } from 'wagmi';
import { mainnet, sepolia } from 'wagmi/chains';

/**
 * Wagmi config.
 *
 * P0 注释保留意图：默认不导入 wagmi/connectors（避免拉入 Coinbase/Base smart-account
 * connector 的 @x402/evm 依赖）；wagmi 的注入式 connector 足以。
 *
 * P1-005：添加 sepolia 测试网络，使登录页可以在测试网签名（不涉及真实资金）。
 * mainnet 保留以便主网地址也能登录（签名消息不消耗 gas）。
 */
export const wagmiConfig = createConfig({
  chains: [mainnet, sepolia],
  transports: {
    [mainnet.id]: http(),
    [sepolia.id]: http(),
  },
  ssr: true,
});
