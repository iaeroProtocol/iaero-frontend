"use client";
// src/contexts/ProtocolContext.js
import React, { createContext, useContext, useReducer, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import {
  connectWallet as connectWalletUtil,
  getNetworkInfo,
  getProvider,
  getSigner,
  formatTokenAmount
} from '../lib/ethereum';
import { getContractAddress, type ContractName } from '../contracts/addresses';
import { ABIS } from '../contracts/abis';
import { fetchPricesWithCache } from '@/lib/client-prices';

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
    liqSupply: string;
  };

  loading: {
    connection: boolean;
    balances: boolean;
    stats: boolean;
    transactions: Record<string, boolean>;
  };

  error: string | null;
};

type ProtocolAction =
  | { type: 'SET_CONNECTION'; payload: { connected: boolean; account: string | null; chainId: number | null; networkSupported: boolean } }
  | { type: 'SET_BALANCES'; payload: Partial<ProtocolState['balances']> }
  | { type: 'SET_ALLOWANCES'; payload: Partial<ProtocolState['allowances']> }
  | { type: 'SET_PENDING_REWARDS'; payload: Partial<ProtocolState['pendingRewards']> }
  | { type: 'SET_STATS'; payload: Partial<ProtocolState['stats']> }
  | { type: 'SET_LOADING'; payload: Partial<ProtocolState['loading']> }
  | { type: 'SET_TRANSACTION_LOADING'; payload: { id: string; loading: boolean } }
  | { type: 'SET_ERROR'; payload: string }
  | { type: 'CLEAR_ERROR' }
  | { type: 'DISCONNECT' };

type ABIKey = keyof typeof ABIS;

const ProtocolContext = createContext<any>(null);

// Initial state
const initialState: ProtocolState = {
  connected: false,
  account: null,
  chainId: null,
  networkSupported: false,

  balances: {
    aero: '0',
    iAero: '0',
    liq: '0',
    stakedIAero: '0',
    ethBalance: '0'
  },

  allowances: {
    aeroToVault: '0',
    iAeroToStaking: '0'
  },

  pendingRewards: {
    tokens: [],
    amounts: [],
    totalValue: '0'
  },

  stats: {
    tvl: '0',
    totalStaked: '0',
    aeroLocked: '0',
    emissionRate: '0',
    iAeroSupply: '0',
    liqSupply: '0'
  },

  loading: {
    connection: false,
    balances: false,
    stats: false,
    transactions: {}
  },

  error: null
};

// Reducer
function protocolReducer(state: ProtocolState, action: ProtocolAction): ProtocolState {
  switch (action.type) {
    case 'SET_CONNECTION':
      return {
        ...state,
        connected: action.payload.connected,
        account: action.payload.account,
        chainId: action.payload.chainId,
        networkSupported: action.payload.networkSupported,
        error: null
      };

    case 'SET_BALANCES':
      return { ...state, balances: { ...state.balances, ...action.payload } };

    case 'SET_ALLOWANCES':
      return { ...state, allowances: { ...state.allowances, ...action.payload } };

    case 'SET_PENDING_REWARDS':
      return { ...state, pendingRewards: { ...state.pendingRewards, ...action.payload } };

    case 'SET_STATS':
      return { ...state, stats: { ...state.stats, ...action.payload } };

    case 'SET_LOADING':
      return { ...state, loading: { ...state.loading, ...action.payload } };

    case 'SET_TRANSACTION_LOADING':
      return {
        ...state,
        loading: {
          ...state.loading,
          transactions: {
            ...state.loading.transactions,
            [action.payload.id]: action.payload.loading
          }
        }
      };

    case 'SET_ERROR':
      return { ...state, error: action.payload };

    case 'CLEAR_ERROR':
      return { ...state, error: null };

    case 'DISCONNECT':
      return { ...initialState };

    default:
      return state;
  }
}

// Helper function to safely format values for ethers v6
function safeFormatEther(value: bigint | string | number | undefined) {
  try {
    if (value == null) return '0';
    if (typeof value === 'bigint') return ethers.formatEther(value);
    if (typeof value === 'number') return value.toString();
    if (typeof value === 'string') {
      if (!value.startsWith('0x') && value.includes('.')) return value; // already formatted
      return ethers.formatEther(value);
    }
    return ethers.formatEther(BigInt(value as any));
  } catch (error: any) {
    console.error('Error formatting value:', value, error);
    return '0';
  }
}

