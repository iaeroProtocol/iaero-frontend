// src/lib/protocol-chain.ts
//
// The wallet config lists Ethereum and Arbitrum as well as Base, only so "Get iAERO" can pay from them, and
// wagmi's chain id follows the wallet onto those chains. The protocol's own contracts exist only on Base
// (and Base Sepolia for testing), so protocol code reads its chain from here: never 1 or 42161.

'use client';

import { useAccount, useChainId } from 'wagmi';
import { arbitrum, base, baseSepolia, mainnet } from 'wagmi/chains';
import { isSupportedNetwork, type SupportedChainId } from '@/components/contracts/addresses';

/** Base, or Base Sepolia when the wallet is on it: the chain protocol addresses are looked up for. */
export function useProtocolChainId(): SupportedChainId {
  const chainId = useChainId();
  return isSupportedNetwork(chainId) ? chainId : base.id;
}

/** Whether a connected wallet sits on a chain the protocol runs on (true while disconnected). */
export function useWalletOnProtocolChain(): boolean {
  const { isConnected, chainId } = useAccount();
  return !isConnected || isSupportedNetwork(chainId);
}

const NAMES: Record<number, string> = {
  [base.id]: 'Base', [baseSepolia.id]: 'Base Sepolia', [mainnet.id]: 'Ethereum', [arbitrum.id]: 'Arbitrum',
};
export const chainName = (id?: number) => (id ? NAMES[id] ?? `chain ${id}` : 'another network');
