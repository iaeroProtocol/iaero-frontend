// =============================
// src/contracts/hooks/useStaking.ts
// =============================
import { useState, useCallback } from 'react';
import { ethers, ContractTransactionReceipt } from 'ethers';
import { useProtocol } from '../../contexts/ProtocolContext';
import { parseTokenAmount } from '../../lib/ethereum';
import { get1559Overrides } from '@/components/lib/fees';


const DEFAULT_STAKING_APR =
  Number(process.env.NEXT_PUBLIC_DEFAULT_STAKING_APR ?? '30'); // percent

// -----------------------------
// Types
// -----------------------------
interface StakingAPR {
  aero: number;
  total: number;
}
interface StakingStats {
  totalStaked: string;
  rewardTokensCount: number;
}
interface PendingReward {
  token: string;       // address (lowercased in JSON loader)
  amount: string;      // human units (formatted)
  symbol?: string;     // optional symbol (resolved ERC20)
  decimals?: number;   // 👈 add this
}


export type ProgressCallback = (message: string) => void;
export type SuccessCallback = (receipt: ContractTransactionReceipt) => void;
export type ErrorCallback = (error: any) => void;

// -----------------------------
// Local helpers
// -----------------------------
const WEEK = 7n * 24n * 60n * 60n;

/** Fetch the list your Python job exported (default in /public). */
async function loadClaimTokensFromJson(url = "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/reward_tokens.json"): Promise<string[]> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    
    // Get current and previous epochs
    const currentEpoch = Math.floor(Date.now() / 1000 / 604800) * 604800;
    const previousEpoch = currentEpoch - 604800;
    
    // Combine tokens from both epochs
    const tokens = new Set<string>();
    
    if (data.epochs?.[currentEpoch]?.tokens) {
      data.epochs[currentEpoch].tokens.forEach((t: string) => tokens.add(t.toLowerCase()));
    }
    if (data.epochs?.[previousEpoch]?.tokens) {
      data.epochs[previousEpoch].tokens.forEach((t: string) => tokens.add(t.toLowerCase()));
    }
    
    // normalize + dedupe
    const norm = Array.from(tokens).filter((t) => /^0x[0-9a-f]{40}$/.test(t));
    
    return norm;
  } catch (e) {
    console.warn("[loadClaimTokensFromJson] failed:", e);
    return [];
  }
}

/** Split into ≤50 (EpochStakingDistributor has a sensible cap and your contract enforces limits). */
function chunk50<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += 50) out.push(arr.slice(i, i + 50));
  return out;
}

/** toBigInt util */
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

/** user-rejection detector */
const isUserRejection = (error: any): boolean =>
  error?.code === 'ACTION_REJECTED' ||
  error?.code === 4001 ||
  error?.message?.toLowerCase?.().includes('user rejected') ||
  error?.message?.toLowerCase?.().includes('user denied');

