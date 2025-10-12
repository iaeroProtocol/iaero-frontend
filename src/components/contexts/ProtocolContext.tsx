"use client";

import React, { createContext, useContext, useEffect, useCallback, useMemo } from 'react';
import { useAccount, useChainId, usePublicClient } from 'wagmi';
import { getContractAddress, isSupportedNetwork, type ContractName } from '../contracts/addresses';
import { ABIS } from '../contracts/abis';
import { fetchPricesWithCache } from '@/lib/client-prices';

/* ========================= Types ========================= */

type ProtocolState = {
  connected: boolean;
  account: string | null;
  chainId: number | null;
  networkSupported: boolean;

  balances: {
    aero: string;
    iAero: string;
    liq: string;
    stakedIAero: string;
    ethBalance: string;
  };

  allowances: {
    aeroToVault: string;
    iAeroToStaking: string;
  };

  pendingRewards: {
    tokens: string[];
    amounts: string[];
    totalValue: string;
  };

  stats: {
    tvl: string;
    totalStaked: string;
    aeroLocked: string;
    emissionRate: string;
    iAeroSupply: string;
    liqSupply: string;       // circulating LIQ
    liqMarketCap: string;    // USD market cap of LIQ (circ * price)
  };

  loading: {
    connection: boolean;
    balances: boolean;
    stats: boolean;
    transactions: Record<string, boolean>;
  };

  error: string | null;
};

interface ProtocolContextValue extends ProtocolState {
  loadBalances: () => Promise<void>;
  loadAllowances: () => Promise<void>;
  loadPendingRewards: () => Promise<void>;
  loadStats: () => Promise<void>;
  setTransactionLoading: (id: string, loading: boolean) => void;
}

const ProtocolContext = createContext<ProtocolContextValue | null>(null);

/* ========================= Helpers ========================= */

// viem-style bigints are already JS bigint; format safely to string (18d)
const safeFormatEther = (value: bigint | undefined | null) => {
  if (!value) return '0';
  return (Number(value) / 1e18).toString();
};
const fmt18 = (x: bigint) => (Number(x) / 1e18).toString();

