// src/lib/rift/config.ts
//
// Where a "Get iAERO" order can start, and where it always ends: iAERO on Base.
// Rift supports Ethereum, Arbitrum, Base, Bitcoin, Hyperliquid (HyperCore spot balances, paid with a signed
// transfer: hypercore.ts), Ink and Robinhood. Ink had no route in testing and Robinhood has no relevant
// tokens, so they are left out. HyperEVM tokens have no Rift route (2026-10-02).

import type { SourceChainKey, SourceToken } from './types';
import { HYPERCORE_TOKENS, spotSendToken } from './hypercore';

export const IAERO_ADDRESS = '0x81034Fb34009115F215f5d5F564AAc9FfA46a1Dc' as const;
export const IAERO_DECIMALS = 18;
/** Every quote and order is pinned to this destination (the API proxy enforces it too). */
export const RIFT_DESTINATION = `base.${IAERO_ADDRESS.toLowerCase()}`;
export const RIFT_INTEGRATOR_ID = 'iaero';
export const RIFT_DOCS_URL = 'https://www.rift.trade/docs';
export const RIFT_SECURITY_URL = 'https://www.rift.trade/docs/security-model';

export interface SourceChainConfig {
  key: SourceChainKey;
  name: string;
  kind: 'evm' | 'bitcoin' | 'hypercore';
  chainId?: number;
  nativeSymbol: string;
  nativeDecimals: number;
  nativeAsset: string;
  /** Kept back from a native "Max" for the payment's own gas. */
  gasReserve?: string;
  txUrl: (hash: string) => string;
  addressUrl: (address: string) => string;
}

export const SOURCE_CHAINS: Record<SourceChainKey, SourceChainConfig> = {
  ethereum: {
    key: 'ethereum', name: 'Ethereum', kind: 'evm', chainId: 1, nativeSymbol: 'ETH', nativeDecimals: 18,
    nativeAsset: 'ethereum.eth', gasReserve: '0.003',
    txUrl: h => `https://etherscan.io/tx/${h}`, addressUrl: a => `https://etherscan.io/address/${a}`,
  },
  arbitrum: {
    key: 'arbitrum', name: 'Arbitrum', kind: 'evm', chainId: 42161, nativeSymbol: 'ETH', nativeDecimals: 18,
    nativeAsset: 'arbitrum.eth', gasReserve: '0.0003',
    txUrl: h => `https://arbiscan.io/tx/${h}`, addressUrl: a => `https://arbiscan.io/address/${a}`,
  },
  base: {
    key: 'base', name: 'Base', kind: 'evm', chainId: 8453, nativeSymbol: 'ETH', nativeDecimals: 18,
    nativeAsset: 'base.eth', gasReserve: '0.0001',
    txUrl: h => `https://basescan.org/tx/${h}`, addressUrl: a => `https://basescan.org/address/${a}`,
  },
  bitcoin: {
    key: 'bitcoin', name: 'Bitcoin', kind: 'bitcoin', nativeSymbol: 'BTC', nativeDecimals: 8,
    nativeAsset: 'bitcoin.btc',
    txUrl: h => `https://mempool.space/tx/${h}`, addressUrl: a => `https://mempool.space/address/${a}`,
  },
  hyperliquid: {
    key: 'hyperliquid', name: 'Hyperliquid', kind: 'hypercore', nativeSymbol: 'HYPE', nativeDecimals: 8,
    nativeAsset: 'hyperliquid.hype',
    txUrl: h => `https://app.hyperliquid.xyz/explorer/tx/${h}`, addressUrl: a => `https://app.hyperliquid.xyz/explorer/address/${a}`,
  },
};

export const BASESCAN_TX = (hash: string) => `https://basescan.org/tx/${hash}`;

const erc20 = (chain: SourceChainKey, symbol: string, name: string, decimals: number, address: `0x${string}`): SourceToken =>
  ({ chain, symbol, name, decimals, address, asset: `${chain}.${address.toLowerCase()}` });
const native = (chain: SourceChainKey): SourceToken => {
  const c = SOURCE_CHAINS[chain];
  return { chain, symbol: c.nativeSymbol, name: chain === 'bitcoin' ? 'Bitcoin' : 'Ether', decimals: c.nativeDecimals, asset: c.nativeAsset };
};

/** Tokens Rift is known to route, taken as supported without a check (support.ts); other holdings are checked. */
export const CURATED_TOKENS: SourceToken[] = [
  native('ethereum'),
  erc20('ethereum', 'USDC', 'USD Coin', 6, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  erc20('ethereum', 'USDT', 'Tether USD', 6, '0xdAC17F958D2ee523a2206206994597C13D831ec7'),
  erc20('ethereum', 'WETH', 'Wrapped Ether', 18, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
  erc20('ethereum', 'WBTC', 'Wrapped BTC', 8, '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'),
  erc20('ethereum', 'DAI', 'Dai', 18, '0x6B175474E89094C44Da98b954EedeAC495271d0F'),
  native('arbitrum'),
  erc20('arbitrum', 'USDC', 'USD Coin', 6, '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
  erc20('arbitrum', 'USDT', 'Tether USD', 6, '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'),
  erc20('arbitrum', 'WETH', 'Wrapped Ether', 18, '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'),
  erc20('arbitrum', 'ARB', 'Arbitrum', 18, '0x912CE59144191C1204E64559FE8253a0e49E6548'),
  erc20('arbitrum', 'WBTC', 'Wrapped BTC', 8, '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f'),
  native('base'),
  erc20('base', 'USDC', 'USD Coin', 6, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
  erc20('base', 'WETH', 'Wrapped Ether', 18, '0x4200000000000000000000000000000000000006'),
  erc20('base', 'AERO', 'Aerodrome', 18, '0x940181a94A35A4569E4529A3CDfB74e38FD98631'),
  erc20('base', 'cbBTC', 'Coinbase Wrapped BTC', 8, '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'),
  erc20('base', 'DAI', 'Dai', 18, '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'),
  native('bitcoin'),
  ...HYPERCORE_TOKENS.map((t): SourceToken => ({
    chain: 'hyperliquid', symbol: t.symbol, name: t.name, decimals: t.decimals, asset: t.asset, hlToken: spotSendToken(t),
  })),
];

/** Display names for the assets that appear in Rift routes. */
export const KNOWN_SYMBOLS: Record<string, string> = {
  [RIFT_DESTINATION]: 'iAERO',
  ...Object.fromEntries(CURATED_TOKENS.map(t => [t.asset, t.symbol])),
};