// =============================
// Hook
// =============================
export const useStaking = () => {
  const { getContracts, loadBalances, loadAllowances, loadPendingRewards, dispatch } = useProtocol();
  const [loading, setLoading] = useState(false);

  // -----------------------------
  // Approvals
  // -----------------------------
  const checkIAeroApprovalWei = useCallback(async (amountWei: bigint): Promise<boolean> => {
    try {
      const contracts = await getContracts(true);
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

  const checkIAeroApproval = useCallback(async (amount: string): Promise<boolean> => {
    return checkIAeroApprovalWei(parseTokenAmount(amount));
  }, [checkIAeroApprovalWei]);

  const approveIAero = useCallback(async (
    amount: string,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback
  ): Promise<ContractTransactionReceipt | undefined> => {
    const txId = 'approveIAero';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    try {
      const amountWei = parseTokenAmount(amount);
      const contracts = await getContracts(true);
      if (!contracts?.iAERO || !contracts?.stakingDistributor) throw new Error('Contracts not initialized');

      const spender = (contracts.stakingDistributor.target || contracts.stakingDistributor.address) as string;

      const owner = contracts.iAERO.runner?.address;
      const current = owner ? await contracts.iAERO.allowance(owner, spender) : 0;
      if (toBigInt(current) >= amountWei) {
        await loadAllowances();
        return undefined;
      }

      const provider = contracts.iAERO.runner?.provider as ethers.Provider;
      const overrides = await get1559Overrides(provider);
      const tx = await contracts.iAERO.approve(spender, ethers.MaxUint256, overrides);

      const receipt = await tx.wait();
      await loadAllowances();
      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) console.error('approveIAero failed:', error);
      onError?.(error);
      if (!isUserRejection(error)) throw error;
      return undefined;
    } finally {
      dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: false } });
    }
  }, [getContracts, dispatch, loadAllowances]);

  // -----------------------------
  // Stake / Unstake
  // -----------------------------
  const stakeIAero = useCallback(async (
    amount: string,
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ) => {
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
      const provider = sd.runner?.provider as ethers.Provider;
      const overrides = await get1559Overrides(provider);
      const gas = await sd.stake.estimateGas(amountWei).catch(() => 180_000n);
      const tx = await sd.stake(amountWei, { ...overrides, gasLimit: (gas * 120n) / 100n });

      const receipt = await tx.wait();

      onProgress?.('Updating balances...');
      await Promise.all([loadBalances(), loadAllowances(), loadPendingRewards?.()].filter(Boolean) as Promise<any>[]);

      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) console.error('stakeIAero failed:', error);
      onError?.(error);
      if (!isUserRejection(error)) throw error;
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
  ) => {
    setLoading(true);
    const txId = 'unstakeIAero';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    try {
      const contracts = await getContracts(true);
      const sd = contracts?.stakingDistributor;
      if (!sd) throw new Error('Staking contract not initialized');

      const amountWei = parseTokenAmount(amount);

      onProgress?.('Unstaking iAERO...');
      const provider = sd.runner?.provider as ethers.Provider;
      const overrides = await get1559Overrides(provider);
      const gas = await sd.unstake.estimateGas(amountWei).catch(() => 150_000n);
      const tx = await sd.unstake(amountWei, { ...overrides, gasLimit: (gas * 120n) / 100n });

      const receipt = await tx.wait();

      onProgress?.('Updating balances...');
      await Promise.all([loadBalances(), loadAllowances(), loadPendingRewards?.()].filter(Boolean) as Promise<any>[]);

      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) console.error('unstakeIAero failed:', error);
      onError?.(error);
      if (!isUserRejection(error)) throw error;
      return undefined;
    } finally {
      setLoading(false);
      dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: false } });
    }
  }, [getContracts, dispatch, loadBalances, loadAllowances, loadPendingRewards]);

  // -----------------------------
  // Claims (FILE-FIRST METHOD)
