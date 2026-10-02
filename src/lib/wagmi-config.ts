// src/lib/wagmi-config.ts
'use client';

import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { arbitrum, base, baseSepolia, mainnet } from 'wagmi/chains';
import { fallback, http } from 'wagmi';

const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';
const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY || '';

const alchemy = (subdomain: string) => http(`https://${subdomain}.g.alchemy.com/v2/${ALCHEMY_KEY}`);

// Alchemy first when a key is configured, then public endpoints that allow browser requests, so one
// rate-limited or failing provider does not break reads (a public RPC alone answers HTTP 429 once the page
// polls a lot; viem's own Ethereum default, eth.merkle.io, rate-limits browsers outright). Alchemy also
// fails over if the key does not have that network enabled. Ethereum and Arbitrum are only used to pay for
// "Get iAERO" orders (src/lib/rift): the live balance, the smart-wallet check and the payment receipt.
const rpc = (subdomain: string, urls: string[]) =>
  fallback([...(ALCHEMY_KEY ? [alchemy(subdomain)] : []), ...urls.map(url => http(url))]);

const transports = {
  [base.id]: rpc('base-mainnet', ['https://mainnet.base.org', 'https://base-rpc.publicnode.com', 'https://base.drpc.org']),
  [mainnet.id]: rpc('eth-mainnet', ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org']),
  [arbitrum.id]: rpc('arb-mainnet', ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com']),
  [baseSepolia.id]: ALCHEMY_KEY ? alchemy('base-sepolia') : http(),
};

export const wagmiConfig = getDefaultConfig({
  appName: 'iAERO Protocol',
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [base, mainnet, arbitrum, baseSepolia],
  transports,
  ssr: false,
});
