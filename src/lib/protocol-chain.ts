// src/lib/protocol-chain.ts
//
// The wallet config lists Ethereum and Arbitrum as well as Base, only so "Get iAERO" can pay from them, and
// wagmi's chain id follows the wallet onto those chains. The protocol's own contracts exist only on Base
// (and Base Sepolia for testing), so protocol code reads its chain from here: never 1 or 42161.
//
// The wallet's real chain comes from useAccount(). useChainId() is not it: on a chain the config doesn't list
// (e.g. Optimism) it stays on the last configured one, so it can say "Base" while the wallet is elsewhere.

'use client';

import { useCallback } from 'react';
import { BaseError, ChainMismatchError } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { isSupportedNetwork, type SupportedChainId } from '@/components/contracts/addresses';

/** Base, or Base Sepolia when the wallet is on it: the chain protocol addresses are looked up and read on. */
export function useProtocolChainId(): SupportedChainId {
  const { chainId } = useAccount();
  return isSupportedNetwork(chainId) ? chainId : base.id;
}

/** Whether a connected wallet sits on a chain the protocol runs on (true while disconnected). */
export function useWalletOnProtocolChain(): boolean {
  const { isConnected, chainId } = useAccount();
  return !isConnected || isSupportedNetwork(chainId);
}

/** A public client on the protocol chain: protocol reads and receipts never follow the wallet elsewhere. */
export function useProtocolPublicClient() {
  return usePublicClient({ chainId: useProtocolChainId() });
}

/**
 * useWriteContract for protocol contracts: every write carries the protocol chain id, so with the wallet on another
 * chain viem refuses it before the wallet is asked, instead of sending it to the protocol address on that chain
 * (no contract there, so it would "succeed").
 */
export function useProtocolWriteContract() {
  const chainId = useProtocolChainId();
  const { writeContractAsync: write, ...rest } = useWriteContract();
  const writeContractAsync = useCallback(
    (async (args: any, options?: any) => {
      try {
        return await write({ ...args, chainId }, options);
      } catch (e) {
        if (e instanceof BaseError && e.walk(x => x instanceof ChainMismatchError)) throw new WalletOffProtocolChainError(chainId);
        throw e;
      }
    }) as typeof write,
    [write, chainId],
  );
  return { ...rest, writeContractAsync };
}

/** A protocol write refused because the wallet is on another chain: nothing was sent. */
export class WalletOffProtocolChainError extends Error {
  shortMessage: string;
  constructor(chainId: number) {
    const name = chainName(chainId) ?? 'Base';
    super(`Your wallet is not on ${name}, so nothing was sent. Switch it to ${name} and try again.`);
    this.name = 'WalletOffProtocolChainError';
    this.shortMessage = this.message;
  }
}

const NAMES: Record<number, string> = {
  1: 'Ethereum', 10: 'Optimism', 25: 'Cronos', 56: 'BNB Chain', 100: 'Gnosis', 130: 'Unichain', 137: 'Polygon',
  146: 'Sonic', 250: 'Fantom', 324: 'zkSync', 480: 'World Chain', 999: 'HyperEVM', 1101: 'Polygon zkEVM',
  1868: 'Soneium', 2741: 'Abstract', 5000: 'Mantle', 8453: 'Base', 34443: 'Mode', 42161: 'Arbitrum',
  42170: 'Arbitrum Nova', 42220: 'Celo', 43114: 'Avalanche', 57073: 'Ink', 59144: 'Linea', 80094: 'Berachain',
  81457: 'Blast', 84532: 'Base Sepolia', 534352: 'Scroll', 7777777: 'Zora', 11155111: 'Sepolia',
};
/** A chain's name ("Ethereum", "Arbitrum"…), or undefined for one we don't name. */
export const chainName = (id?: number): string | undefined => (id ? NAMES[id] : undefined);
