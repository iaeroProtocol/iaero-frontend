// src/contracts/hooks/useStaking.ts
import { useState, useCallback } from 'react';
import { ethers, ContractTransactionReceipt } from 'ethers';
import { useProtocol } from '../../contexts/ProtocolContext';
import { parseTokenAmount } from '../../lib/ethereum';
import { getContractAddress } from '../../contracts/addresses';
import { ABIS } from '../../contracts/abis';

// Same defaults as in ProtocolContext:
const DEFAULT_CLAIM_TOKENS_BY_CHAIN: Record<number, string[]> = {
  8453: [
    getContractAddress('AERO', 8453)!,
    getContractAddress('WETH', 8453) ?? "",
    getContractAddress('USDC', 8453) ?? "",
  ].filter(Boolean),
};

const DEFAULT_STAKING_APR =
  Number(process.env.NEXT_PUBLIC_DEFAULT_STAKING_APR ?? '30'); // percent

async function fetchEpochTokensViaRewardsSugar(contracts: any, chainId: number, limit = 200): Promise<string[]> {
  try {
    const rs = contracts.RewardsSugar;
    if (!rs) return [];
    const rows = await rs.epochsLatest(limit, 0);
    const seen = new Set<string>();
    for (const row of rows) {
      const bribes = row.bribes ?? [];
      const fees   = row.fees ?? [];
      for (const b of bribes) if (b?.token) seen.add(b.token.toLowerCase());
      for (const f of fees)   if (f?.token) seen.add(f.token.toLowerCase());
    }
    return Array.from(seen);
  } catch { return []; }
}

async function getEpochClaimTokenList(contracts: any, chainId: number): Promise<string[]> {
  const viaSugar = await fetchEpochTokensViaRewardsSugar(contracts, chainId);
  if (viaSugar.length) return viaSugar;
  return DEFAULT_CLAIM_TOKENS_BY_CHAIN[chainId] ?? [];
}

// -----------------------------
// Types
// -----------------------------
interface StakingAPR {
  aero: number; // APR for AERO-denominated rewards (primary)
  total: number; // Sum APR across all reward tokens (when price feeds available)
}

interface StakingStats {
  totalStaked: string; // in ether units (18d)
  rewardTokensCount: number;
}

interface PendingReward {
  token: string; // token address (0x0 for native)
  amount: string; // amount in ether units (18d)
  symbol?: string; // best-effort symbol
}

// Useful callbacks
export type ProgressCallback = (message: string) => void;
export type SuccessCallback = (receipt: ContractTransactionReceipt) => void;
export type ErrorCallback = (error: any) => void;

// -----------------------------
// Utils
// -----------------------------
const toBigInt = (v: any): bigint => {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') return BigInt(Math.floor(v));
    if (typeof v === 'string') return BigInt(v);
    return BigInt(v?.toString?.() ?? '0');
  } catch {
    return 0n;
  }
};

// Helper to check if error is user rejection
const isUserRejection = (error: any): boolean => {
  return error?.code === 'ACTION_REJECTED' || 
         error?.code === 4001 || 
         error?.message?.includes('user rejected') ||
         error?.message?.includes('User denied');
};

// Best-effort call wrapper that tries multiple function names, returns undefined if all fail
const tryCalls = async <T>(c: any, fns: Array<[string, any[]]>, label?: string): Promise<T | undefined> => {
  for (const [name, args] of fns) {
    try {
      if (typeof c?.[name] === 'function') {
        // @ts-ignore
        return await c[name](...args);
      }
    } catch {
      // continue to next candidate
    }
  }
  return undefined;
};

