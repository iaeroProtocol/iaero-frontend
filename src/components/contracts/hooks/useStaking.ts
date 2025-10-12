// src/contracts/hooks/useStaking.ts
import { useState, useCallback } from 'react';
import { useAccount, useChainId, useWriteContract, useWaitForTransactionReceipt, usePublicClient } from 'wagmi';
import type { Hash } from 'viem';
import { getContractAddress } from '../addresses';
import { ABIS } from '../abis';
import { useProtocol } from '../../contexts/ProtocolContext';

const DEFAULT_STAKING_APR = Number(process.env.NEXT_PUBLIC_DEFAULT_STAKING_APR ?? '30');

// Types
interface StakingAPR {
  aero: number;
  total: number;
}

interface StakingStats {
  totalStaked: string;
  rewardTokensCount: number;
}

interface PendingReward {
  token: string;
  amount: string;
  symbol?: string;
  decimals?: number;
}

export type SuccessCallback = (receipt: any) => void;
export type ErrorCallback = (error: any) => void;
export type ProgressCallback = (message: string) => void;

// Helper to check user rejection
const isUserRejection = (error: any): boolean =>
  error?.name === 'UserRejectedRequestError' ||
  error?.message?.toLowerCase?.().includes('user rejected') ||
  error?.message?.toLowerCase?.().includes('user denied');

// Helper to format ether
const safeFormatEther = (value: bigint | undefined): string => {
  if (!value) return '0';
  return (Number(value) / 1e18).toString();
};

// Helper to parse ether
const parseEther = (value: string): bigint => {
  try {
    return BigInt(Math.floor(parseFloat(value) * 1e18));
  } catch {
    return 0n;
  }
};

// Load claim tokens from JSON
async function loadClaimTokensFromJson(
  url = "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/reward_tokens.json"
): Promise<string[]> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    const currentEpoch = Math.floor(Date.now() / 1000 / 604800) * 604800;
    const previousEpoch = currentEpoch - 604800;
    
    const tokens = new Set<string>();
    
    if (data.epochs?.[currentEpoch]?.tokens) {
      data.epochs[currentEpoch].tokens.forEach((t: string) => tokens.add(t.toLowerCase()));
    }
    if (data.epochs?.[previousEpoch]?.tokens) {
      data.epochs[previousEpoch].tokens.forEach((t: string) => tokens.add(t.toLowerCase()));
    }
    
    return Array.from(tokens).filter((t) => /^0x[0-9a-f]{40}$/.test(t));
  } catch (e) {
    console.warn("[loadClaimTokensFromJson] failed:", e);
    return [];
  }
}

// Chunk array into groups of 50
function chunk50<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += 50) {
    out.push(arr.slice(i, i + 50));
  }
  return out;
}

