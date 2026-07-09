// src/contracts/hooks/useStaking.ts
import { useState, useCallback } from 'react';
import { useAccount, useChainId, useWriteContract, usePublicClient } from 'wagmi';
import type { Hash } from 'viem';
import { parseAbi } from 'viem';
import { getContractAddress } from '../addresses';
import { ABIS } from '../abis';
import { useProtocol } from '../../contexts/ProtocolContext';
import { usePrices } from '../../contexts/PriceContext';


const DEFAULT_STAKING_APR = Number(process.env.NEXT_PUBLIC_DEFAULT_STAKING_APR ?? '30');

// On-chain reward-token registry — source of truth for the reward-token list
// (mirrors RewardsSection.tsx). Used to count reward tokens for the Stake page.
const REWARD_TOKEN_REGISTRY = '0xd3e32B22Da6Bf601A5917ECd344a7Ec46BCA072c' as const;
const REGISTRY_ABI = parseAbi(['function allTokens() view returns (address[])']);

// Types
interface StakingAPR {
  aero: number;
  total: number;
}

interface StakingStats {
  totalStaked: string;
  rewardTokensCount: number;
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

export const useStaking = () => {
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { loadBalances, loadAllowances, loadPendingRewards, setTransactionLoading } = useProtocol();
  // `lastUpdate` is null until PriceContext has fetched real prices once. Until
  // then, `prices` holds MOCKS (LIQ=$0.15 etc.) — using them silently produces
  // a stable-looking but wrong APR display (the classic "shows 2.7% by default").
  const { prices, lastUpdate: pricesLastUpdate } = usePrices();

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

  const E18 = 10n ** 18n;
  const toE18 = (x: number) => BigInt(Math.round(x * 1e18));

  const REWARDS_JSON_URL =
    process.env.NEXT_PUBLIC_REWARDS_JSON_URL ||
    "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/estimated_rewards_usd.json";

  async function fetchStakersWeeklyUSD(): Promise<bigint> {
    const r = await fetch(REWARDS_JSON_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`rewards json ${r.status}`);
    const j = await r.json();
    if (j?.stakersWeeklyUSD_1e18) return BigInt(j.stakersWeeklyUSD_1e18);
    if (j?.estimatedWeeklyUSD_1e18) return (BigInt(j.estimatedWeeklyUSD_1e18) * 8000n) / 10000n; // 0.8x fallback
    throw new Error("missing stakersWeeklyUSD");
  }

  // Total protocol weekly USD (1e18), for LIQ APR math.
  // Prefer estimatedWeeklyUSD_1e18. If missing, derive it from stakersWeeklyUSD_1e18 / 0.8
  async function fetchEstimatedWeeklyUSD(): Promise<bigint> {
    const r = await fetch(REWARDS_JSON_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`rewards json ${r.status}`);
    const j = await r.json();

    if (j?.estimatedWeeklyUSD_1e18) {
      return BigInt(j.estimatedWeeklyUSD_1e18);
    }
    if (j?.stakersWeeklyUSD_1e18) {
      // stakersWeekly = 80% of estimated → estimated = stakersWeekly / 0.8
      const stakers = BigInt(j.stakersWeeklyUSD_1e18);
      return (stakers * 10000n) / 8000n;
    }
    throw new Error("missing estimatedWeeklyUSD_1e18");
  }



  // Check approval
  const checkIAeroApproval = useCallback(async (amount: string): Promise<boolean> => {
    if (!address || !publicClient) return false;
    
    try {
      const stakingAddr = getAddr('StakingDistributor') as `0x${string}` | undefined;
      if (!stakingAddr) return false;

      const allowance = await publicClient.readContract({
        address: getAddr('iAERO')! as `0x${string}`,
        abi: ABIS.iAERO,
        functionName: 'allowance',
        args: [address as `0x${string}`, stakingAddr],
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
      const stakingAddr = getAddr('StakingDistributor') as `0x${string}` | undefined;
      if (!stakingAddr) throw new Error('Staking contract not found');

      // Check if already approved
      const isApproved = await checkIAeroApproval(amount);
      if (isApproved) {
        await loadAllowances();
        return undefined;
      }

      // Write approval transaction
      const hash = await writeContractAsync({
        address: getAddr('iAERO')! as `0x${string}`,
        abi: ABIS.iAERO,
        functionName: 'approve',
        args: [stakingAddr, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')], // MaxUint256
        gas: 100_000n,
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
      const stakingAddr = getAddr('StakingDistributor') as `0x${string}` | undefined;
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
        gas: 300_000n,
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
      const stakingAddr = getAddr('StakingDistributor') as `0x${string}` | undefined;
      if (!stakingAddr) throw new Error('Staking contract not initialized');

      onProgress?.('Unstaking iAERO...');
      const hash = await writeContractAsync({
        address: stakingAddr,
        abi: ABIS.StakingDistributor,
        functionName: 'unstake',
        args: [amountWei],
        gas: 300_000n,
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

  const claimReward = useCallback(async (
    tokenAddress: `0x${string}`,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ) => {
    setLoading(true);
    const txId = 'claimReward';
    setTransactionLoading(txId, true);
  
    try {
      const stakingAddr = getAddr('StakingDistributor') as `0x${string}` | undefined;
      if (!stakingAddr) throw new Error('Staking contract not initialized');
  
      onProgress?.('Claiming reward…');
  
      // We need both epochs to match the UI's preview logic
      const currentEpoch = await publicClient!.readContract({
        address: stakingAddr,
        abi: ABIS.StakingDistributor,
        functionName: 'currentEpoch',
      }) as bigint;
  
      const WEEK = 7n * 24n * 60n * 60n;
      const prevEpoch = currentEpoch - WEEK;
  
      let hash: Hash | undefined;
  
      // Try claimLatest([token]) first (claims prev + current)
      try {
        hash = await writeContractAsync({
          address: stakingAddr,
          abi: ABIS.StakingDistributor,
          functionName: 'claimLatest',
          args: [[tokenAddress]],
          gas: 400_000n,
        });
      } catch {
        // Fallback: claim prev, then current
        try {
          const h1 = await writeContractAsync({
            address: stakingAddr,
            abi: ABIS.StakingDistributor,
            functionName: 'claim',
            args: [tokenAddress, prevEpoch],
            gas: 300_000n,
          });
          await publicClient!.waitForTransactionReceipt({ hash: h1 });
        } catch { /* okay if nothing pending in prev */ }

        hash = await writeContractAsync({
          address: stakingAddr,
          abi: ABIS.StakingDistributor,
          functionName: 'claim',
          args: [tokenAddress, currentEpoch],
          gas: 300_000n,
        });
      }
  
      const receipt = await publicClient!.waitForTransactionReceipt({ hash: hash! });
  
      onProgress?.('Updating balances…');
      await Promise.all([
        loadBalances(),
        loadPendingRewards?.(),
      ].filter(Boolean));
  
      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) console.error('claimReward failed:', error);
      onError?.(error);
      return undefined;
    } finally {
      setLoading(false);
      setTransactionLoading(txId, false);
    }
  }, [publicClient, writeContractAsync, getAddr, loadBalances, loadPendingRewards, setTransactionLoading]);
  


  // Calculate staking APR (real-time)
  const calculateStakingAPR = useCallback(async (): Promise<StakingAPR> => {
    try {
      const stakingAddr = getAddr('StakingDistributor') as `0x${string}` | undefined;
      if (!stakingAddr || !publicClient) {
        return { aero: DEFAULT_STAKING_APR, total: DEFAULT_STAKING_APR };
      }

      // (1) weekly stakers USD (1e18)
      const weeklyUSD_1e18 = await fetchStakersWeeklyUSD();

      // (2) total iAERO staked (1e18)
      const totalStakedRaw = await publicClient.readContract({
        address: stakingAddr,
        abi: ABIS.StakingDistributor,
        functionName: 'totalStaked',
      }) as bigint;

      if (!totalStakedRaw || totalStakedRaw === 0n) {
        return { aero: 0, total: 0 };
      }

      // (3) iAERO price (fallback to AERO)
      let iaeroUsd = Number(prices?.iAERO?.usd ?? 0);
      if (!Number.isFinite(iaeroUsd) || iaeroUsd <= 0) {
        iaeroUsd = Number(prices?.AERO?.usd ?? 0);
      }
      if (!Number.isFinite(iaeroUsd) || iaeroUsd <= 0) {
        // cannot price → UI baseline only
        return { aero: DEFAULT_STAKING_APR, total: DEFAULT_STAKING_APR };
      }

      // (4) APR = (weekly * 52) / (totalStaked * price) * 100
      const iaeroUsd_1e18 = toE18(iaeroUsd);
      const annualUSD_1e18 = weeklyUSD_1e18 * 52n;
      const tvlUSD_1e18 = (totalStakedRaw * iaeroUsd_1e18) / E18;

      if (tvlUSD_1e18 === 0n) {
        return { aero: 0, total: 0 };
      }

      const apyRatio_1e18 = (annualUSD_1e18 * E18) / tvlUSD_1e18; // 1e18-scaled ratio
      const apyPct_1e18 = apyRatio_1e18 * 100n;                   // percentage * 1e18
      const apyPct = Number(apyPct_1e18) / 1e18;

      return { aero: apyPct, total: apyPct };
    } catch (e) {
      console.error('calculateStakingAPR failed:', e);
      return { aero: DEFAULT_STAKING_APR, total: DEFAULT_STAKING_APR };
    }
  }, [publicClient, getAddr, prices]);

  const calculateLiqStakingAPR = useCallback(async (): Promise<number | null> => {
    try {
      const liqStakingAddr = getAddr('LIQStakingDistributor') as `0x${string}` | undefined;
      if (!liqStakingAddr || !publicClient) return null;

      // Bail until PriceContext has real prices. Using the mock LIQ price ($0.15)
      // before the first fetch resolves produces a stable-looking 2.7% APR that
      // overrides itself only after a wallet/chain change kicks the consumer's
      // useEffect — the source of the "shows 2.7% for ages" bug.
      if (pricesLastUpdate == null) return null;

      // (1) LIQ gets 8% of the *estimated* total protocol weekly USD.
      // (10% routed to TreasuryDistributor on-chain, of which 80% reaches LIQ
      //  stakers and 20% goes to the treasury wallet — net 8%.)
      const estimatedWeeklyUSD_1e18 = await fetchEstimatedWeeklyUSD();
      const liqWeeklyUSD_1e18 = (estimatedWeeklyUSD_1e18 * 800n) / 10000n; // 0.08

      // (2) Total LIQ staked (1e18)
      const totalLiqStaked = await publicClient.readContract({
        address: liqStakingAddr,
        abi: ABIS.LIQStakingDistributor,
        functionName: 'totalLIQStaked',
      }) as bigint;
      if (!totalLiqStaked || totalLiqStaked === 0n) return 0;

      // (3) LIQ price (USD)
      const liqUsd = Number(prices?.LIQ?.usd ?? 0);
      if (!Number.isFinite(liqUsd) || liqUsd <= 0) return null;

      // (4) APR = (0.08 * weekly * 52) / (totalLIQStaked * price) * 100
      const liqUsd_1e18 = toE18(liqUsd);
      const annualUSD_1e18 = liqWeeklyUSD_1e18 * 52n;
      const tvlUSD_1e18 = (totalLiqStaked * liqUsd_1e18) / E18;
      if (tvlUSD_1e18 === 0n) return 0;

      const aprRatio_1e18 = (annualUSD_1e18 * E18) / tvlUSD_1e18; // 1e18-scaled ratio
      const aprPct = (Number(aprRatio_1e18) / 1e18) * 100;        // keep fractional precision
      return aprPct;

    } catch (e) {
      console.error('calculateLiqStakingAPR failed:', e);
      // Return null (not DEFAULT_STAKING_APR) so the UI can render a "—" instead
      // of fabricating a number that looks legitimate.
      return null;
    }
  }, [publicClient, getAddr, prices, pricesLastUpdate]);



  // Get staking stats
  const getStakingStats = useCallback(async (): Promise<StakingStats> => {
    try {
      const stakingAddr = getAddr('StakingDistributor') as `0x${string}` | undefined;
      if (!stakingAddr || !publicClient) {
        return { totalStaked: '0', rewardTokensCount: 0 };
      }

      const totalStakedRaw = await publicClient.readContract({
        address: stakingAddr,
        abi: ABIS.StakingDistributor,
        functionName: 'totalStaked',
      });

      // Reward-token count comes from the on-chain registry (source of truth,
      // matches RewardsSection). Non-fatal: leave the count at 0 if it fails.
      let rewardTokensCount = 0;
      try {
        const tokens = await publicClient.readContract({
          address: REWARD_TOKEN_REGISTRY,
          abi: REGISTRY_ABI,
          functionName: 'allTokens',
        }) as readonly string[];
        rewardTokensCount = tokens.length;
      } catch {
        /* leave rewardTokensCount at 0 */
      }

      return {
        totalStaked: safeFormatEther(totalStakedRaw as bigint),
        rewardTokensCount,
      };
    } catch (e) {
      console.error('getStakingStats failed:', e);
      return { totalStaked: '0', rewardTokensCount: 0 };
    }
  }, [publicClient, getAddr]);

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
      const stakingAddr = getAddr('StakingDistributor') as `0x${string}` | undefined;
      if (!stakingAddr) throw new Error('Staking contract not initialized');
      

      onProgress?.('Exiting position...');
      
      const hash = await writeContractAsync({
        address: stakingAddr,
        abi: ABIS.StakingDistributor,
        functionName: 'exit',
        gas: 3_000_000n,
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
    claimReward,
    exit,
    checkIAeroApproval,
    approveIAero,
    calculateStakingAPR,
    calculateLiqStakingAPR,
    getStakingStats,
  };
};