/** Minimal ABIs used only for a couple of read calls */
const VESTER_ABI = [
  {
    type: 'function',
    name: 'vested',
    stateMutability: 'view',
    inputs: [
      { name: 'streamId', type: 'uint256' },
      { name: 'timestamp', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const VAULT_META_ABI = [
  { type: 'function', name: 'treasury', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/* ========================= Provider ========================= */

export function ProtocolProvider({ children }: { children: React.ReactNode }) {
  // Wagmi
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const networkSupported = useMemo(() => isSupportedNetwork(chainId), [chainId]);

  // Local state
  const [state, setState] = React.useState<ProtocolState>({
    connected: false,
    account: null,
    chainId: null,
    networkSupported: false,
    balances: {
      aero: '0',
      iAero: '0',
      liq: '0',
      stakedIAero: '0',
      ethBalance: '0',
    },
    allowances: {
      aeroToVault: '0',
      iAeroToStaking: '0',
    },
    pendingRewards: {
      tokens: [],
      amounts: [],
      totalValue: '0',
    },
    stats: {
      tvl: '0',
      totalStaked: '0',
      aeroLocked: '0',
      emissionRate: '1',
      iAeroSupply: '0',
      liqSupply: '0',
      liqMarketCap: '0',
    },
    loading: {
      connection: false,
      balances: false,
      stats: false,
      transactions: {},
    },
    error: null,
  });

  // React to wallet/chain changes
  useEffect(() => {
    setState(prev => ({
      ...prev,
      connected: isConnected,
      account: address || null,
      chainId: chainId || null,
      networkSupported,
    }));
  }, [isConnected, address, chainId, networkSupported]);

  /* ========================= Balances ========================= */

  const loadBalances = useCallback(async () => {
    if (!isConnected || !address || !networkSupported || !publicClient) return;

    setState(prev => ({ ...prev, loading: { ...prev.loading, balances: true } }));

    try {
      const AERO = getContractAddress('AERO', chainId);
      const IAERO = getContractAddress('iAERO', chainId);
      const LIQ = getContractAddress('LIQ', chainId);
      const STAKE = getContractAddress('StakingDistributor', chainId);

      const [ethBalance, aero, iAero, liq, staked] = await Promise.all([
        publicClient.getBalance({ address }),
        publicClient.readContract({ address: AERO, abi: ABIS.AERO, functionName: 'balanceOf', args: [address] }) as Promise<bigint>,
        publicClient.readContract({ address: IAERO, abi: ABIS.iAERO, functionName: 'balanceOf', args: [address] }) as Promise<bigint>,
        publicClient.readContract({ address: LIQ,   abi: ABIS.LIQ,   functionName: 'balanceOf', args: [address] }) as Promise<bigint>,
        publicClient.readContract({ address: STAKE, abi: ABIS.StakingDistributor, functionName: 'balanceOf', args: [address] }) as Promise<bigint>,
      ]);

      setState(prev => ({
        ...prev,
        balances: {
          aero: safeFormatEther(aero),
          iAero: safeFormatEther(iAero),
          liq: safeFormatEther(liq),
          stakedIAero: safeFormatEther(staked),
          ethBalance: safeFormatEther(ethBalance),
        },
      }));
    } catch (error: any) {
      console.error('Failed to load balances:', error);
      setState(prev => ({ ...prev, error: 'Failed to load balances' }));
    } finally {
      setState(prev => ({ ...prev, loading: { ...prev.loading, balances: false } }));
    }
  }, [isConnected, address, chainId, networkSupported, publicClient]);

  /* ========================= Allowances ========================= */

  const loadAllowances = useCallback(async () => {
    if (!isConnected || !address || !networkSupported || !publicClient) return;

    try {
      const AERO = getContractAddress('AERO', chainId);
      const IAERO = getContractAddress('iAERO', chainId);
      const VAULT = getContractAddress('PermalockVault', chainId);
      const STAKE = getContractAddress('StakingDistributor', chainId);

      const [aeroToVault, iAeroToStaking] = await Promise.all([
        publicClient.readContract({ address: AERO,  abi: ABIS.AERO,  functionName: 'allowance', args: [address, VAULT] }) as Promise<bigint>,
        publicClient.readContract({ address: IAERO, abi: ABIS.iAERO, functionName: 'allowance', args: [address, STAKE] }) as Promise<bigint>,
      ]);

      setState(prev => ({
        ...prev,
        allowances: {
          aeroToVault: safeFormatEther(aeroToVault),
          iAeroToStaking: safeFormatEther(iAeroToStaking),
        },
      }));
    } catch (error: any) {
      console.error('Failed to load allowances:', error);
    }
  }, [isConnected, address, chainId, networkSupported, publicClient]);

  /* ========================= Stats (TVL, supplies, LIQ circ & mcap) ========================= */

  const loadStats = useCallback(async () => {
    setState(prev => ({ ...prev, loading: { ...prev.loading, stats: true } }));

    try {
      if (!publicClient) throw new Error('No public client');

      const VAULT = getContractAddress('PermalockVault', chainId);
      const STAKE = getContractAddress('StakingDistributor', chainId);
      const IAERO = getContractAddress('iAERO', chainId);
      const LIQ   = getContractAddress('LIQ', chainId);
      const VESTER= getContractAddress('LIQLinearVester', chainId);

      // 1) Read core stats
      const [vaultStatus, totalStaked, iAeroSupply, liqTotalSupply] = await Promise.all([
        publicClient.readContract({
          address: VAULT,
          abi: ABIS.PermalockVault,
          functionName: 'vaultStatus',
        }),
        publicClient.readContract({
          address: STAKE,
          abi: ABIS.StakingDistributor,
          functionName: 'totalStaked',
        }) as Promise<bigint>,
        publicClient.readContract({
          address: IAERO,
          abi: ABIS.iAERO,
          functionName: 'totalSupply',
        }) as Promise<bigint>,
        publicClient.readContract({
          address: LIQ,
          abi: ABIS.LIQ,
          functionName: 'totalSupply',
        }) as Promise<bigint>,
      ]);

      const totalAeroLocked = (vaultStatus as any)?.[0] ?? 0n;

      // 2) Treasury address (exclude its LIQ from circ)
      const treasuryAddr = await publicClient.readContract({
        address: VAULT,
        abi: VAULT_META_ABI,
        functionName: 'treasury',
      }) as `0x${string}`;

      // 3) Vester unvested (streams 0 & 1, 20M total)
      let unvested: bigint = 0n;
      try {
        const nowTs = BigInt(Math.floor(Date.now() / 1000));
        const [v0, v1] = await Promise.all([
          publicClient.readContract({ address: VESTER, abi: VESTER_ABI, functionName: 'vested', args: [0n, nowTs] }) as Promise<bigint>,
          publicClient.readContract({ address: VESTER, abi: VESTER_ABI, functionName: 'vested', args: [1n, nowTs] }) as Promise<bigint>,
        ]);
        const VESTING_TOTAL = 20_000_000n * 10n ** 18n; // 20M LIQ
        const totalVested   = (v0 ?? 0n) + (v1 ?? 0n);
        unvested = VESTING_TOTAL > totalVested ? (VESTING_TOTAL - totalVested) : 0n;
      } catch {
        // keep 0n on error
      }

      // 4) Treasury LIQ balance
      let treasuryBal: bigint = 0n;
      try {
        treasuryBal = await publicClient.readContract({
          address: LIQ,
          abi: ABIS.LIQ,
          functionName: 'balanceOf',
          args: [treasuryAddr],
        }) as bigint;
      } catch {}

      // 5) Circulating = total - unvested - treasury
      let liqCirc = (liqTotalSupply as bigint) ?? 0n;
      if (liqCirc > unvested)     liqCirc -= unvested; else liqCirc = 0n;
      if (liqCirc > treasuryBal)  liqCirc -= treasuryBal; else liqCirc = 0n;

      // 6) Prices & TVL
      const prices = await fetchPricesWithCache(); // expects .aeroUsd and .liqUsd if available
      const aeroPrice = prices.aeroUsd || 0;
      const liqPrice  = prices.liqUsd  || 0; // if missing, market cap falls back to 0
      const tvl = (Number(totalAeroLocked) / 1e18) * aeroPrice;

      // 7) Market cap = circulating * price
      const liqMcapNum = (Number(liqCirc) / 1e18) * liqPrice;

      setState(prev => ({
        ...prev,
        stats: {
          tvl: Math.round(tvl).toString(),
          totalStaked: safeFormatEther(totalStaked),
          aeroLocked:  safeFormatEther(totalAeroLocked),
          emissionRate:'1', // hook up getCurrentEmissionRate() later if desired
          iAeroSupply: safeFormatEther(iAeroSupply),
          liqSupply:   fmt18(liqCirc),                      // circulating supply
          liqMarketCap: Math.round(liqMcapNum).toString(),  // USD mcap
        },
      }));
    } catch (error: any) {
      console.error('Failed to load stats:', error);
    } finally {
      setState(prev => ({ ...prev, loading: { ...prev.loading, stats: false } }));
    }
  }, [chainId, publicClient]);

  /* ========================= Pending Rewards (no-op placeholder) ========================= */

  const loadPendingRewards = useCallback(async () => {
    // Kept for backwards compatibility; your dedicated components fetch rewards now.
    return;
  }, []);

  /* ========================= Tx loading flag ========================= */

  const setTransactionLoading = useCallback((id: string, loading: boolean) => {
    setState(prev => ({
      ...prev,
      loading: {
        ...prev.loading,
        transactions: {
          ...prev.loading.transactions,
          [id]: loading,
        },
      },
    }));
  }, []);

  /* ========================= Auto-refresh ========================= */

  useEffect(() => {
    if (isConnected && networkSupported) {
      loadBalances();
      loadAllowances();
      loadPendingRewards();
    }
  }, [isConnected, networkSupported, loadBalances, loadAllowances, loadPendingRewards]);

  useEffect(() => {
    loadStats();
    const interval = setInterval(loadStats, 300000); // 5 minutes
    return () => clearInterval(interval);
  }, [loadStats]);

  const value: ProtocolContextValue = {
    ...state,
    loadBalances,
    loadAllowances,
    loadPendingRewards,
    loadStats,
    setTransactionLoading,
  };

  return (
    <ProtocolContext.Provider value={value}>
      {children}
    </ProtocolContext.Provider>
  );
}

export const useProtocol = () => {
  const context = useContext(ProtocolContext);
  if (!context) {
    throw new Error('useProtocol must be used within ProtocolProvider');
  }
  return context;
};
