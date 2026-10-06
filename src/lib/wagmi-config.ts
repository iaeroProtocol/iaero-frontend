// src/lib/wagmi-config.ts
'use client';

import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { arbitrum, base, baseSepolia, mainnet } from 'wagmi/chains';
import { fallback, http } from 'wagmi';
import { ALCHEMY_KEY, rpcUrls, type RpcChainId } from './public-rpcs';

const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';

// Alchemy first when a key is configured, then public endpoints (public-rpcs.ts). Ethereum and Arbitrum are
// only used to pay for "Get iAERO" orders (src/lib/rift): the live balance, the smart-wallet check, the
// payment receipt and switching chains to sign a Hyperliquid transfer.
const rpc = (chainId: RpcChainId) => fallback(rpcUrls(chainId).map(url => http(url)));

const transports = {
  [base.id]: rpc(base.id),
  [mainnet.id]: rpc(mainnet.id),
  [arbitrum.id]: rpc(arbitrum.id),
  [baseSepolia.id]: ALCHEMY_KEY ? http(`https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`) : http(),
};

export const wagmiConfig = getDefaultConfig({
  appName: 'iAERO Protocol',
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [base, mainnet, arbitrum, baseSepolia],
  transports,
  ssr: false,
});
