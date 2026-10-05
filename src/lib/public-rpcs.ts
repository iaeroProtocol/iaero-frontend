// src/lib/public-rpcs.ts
//
// RPC endpoints per chain, tried in order so one rate-limited or failing provider does not break reads:
// Alchemy and public endpoints that allow browser requests. viem's own Ethereum default (eth.merkle.io)
// rate-limits browsers with HTTP 429, and mainnet.base.org 429s a busy page.
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

const alchemyUrl = (chainId: RpcChainId, key: string) => `https://${ALCHEMY_SUBDOMAIN[chainId]}.g.alchemy.com/v2/${key}`;

/**
 * The endpoints to try, in order.
 * - Browser: Alchemy first when NEXT_PUBLIC_ALCHEMY_KEY is set (that key only answers the site's own origin:
 *   the Alchemy app has a domain allowlist), then the public endpoints.
 * - Server (`server: true`): the public endpoints first, then ALCHEMY_SERVER_KEY last when it is set (a separate
 *   key without the allowlist, never sent to browsers), so an anonymous route spends its quota only when every
 *   public endpoint fails. Read on each call: the Pages worker exposes its variables through process.env per
 *   request. A URL with a key in it must never be logged or returned (viem errors carry the URL).
 */
export const rpcUrls = (chainId: RpcChainId, opts: { server?: boolean } = {}): string[] => {
  if (!opts.server) return [...(ALCHEMY_KEY ? [alchemyUrl(chainId, ALCHEMY_KEY)] : []), ...PUBLIC_RPCS[chainId]];
  const key = process.env.ALCHEMY_SERVER_KEY || '';
  return [...PUBLIC_RPCS[chainId], ...(key ? [alchemyUrl(chainId, key)] : [])];
};