export const useStaking = () => {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { loadBalances, loadAllowances, loadPendingRewards, setTransactionLoading } = useProtocol();
  
  const [loading, setLoading] = useState(false);
  
  // Wagmi write hook
  const { writeContractAsync } = useWriteContract();

  // Helper to get contract address safely
  const getAddr = useCallback((name: any) => {
    try {
      return getContractAddress(name, chainId);
    } catch {
      return undefined;
    }
  }, [chainId]);

  // Check approval
  const checkIAeroApproval = useCallback(async (amount: string): Promise<boolean> => {
    if (!address || !publicClient) return false;
    
    try {
      const stakingAddr = getAddr('StakingDistributor');
      if (!stakingAddr) return false;

      const allowance = await publicClient.readContract({
        address: getAddr('iAERO')!,
        abi: ABIS.iAERO,
        functionName: 'allowance',
        args: [address, stakingAddr],
      });

      return (allowance as bigint) >= parseEther(amount);
    } catch (e) {
      console.error('checkIAeroApproval error', e);
      return false;
    }
  }, [address, publicClient, getAddr]);

  // Approve iAERO
  const approveIAero = useCallback(async (
    amount: string,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback
  ): Promise<any> => {
    const txId = 'approveIAero';
    setTransactionLoading(txId, true);
    
    try {
      const stakingAddr = getAddr('StakingDistributor');
      if (!stakingAddr) throw new Error('Staking contract not found');

      // Check if already approved
      const isApproved = await checkIAeroApproval(amount);
      if (isApproved) {
        await loadAllowances();
        return undefined;
      }

      // Write approval transaction
      const hash = await writeContractAsync({
        address: getAddr('iAERO')!,
        abi: ABIS.iAERO,
        functionName: 'approve',
        args: [stakingAddr, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')], // MaxUint256
      });

      // Wait for transaction
      const receipt = await publicClient?.waitForTransactionReceipt({ hash });
      
      await loadAllowances();
      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) {
        console.error('approveIAero failed:', error);
      }
      onError?.(error);
      if (!isUserRejection(error)) throw error;
      return undefined;
    } finally {
      setTransactionLoading(txId, false);
    }
  }, [address, publicClient, writeContractAsync, getAddr, checkIAeroApproval, loadAllowances, setTransactionLoading]);

  // Stake iAERO
  const stakeIAero = useCallback(async (
    amount: string,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ) => {
    setLoading(true);
    const txId = 'stakeIAero';
    setTransactionLoading(txId, true);
    
    try {
      const amountWei = parseEther(amount);
      const stakingAddr = getAddr('StakingDistributor');
      if (!stakingAddr) throw new Error('Staking contract not initialized');

      // Check approval
      onProgress?.('Checking allowance...');
      const isApproved = await checkIAeroApproval(amount);
      
      if (!isApproved) {
        onProgress?.('Approving iAERO spending...');
        await approveIAero(amount);
      }

      // Stake transaction
      onProgress?.('Staking iAERO...');
      const hash = await writeContractAsync({
        address: stakingAddr,
        abi: ABIS.StakingDistributor,
        functionName: 'stake',
        args: [amountWei],
      });

      // Wait for confirmation
      const receipt = await publicClient?.waitForTransactionReceipt({ hash });

      onProgress?.('Updating balances...');
      await Promise.all([
        loadBalances(),
        loadAllowances(),
        loadPendingRewards?.()
      ].filter(Boolean));

      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) {
        console.error('stakeIAero failed:', error);
      }
      onError?.(error);
      if (!isUserRejection(error)) throw error;
      return undefined;
    } finally {
      setLoading(false);
      setTransactionLoading(txId, false);
    }
  }, [
    publicClient,
    writeContractAsync,
    getAddr,
    checkIAeroApproval,
    approveIAero,
    loadBalances,
    loadAllowances,
    loadPendingRewards,
    setTransactionLoading
  ]);

  // Unstake iAERO
  const unstakeIAero = useCallback(async (
    amount: string,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ) => {
    setLoading(true);
    const txId = 'unstakeIAero';
    setTransactionLoading(txId, true);
    
    try {
      const amountWei = parseEther(amount);
      const stakingAddr = getAddr('StakingDistributor');
      if (!stakingAddr) throw new Error('Staking contract not initialized');

      onProgress?.('Unstaking iAERO...');
      const hash = await writeContractAsync({
        address: stakingAddr,
        abi: ABIS.StakingDistributor,
        functionName: 'unstake',
        args: [amountWei],
      });

      const receipt = await publicClient?.waitForTransactionReceipt({ hash });

      onProgress?.('Updating balances...');
      await Promise.all([
        loadBalances(),
        loadAllowances(),
        loadPendingRewards?.()
      ].filter(Boolean));

      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) {
        console.error('unstakeIAero failed:', error);
      }
      onError?.(error);
      if (!isUserRejection(error)) throw error;
      return undefined;
    } finally {
      setLoading(false);
      setTransactionLoading(txId, false);
    }
  }, [
    publicClient,
    writeContractAsync,
    getAddr,
    loadBalances,
    loadAllowances,
    loadPendingRewards,
    setTransactionLoading
  ]);

  // Claim all rewards
  const claimAllRewards = useCallback(async (
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback,
    tokenFileUrl = "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/reward_tokens.json"
  ) => {
    setLoading(true);
    const txId = 'claimAllRewards';
    setTransactionLoading(txId, true);
    
    try {
      const stakingAddr = getAddr('StakingDistributor');
      if (!stakingAddr || !address) throw new Error('Not initialized');

      onProgress?.('Loading token list…');
      const tokens = await loadClaimTokensFromJson(tokenFileUrl);
      if (!tokens.length) {
        onError?.(new Error('No tokens found in token file.'));
        return undefined;
      }

      onProgress?.('Prefiltering claimable tokens…');
      
      // Get current epoch
      const currentEpoch = await publicClient?.readContract({
        address: stakingAddr,
        abi: ABIS.StakingDistributor,
        functionName: 'currentEpoch',
      }) as bigint;

      const WEEK = 7n * 24n * 60n * 60n;
      const prevEpoch = currentEpoch - WEEK;

      // Filter claimable tokens
      const claimables: string[] = [];
      for (const token of tokens) {
        const [aNow, aPrev] = await Promise.all([
          publicClient?.readContract({
            address: stakingAddr,
            abi: ABIS.StakingDistributor,
            functionName: 'previewClaim',
            args: [address, token, currentEpoch],
          }).catch(() => 0n),
          publicClient?.readContract({
            address: stakingAddr,
            abi: ABIS.StakingDistributor,
            functionName: 'previewClaim',
            args: [address, token, prevEpoch],
          }).catch(() => 0n),
        ]);
        
        if ((aNow as bigint ?? 0n) + (aPrev as bigint ?? 0n) > 0n) {
          claimables.push(token);
        }
      }

      if (!claimables.length) {
        onError?.(new Error('No claimable rewards for your account right now.'));
        return undefined;
      }

      // Claim in batches
      const batches = chunk50(claimables);
      let lastReceipt: any;

      onProgress?.(`Claiming ${claimables.length} tokens in ${batches.length} batch(es)…`);
      
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        
        try {
          const hash = await writeContractAsync({
            address: stakingAddr,
            abi: ABIS.StakingDistributor,
            functionName: 'claimLatest',
            args: [batch],
            gas: 1_000_000n,
          });
          
          lastReceipt = await publicClient?.waitForTransactionReceipt({ hash });
        } catch (e) {
          console.warn(`Batch ${i + 1} failed, trying per-token:`, e);
          
          // Fallback: claim individually
          for (const token of batch) {
            try {
              const hash = await writeContractAsync({
                address: stakingAddr,
                abi: ABIS.StakingDistributor,
                functionName: 'claimLatest',
                args: [[token]],
                gas: 400_000n,
              });
              
              lastReceipt = await publicClient?.waitForTransactionReceipt({ hash });
            } catch (err) {
              console.warn(`Token ${token} failed, skipping`, err);
            }
          }
        }
      }

      onProgress?.('Updating balances…');
      await Promise.all([loadBalances(), loadPendingRewards?.()].filter(Boolean));

      if (!lastReceipt) {
        onError?.(new Error('No claims succeeded.'));
        return undefined;
      }
      
      onSuccess?.(lastReceipt);
      return lastReceipt;
    } catch (error: any) {
      console.error('claimAllRewards failed:', error);
      onError?.(error);
      return undefined;
    } finally {
      setLoading(false);
      setTransactionLoading(txId, false);
    }
  }, [
    address,
    publicClient,
    writeContractAsync,
    getAddr,
    loadBalances,
    loadPendingRewards,
    setTransactionLoading
  ]);

  // Claim single reward
  const claimReward = useCallback(async (
    tokenAddress: string,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ) => {
    setLoading(true);
    const txId = 'claimReward';
    setTransactionLoading(txId, true);
    
    try {
      const stakingAddr = getAddr('StakingDistributor');
      if (!stakingAddr) throw new Error('Staking contract not initialized');

      onProgress?.('Claiming reward…');
      
      const epoch = await publicClient?.readContract({
        address: stakingAddr,
        abi: ABIS.StakingDistributor,
        functionName: 'currentEpoch',
      }) as bigint;

      const hash = await writeContractAsync({
        address: stakingAddr,
        abi: ABIS.StakingDistributor,
        functionName: 'claim',
        args: [tokenAddress, epoch],
      });

      const receipt = await publicClient?.waitForTransactionReceipt({ hash });

      onProgress?.('Updating balances…');
      await Promise.all([loadBalances(), loadPendingRewards?.()].filter(Boolean));

      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) {
        console.error('claimReward failed:', error);
      }
      onError?.(error);
      return undefined;
    } finally {
      setLoading(false);
      setTransactionLoading(txId, false);
    }
  }, [
    publicClient,
    writeContractAsync,
    getAddr,
    loadBalances,
    loadPendingRewards,
    setTransactionLoading
  ]);

  // Get reward tokens
  const getRewardTokens = useCallback(async (
    tokenFileUrl = "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/reward_tokens.json"
  ): Promise<string[]> => {
    try {
      return await loadClaimTokensFromJson(tokenFileUrl);
    } catch (e) {
      console.error('getRewardTokens failed:', e);
      return [];
    }
  }, []);

  // Calculate staking APR
  const calculateStakingAPR = useCallback(async (): Promise<StakingAPR> => {
    return { aero: DEFAULT_STAKING_APR, total: DEFAULT_STAKING_APR };
  }, []);

  // Get staking stats
  const getStakingStats = useCallback(async (
    tokenFileUrl = "/claim_tokens_last7d.json"
  ): Promise<StakingStats> => {
    try {
      const stakingAddr = getAddr('StakingDistributor');
      if (!stakingAddr || !publicClient) {
        return { totalStaked: '0', rewardTokensCount: 0 };
      }

      const totalStakedRaw = await publicClient.readContract({
        address: stakingAddr,
        abi: ABIS.StakingDistributor,
        functionName: 'totalStaked',
      });

      const tokens = await loadClaimTokensFromJson(tokenFileUrl);
      
      return {
        totalStaked: safeFormatEther(totalStakedRaw as bigint),
        rewardTokensCount: tokens.length,
      };
    } catch (e) {
      console.error('getStakingStats failed:', e);
      return { totalStaked: '0', rewardTokensCount: 0 };
    }
  }, [publicClient, getAddr]);

  // Get pending rewards
  const getPendingRewards = useCallback(async (
    userAddress?: string,
    tokenFileUrl = "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/reward_tokens.json"
  ): Promise<PendingReward[]> => {
    try {
      const stakingAddr = getAddr('StakingDistributor');
      const addr = userAddress || address;
      
      if (!stakingAddr || !addr || !publicClient) return [];

      const currentEpoch = await publicClient.readContract({
        address: stakingAddr,
        abi: ABIS.StakingDistributor,
        functionName: 'currentEpoch',
      }) as bigint;

      const WEEK = 7n * 24n * 60n * 60n;
      const prevEpoch = currentEpoch - WEEK;

      const tokens = await loadClaimTokensFromJson(tokenFileUrl);
      if (!tokens.length) return [];

      const out: PendingReward[] = [];

      for (const token of tokens) {
        const [aPrev, aNow] = await Promise.all([
          publicClient.readContract({
            address: stakingAddr,
            abi: ABIS.StakingDistributor,
            functionName: 'previewClaim',
            args: [addr, token, prevEpoch],
          }).catch(() => 0n),
          publicClient.readContract({
            address: stakingAddr,
            abi: ABIS.StakingDistributor,
            functionName: 'previewClaim',
            args: [addr, token, currentEpoch],
          }).catch(() => 0n),
        ]);

        const total = (aPrev as bigint) + (aNow as bigint);
        if (total === 0n) continue;

        let symbol = 'ETH';
        let decimals = 18;

        if (token !== '0x0000000000000000000000000000000000000000') {
          try {
            const [sym, dec] = await Promise.all([
              publicClient.readContract({
                address: token as `0x${string}`,
                abi: ABIS.ERC20,
                functionName: 'symbol',
              }),
              publicClient.readContract({
                address: token as `0x${string}`,
                abi: ABIS.ERC20,
                functionName: 'decimals',
              }),
            ]);
            
            symbol = String(sym);
            decimals = Number(dec);
          } catch {
            symbol = `${token.slice(0, 6)}...${token.slice(-4)}`;
          }
        }

        out.push({
          token,
          amount: (Number(total) / 10 ** decimals).toString(),
          symbol,
          decimals,
        });
      }

      return out;
    } catch (e) {
      console.error('getPendingRewards failed:', e);
      return [];
    }
  }, [address, publicClient, getAddr]);

  // Exit (unstake all + claim all)
  const exit = useCallback(async (
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ) => {
    setLoading(true);
    const txId = 'exit';
    setTransactionLoading(txId, true);
    
    try {
      const stakingAddr = getAddr('StakingDistributor');
      if (!stakingAddr) throw new Error('Staking contract not initialized');

      onProgress?.('Exiting position...');
      
      const hash = await writeContractAsync({
        address: stakingAddr,
        abi: ABIS.StakingDistributor,
        functionName: 'exit',
      });

      const receipt = await publicClient?.waitForTransactionReceipt({ hash });

      onProgress?.('Updating balances…');
      await Promise.all([
        loadBalances(),
        loadAllowances(),
        loadPendingRewards?.()
      ].filter(Boolean));

      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) {
        console.error('exit failed:', error);
      }
      onError?.(error);
      if (!isUserRejection(error)) throw error;
      return undefined;
    } finally {
      setLoading(false);
      setTransactionLoading(txId, false);
    }
  }, [
    publicClient,
    writeContractAsync,
    getAddr,
    loadBalances,
    loadAllowances,
    loadPendingRewards,
    setTransactionLoading
  ]);

  return {
    loading,
    stakeIAero,
    unstakeIAero,
    claimAllRewards,
    claimReward,
    exit,
    checkIAeroApproval,
    approveIAero,
    calculateStakingAPR,
    getStakingStats,
    getPendingRewards,
    getRewardTokens,
  };
};