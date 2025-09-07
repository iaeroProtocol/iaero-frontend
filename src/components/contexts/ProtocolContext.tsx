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
const initialState = {
  // Connection
  connected: false,
  account: null,
  chainId: null,
  networkSupported: false,
  
  // Balances
  balances: {
    aero: '0',
    iAero: '0',
    liq: '0',
    stakedIAero: '0',
    ethBalance: '0'
  },
  
  // Allowances
  allowances: {
    aeroToVault: '0',
    iAeroToStaking: '0'
  },
  
  // Rewards
  pendingRewards: {
    tokens: [],
    amounts: [],
    totalValue: '0'
  },
  
  // Protocol Stats
  stats: {
    tvl: '0',
    totalStaked: '0',
    aeroLocked: '0',
    emissionRate: '0',
    iAeroSupply: '0',
    liqSupply: '0'
  },
  
  // Loading states
  loading: {
    connection: false,
    balances: false,
    stats: false,
    transactions: {}
  },
  
  // Error state
  error: null
};

// Reducer
function protocolReducer(state: ProtocolState, action: ProtocolAction) {
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
      return {
        ...state,
        balances: { ...state.balances, ...action.payload }
      };
    
    case 'SET_ALLOWANCES':
      return {
        ...state,
        allowances: { ...state.allowances, ...action.payload }
      };
    
    case 'SET_PENDING_REWARDS':
      return {
        ...state,
        pendingRewards: { ...state.pendingRewards, ...action.payload }
      };
    
    case 'SET_STATS':
      return {
        ...state,
        stats: { ...state.stats, ...action.payload }
      };
    
    case 'SET_LOADING':
      return {
        ...state,
        loading: { ...state.loading, ...action.payload }
      };
    
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
      return {
        ...state,
        error: action.payload
      };
    
    case 'CLEAR_ERROR':
      return {
        ...state,
        error: null
      };
    
    case 'DISCONNECT':
      return {
        ...initialState
      };
    
    default:
      return state;
  }
}

// Helper function to safely format values for ethers v6
function safeFormatEther(value: bigint | string | number | undefined) {
  try {
    if (!value) return '0';
    
    // Handle native bigint (ethers v6)
    if (typeof value === 'bigint') {
      return ethers.formatEther(value);
    }
    
    // Handle string
    if (typeof value === 'string') {
      // If it's already formatted, return it
      if (!value.startsWith('0x') && value.includes('.')) {
        return value;
      }
      // Convert hex or numeric string to bigint then format
      return ethers.formatEther(value);
    }
    
    // Handle number
    if (typeof value === 'number') {
      return value.toString();
    }
    
    // Try to convert to bigint and format
    return ethers.formatEther(BigInt(value));
  } catch (error: any) {
    console.error('Error formatting value:', value, error);
    return '0';
  }
}

// --- Helpers for epoch distributor ---

// Reasonable defaults if RewardsSugar isn't wired yet:
const DEFAULT_CLAIM_TOKENS_BY_CHAIN: Record<number, string[]> = {
  8453: [
    getContractAddress('AERO', 8453)!,       // AERO
    getContractAddress('WETH', 8453) ?? "",  // WETH if in addresses.ts
    getContractAddress('USDC', 8453) ?? "",  // USDC if in addresses.ts
  ].filter(Boolean),
};

async function fetchEpochTokensViaRewardsSugar(contracts: any, chainId: number, limit = 200): Promise<string[]> {
  try {
    const rs = contracts.RewardsSugar;
    if (!rs) return [];
    // Pull latest epochs across pools, grab bribe+fee token addresses
    const rows = await rs.epochsLatest(limit, 0);
    const seen = new Set<string>();
    for (const row of rows) {
      const bribes = row.bribes ?? [];
      const fees   = row.fees ?? [];
      for (const b of bribes) if (b?.token) seen.add(b.token.toLowerCase());
      for (const f of fees)   if (f?.token) seen.add(f.token.toLowerCase());
    }
    return Array.from(seen);
  } catch {
    return [];
  }
}

/** Final token candidate list: RewardsSugar (if available) else default config. */
async function getEpochClaimTokenList(contracts: any, chainId: number): Promise<string[]> {
  const viaSugar = await fetchEpochTokensViaRewardsSugar(contracts, chainId);
  if (viaSugar.length) return viaSugar;
  return DEFAULT_CLAIM_TOKENS_BY_CHAIN[chainId] ?? [];
}

