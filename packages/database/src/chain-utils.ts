// ============================================================================
// ChainUtils — numeric chainId mapping + helpers for EIP-4361 / SIWE support.
//
// P1-002 wallet auth scope: EV chains only. TRON does not follow the EIP-191
// personal_sign semantics required by SIWE A-BNF, so it is intentionally
// UNSUPPORTED_SENTINEL (-1). Callers should translate UNSUPPORTED into a
// 400 / AuthFailReason.CHAIN_UNSUPPORTED response and log it.
// ============================================================================

import type { Chain } from '@prisma/client';

/** Returned when a Chain has no SIWE-compatible chainId. */
export const UNSUPPORTED_CHAIN_ID = -1;

const CHAIN_ID_BY_CHAIN: Record<Chain, number> = {
  ETH: 1,
  BSC: 56,
  POLYGON: 137,
  ARBITRUM: 42161,
  // TRON SIWE is not supported in P1-002. Using -1 sentinel lets callers
  // distinguish "unset" from "not yet mapped".
  TRON: UNSUPPORTED_CHAIN_ID,
};

export const EV_CHAINS_SUPPORTED: Chain[] = ['ETH', 'BSC', 'POLYGON', 'ARBITRUM'];

export class ChainUtils {
  /** Map a Chain enum value to its canonical L1/L2 numeric chain id. */
  static chainToChainId(chain: Chain): number {
    return CHAIN_ID_BY_CHAIN[chain] ?? UNSUPPORTED_CHAIN_ID;
  }

  /** Reverse map a numeric chainId to its Chain enum. Returns null on miss. */
  static chainIdToChain(chainId: number): Chain | null {
    for (const entry of Object.entries(CHAIN_ID_BY_CHAIN) as [Chain, number][]) {
      if (entry[1] === chainId) return entry[0];
    }
    return null;
  }

  /** True if the given chain is supported for SIWE personal_sign flows. */
  static isSupportedForSiwe(chain: Chain): boolean {
    return CHAIN_ID_BY_CHAIN[chain] !== UNSUPPORTED_CHAIN_ID;
  }

  /** Returns true if address looks like an EVM 0x address (length + hex). */
  static isEvmAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }
}