// -----------------------------
  const claimAllRewards = useCallback(async (
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback,
    tokenFileUrl = "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/reward_tokens.json"
  ) => {
    setLoading(true);
    const txId = 'claimAllRewards';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    try {
      const contracts = await getContracts(true);
      const sd = contracts?.stakingDistributor;
      if (!sd) throw new Error('Staking contract not initialized');

      // Optional: handle pause if exposed
      try {
        const paused = await (sd as any).paused?.();
        if (paused) {
          onError?.(new Error('Claims are paused on the distributor.'));
          return undefined;
        }
      } catch {}

      onProgress?.('Loading token list…');
      const tokens = await loadClaimTokensFromJson(tokenFileUrl);
      if (!tokens.length) {
        onError?.(new Error('No tokens found in token file.'));
        return undefined;
      }

      onProgress?.('Prefiltering claimable tokens…');
      const nowEpoch: bigint = await sd.currentEpoch();
      const prevEpoch: bigint = nowEpoch - WEEK;

      // Get user address (signer preferred)
      const signerAddr =
        (sd.runner as ethers.Signer | undefined)?.getAddress
          ? await (sd.runner as ethers.Signer).getAddress()
          : (contracts.account || (sd.runner as any)?.address);

      if (!signerAddr) {
        onError?.(new Error('No connected account for claim.'));
        return undefined;
      }

      // Pre-filter: keep only tokens with >0 claimable (prev+now)
      const claimables: string[] = [];
      for (const t of tokens) {
        const [aNow, aPrev] = await Promise.all([
          sd.previewClaim(signerAddr, t, nowEpoch).catch(() => 0n),
          sd.previewClaim(signerAddr, t, prevEpoch).catch(() => 0n),
        ]);
        if ((aNow ?? 0n) + (aPrev ?? 0n) > 0n) claimables.push(t);
      }
      if (!claimables.length) {
        onError?.(new Error('No claimable rewards for your account right now.'));
        return undefined;
      }

      const batches = chunk50(claimables);
      let lastRc: ContractTransactionReceipt | undefined;

      onProgress?.(`Claiming ${claimables.length} tokens in ${batches.length} batch(es)…`);
      const provider = sd.runner?.provider as ethers.Provider;
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const overrides = await get1559Overrides(provider);  // <— HOISTED
      
        try {
          const tx = await sd.claimLatest(batch, { ...overrides, gasLimit: 1_000_000n });
          lastRc = await tx.wait();
        } catch (e) {
          console.warn(`[claimAllRewards] batch ${i + 1} failed, falling back per-token:`, e);
          for (const t of batch) {
            try {
              const tx = await sd.claimLatest([t], { ...overrides, gasLimit: 400_000n });
              lastRc = await tx.wait();
            } catch (err) {
              console.warn(`[claimAllRewards] token ${t} failed, skipping`, err);
            }
          }
        }
      }

      onProgress?.('Updating balances…');
      await Promise.all([loadBalances(), loadPendingRewards?.()].filter(Boolean) as Promise<any>[]);

      if (!lastRc) {
        onError?.(new Error('No claims succeeded.'));
        return undefined;
      }
      onSuccess?.(lastRc);
      return lastRc;
    } catch (error: any) {
      console.error('claimAllRewards failed:', error);
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
  ) => {
    setLoading(true);
    const txId = 'claimReward';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    try {
      const contracts = await getContracts(true);
      const sd = contracts?.stakingDistributor;
      if (!sd) throw new Error('Staking contract not initialized');

      onProgress?.('Claiming reward…');
      const provider = sd.runner?.provider as ethers.Provider;
      const overrides = await get1559Overrides(provider);
      const epoch = await sd.currentEpoch();
      const gas = await sd.claim.estimateGas(tokenAddress, epoch).catch(() => 180_000n);
      const tx = await sd.claim(tokenAddress, epoch, { ...overrides, gasLimit: (gas * 120n) / 100n });


      const receipt = await tx.wait();

      onProgress?.('Updating balances…');
      await Promise.all([loadBalances(), loadPendingRewards?.()].filter(Boolean) as Promise<any>[]);

      onSuccess?.(receipt);
      return receipt;
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
  // Views / Stats (FILE-FIRST)
// -----------------------------
  const getRewardTokens = useCallback(async (tokenFileUrl = "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/reward_tokens.json"): Promise<string[]> => {
    try {
      // primary: file
      const fileTokens = await loadClaimTokensFromJson(tokenFileUrl);
      return fileTokens;
    } catch (e) {
      console.error('getRewardTokens failed:', e);
      return [];
    }
  }, []);

  const calculateStakingAPR = useCallback(async (): Promise<StakingAPR> => {
    // Keep constant unless you’ve wired a model
    return { aero: DEFAULT_STAKING_APR, total: DEFAULT_STAKING_APR };
  }, []);

  const getStakingStats = useCallback(async (tokenFileUrl = "/claim_tokens_last7d.json"): Promise<StakingStats> => {
    try {
      const contracts = await getContracts();
      const sd = contracts?.stakingDistributor;
      if (!sd) return { totalStaked: '0', rewardTokensCount: 0 };

      const totalStakedRaw = await sd.totalStaked();
      const tokens = await loadClaimTokensFromJson(tokenFileUrl);
      return {
        totalStaked: ethers.formatEther(totalStakedRaw ?? 0n),
        rewardTokensCount: tokens.length,
      };
    } catch (e) {
      console.error('getStakingStats failed:', e);
      return { totalStaked: '0', rewardTokensCount: 0 };
    }
  }, [getContracts]);

  const getPendingRewards = useCallback(
    async (
      userAddress?: string,
      tokenFileUrl = "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/reward_tokens.json"
    ): Promise<PendingReward[]> => {
      try {
        const contracts = await getContracts();
        const sd = contracts?.stakingDistributor;
        if (!sd) return [];
  
        // Resolve the user address robustly (ethers v6)
        let addr = userAddress || "";
        if (!addr) {
          // Try signer address first if sd was built with a signer
          const r: any = sd.runner;
          if (r && typeof r.getAddress === "function") {
            try { addr = await r.getAddress(); } catch {}
          }
          // Fallback to whatever the caller placed in context
          if (!addr) addr = (contracts as any).account || "";
        }
        if (!addr) return [];
  
        // This is an epoch distributor: we need current + previous epoch
        if (typeof (sd as any).currentEpoch !== "function") return [];
  
        const nowEpoch: bigint = await sd.currentEpoch();
        const prevEpoch: bigint = nowEpoch - WEEK;
  
        // Get token list (same source the keeper uses)
        const tokens = await loadClaimTokensFromJson(tokenFileUrl);
        if (!tokens.length) return [];

        console.debug('[getPendingRewards] addr=', addr, 'tokens=', tokens.length, 'nowEpoch=', nowEpoch.toString());
  
        const toLower = tokens.map(t => t.toLowerCase());
  
        // Try batch path (fast): previewClaimsForEpoch for prev and now
        const hasBatch =
          typeof (sd as any).previewClaimsForEpoch === "function";
  
        let prevAmounts: bigint[] = [];
        let nowAmounts: bigint[] = [];
  
        if (hasBatch) {
          try {
            // batch prev
            const amountsPrev: bigint[] = await (sd as any).previewClaimsForEpoch(
              addr,
              toLower,
              prevEpoch
            );
            prevAmounts = amountsPrev || [];
            // batch now
            const amountsNow: bigint[] = await (sd as any).previewClaimsForEpoch(
              addr,
              toLower,
              nowEpoch
            );
            nowAmounts = amountsNow || [];
          } catch (e) {
            // fall back to per-token
            prevAmounts = [];
            nowAmounts = [];
          }
        }
  
        // Fallback if batch failed or returned wrong length
        const needPerToken =
          prevAmounts.length !== toLower.length ||
          nowAmounts.length !== toLower.length;
  
        if (needPerToken) {
          prevAmounts = [];
          nowAmounts = [];
          for (const t of toLower) {
            const [p, n] = await Promise.all([
              sd.previewClaim(addr, t, prevEpoch).catch(() => 0n),
              sd.previewClaim(addr, t, nowEpoch).catch(() => 0n),
            ]);
            prevAmounts.push(p ?? 0n);
            nowAmounts.push(n ?? 0n);
          }
        }
  
        // Build output: include only tokens with > 0 total (prev + now)
        const out: PendingReward[] = [];
        for (let i = 0; i < toLower.length; i++) {
          const total = (prevAmounts[i] ?? 0n) + (nowAmounts[i] ?? 0n);
          if (total === 0n) continue;
  
          const tokenAddr = toLower[i];
          let symbol = "ETH";
          let decimals = 18;
  
          if (tokenAddr !== ethers.ZeroAddress) {
            try {
              const erc20 = new ethers.Contract(
                tokenAddr,
                ["function symbol() view returns (string)", "function decimals() view returns (uint8)"],
                contracts.provider
              );
              const [sym, dec] = await Promise.all([erc20.symbol(), erc20.decimals()]);
              symbol = String(sym);
              decimals = Number(dec);
            } catch {
              symbol = `${tokenAddr.slice(0, 6)}...${tokenAddr.slice(-4)}`;
              decimals = 18;
            }
          }
  
          out.push({
            token: tokenAddr,
            amount: ethers.formatUnits(total, decimals),
            symbol,
          });
        }
  
        return out;
      } catch (e) {
        console.error("getPendingRewards failed:", e);
        return [];
      }
    },
    [getContracts]
  );
  

  // -----------------------------
  // Exit
  // -----------------------------
  const exit = useCallback(async (
    onSuccess?: SuccessCallback,
    onError?: ErrorCallback,
    onProgress?: ProgressCallback
  ) => {
    setLoading(true);
    const txId = 'exit';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    try {
      const contracts = await getContracts(true);
      const sd = contracts?.stakingDistributor;
      if (!sd) throw new Error('Staking contract not initialized');

      onProgress?.('Exiting position...');
      const provider = sd.runner?.provider as ethers.Provider;
      const overrides = await get1559Overrides(provider);
      // (optional) estimate gas
      const gas = await sd.exit.estimateGas().catch(() => 180_000n);
      const tx = await sd.exit({ ...overrides, gasLimit: (gas * 120n) / 100n });
      const receipt = await tx.wait();


      onProgress?.('Updating balances…');
      await Promise.all([loadBalances(), loadAllowances(), loadPendingRewards?.()].filter(Boolean) as Promise<any>[]);

      onSuccess?.(receipt);
      return receipt;
    } catch (error: any) {
      if (!isUserRejection(error)) console.error('exit failed:', error);
      onError?.(error);
      if (!isUserRejection(error)) throw error;
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
    getRewardTokens,
  };
};