/** Preview user pending (prev + current epoch) per token, with proper decimals. */
async function previewEpochPendingAll(
  sd: any,
  provider: ethers.Provider,
  account: string,
  tokens: string[],
) : Promise<{ tokens: string[]; amounts: string[] }> {
  // currentEpoch() returns uint256
  const nowEpoch: bigint = await sd.currentEpoch();
  const WEEK = 7n * 24n * 60n * 60n;
  const prevEpoch = nowEpoch - WEEK;

  const outTokens: string[] = [];
  const outAmounts: string[] = [];

  for (const t of tokens) {
    // previewClaim returns uint256
    const aPrev: bigint = await sd.previewClaim(account, t, prevEpoch).catch(() => 0n);
    const aNow:  bigint = await sd.previewClaim(account, t, nowEpoch).catch(() => 0n);
    const total: bigint = aPrev + aNow;

    if (total === 0n) continue;

    const decimals = t === ethers.ZeroAddress
      ? 18
      : await new ethers.Contract(t, ["function decimals() view returns (uint8)"], provider)
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


  // Get contract instances
  const getContracts = useCallback(async (needSigner = false) => {
    if (!state.chainId) throw new Error('No network connected');

    const provider = getProvider();
    const runner = needSigner ? await getSigner() : provider;

    // tiny helper that returns undefined if a contract isn't deployed on the current chain
        const make = (name: ContractName, abiKey: ABIKey = name as ABIKey) => {
      try {
        if (!state.chainId) return undefined;
        const addr = getContractAddress(name, state.chainId);
        const abi = ABIS[abiKey];
        if (!abi) throw new Error(`ABI missing for ${abiKey}`);
        return new ethers.Contract(addr, abi, runner);
      } catch {
        return undefined;
      }
    };

    const map = {
      // canonical names that match addresses.ts
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

      // keep a provider handy
      provider,
    };

    // Back-compat / ergonomic aliases used across hooks/components
    return {
      ...map,
      // existing code expects these:
      vault: map.PermalockVault,
      stakingDistributor: map.StakingDistributor,

      // expose a single "VeAERO" that works on both networks
      // (mainnet has VeAERO; sepolia has MockVeAERO)
      VeAEROResolved: map.VeAERO ?? map.MockVeAERO,
      VoterResolved:  map.VOTER ?? map.MockVoter,
    };
  }, [state.chainId]);


  // Connect wallet
  const connectWallet = async () => {
    dispatch({ type: 'SET_LOADING', payload: { connection: true } });
    dispatch({ type: 'CLEAR_ERROR' });

    try {
      const result = await connectWalletUtil();
      
      // Add null check
      if (!result) {
        throw new Error('Failed to connect wallet');
      }
      
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
      
      // Check required contracts exist
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
      // Clear stale values so UI reflects “zero” when the new contract can’t be read yet
      dispatch({
        type: 'SET_BALANCES',
        payload: { stakedIAero: '0' },
      });
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
          getContractAddress('PermalockVault', state.chainId!)
        ),
        contracts.iAERO?.allowance(
          state.account, 
          getContractAddress('StakingDistributor', state.chainId!)
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
  
      // LEGACY path (streaming distributor)
      if (typeof sd.getPendingRewards === 'function') {
        const [tokens, amounts] = await sd.getPendingRewards(state.account);
        // optional: keep your value calc
        dispatch({
          type: 'SET_PENDING_REWARDS',
          payload: {
            tokens,
            amounts: amounts.map((x: any) => safeFormatEther(x)),
            totalValue: '0', // your price calc can stay here
          },
        });
        return;
      }
  
      // EPOCH path
      if (typeof sd.currentEpoch === 'function' && typeof sd.previewClaim === 'function') {
        const tokens = await getEpochClaimTokenList(contracts, state.chainId!);
        if (!tokens.length) {
          dispatch({ type: 'SET_PENDING_REWARDS', payload: { tokens: [], amounts: [], totalValue: '0' } });
          return;
        }
  
        const { tokens: tks, amounts: amts } = await previewEpochPendingAll(sd, contracts.provider, state.account, tokens);
  
        // Optional value calc (example: only AERO priced)
        const aeroAddr = getContractAddress('AERO', state.chainId!)?.toLowerCase();
        let totalValue = 0;
        for (let i = 0; i < tks.length; i++) {
          if (tks[i].toLowerCase() === aeroAddr) {
            const amt = Number(amts[i] || '0');
            const price = 1.1; // your PriceContext can replace this
            totalValue += amt * price;
          }
        }
  
        dispatch({
          type: 'SET_PENDING_REWARDS',
          payload: {
            tokens: tks,
            amounts: amts,            // amounts properly formatted by each token's decimals
            totalValue: totalValue.toFixed(2),
          },
        });
      }
    } catch (error: any) {
      console.error('Failed to load rewards:', error);
      // leave prior rewards but avoid throwing
    }
  }, [state.connected, state.account, state.networkSupported, state.chainId, getContracts]);
  

  // Load protocol stats - FIXED VERSION
  const loadStats = useCallback(async () => {
    dispatch({ type: 'SET_LOADING', payload: { stats: true } });
    
    try {
      const contracts = await getContracts();
      
      // Get vault status - returns an array
      const vaultStatus = await contracts.vault?.vaultStatus();
      
      // Debug log the raw vault status
      console.log('Raw vault status:', {
        array: vaultStatus,
        index0: vaultStatus[0]?.toString(),
        index1: vaultStatus[1]?.toString(),
        index5: vaultStatus[5]?.toString()
      });
      
      // Extract values from the array with proper formatting
      // Index 0: totalUserDeposits (this is the ACTUAL AERO locked in vault)
      const totalAeroLocked = vaultStatus[0];
      const totalAeroLockedFormatted = safeFormatEther(totalAeroLocked);
      
      // Get total staked from StakingDistributor (iAERO staked for rewards)
      let totalStakedFormatted = '0';
      try {
        const totalStaked = await contracts.stakingDistributor?.totalStaked();
        totalStakedFormatted = safeFormatEther(totalStaked);
        console.log('Total iAERO staked in distributor:', totalStakedFormatted);
      } catch (e: any) {
        console.error('Failed to get totalStaked:', e);
      }
      
      // Get iAERO total supply (includes test mints)
      let iAeroSupplyFormatted = '0';
      try {
        const iAeroSupply = await contracts.iAERO?.totalSupply();
        iAeroSupplyFormatted = safeFormatEther(iAeroSupply);
        console.log('iAERO total supply (including test mints):', iAeroSupplyFormatted);
      } catch (e: any) {
        console.error('Failed to get iAERO supply:', e);
      }
            // Get LIQ total supply
      let liqSupplyFormatted = '0';
      let liqCirculatingFormatted = '0';
      try {
        const liqSupply: bigint = await contracts.LIQ?.totalSupply();
        // remaining to vest = LIQ held by the vesting contract
        let remainingToVest: bigint = 0n;
        try {
          const vesterAddr = getContractAddress('LIQLinearVester', state.chainId!);

          remainingToVest = await contracts.LIQ?.balanceOf(vesterAddr) || 0n;

        } catch (e: any) {
          console.debug('LIQLinearVester address/balance not available:', e);
        }

        const circulating = liqSupply > remainingToVest ? liqSupply - remainingToVest : 0n;
        liqSupplyFormatted       = ethers.formatEther(liqSupply);
        console.log('LIQ total supply:', liqSupplyFormatted);
        liqCirculatingFormatted  = ethers.formatEther(circulating);

        console.log('LIQ total:', liqSupplyFormatted, 'circulating:', liqCirculatingFormatted);
      } catch (e: any) {
        console.error('Failed to get LIQ supply:', e);
      }

      
      // Get emission rate
      let emissionRateFormatted = '1';
      try {
        const emissionRate = await contracts.vault?.getCurrentEmissionRate();
        emissionRateFormatted = safeFormatEther(emissionRate);
        console.log('Emission rate:', emissionRateFormatted);
      } catch (e: any) {
        // Try alternative method
        try {
          const baseEmissionRate = await contracts.vault?.baseEmissionRate();
          emissionRateFormatted = safeFormatEther(baseEmissionRate);
          console.log('Base emission rate:', emissionRateFormatted);
        } catch (e2: any) {
          console.log('Using default emission rate: 1');
        }
      }
      
      // Calculate TVL based on AERO locked in vault (not iAERO supply)
      const aeroPrice = 1.15;
      const aeroLockedNum = parseFloat(totalAeroLockedFormatted);
      const totalValueLocked = aeroLockedNum * aeroPrice;
      
      // Build stats object with correct mappings
      const statsData = {
        tvl: totalValueLocked.toFixed(0),
        totalStaked: totalStakedFormatted,     // iAERO staked in StakingDistributor
        aeroLocked: totalAeroLockedFormatted,  // AERO locked in vault (from vaultStatus[0])
        emissionRate: emissionRateFormatted,   // LIQ emission rate
        iAeroSupply: iAeroSupplyFormatted,     // Total iAERO minted (includes test mints)
        liqSupply: liqSupplyFormatted          // Total LIQ minted
      };
      
      console.log('Final formatted stats:', statsData);
      console.log('Note: iAERO supply includes test mints. Vault locked AERO:', totalAeroLockedFormatted);
      
      dispatch({
        type: 'SET_STATS',
        payload: statsData
      });
      
    } catch (error: any) {
      console.error('Failed to load stats:', error);
      
      // Set default values on error
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
  }, [getContracts]);

  // Auto-refresh data when connected
  useEffect(() => {
    if (state.connected && state.networkSupported) {
      // Initial load
      loadBalances();
      loadAllowances();
      loadPendingRewards();
      loadStats();
      
      // Set up intervals
      const balanceInterval = setInterval(() => {
        loadBalances();
        loadAllowances();
        loadPendingRewards();
      }, 30000); // Every 30 seconds
      
      const statsInterval = setInterval(loadStats, 60000); // Every minute
      
      return () => {
        clearInterval(balanceInterval);
        clearInterval(statsInterval);
      };
    }
  }, [state.connected, state.networkSupported, loadBalances, loadAllowances, loadPendingRewards, loadStats]);

  // Check connection on mount
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

  // Context value
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
