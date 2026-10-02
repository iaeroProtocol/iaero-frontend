// src/lib/public-rpcs.ts
//
// RPC endpoints per chain: Alchemy first when a key is configured, then public endpoints that allow
// browser requests, so one rate-limited or failing provider does not break reads. viem's own Ethereum
// default (eth.merkle.io) rate-limits browsers with HTTP 429, and mainnet.base.org 429s a busy page.
// Used by the wallet config (src/lib/wagmi-config.ts) and by the server's balance reads (/api/rift/holdings).

export const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY || '';

export const ALCHEMY_SUBDOMAIN = { 1: 'eth-mainnet', 42161: 'arb-mainnet', 8453: 'base-mainnet' } as const;

export const PUBLIC_RPCS = {
  1: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
  42161: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com'],
  // mainnet.base.org last: it rate-limits a busy page first.
  8453: ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://mainnet.base.org'],
} as const;

export type RpcChainId = keyof typeof PUBLIC_RPCS;

/**
 * Alchemy (when configured) then the public endpoints, in order. The browser key only answers requests from
 * the site's own origin (the Alchemy app has a domain allowlist), so server code passes `server: true` and
 * uses ALCHEMY_SERVER_KEY (a separate key without the allowlist, never sent to browsers) when it is set,
 * else the public endpoints alone.
 */
export const rpcUrls = (chainId: RpcChainId, opts: { server?: boolean } = {}): string[] => {
  const key = opts.server ? process.env.ALCHEMY_SERVER_KEY || '' : ALCHEMY_KEY;
  return [...(key ? [`https://${ALCHEMY_SUBDOMAIN[chainId]}.g.alchemy.com/v2/${key}`] : []), ...PUBLIC_RPCS[chainId]];
};