export const useStaking = () => {
  const { getContracts, loadBalances, loadAllowances, loadPendingRewards, dispatch } = useProtocol();
  const [loading, setLoading] = useState(false);

  // -----------------------------
  // Approvals (signer-aware)
  // -----------------------------

  /** Check allowance using signer (so "owner" is known). */
  const checkIAeroApprovalWei = useCallback(async (amountWei: bigint): Promise<boolean> => {
    try {
      const contracts = await getContracts(true); // signer for owner
      if (!contracts?.iAERO || !contracts?.stakingDistributor) return false;
      const owner = contracts.iAERO.runner?.address;
      if (!owner) return false;
      const spender = (contracts.stakingDistributor.target || contracts.stakingDistributor.address) as string;
      const currentAllowance = await contracts.iAERO.allowance(owner, spender);
      return toBigInt(currentAllowance) >= amountWei;
    } catch (e) {
      console.error('checkIAeroApprovalWei error', e);
      return false;
    }
  }, [getContracts]);

  /** String wrapper that calls the Wei version. */
  const checkIAeroApproval = useCallback(async (amount: string): Promise<boolean> => {
    return checkIAeroApprovalWei(parseTokenAmount(amount));
  }, [checkIAeroApprovalWei]);

  /**
   * Approve iAERO once with MaxUint256 to avoid repeated prompts.
   * Early-exits if allowance already sufficient for `amount`.
   */
  const approveIAero = useCallback(async (
    amount: string,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback
  ): Promise<ContractTransactionReceipt | undefined> => {
    const txId = 'approveIAero';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    try {
      const amountWei = parseTokenAmount(amount);
      const contracts = await getContracts(true); // signer
      if (!contracts?.iAERO || !contracts?.stakingDistributor) throw new Error('Contracts not initialized');

      const spender = (contracts.stakingDistributor.target || contracts.stakingDistributor.address) as string;

      // Early exit if already approved enough
      const owner = contracts.iAERO.runner?.address;
      const current = owner ? await contracts.iAERO.allowance(owner, spender) : 0;
      if (toBigInt(current) >= amountWei) {
        await loadAllowances();
        return undefined;
      }

      // Approve max to avoid future prompts
      const tx = await contracts.iAERO.approve(spender, ethers.MaxUint256);
      const receipt = await tx.wait();
      await loadAllowances();
      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) {
        console.error('approveIAero failed:', error);
      }
      onError?.(error);
      if (!isUserRejection(error)) {
        throw error;
      }
      return undefined;
    } finally {
      dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: false } });
    }
  }, [getContracts, dispatch, loadAllowances]);

  // -----------------------------
  // Stake / Unstake (symmetric flow)
  // -----------------------------

  const stakeIAero = useCallback(async (
    amount: string,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ): Promise<ContractTransactionReceipt | undefined> => {
    setLoading(true);
    const txId = 'stakeIAero';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    try {
      const contracts = await getContracts(true);
      const sd = contracts?.stakingDistributor;
      if (!sd) throw new Error('Staking contract not initialized');

      const amountWei = parseTokenAmount(amount);

      onProgress?.('Checking allowance...');
      if (!(await checkIAeroApprovalWei(amountWei))) {
        onProgress?.('Approving iAERO spending...');
        await approveIAero(ethers.formatEther(amountWei));
      }

      onProgress?.('Staking iAERO...');
      
      // Direct call to stake method
      let tx;
      try {
        tx = await sd.stake(amountWei);
      } catch (error: any) {
        if (isUserRejection(error)) {
          onError?.(error);
          return undefined;
        }
        console.error('Stake method error:', error);
        throw new Error(`Staking failed: ${error.message || 'Unknown error'}`);
      }
      
      if (!tx) {
        throw new Error('Transaction failed to initiate');
      }

      onProgress?.('Confirming transaction...');
      const receipt = await tx.wait();

      onProgress?.('Updating balances...');
      await Promise.all([loadBalances(), loadAllowances(), loadPendingRewards()]);

      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) {
        console.error('stakeIAero failed:', error);
      }
      onError?.(error);
      if (!isUserRejection(error)) {
        throw error;
      }
      return undefined;
    } finally {
      setLoading(false);
      dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: false } });
    }
  }, [getContracts, checkIAeroApprovalWei, approveIAero, dispatch, loadBalances, loadAllowances, loadPendingRewards]);

  const unstakeIAero = useCallback(async (
    amount: string,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ): Promise<ContractTransactionReceipt | undefined> => {
    setLoading(true);
    const txId = 'unstakeIAero';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    try {
      const contracts = await getContracts(true);
      const sd = contracts?.stakingDistributor;
      if (!sd) throw new Error('Staking contract not initialized');

      const amountWei = parseTokenAmount(amount);

      onProgress?.('Unstaking iAERO...');
      
      // Direct call to unstake method
      let tx;
      try {
        tx = await sd.unstake(amountWei);
      } catch (error: any) {
        if (isUserRejection(error)) {
          onError?.(error);
          return undefined;
        }
        console.error('Unstake method error:', error);
        throw new Error(`Unstaking failed: ${error.message || 'Unknown error'}`);
      }
      
      if (!tx) {
        throw new Error('Transaction failed to initiate');
      }

      onProgress?.('Confirming transaction...');
      const receipt = await tx.wait();

      onProgress?.('Updating balances...');
      await Promise.all([loadBalances(), loadAllowances(), loadPendingRewards()]);

      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) {
        console.error('unstakeIAero failed:', error);
      }
      onError?.(error);
      if (!isUserRejection(error)) {
        throw error;
      }
      return undefined;
    } finally {
      setLoading(false);
      dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: false } });
    }
  }, [getContracts, dispatch, loadBalances, loadAllowances, loadPendingRewards]);

  // -----------------------------
  // Claims
  // -----------------------------
  const claimAllRewards = useCallback(async (
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ): Promise<ContractTransactionReceipt | undefined> => {
    setLoading(true);
    const txId = 'claimAllRewards';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    try {
      const contracts = await getContracts(true);
      const sd = contracts?.stakingDistributor;
      if (!sd) throw new Error('Staking contract not initialized');
  
      // LEGACY
      if (typeof sd.claimRewards === 'function') {
        onProgress?.('Claiming all rewards...');
        const tx = await sd.claimRewards();
        const receipt = await tx.wait();
        await Promise.all([loadBalances(), loadPendingRewards()]);
        onSuccess?.(receipt);
        return receipt;
      }
  
      // EPOCH
      if (typeof sd.claimLatest === 'function') {
        const tokens = await getEpochClaimTokenList(contracts, contracts.provider?.network?.chainId ?? 8453);
        if (!tokens.length) {
          onError?.(new Error('No tokens to claim'));
          return undefined;
        }
        onProgress?.('Claiming latest epoch rewards...');
        const tx = await sd.claimLatest(tokens);
        const receipt = await tx.wait();
        await Promise.all([loadBalances(), loadPendingRewards()]);
        onSuccess?.(receipt);
        return receipt;
      }
  
      onError?.(new Error('No compatible claim method'));
      return undefined;
    } catch (error: any) {
      if (!isUserRejection(error)) console.error('claimAllRewards failed:', error);
      onError?.(error);
      return undefined;
    } finally {
      setLoading(false);
      dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: false } });
    }
  }, [getContracts, dispatch, loadBalances, loadPendingRewards]);
  
  
  const claimReward = useCallback(async (
    tokenAddress: string,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ): Promise<ContractTransactionReceipt | undefined> => {
    setLoading(true);
    const txId = 'claimReward';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    try {
      const contracts = await getContracts(true);
      const sd = contracts?.stakingDistributor;
      if (!sd) throw new Error('Staking contract not initialized');
  
      // LEGACY single-claim (if available)
      if (typeof sd.claimReward === 'function') {
        onProgress?.('Claiming reward...');
        const tx = await sd.claimReward(tokenAddress);
        const receipt = await tx.wait();
        await Promise.all([loadBalances(), loadPendingRewards()]);
        onSuccess?.(receipt);
        return receipt;
      }
  
      // EPOCH: claim both prev & current using claimLatest([token])
      if (typeof sd.claimLatest === 'function') {
        onProgress?.('Claiming latest for token...');
        const tx = await sd.claimLatest([tokenAddress]);
        const receipt = await tx.wait();
        await Promise.all([loadBalances(), loadPendingRewards()]);
        onSuccess?.(receipt);
        return receipt;
      }
  
      onError?.(new Error('No compatible claim method'));
      return undefined;
    } catch (error: any) {
      if (!isUserRejection(error)) console.error('claimReward failed:', error);
      onError?.(error);
      return undefined;
    } finally {
      setLoading(false);
      dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: false } });
    }
  }, [getContracts, dispatch, loadBalances, loadPendingRewards]);
  

  // -----------------------------
  // Views / Stats
  // -----------------------------
  const getRewardTokens = useCallback(async (): Promise<string[]> => {
    try {
      const contracts = await getContracts();
      const sd = contracts?.stakingDistributor;
      if (!sd) return [];
  
      // LEGACY contract
      if (typeof sd.getRewardTokens === 'function') {
        try { return await sd.getRewardTokens(); } catch {}
        // fallback enumerate … (your old code) …
      }
  
      // EPOCH contract — return candidate list
      return await getEpochClaimTokenList(contracts, contracts.provider?.network?.chainId ?? 8453);
    } catch (e) {
      console.error('getRewardTokens failed:', e);
      return [];
    }
  }, [getContracts]);
  

  const calculateStakingAPR = useCallback(async (): Promise<StakingAPR> => {
    try {
      const contracts = await getContracts();
      const sd = contracts?.stakingDistributor;
  
      // If no distributor, return default APR
      if (!sd) return { aero: DEFAULT_STAKING_APR, total: DEFAULT_STAKING_APR };
  
      // EPOCH model: APR ≈ (last-epoch AERO / supplySnapshotAtStart) * 52 * 100
      if (typeof sd.currentEpoch === 'function') {
        const chainId = contracts.provider?.network?.chainId ?? 8453;
        const aeroAddr = getContractAddress('AERO', chainId);
  
        const WEEK = 7n * 24n * 60n * 60n;
        const nowEpoch: bigint = await sd.currentEpoch();
        const prev: bigint = nowEpoch - WEEK;
  
        const totalAeroPrev: bigint = await sd
          .rewardsForEpoch(aeroAddr, prev)
          .catch(() => 0n);
  
        let supplySnap: bigint = await sd
          .supplySnapshotAtEpochStart(prev)
          .catch(() => 0n);
  
        if (supplySnap === 0n && typeof sd.totalSupplyAtEpochStart === 'function') {
          supplySnap = await sd.totalSupplyAtEpochStart(prev).catch(() => 0n);
        }
  
        if (totalAeroPrev === 0n || supplySnap === 0n) {
          return { aero: DEFAULT_STAKING_APR, total: DEFAULT_STAKING_APR };
        }
  
        const apr = Number((totalAeroPrev * 52n * 100n) / supplySnap);
        return { aero: apr, total: apr };
      }
  
      // Fallback
      return { aero: DEFAULT_STAKING_APR, total: DEFAULT_STAKING_APR };
    } catch (e) {
      console.error('calculateStakingAPR failed:', e);
      return { aero: DEFAULT_STAKING_APR, total: DEFAULT_STAKING_APR };
    }
  }, [getContracts]);
  
  

  const getStakingStats = useCallback(async (): Promise<StakingStats> => {
    try {
      const contracts = await getContracts();
      const sd = contracts?.stakingDistributor;
      if (!sd) return { totalStaked: '0', rewardTokensCount: 0 };
  
      const totalStakedRaw = await (sd.totalStaked?.() ?? 0n);
      let tokenCount = 0;
  
      // LEGACY
      if (typeof sd.getRewardTokens === 'function') {
        try {
          const t = await sd.getRewardTokens();
          tokenCount = Array.isArray(t) ? t.length : 0;
        } catch {}
      } else {
        // EPOCH
        const tokens = await getEpochClaimTokenList(contracts, contracts.provider?.network?.chainId ?? 8453);
        tokenCount = tokens.length;
      }
  
      return {
        totalStaked: ethers.formatEther(toBigInt(totalStakedRaw ?? 0)),
        rewardTokensCount: tokenCount,
      };
    } catch (e) {
      console.error('getStakingStats failed:', e);
      return { totalStaked: '0', rewardTokensCount: 0 };
    }
  }, [getContracts]);
  

  const getPendingRewards = useCallback(async (userAddress?: string): Promise<PendingReward[]> => {
    try {
      const contracts = await getContracts();
      const sd = contracts?.stakingDistributor;
      if (!sd) return [];
  
      const addr = userAddress || sd.runner?.address;
      if (!addr) return [];
  
      // ---- EPOCH CONTRACT PATH ----
      if (typeof sd.currentEpoch === 'function' && typeof sd.previewClaim === 'function') {
        const chainId = contracts.provider?.network?.chainId ?? 8453;
        const tokens = await getEpochClaimTokenList(contracts, chainId);
        if (!tokens.length) return [];
  
        const WEEK = 7n * 24n * 60n * 60n;
        const nowEpoch: bigint = await sd.currentEpoch();
        const prev = nowEpoch - WEEK;
  
        const out: PendingReward[] = [];
  
        await Promise.all(tokens.map(async (t) => {
          const [pPrev, pNow] = await Promise.all([
            sd.previewClaim(addr, t, prev).catch(() => 0n),
            sd.previewClaim(addr, t, nowEpoch).catch(() => 0n),
          ]);
  
          const total = (pPrev ?? 0n) + (pNow ?? 0n);
          if (total === 0n) return;
  
          let symbol = 'ETH';
          let decimals = 18;
          if (t !== ethers.ZeroAddress) {
            try {
              const erc20 = new ethers.Contract(
                t,
                ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'],
                contracts.provider
              );
              [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
            } catch {
              symbol = `${t.slice(0, 6)}...${t.slice(-4)}`;
              decimals = 18;
            }
          }
          out.push({ token: t, amount: ethers.formatUnits(total, decimals), symbol });
        }));
  
        return out;
      }
  
      // ---- LEGACY CONTRACT PATH ----
      const data = await tryCalls<any>(
        sd,
        [['getPendingRewards', [addr]], ['pendingRewards', [addr]]],
        'getPendingRewards'
      );
      if (!data) return [];
  
      const tokens: string[] = Array.isArray(data[0]) ? data[0] : [];
      const amounts: any[] = Array.isArray(data[1]) ? data[1] : [];
  
      const out: PendingReward[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const amt = toBigInt(amounts[i] ?? 0);
  
        let symbol = 'ETH';
        let decimals = 18;
        if (t !== ethers.ZeroAddress) {
          try {
            const erc20 = new ethers.Contract(
              t,
              ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'],
              contracts.provider
            );
            [symbol, decimals] = await Promise.all([erc20.symbol(), erc20.decimals()]);
          } catch {
            symbol = `${t.slice(0, 6)}...${t.slice(-4)}`;
            decimals = 18;
          }
        }
        out.push({ token: t, amount: ethers.formatUnits(amt, decimals), symbol });
      }
      return out;
  
    } catch (e) {
      console.error('getPendingRewards failed:', e);
      return [];
    }
  }, [getContracts]);
  

  // Exit = Unstake everything + claim
  const exit = useCallback(async (
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ): Promise<ContractTransactionReceipt | undefined> => {
    setLoading(true);
    const txId = 'exit';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    try {
      const contracts = await getContracts(true);
      const sd = contracts?.stakingDistributor;
      if (!sd) throw new Error('Staking contract not initialized');

      onProgress?.('Exiting position...');
      
      // Direct call to exit method
      let tx;
      try {
        tx = await sd.exit();
      } catch (error: any) {
        if (isUserRejection(error)) {
          onError?.(error);
          return undefined;
        }
        console.error('Exit method error:', error);
        throw new Error(`Exit failed: ${error.message || 'Unknown error'}`);
      }
      
      if (!tx) {
        throw new Error('Transaction failed to initiate');
      }

      onProgress?.('Confirming transaction...');
      const receipt = await tx.wait();

      onProgress?.('Updating balances...');
      await Promise.all([loadBalances(), loadAllowances(), loadPendingRewards()]);

      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) {
        console.error('exit failed:', error);
      }
      onError?.(error);
      if (!isUserRejection(error)) {
        throw error;
      }
      return undefined;
    } finally {
      setLoading(false);
      dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: false } });
    }
  }, [getContracts, dispatch, loadBalances, loadAllowances, loadPendingRewards]);

  return {
    loading,
    // actions
    stakeIAero,
    unstakeIAero,
    claimAllRewards,
    claimReward,
    exit,
    // approvals
    checkIAeroApproval,
    approveIAero,
    // views
    calculateStakingAPR,
    getStakingStats,
    getPendingRewards,
  };
};