// --- Helpers for epoch distributor ---
const DEFAULT_CLAIM_TOKENS_BY_CHAIN: Record<number, string[]> = {
  8453: [
    getContractAddress('AERO', 8453)!,
    getContractAddress('WETH', 8453) ?? '',
    getContractAddress('USDC', 8453) ?? '',
  ].filter(Boolean),
};

async function fetchEpochTokensViaRewardsSugar(contracts: any, chainId: number, limit = 200): Promise<string[]> {
  try {
    const rs = contracts.RewardsSugar;
    if (!rs) return [];
    const rows = await rs.epochsLatest(limit, 0);
    const seen = new Set<string>();
    for (const row of rows) {
      const bribes = row.bribes ?? [];
      const fees = row.fees ?? [];
      for (const b of bribes) if (b?.token) seen.add(b.token.toLowerCase());
      for (const f of fees) if (f?.token) seen.add(f.token.toLowerCase());
    }
    return Array.from(seen);
  } catch {
    return [];
  }
}

async function getEpochClaimTokenList(contracts: any, chainId: number): Promise<string[]> {
  const viaSugar = await fetchEpochTokensViaRewardsSugar(contracts, chainId);
  if (viaSugar.length) return viaSugar;
  return DEFAULT_CLAIM_TOKENS_BY_CHAIN[chainId] ?? [];
}

async function previewEpochPendingAll(
  sd: any,
  provider: ethers.Provider,
  account: string,
  tokens: string[],
): Promise<{ tokens: string[]; amounts: string[] }> {
  const nowEpoch: bigint = await sd.currentEpoch();
  const WEEK = 7n * 24n * 60n * 60n;
  const prevEpoch = nowEpoch - WEEK;

  const outTokens: string[] = [];
  const outAmounts: string[] = [];

  for (const t of tokens) {
    const aPrev: bigint = await sd.previewClaim(account, t, prevEpoch).catch(() => 0n);
    const aNow: bigint = await sd.previewClaim(account, t, nowEpoch).catch(() => 0n);
    const total: bigint = aPrev + aNow;
    if (total === 0n) continue;

    const decimals = t === ethers.ZeroAddress
      ? 18
      : await new ethers.Contract(t, ['function decimals() view returns (uint8)'], provider)
          .decimals()
          .catch(() => 18);

    outTokens.push(t);
    outAmounts.push(ethers.formatUnits(total, decimals));
  }
  return { tokens: outTokens, amounts: outAmounts };
}

