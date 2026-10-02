// src/lib/wagmi-config.ts
'use client';

import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { arbitrum, base, baseSepolia, mainnet } from 'wagmi/chains';
import { http } from 'wagmi';

const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';
const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY || '';

// Alchemy when a key is configured; each chain's public RPC otherwise (e.g. a local build without keys).
const rpc = (subdomain: string) => (ALCHEMY_KEY ? http(`https://${subdomain}.g.alchemy.com/v2/${ALCHEMY_KEY}`) : http());

const transports = {
  [base.id]: rpc('base-mainnet'),
  // Ethereum and Arbitrum are only used to pay for "Get iAERO" orders (src/lib/rift).
  [mainnet.id]: rpc('eth-mainnet'),
  [arbitrum.id]: rpc('arb-mainnet'),
  [baseSepolia.id]: rpc('base-sepolia'),
};

export const wagmiConfig = getDefaultConfig({
  appName: 'iAERO Protocol',
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [base, mainnet, arbitrum, baseSepolia],
  transports,
  ssr: false,
});
