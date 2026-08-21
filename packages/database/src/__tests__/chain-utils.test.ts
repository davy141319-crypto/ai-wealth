import { ChainUtils, UNSUPPORTED_CHAIN_ID, EV_CHAINS_SUPPORTED } from '../chain-utils';

describe('ChainUtils', () => {
  it('chainToChainId maps EV chains correctly', () => {
    expect(ChainUtils.chainToChainId('ETH')).toBe(1);
    expect(ChainUtils.chainToChainId('BSC')).toBe(56);
    expect(ChainUtils.chainToChainId('POLYGON')).toBe(137);
    expect(ChainUtils.chainToChainId('ARBITRUM')).toBe(42161);
  });

  it('chainToChainId returns UNSUPPORTED sentinel for TRON (P1-002)', () => {
    expect(ChainUtils.chainToChainId('TRON')).toBe(UNSUPPORTED_CHAIN_ID);
    expect(ChainUtils.isSupportedForSiwe('TRON')).toBe(false);
  });

  it('supported list covers 4 EV chains', () => {
    expect(EV_CHAINS_SUPPORTED.sort()).toEqual(['ETH', 'BSC', 'POLYGON', 'ARBITRUM'].sort());
    for (const ch of EV_CHAINS_SUPPORTED) {
      expect(ChainUtils.isSupportedForSiwe(ch)).toBe(true);
    }
  });

  it('chainIdToChain reverse maps', () => {
    expect(ChainUtils.chainIdToChain(1)).toBe('ETH');
    expect(ChainUtils.chainIdToChain(56)).toBe('BSC');
    expect(ChainUtils.chainIdToChain(137)).toBe('POLYGON');
    expect(ChainUtils.chainIdToChain(42161)).toBe('ARBITRUM');
    expect(ChainUtils.chainIdToChain(9999)).toBeNull();
  });

  it('isEvmAddress', () => {
    expect(ChainUtils.isEvmAddress('0x'.padEnd(42, 'f'))).toBe(true);
    expect(ChainUtils.isEvmAddress('0x')).toBe(false);
    expect(ChainUtils.isEvmAddress('TQ57q…')).toBe(false);
    expect(ChainUtils.isEvmAddress('0xA0Cf798816D4b9b9866b5330EEa46a18382f251e')).toBe(true);
  });
});
