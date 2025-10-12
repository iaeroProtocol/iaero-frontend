// src/lib/wagmi-config.ts
'use client';

import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { base, baseSepolia } from 'wagmi/chains';
import { http } from 'wagmi';

const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';
const ALCHEMY_KEY = process.env.NEXT_PUBLIC_ALCHEMY_KEY || '';

// Create custom transports using Alchemy
const transports = {
  [base.id]: http(`https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`),
  [baseSepolia.id]: http(`https://base-sepolia.g.alchemy.com/v2/${ALCHEMY_KEY}`),
};

export const wagmiConfig = getDefaultConfig({
  appName: 'iAERO Protocol',
  projectId: WALLETCONNECT_PROJECT_ID,
  chains: [base, baseSepolia],
  transports, // ✅ Add this to use Alchemy instead of public RPC
  ssr: false,
});