// Context Provider
export function ProtocolProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(protocolReducer, initialState);

  // Get contract instances (read-only by default; signer only when needed)
  const getContracts = useCallback(async (needSigner = false) => {
    // Fallback to Base mainnet if wallet not connected yet
    const chainId = state.chainId ?? 8453;

    const provider = getProvider();
    const runner = needSigner ? await getSigner() : provider;

    const make = (name: ContractName, abiKey: ABIKey = name as ABIKey) => {
      try {
        const addr = getContractAddress(name, chainId);
        const abi = ABIS[abiKey];
        if (!abi) throw new Error(`ABI missing for ${abiKey}`);
        return new ethers.Contract(addr, abi, runner);
      } catch {
        return undefined;
      }
    };

    const map = {
      PermalockVault:        make('PermalockVault', 'PermalockVault'),
      StakingDistributor:    make('StakingDistributor', 'StakingDistributor'),
      LIQStakingDistributor: make('LIQStakingDistributor'),
      RewardsHarvester:      make('RewardsHarvester', 'RewardsHarvester'),
      VotingManager:         make('VotingManager', 'VotingManager'),
      iAERO:                 make('iAERO', 'iAERO'),
      LIQ:                   make('LIQ', 'LIQ'),
      AERO:                  make('AERO', 'AERO'),
      VeAERO:                make('VeAERO', 'VeAERO'),
      MockVeAERO:            make('MockVeAERO', 'MockVeAERO'),
      VOTER:                 make('VOTER', 'VOTER'),
      MockVoter:             make('MockVoter', 'MockVoter'),
      Router:                make('Router', 'Router'),
      PoolFactory:           make('PoolFactory', 'PoolFactory'),
      RewardsSugar:          make('RewardsSugar', 'RewardsSugar'),

      provider,
    };

    return {
      ...map,
      vault: map.PermalockVault,
      stakingDistributor: map.StakingDistributor,
      VeAEROResolved: map.VeAERO ?? map.MockVeAERO,
      VoterResolved: map.VOTER ?? map.MockVoter,
    };
  }, [state.chainId]);

  // Connect wallet
  const connectWallet = async () => {
    dispatch({ type: 'SET_LOADING', payload: { connection: true } });
    dispatch({ type: 'CLEAR_ERROR' });

    try {
      const result = await connectWalletUtil();
      if (!result) throw new Error('Failed to connect wallet');

      const { account, chainId } = result;
      const networkInfo = await getNetworkInfo();

      dispatch({
        type: 'SET_CONNECTION',
        payload: {
          connected: true,
          account,
          chainId,
          networkSupported: networkInfo.supported
        }
      });

      return true;
    } catch (error: any) {
      console.error('Wallet connection failed:', error);
      dispatch({ type: 'SET_ERROR', payload: error?.message || 'Failed to connect wallet' });
      return false;
    } finally {
      dispatch({ type: 'SET_LOADING', payload: { connection: false } });
    }
  };

  // Disconnect wallet
  const disconnectWallet = useCallback(() => {
    dispatch({ type: 'DISCONNECT' });
  }, []);

  // Load user balances
  const loadBalances = useCallback(async () => {
    if (!state.connected || !state.account || !state.networkSupported) return;

    dispatch({ type: 'SET_LOADING', payload: { balances: true } });

    try {
      const contracts = await getContracts();
      const provider = getProvider();

      if (!contracts.AERO || !contracts.iAERO || !contracts.LIQ || !contracts.stakingDistributor) {
        throw new Error('Required contracts not available on this network');
      }

      const [
        ethBalance,
        aeroBalance,
        iAeroBalance,
        liqBalance,
        stakedBalance,
      ] = await Promise.all([
        provider.getBalance(state.account),
        contracts.AERO.balanceOf(state.account),
        contracts.iAERO.balanceOf(state.account),
        contracts.LIQ?.balanceOf(state.account),
        contracts.stakingDistributor.balanceOf(state.account),
      ]);

      dispatch({
        type: 'SET_BALANCES',
        payload: {
          ethBalance: safeFormatEther(ethBalance),
          aero: safeFormatEther(aeroBalance),
          iAero: safeFormatEther(iAeroBalance),
          liq: safeFormatEther(liqBalance),
          stakedIAero: safeFormatEther(stakedBalance)
        }
      });

    } catch (error: any) {
      console.error('Failed to load balances:', error);
      dispatch({ type: 'SET_BALANCES', payload: { stakedIAero: '0' } });
      dispatch({ type: 'SET_ERROR', payload: 'Failed to load balances' });
    } finally {
      dispatch({ type: 'SET_LOADING', payload: { balances: false } });
    }

  }, [state.connected, state.account, state.networkSupported, getContracts]);

  // Load allowances
  const loadAllowances = useCallback(async () => {
    if (!state.connected || !state.account || !state.networkSupported) return;

    try {
      const contracts = await getContracts();

      const [aeroToVault, iAeroToStaking] = await Promise.all([
        contracts.AERO?.allowance(
          state.account,
          getContractAddress('PermalockVault', (state.chainId ?? 8453))
        ),
        contracts.iAERO?.allowance(
          state.account,
          getContractAddress('StakingDistributor', (state.chainId ?? 8453))
        )
      ]);

      dispatch({
        type: 'SET_ALLOWANCES',
        payload: {
          aeroToVault: safeFormatEther(aeroToVault),
          iAeroToStaking: safeFormatEther(iAeroToStaking)
        }
      });

    } catch (error: any) {
      console.error('Failed to load allowances:', error);
    }
  }, [state.connected, state.account, state.networkSupported, state.chainId, getContracts]);

  // Load pending rewards
  const loadPendingRewards = useCallback(async () => {
    if (!state.connected || !state.account || !state.networkSupported) return;

    try {
      const contracts = await getContracts();
      const sd = contracts?.stakingDistributor;
      if (!sd) return;

      // LEGACY streaming
      if (typeof sd.getPendingRewards === 'function') {
        const [tokens, amounts] = await sd.getPendingRewards(state.account);
        dispatch({
          type: 'SET_PENDING_REWARDS',
          payload: {
            tokens,
            amounts: amounts.map((x: any) => safeFormatEther(x)),
            totalValue: '0',
          },
        });
        return;
      }

      // EPOCH distributor
      if (typeof sd.currentEpoch === 'function' && typeof sd.previewClaim === 'function') {
        const tokens = await getEpochClaimTokenList(contracts, (state.chainId ?? 8453));
        if (!tokens.length) {
          dispatch({ type: 'SET_PENDING_REWARDS', payload: { tokens: [], amounts: [], totalValue: '0' } });
          return;
        }

        const { tokens: tks, amounts: amts } = await previewEpochPendingAll(sd, contracts.provider, state.account, tokens);

        const aeroAddr = getContractAddress('AERO', (state.chainId ?? 8453))?.toLowerCase();
        let totalValue = 0;
        for (let i = 0; i < tks.length; i++) {
          if (tks[i].toLowerCase() === aeroAddr) {
            const amt = Number(amts[i] || '0');
            const price = 1.1; // placeholder; hook up to PriceContext if desired
            totalValue += amt * price;
          }
        }

        dispatch({
          type: 'SET_PENDING_REWARDS',
          payload: { tokens: tks, amounts: amts, totalValue: totalValue.toFixed(2) },
        });
      }
    } catch (error: any) {
      console.error('Failed to load rewards:', error);
    }
  }, [state.connected, state.account, state.networkSupported, state.chainId, getContracts]);

  // Load protocol stats (read-only; works without wallet)
  const loadStats = useCallback(async () => {
    dispatch({ type: 'SET_LOADING', payload: { stats: true } });

    try {
      const contracts = await getContracts();

      const vaultStatus = await contracts.vault?.vaultStatus();

      const totalAeroLocked = vaultStatus?.[0] ?? 0n;
      const totalAeroLockedFormatted = safeFormatEther(totalAeroLocked);

      // Total iAERO staked (ok if undefined on some networks)
      let totalStakedFormatted = '0';
      try {
        const totalStaked = await contracts.stakingDistributor?.totalStaked();
        totalStakedFormatted = safeFormatEther(totalStaked);
      } catch {}

      // iAERO total supply
      let iAeroSupplyFormatted = '0';
      try {
        const iAeroSupply = await contracts.iAERO?.totalSupply();
        iAeroSupplyFormatted = safeFormatEther(iAeroSupply);
      } catch {}

      // LIQ circulating calc (best-effort)
      let liqCirculatingFormatted = '0';
      try {
        const liqSupply: bigint = await contracts.LIQ?.totalSupply();
        const VESTING_TOTAL = ethers.parseEther('20000000');
        let totalVested: bigint = 0n;
        try {
          const vesterAddr = getContractAddress('LIQLinearVester', (state.chainId ?? 8453));
          const vester = new ethers.Contract(
            vesterAddr,
            ['function vested(uint256 streamId, uint256 timestamp) view returns (uint256)'],
            contracts.provider
          );
          const currentBlock = await contracts.provider.getBlock('latest');
          const ts = currentBlock ? currentBlock.timestamp : Math.floor(Date.now() / 1000);
          const vested0 = await vester.vested(0, ts);
          const vested1 = await vester.vested(1, ts);
          totalVested = vested0 + vested1;
        } catch {}
        const unvested = VESTING_TOTAL - totalVested;
        const circulating = liqSupply - unvested;
        liqCirculatingFormatted = ethers.formatEther(circulating);
      } catch {}

      // Emission rate (best-effort)
      let emissionRateFormatted = '1';
      try {
        const emissionRate = await contracts.vault?.getCurrentEmissionRate();
        emissionRateFormatted = safeFormatEther(emissionRate);
      } catch {
        try {
          const baseEmissionRate = await contracts.vault?.baseEmissionRate();
          emissionRateFormatted = safeFormatEther(baseEmissionRate);
        } catch {}
      }

      // TVL via prices
      const prices = await fetchPricesWithCache();
      const aeroPrice = prices.aeroUsd || 0;
      const aeroLockedNum = parseFloat(totalAeroLockedFormatted);
      const totalValueLocked = aeroLockedNum * aeroPrice;

      const statsData = {
        tvl: totalValueLocked.toFixed(0),
        totalStaked: totalStakedFormatted,
        aeroLocked: totalAeroLockedFormatted,
        emissionRate: emissionRateFormatted,
        iAeroSupply: iAeroSupplyFormatted,
        liqSupply: liqCirculatingFormatted,
      };

      dispatch({ type: 'SET_STATS', payload: statsData });

    } catch (error: any) {
      console.error('Failed to load stats:', error);
      dispatch({
        type: 'SET_STATS',
        payload: {
          tvl: '0',
          totalStaked: '0',
          aeroLocked: '0',
          emissionRate: '1',
          iAeroSupply: '0',
          liqSupply: '0',
        }
      });
      dispatch({ type: 'SET_ERROR', payload: 'Failed to load protocol stats' });
    } finally {
      dispatch({ type: 'SET_LOADING', payload: { stats: false } });
    }
  }, [getContracts, state.chainId]);

  // --- NEW: initialize chain info on first paint (read-only) ---
  useEffect(() => {
    (async () => {
      try {
        const info = await getNetworkInfo(); // should work with public provider
        dispatch({
          type: 'SET_CONNECTION',
          payload: {
            connected: false,
            account: null,
            chainId: info?.chainId ?? 8453,
            networkSupported: info?.supported ?? true
          }
        });
      } catch {
        // fallback to Base mainnet
        dispatch({
          type: 'SET_CONNECTION',
          payload: {
            connected: false,
            account: null,
            chainId: 8453,
            networkSupported: true
          }
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Always load protocol stats (read-only) on mount + interval
  useEffect(() => {
    loadStats(); // first paint
    const statsInterval = setInterval(loadStats, 300000); // every 5 minutes
    return () => clearInterval(statsInterval);
  }, [loadStats]);

  // User-specific auto-refresh when connected
  useEffect(() => {
    if (state.connected && state.networkSupported) {
      loadBalances();
      loadAllowances();
      loadPendingRewards();

      const balanceInterval = setInterval(() => {
        loadBalances();
        loadAllowances();
        loadPendingRewards();
      }, 120000); // every 2 minutes

      return () => clearInterval(balanceInterval);
    }
  }, [state.connected, state.networkSupported, loadBalances, loadAllowances, loadPendingRewards]);

  // Check existing wallet session on mount (optional convenience)
  useEffect(() => {
    const checkConnection = async () => {
      if (typeof window !== 'undefined' && window.ethereum) {
        try {
          const accounts = await window.ethereum.request({ method: 'eth_accounts' });
          if (accounts.length > 0) {
            const networkInfo = await getNetworkInfo();
            dispatch({
              type: 'SET_CONNECTION',
              payload: {
                connected: true,
                account: accounts[0],
                chainId: networkInfo.chainId,
                networkSupported: networkInfo.supported
              }
            });
          }
        } catch (error: any) {
          console.error('Failed to check existing connection:', error);
        }
      }
    };
    checkConnection();
  }, []);

  const value = {
    ...state,
    connectWallet,
    disconnectWallet,
    loadBalances,
    loadAllowances,
    loadPendingRewards,
    loadStats,
    getContracts,
    dispatch
  };

  return (
    <ProtocolContext.Provider value={value}>
      {children}
    </ProtocolContext.Provider>
  );
}

// Custom hook
export const useProtocol = () => {
  const context = useContext(ProtocolContext);
  if (!context) {
    throw new Error('useProtocol must be used within ProtocolProvider');
  }
  return context;
};
