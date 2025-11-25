// ==============================================
// src/components/protocol/RewardsSection.tsx
// ==============================================
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePublicClient, useWriteContract } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { parseAbi, encodeAbiParameters } from 'viem';
import type { PublicClient, Transport, Chain } from 'viem';

import {
  Gift,
  TrendingUp,
  Loader2,
  Clock,
  RefreshCw,
  History,
  CheckCircle,
  Wallet,
  Coins,
} from "lucide-react";

import { useProtocol } from "@/components/contexts/ProtocolContext";
import { useStaking } from "../contracts/hooks/useStaking";
import { getContractAddress, type ContractName } from "../contracts/addresses";
import {
  parseInputToBigNumber,
  formatBigNumber,
  calculateYield,
} from "../lib/defi-utils";
import { usePrices } from "@/components/contexts/PriceContext";

// --------------------------------------------------------------------------
// 1. CONFIGURATION & ABIS
// --------------------------------------------------------------------------
const SWAPPER_ADDRESS = "0x25f11f947309df89bf4d36da5d9a9fb5f1e186c1"; 
const REGISTRY_ADDRESS = "0xd3e32B22Da6Bf601A5917ECd344a7Ec46BCA072c";

// ✅ AERODROME CONFIGURATION
const AERODROME_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const AERODROME_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da"; // Default V2 Factory

const AERO_ADDR = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const IAERO_ADDR = "0x81034Fb34009115F215f5d5F564AAc9FfA46a1Dc";
const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const AERODROME_ABI = [
  {
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      {
        name: 'routes',
        type: 'tuple[]',
        components: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'stable', type: 'bool' },
          { name: 'factory', type: 'address' }
        ]
      },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' }
    ],
    name: 'swapExactTokensForTokens',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      {
        name: 'routes',
        type: 'tuple[]',
        components: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'stable', type: 'bool' },
          { name: 'factory', type: 'address' }
        ]
      }
    ],
    name: 'getAmountsOut',
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const;

if (SWAPPER_ADDRESS.includes("YOUR_DEPLOYED")) {
    console.error("🚨 SWAPPER_ADDRESS not set in RewardsSection.tsx");
}

const REWARDS_JSON_URL = process.env.NEXT_PUBLIC_REWARDS_JSON_URL || "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/estimated_rewards_usd.json";
const STAKER_REWARDS_JSON_URL = process.env.NEXT_PUBLIC_STAKER_REWARDS_JSON_URL || "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/staker_rewards.json";

// [FIXED] Use JSON ABI to prevent 'Invalid ABI parameter' tuple errors
const SWAPPER_ABI = [
  {
    name: 'executePlanFromCaller',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'plan',
        type: 'tuple[]',
        components: [
          { name: 'kind', type: 'uint8' },
          { name: 'tokenIn', type: 'address' },
          { name: 'outToken', type: 'address' },
          { name: 'useAll', type: 'bool' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'quotedIn', type: 'uint256' },
          { name: 'quotedOut', type: 'uint256' },
          { name: 'slippageBps', type: 'uint16' },
          { name: 'data', type: 'bytes' },
          { name: 'viaPermit2', type: 'bool' },
          { name: 'permitSig', type: 'bytes' },
          { name: 'permitAmount', type: 'uint256' },
          { name: 'permitDeadline', type: 'uint256' },
          { name: 'permitNonce', type: 'uint256' }
        ]
      },
      { name: 'recipient', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  }
] as const;

const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);

const ERC20_FULL_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
]);

const PREVIEW_ABI = parseAbi(['function previewClaim(address user, address token, uint256 epoch) view returns (uint256)']);
const EPOCH_DIST_ABI = parseAbi(['function claimMany(address[] tokens, uint256[] epochs) external']);
const DIST_ABI = parseAbi(['function totalStaked() view returns (uint256)']);
// [NEW] Registry ABI
const REGISTRY_ABI = parseAbi(['function allTokens() view returns (address[])']);

const GAS_ESTIMATES = { claimSingle: 120000n, claimAll: 200000n };
const ZERO = "0x0000000000000000000000000000000000000000";
const DUST_USD = 0.01; 
const dustRawThreshold = (dec: number) => (dec >= 12 ? 10n ** BigInt(dec - 12) : 0n); 

// [FIXED] Matched to Solidity Enum: AERODROME=0, UNIV3=1, AGGREGATOR=2
const RouterKind = { AERODROME: 0, UNIV3: 1, AGGREGATOR: 2 };
const BATCH_SIZE = 8; 

// --------------------------------------------------------------------------
// 2. HELPERS
// --------------------------------------------------------------------------
const msgFromError = (e: any, fallback = "Transaction failed") => {
  if (e?.code === 4001) return "Transaction rejected by user";
  const m = String(e?.message || "").toLowerCase();
  if (m.includes("insufficient funds")) return "Insufficient ETH for gas fees";
  if (m.includes("no pending rewards")) return "No rewards available to claim";
  return fallback;
};

const formatTimeAgo = (t: number) => {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

// --------------------------------------------------------------------------
// 3. TYPES
// --------------------------------------------------------------------------
interface RewardsSectionProps {
  showToast: (m: string, t: "success" | "error" | "info" | "warning") => void;
  formatNumber: (v: string | number) => string;
}

interface RewardTokenRow {
  address: string;
  symbol: string;
  decimals: number;
  amountBN: bigint;
  usdValue: number;
  icon: string;
  gradient: string;
  epoch?: bigint;
  rawBN?: bigint;
  claimableBN: bigint; 
  walletBN: bigint;    
}

interface TxHistory {
  type: "claim" | "claimAll";
  tokens: string[];
  amounts: string[];
  totalValue: number;
  timestamp: number;
  txHash?: string;
}

// 1. Define the interface for your JSON structure
interface JsonRewardItem {
  token: string;      // The token contract address
  symbol: string;
  decimals: number;
  amount: string;     // The raw amount string
  epoch: number;      // CRITICAL: The timestamp
  priceUsd: number;
}

interface JsonResponse {
  address: string;
  pending: JsonRewardItem[];
}

async function fetchRewardsFromJson(userAddress: string): Promise<JsonRewardItem[]> {
  try {
    console.log(`🌐 Fetching Rewards from: ${STAKER_REWARDS_JSON_URL}`);
    const response = await fetch(STAKER_REWARDS_JSON_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to fetch rewards JSON: ${response.status}`);
    
    const data = await response.json();
    const targetAddr = userAddress.toLowerCase();

    console.log("👤 Looking for user:", targetAddr);

    // --- UNIVERSAL SEARCHER ---
    // This helper function recursively searches for an object containing "address": "your_address"
    // or looks for your address as a Key in a dictionary.
    function findUser(obj: any): any {
        if (!obj || typeof obj !== 'object') return null;

        // 1. Direct Match (Dictionary Mode): Key is the address
        if (obj[targetAddr]) return obj[targetAddr];

        // 2. Object Match (Array/Object Mode): Object has "address" property matching ours
        if (obj.address && typeof obj.address === 'string' && obj.address.toLowerCase() === targetAddr) {
            return obj;
        }

        // 3. Recursive Search (Arrays)
        if (Array.isArray(obj)) {
            for (const item of obj) {
                const found = findUser(item);
                if (found) return found;
            }
        }
        
        // 4. Recursive Search (Object Values - e.g. { "users": [...] })
        // We limit depth to avoid performance issues on massive files, but standard depth is fine.
        // Only dive into objects that don't look like reward items themselves.
        for (const key in obj) {
            if (key === 'address' || key === 'pending') continue; 
            if (typeof obj[key] === 'object') {
                const found = findUser(obj[key]);
                if (found) return found;
            }
        }

        return null;
    }
    // ---------------------------

    const userData = findUser(data);

    if (userData) {
        console.log("✅ Found user data!");
        return userData.pending || [];
    }

    console.warn("❌ User not found in staker_rewards.json (Universal Search)");
    // Debugging: print keys to help developer debug if it fails
    if (typeof data === 'object') console.log("Keys at root:", Object.keys(data).slice(0, 10));
    
    return [];

  } catch (e) {
    console.error("Error fetching JSON rewards:", e);
    return [];
  }
}

// --------------------------------------------------------------------------
// 4. COMPONENT
// --------------------------------------------------------------------------
export default function RewardsSection({ showToast, formatNumber }: RewardsSectionProps) {
  const { connected, networkSupported, chainId, account, balances, loading } = useProtocol();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { claimReward, loading: stakingLoading, calculateStakingAPR } = useStaking();
  const { prices } = usePrices();

  // State
  const [pending, setPending] = useState<any[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressStep, setProgressStep] = useState("");
  const [claimingSpecific, setClaimingSpecific] = useState<string | null>(null);
  const [stakingAPR, setStakingAPR] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [txHistory, setTxHistory] = useState<TxHistory[]>([]);
  const [estimatedGasCost, setEstimatedGasCost] = useState<string>("0");
  const [failedTokens, setFailedTokens] = useState<Array<{
    address: string;
    symbol: string;
    reason: string;
    step: string;
  }>>([]);
  
  const [rewardsLoading, setRewardsLoading] = useState(false);
  const [pricesLoading, setPricesLoading] = useState(false);
  const [apyPct, setApyPct] = useState<number | null>(null);
  const [apyLoading, setApyLoading] = useState<boolean>(false);
  const [apyError,   setApyError]   = useState<string | null>(null);

  // Data loading state
  const [priceByAddr, setPriceByAddr] = useState<Record<string, number>>({});
  const [lastEpoch, setLastEpoch] = useState<bigint | undefined>(undefined);

  const E18 = 10n ** 18n;
  const toE18 = (num: number) => BigInt(Math.round(num * 1e18));

  const formatUSD = (v: number, max = 6) => {
    if (!isFinite(v) || v === 0) return "$0";
    const tiny = 1e-6;
    if (v > 0 && v < tiny) {
      const threshold = tiny.toLocaleString(undefined, { maximumFractionDigits: max });
      return `< $${threshold}`;
    }
    return `$${v.toLocaleString(undefined, { minimumFractionDigits: v < 1 ? Math.min(max, 6) : 2, maximumFractionDigits: max })}`;
  };

  const txBaseUrl = useMemo(() => chainId === 84532 ? "https://sepolia.basescan.org/tx/" : chainId === 8453 ? "https://basescan.org/tx/" : "https://etherscan.io/tx/", [chainId]);
  const stakedIAeroBN = useMemo(() => parseInputToBigNumber(balances?.stakedIAero || "0"), [balances?.stakedIAero]);
  const DEFAULT_WETH_BASE = "0x4200000000000000000000000000000000000006";

  // --- INTERNAL HELPERS ---

  const estimateGasCost = useCallback(async (action: "single" | "all") => {
    try {
      if (!publicClient) return "0.001";
      const gasPrice = await publicClient.getGasPrice();
      const gasLimit = action === "all" ? GAS_ESTIMATES.claimAll : GAS_ESTIMATES.claimSingle;
      const gasCost = gasPrice * gasLimit;
      return formatBigNumber(gasCost, 18, 4);
    } catch {
      return "0.001";
    }
  }, [publicClient]);

  const trackFailedToken = useCallback((address: string, symbol: string, reason: string, step: string) => {
    setFailedTokens(prev => {
      // Avoid duplicates
      const exists = prev.find(t => t.address.toLowerCase() === address.toLowerCase());
      if (exists) return prev;
      
      return [...prev, { address, symbol, reason, step }];
    });
    
    console.log(`📝 Tracked failed token: ${symbol} (${address}) - ${reason}`);
  }, []);

  function addrOrEmpty(key: string) {
    try { const name = key as unknown as ContractName; return (getContractAddress(name, chainId || 8453) || '').toLowerCase(); } catch { return ''; }
  }
  const iAeroAddr = useMemo(() => (addrOrEmpty('iAERO') || addrOrEmpty('IAERO')).toLowerCase(), [chainId]);
  const distAddr  = useMemo(() => (addrOrEmpty('EPOCH_DIST') || addrOrEmpty('StakingDistributor') || addrOrEmpty('EPOCH_STAKING_DISTRIBUTOR')).toLowerCase(), [chainId]);
  const aeroAddr = useMemo(() => (addrOrEmpty('AERO')).toLowerCase(), [chainId]);
  const liqAddr = useMemo(() => (addrOrEmpty('LIQ')).toLowerCase(), [chainId]);
  

  function calculateSafeSlippage(quote: any, symbol: string): number {
    const priceImpact = Number(quote.estimatedPriceImpact || 0);
    
    // Add 1-2% buffer on top of price impact, cap at 5%
    const slippage = Math.min(priceImpact + 0.02, 0.05);
    const slippageBps = Math.ceil(slippage * 10000);
    
    console.log(`💱 ${symbol}: Impact ${(priceImpact*100).toFixed(2)}% → Slippage ${slippageBps/100}%`);
    
    return slippageBps;
  }

  function calculateSmartSlippage(
    quote: any,
    token: { symbol: string; address: string; decimals: number; walletBN: bigint },
    priceUSD: number
  ): { slippageBps: number; shouldSwap: boolean; reason: string } {
    
    const priceImpact = Number(quote.estimatedPriceImpact || 0);
    const valueUSD = (Number(token.walletBN) / 10 ** token.decimals) * priceUSD;
    
    console.log(`📊 ${token.symbol}:`);
    console.log(`   Price Impact from 0x: ${(priceImpact * 100).toFixed(2)}%`);
    console.log(`   Token Value: $${valueUSD.toFixed(2)}`);
    
    // Calculate base slippage from price impact
    let baseSlippageBps: number;
    
    if (priceImpact < 0.005) {
      // ✅ FIX: Very liquid tokens need 2% minimum (not 1%)
      // This accounts for quote staleness and price volatility
      baseSlippageBps = 200;  // Changed from 100 to 200
      console.log(`   → Very liquid, base slippage: 2%`);
    } else if (priceImpact < 0.01) {
      baseSlippageBps = 250;  // Changed from 150 to 250
      console.log(`   → Liquid, base slippage: 2.5%`);
    } else if (priceImpact < 0.03) {
      // Add 2% buffer (increased from 1%)
      baseSlippageBps = Math.ceil((priceImpact + 0.02) * 10000);
      console.log(`   → Medium liquidity, base slippage: ${baseSlippageBps / 100}% (impact + 2%)`);
    } else if (priceImpact < 0.05) {
      // Add 3% buffer (increased from 2%)
      baseSlippageBps = Math.ceil((priceImpact + 0.03) * 10000);
      console.log(`   → Low liquidity, base slippage: ${baseSlippageBps / 100}% (impact + 3%)`);
    } else {
      // Add 4% buffer (increased from 3%)
      baseSlippageBps = Math.ceil((priceImpact + 0.04) * 10000);
      console.log(`   → Very low liquidity, base slippage: ${baseSlippageBps / 100}% (impact + 4%)`);
    }
    
    // Rest of the function remains the same...
    let maxAllowedSlippage: number;
    
    if (valueUSD >= 100) {
      maxAllowedSlippage = 1500;
      console.log(`   → High value ($${valueUSD.toFixed(2)}), max allowed: 15%`);
    } else if (valueUSD >= 20) {
      maxAllowedSlippage = 1000;
      console.log(`   → Medium value ($${valueUSD.toFixed(2)}), max allowed: 10%`);
    } else if (valueUSD >= 5) {
      maxAllowedSlippage = 500;
      console.log(`   → Low value ($${valueUSD.toFixed(2)}), max allowed: 5%`);
    } else {
      maxAllowedSlippage = 300;
      console.log(`   → Dust value ($${valueUSD.toFixed(2)}), max allowed: 3%`);
    }
    
    const finalSlippageBps = Math.min(baseSlippageBps, maxAllowedSlippage);
    console.log(`   → Final slippage: ${finalSlippageBps / 100}%`);
  
    // Build proper reason string...
    let reason: string;
    const needsSlippage = baseSlippageBps;
  
    if (needsSlippage > maxAllowedSlippage) {
      const impactPct = (priceImpact * 100).toFixed(1);
      reason = `Value $${valueUSD.toFixed(2)} too low for ${impactPct}% impact (needs ${(needsSlippage / 100).toFixed(1)}% but max is ${maxAllowedSlippage / 100}%)`;
    } else if (finalSlippageBps > 1000) {
      reason = `High value ($${valueUSD.toFixed(2)}) - accepting ${finalSlippageBps / 100}% slippage (high MEV risk)`;
    } else if (finalSlippageBps > 500) {
      reason = `Medium value ($${valueUSD.toFixed(2)}) - using ${finalSlippageBps / 100}% slippage (moderate MEV risk)`;
    } else {
      reason = `Good liquidity ($${valueUSD.toFixed(2)}) - using ${finalSlippageBps / 100}% slippage`;
    }
  
    const shouldSwap = needsSlippage <= maxAllowedSlippage;
  
    return { slippageBps: finalSlippageBps, shouldSwap, reason };
  }

  async function fetchPricesForAddrs(addrs: string[], chainId?: number): Promise<Record<string, number>> {
    const unique = Array.from(new Set(addrs.map(a => a.toLowerCase()).filter(Boolean)));
    if (unique.length === 0) return {};
    try {
      const q = new URLSearchParams({ chainId: String(chainId ?? 8453), addresses: unique.join(',') });
      const res = await fetch(`/api/prices/token?${q}`, { cache: 'no-store' });
      if (res.ok) {
        const j = await res.json();
        const map = j?.prices || {};
        const out: Record<string, number> = {};
        for (const k of Object.keys(map)) out[k.toLowerCase()] = Number(map[k]) || 0;
        if (Object.keys(out).length) return out;
      }
    } catch {}
    try {
      const baseWeth = DEFAULT_WETH_BASE.toLowerCase();
      const forLlama = unique.map(a => (a === ZERO ? baseWeth : a));
      const ids = forLlama.map(a => `base:${a}`).join(',');
      const r = await fetch(`https://coins.llama.fi/prices/current/${ids}`);
      if (!r.ok) return {};
      const data = await r.json();
      const out: Record<string, number> = {};
      for (const [key, val] of Object.entries<any>(data.coins || {})) {
        const addr = key.split(':')[1]?.toLowerCase();
        const px = Number(val?.price);
        if (addr && isFinite(px)) out[addr] = px;
      }
      if (!out[ZERO] && out[baseWeth]) out[ZERO] = out[baseWeth];
      return out;
    } catch { return {}; }
  }

  // [NEW] Fetch token list from Registry Contract
  async function fetchRegistryTokens(): Promise<string[]> {
      if (!publicClient) return [];
      try {
          const tokens = await publicClient.readContract({
              address: REGISTRY_ADDRESS as `0x${string}`,
              abi: REGISTRY_ABI,
              functionName: 'allTokens',
          });
          return (tokens as string[]).map(t => t.toLowerCase());
      } catch (e) {
          console.error("Failed to fetch registry tokens:", e);
          return [];
      }
  }

  // ✅ FIXED: Use 'address' property consistently
  async function enrichTokens(tokens: string[]) {
      if (!publicClient) return [];
      const calls = tokens.flatMap(t => [
          { address: t as `0x${string}`, abi: ERC20_ABI, functionName: 'symbol' },
          { address: t as `0x${string}`, abi: ERC20_ABI, functionName: 'decimals' }
      ]);
      
      const res = await publicClient.multicall({ contracts: calls });
      
      return tokens.map((t, i) => {
          const symRes = res[2*i];
          const decRes = res[2*i+1];
          return {
              address: t,  // ✅ FIXED: Use 'address' instead of 'token'
              symbol: (symRes.status === 'success' ? symRes.result : 'TOKEN') as string,
              decimals: (decRes.status === 'success' ? Number(decRes.result) : 18) as number,
              epoch: 0n 
          };
      });
  }

  
  async function fetchStakersWeeklyUSD(): Promise<bigint> {
    const r = await fetch(REWARDS_JSON_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`rewards json ${r.status}`);
    const j = await r.json();
    if (j?.stakersWeeklyUSD_1e18) return BigInt(j.stakersWeeklyUSD_1e18);
    if (j?.estimatedWeeklyUSD_1e18) return (BigInt(j.estimatedWeeklyUSD_1e18) * 8000n) / 10000n;
    throw new Error("missing stakersWeeklyUSD");
  }

  // Smart Preflight: Checks both Distributor AND Wallet
  async function smartPreflight(items: any[], account: `0x${string}`, distributor: `0x${string}`) {
    try {
      const pc = publicClient as unknown as PublicClient<Transport, Chain> | undefined;
      if (!pc) return { results: items.map(it => ({ ...it, claimable: 0n, wallet: 0n })) };
      
      const calls = items.flatMap(it => ([
        { address: distributor, abi: PREVIEW_ABI, functionName: 'previewClaim', args: [account, it.address, it.epoch || 0n] },
        { address: it.address as `0x${string}`,    abi: ERC20_ABI,  functionName: 'balanceOf',     args: [distributor] },
        { address: it.address as `0x${string}`,    abi: ERC20_ABI,  functionName: 'balanceOf',     args: [account] }
      ]));
      
      const res = await pc.multicall({ contracts: calls });
      const results = items.map((it, i) => {
          const previewRes = res[3 * i];
          const distBalRes = res[3 * i + 1];
          const userBalRes = res[3 * i + 2];

          let claimable = (previewRes.status === 'success') ? (previewRes.result as bigint) : 0n;
          const distBal = (distBalRes.status === 'success') ? (distBalRes.result as bigint) : 0n;
          const wallet  = (userBalRes.status === 'success') ? (userBalRes.result as bigint) : 0n;

          if (claimable > distBal) {
            console.warn(`❌ Hiding ${it.symbol}: Protocol insolvent (Owes ${formatBigNumber(claimable, it.decimals)}, Has ${formatBigNumber(distBal, it.decimals)})`);
            claimable = 0n;
        } else if (claimable > 0n) {
            console.log(`✅ Keep ${it.symbol}: Solvent (Owes ${formatBigNumber(claimable, it.decimals)})`);
        }

          return { ...it, claimable, wallet, total: claimable + wallet };
      });

      return { results };
    } catch (err) {
      console.error("Smart preflight failed:", err);
      return { results: [] };
    }
  }

  // --- DATA FETCHING & REFRESH ---
  const handleRefresh = useCallback(async () => {
      if (!account || !publicClient) return;

      if (!distAddr) {
          console.error("❌ Staking Distributor Address (EPOCH_DIST) not found in addresses.ts");
          showToast("Contract configuration error", "error");
          return;
      }

      setIsRefreshing(true);
      setRewardsLoading(true);
      
      try {
        console.log("🔄 Refreshing rewards from JSON...");

        // 1. Fetch Raw JSON
        const jsonRewards = await fetchRewardsFromJson(account);
        
        if (jsonRewards.length === 0) {
          console.warn("No pending rewards found in JSON for this wallet");
          setPending([]);
          return;
        }

        // ✅ FIX 1: ENRICH TOKENS ON-CHAIN
        // We ignore the 'decimals' from JSON and get the REAL decimals from the chain.
        // This fixes the cbBTC 18 vs 8 decimal bug.
        const tokenAddresses = jsonRewards.map(j => j.token);
        const enrichedData = await enrichTokens(tokenAddresses);
        
        // Create a map for easy lookup: address -> decimals
        const decimalMap: Record<string, number> = {};
        enrichedData.forEach(t => {
            decimalMap[t.address.toLowerCase()] = t.decimals;
        });

        // 2. Map JSON to Preflight Format (using CORRECT decimals)
        const tokensToCheck = jsonRewards.map(item => {
          const realDecimals = decimalMap[item.token.toLowerCase()] || item.decimals;
          
          // Debug cbBTC specifically
          if (item.symbol === 'cbBTC') {
              console.log(`🔍 cbBTC Correction: JSON says ${item.decimals}, Chain says ${realDecimals}`);
          }

          return {
            address: item.token.toLowerCase(),
            symbol: item.symbol,
            decimals: realDecimals, // Use the on-chain decimals
            epoch: BigInt(item.epoch), 
            priceUsd: item.priceUsd
          };
        });

        // 3. Check On-Chain Status
        const { results } = await smartPreflight(
          tokensToCheck, 
          account as `0x${string}`, 
          distAddr as `0x${string}`
        );

        // 4. Filter & Normalize
        const validated = results.map((res: any) => {
            if (!res || res.total === 0n) return null;
            return {
                address: res.address,
                symbol: res.symbol,
                decimals: res.decimals,
                raw: res.claimable.toString(),
                claimableBN: res.claimable,
                walletBN: res.wallet,
                amountBN: res.claimable,
                // Correct Amount Human Readable
                amount: (Number(res.claimable) / 10 ** res.decimals).toString(),
                epoch: res.epoch, 
                priceUsd: res.priceUsd 
            };
        }).filter(Boolean);

        console.log(`✅ Found ${validated.length} claimable tokens`);
        setPending(validated);
        
        // 5. Fetch Prices
        if (validated.length > 0) {
          fetchPricesForAddrs(validated.map((p:any) => p.address), chainId || 8453)
            .then(map => setPriceByAddr(prev => ({...prev, ...map})));
        }
        
        showToast("Rewards refreshed", "info");

      } catch(e) { 
          console.error(e); 
          showToast("Failed to refresh rewards", "error");
          setPending([]); 
      } finally { 
          setRewardsLoading(false); 
          setIsRefreshing(false);
      }
  }, [account, publicClient, distAddr, showToast, chainId]);

  // --- EFFECTS ---
  useEffect(() => {
    if (connected && networkSupported) calculateStakingAPR().then(apr => setStakingAPR(Number((apr as any)?.aero || 0))).catch(console.error);
  }, [connected, networkSupported, calculateStakingAPR]);

  useEffect(() => { if (connected && networkSupported) estimateGasCost("all").then(setEstimatedGasCost); }, [connected, networkSupported, estimateGasCost]);

  // Trigger load on mount/connect
  useEffect(() => {
    if (connected && networkSupported && account) {
        handleRefresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, networkSupported, chainId, account]); 

  useEffect(() => {
    if (!pending.length) return;
    fetchPricesForAddrs(pending.map((p:any)=>p.address), chainId || 8453).then(map => setPriceByAddr(p => ({...p, ...map})));
  }, [pending, chainId]);

  useEffect(() => {
    if (!connected || !networkSupported || !publicClient) return;
    (async () => {
      setApyLoading(true);
      setApyError(null);
      try {
        const stakersWeeklyUSD_1e18 = await fetchStakersWeeklyUSD();
        if (!distAddr) throw new Error("staking distributor address missing");
        const totalStakedRaw = await publicClient.readContract({
          address: distAddr as `0x${string}`,
          abi: DIST_ABI,
          functionName: 'totalStaked',
        }) as bigint;
        if (!totalStakedRaw || totalStakedRaw === 0n) { setApyPct(0); setApyLoading(false); return; }
        let iaeroUsdNum = Number(prices?.iAERO?.usd ?? 0);
        if (!isFinite(iaeroUsdNum) || iaeroUsdNum <= 0) iaeroUsdNum = Number(prices?.AERO?.usd ?? 0);
        if (!isFinite(iaeroUsdNum) || iaeroUsdNum <= 0) throw new Error("iAERO/AERO price unavailable");
        const iaeroUsd_1e18 = toE18(iaeroUsdNum);
        const annualUSD_1e18 = stakersWeeklyUSD_1e18 * 52n;
        const tvlUSD_1e18 = (totalStakedRaw * iaeroUsd_1e18) / E18;
        if (tvlUSD_1e18 === 0n) { setApyPct(0); setApyLoading(false); return; }
        const apyRatio_1e18 = (annualUSD_1e18 * E18) / tvlUSD_1e18;
        const apyPct_1e18 = apyRatio_1e18 * 100n;
        setApyPct(Number(apyPct_1e18) / 1e18);
      } catch (e: any) {
        console.error('APY calc error:', e?.message || e);
        setApyError('APY unavailable');
        setApyPct(null);
      } finally { setApyLoading(false); }
    })();
  }, [connected, networkSupported, publicClient, chainId, iAeroAddr, distAddr, prices]);

  const rows: RewardTokenRow[] = useMemo(() => {
    return pending.map((p:any) => {
        const addr = p.address; 
        
        // ✅ FIX 2: PRIORITIZE LIVE PRICE
        // If live price exists and is > 0, use it. Otherwise fallback to JSON price.
        const livePrice = priceByAddr[addr];
        const price = (livePrice && livePrice > 0) ? livePrice : (p.priceUsd || 0);

        const human = Number(p.amount);
        const rawBN = BigInt(p.raw); 
        const decimals = p.decimals;
        const usdValue = human * price;
        
        // Always show if claimable > 0, regardless of dust value
        const isClaimable = (p.claimableBN || 0n) > 0n;
        if (!isClaimable && usdValue < DUST_USD && rawBN <= dustRawThreshold(decimals)) {
            return null;
        }

        let icon = '💰', gradient = 'from-slate-600 to-slate-700';
        if (p.symbol === 'AERO') { icon = '🚀'; gradient = 'from-blue-500 to-cyan-500'; }
        else if (addr === ZERO) { icon = '⚡'; gradient = 'from-purple-500 to-indigo-500'; }

        return {
            address: addr,
            symbol: p.symbol || 'TOKEN',
            decimals,
            amountBN: rawBN, 
            claimableBN: p.claimableBN || 0n,
            walletBN: p.walletBN || 0n,
            usdValue,
            icon, gradient,
            epoch: p.epoch ?? lastEpoch,
            rawBN
        };
    }).filter(Boolean) as RewardTokenRow[];
  }, [pending, priceByAddr, lastEpoch]);

  const hasRewards = rows.some(r => (r.rawBN??0n) > 0n);
  const totalRewardsUSD = rows.reduce((s,r) => s + r.usdValue, 0);

  const addToHistory = (type: TxHistory["type"], tokens: string[], amounts: string[], totalValue: number, txHash?: string) =>
    setTxHistory((prev) => [{ type, tokens, amounts, totalValue, timestamp: Date.now(), txHash }, ...prev.slice(0, 4)]);

  const checkGasBalance = async (): Promise<boolean> => {
    try {
      if (!publicClient) return true;
      const gasPrice = await publicClient.getGasPrice();
      const gasLimit = GAS_ESTIMATES.claimAll;
      const gasCost = gasPrice * gasLimit;
      const ethBal = parseInputToBigNumber(balances.ethBalance || "0");
      if (ethBal < gasCost) { showToast(`Insufficient ETH for gas. Need ~${formatBigNumber(gasCost, 18, 4)} ETH`, "warning"); return false; }
      return true;
    } catch { return true; }
  };

  // --------------------------------------------------------------------------
  // 5. SWAPPER LOGIC (WITH PRE-SCREENING)
  // --------------------------------------------------------------------------
  
  // ✅ FIXED: Property name consistency + better approval flow
  const ensureApprovals = async (rewardsToCheck: Array<{ address: string; symbol: string; walletBN: bigint }>) => {
    const candidates = rewardsToCheck.filter(r => 
        (r.walletBN || 0n) > 0n && 
        r.address && 
        r.address.startsWith("0x") && 
        r.address.length === 42
    );
  
    console.log(`🔐 Checking ${candidates.length} tokens for approval...`);
    
    for (let i = 0; i < candidates.length; i++) {
      const reward = candidates[i];
      console.log(`  [${i+1}/${candidates.length}] ${reward.symbol}...`);
      
      try {
        const currentAllowance = await publicClient?.readContract({
          address: reward.address as `0x${string}`,
          abi: ERC20_FULL_ABI,
          functionName: 'allowance',
          args: [account as `0x${string}`, SWAPPER_ADDRESS],
        }).catch(err => {
            console.warn(`    ⚠️  Read allowance failed`);
            trackFailedToken(reward.address, reward.symbol, `Allowance read failed: ${err.message}`, 'approval_read');
            return 0n; 
        }) as bigint;
  
        const amountToSwap = reward.walletBN || 0n;
  
        if (currentAllowance < amountToSwap) {
          // Reset if there's existing allowance
          if (currentAllowance > 0n) {
            try {
              console.log(`    🔄 Resetting allowance...`);
              const hash0 = await writeContractAsync({
                address: reward.address as `0x${string}`,
                abi: ERC20_FULL_ABI,
                functionName: 'approve',
                args: [SWAPPER_ADDRESS, 0n],
              });
              await publicClient?.waitForTransactionReceipt({ hash: hash0 });
            } catch (e: any) {
              console.warn(`    ⚠️  Reset failed:`, e.message);
            }
          }
  
          setProgressStep(`Approving ${reward.symbol}...`);
          console.log(`    📝 Approving...`);
          const hash = await writeContractAsync({
            address: reward.address as `0x${string}`,
            abi: ERC20_FULL_ABI,
            functionName: 'approve',
            args: [SWAPPER_ADDRESS, 115792089237316195423570985008687907853269984665640564039457584007913129639935n],
          });
          await publicClient?.waitForTransactionReceipt({ hash });
          showToast(`Approved ${reward.symbol}`, "success");
          console.log(`    ✅ Done`);
        } else {
          console.log(`    ✅ Already approved`);
        }
      } catch (e: any) {
        console.error(`    ❌ Approval FAILED:`, e.message);
        trackFailedToken(reward.address, reward.symbol, `Approval failed: ${e.message}`, 'approval_failed');
        showToast(`Skipping ${reward.symbol} (Approval Error)`, "warning");
        continue;
      }
    }
    console.log(`✅ Approval phase complete`);
  };

  const preScreenTokens = async (tokens: Array<{ address: string; symbol: string; decimals: number; walletBN: bigint }>) => {
    console.log(`\n🔍 === PRE-SCREENING PHASE ===`);
    console.log(`Checking prices for ${tokens.length} tokens...`);
    
    setProgressStep(`Pre-screening ${tokens.length} tokens for valid prices...`);
    
    // Fetch prices for all tokens
    const addresses = tokens.map(t => t.address);
    const priceMap = await fetchPricesForAddrs(addresses, chainId || 8453);
    
    // Filter tokens with valid prices
    const validTokens: typeof tokens = [];
    const scamTokens: typeof tokens = [];
    
    for (const token of tokens) {
      const price = priceMap[token.address.toLowerCase()];
      
      if (!price || price <= 0 || !isFinite(price)) {
        console.log(`  ❌ ${token.symbol}: No valid price (likely scam token)`);
        scamTokens.push(token);
        trackFailedToken(
          token.address, 
          token.symbol, 
          'No valid price data - likely scam token',
          'pre_screening'
        );
      } else {
        console.log(`  ✓ ${token.symbol}: $${price.toFixed(6)}`);
        validTokens.push(token);
      }
    }
    
    console.log(`\n✅ Pre-screening complete:`);
    console.log(`   Valid tokens: ${validTokens.length}`);
    console.log(`   Filtered out: ${scamTokens.length}`);
    
    if (scamTokens.length > 0) {
      console.log(`\n📋 Scam tokens filtered:`);
      scamTokens.forEach(t => console.log(`   • ${t.symbol} (${t.address})`));
      
      showToast(
        `Filtered out ${scamTokens.length} token(s) with no price data`,
        "info"
      );
    }
    
    return { validTokens, priceMap };
  };


  // ==============================================
// REPLACE buildSwapPlan IN RewardsSection.tsx
// ==============================================

const buildSwapPlan = async (
    targetToken: string, 
    rewardsToProcess: Array<{ address: string; symbol: string; decimals: number; walletBN: bigint }>,
    priceMap: Record<string, number>
  ) => {
    const plan: any[] = [];
    const ZERO_EX_URL = "/api/0x/quote";
    const headers = {}; 
    const validRewards = rewardsToProcess.filter(r => (r.walletBN || 0n) > 0n);

    console.log(`\n🔄 Building swap plan for ${validRewards.length} tokens...`);
    
    // Check if target is iAERO (case-insensitive)
    const isSweepingToIAERO = targetToken.toLowerCase() === IAERO_ADDR.toLowerCase();
    if (isSweepingToIAERO) {
        console.log("ℹ️  Target is iAERO - enabling higher slippage/routing tolerance (20%)");
    }

    // ... (Balance checking logic remains the same) ...
    const balanceCalls = validRewards.map(r => ({
      address: r.address as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'balanceOf' as const,
      args: [account as `0x${string}`]
    }));
    
    const balanceResults = await publicClient?.multicall({ contracts: balanceCalls });
    
    const tokensWithBalance = validRewards
      .map((reward, idx) => {
        const balResult = balanceResults?.[idx];
        const balance = balResult?.status === 'success' ? (balResult.result as bigint) : 0n;
        if (balance === 0n) return null;
        return { ...reward, currentBalance: balance };
      })
      .filter(Boolean) as Array<{ address: string; symbol: string; decimals: number; walletBN: bigint; currentBalance: bigint }>;
    
    if (tokensWithBalance.length === 0) return [];
    
    const QUOTE_BATCH_SIZE = 5; 
    const BATCH_DELAY_MS = 2000;
    const allQuoteResults: Array<any> = [];
    
    for (let i = 0; i < tokensWithBalance.length; i += QUOTE_BATCH_SIZE) {
      const batch = tokensWithBalance.slice(i, i + QUOTE_BATCH_SIZE);
      const batchPromises = batch.map(async (reward, idx) => {
        try {
          // ✅ ADJUSTMENT: Allow higher slippage for iAERO targets to find routes
          // 0.10 = 10%, 0.20 = 20%
          const slippageParam = isSweepingToIAERO ? '0.20' : '0.10'; 
          
          const params = new URLSearchParams({
            chainId: String(chainId || 8453),
            sellToken: reward.address,
            buyToken: targetToken,
            sellAmount: reward.currentBalance.toString(),
            taker: SWAPPER_ADDRESS,
            slippagePercentage: slippageParam,
            // Optional: Force disable 'RFQ' if it causes issues with obscure tokens
            // includedSources: 'Uniswap_V3,Aerodrome,SushiSwap,Balancer_V2' 
          });
          
          const res = await fetch(`${ZERO_EX_URL}?${params}`, { headers });
          
          if (!res.ok) {
              const errText = await res.text();
              return { success: false, reward, error: `HTTP ${res.status}: ${errText}`, step: 'quote_fetch' };
          }
          
          const quote = await res.json();
          if (quote.code || quote.reason) return { success: false, reward, error: quote.reason, step: 'quote_validation' };
          if (!quote.transaction?.data) return { success: false, reward, error: 'No tx data', step: 'quote_invalid' };
          
          return { success: true, reward, quote, currentBalance: reward.currentBalance };
        } catch (e: any) {
          return { success: false, reward, error: e.message, step: 'quote_exception' };
        }
      });
      
      const batchResults = await Promise.allSettled(batchPromises);
      allQuoteResults.push(...batchResults);
      if (i + QUOTE_BATCH_SIZE < tokensWithBalance.length) {
        await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }
    
    // ... (Processing results logic) ...
    allQuoteResults.forEach((result, idx) => {
      if (result.status === 'rejected') return;
      const data = result.value;
      
      if (!data.success) {
        // Log the specific error for debugging
        console.warn(`❌ Quote failed for ${data.reward.symbol}: ${data.error}`);
        trackFailedToken(data.reward.address, data.reward.symbol, data.error, data.step);
        return;
      }
      
      try {
        const encodedData = encodeAbiParameters(
          [{ type: 'address' }, { type: 'bytes' }],
          [data.quote.transaction.to, data.quote.transaction.data]
        );
        const priceUSD = priceMap[data.reward.address.toLowerCase()] || 0;
        
        const slippageDecision = calculateSmartSlippage(data.quote, data.reward, priceUSD);
        
        // ✅ OVERRIDE: If we are sweeping to iAERO, we might accept higher impact/slippage
        // If smart slippage says "No" but we are sweeping to iAERO, force it (up to 20%)
        if (isSweepingToIAERO && !slippageDecision.shouldSwap && slippageDecision.slippageBps < 2000) {
            console.log(`⚠️ Allowing higher slippage for ${data.reward.symbol} -> iAERO sweep`);
            slippageDecision.shouldSwap = true;
            slippageDecision.slippageBps = 2000; // Cap at 20%
        }

        if (!slippageDecision.shouldSwap) {
          trackFailedToken(data.reward.address, data.reward.symbol, slippageDecision.reason, 'slippage_too_high');
          return;
        }
        
        const optimisticBuyAmount = BigInt(data.quote.buyAmount);
        const slippageAmount = (optimisticBuyAmount * BigInt(slippageDecision.slippageBps)) / 10000n;
        const minAmountOut = optimisticBuyAmount - slippageAmount;
        
        plan.push({
          kind: RouterKind.AGGREGATOR,
          tokenIn: data.reward.address,
          outToken: targetToken,
          useAll: true, 
          amountIn: data.currentBalance,
          quotedIn: data.currentBalance,
          quotedOut: minAmountOut, 
          slippageBps: 0,
          data: encodedData,
          viaPermit2: false,
          permitSig: "0x",
          permitAmount: 0n,
          permitDeadline: 0n,
          permitNonce: 0n
        });
      } catch (e: any) {
        trackFailedToken(data.reward.address, data.reward.symbol, e.message, 'quote_encoding');
      }
    });
    return plan;
  };

  // Simulate each swap individually to find failures
  const simulateSwaps = async (plan: any[], recipient: string) => {
    console.log(`\n🧪 === SIMULATION PHASE ===`);
    console.log(`Testing ${plan.length} swaps in parallel...`);
    
    const simulations = plan.map(async (swap, idx) => {
      try {
        // Simulate this single swap
        await publicClient?.simulateContract({
          address: SWAPPER_ADDRESS as `0x${string}`,
          abi: SWAPPER_ABI,
          functionName: 'executePlanFromCaller',
          args: [[swap], recipient as `0x${string}`],
          account: account as `0x${string}`,
        });
        
        return {
          index: idx,
          success: true,
          swap,
        };
        
      } catch (e: any) {
        // Parse the error
        const errorMsg = String(e.message || e);
        let reason = 'Unknown error';
        
        if (errorMsg.includes('#1002')) {
          reason = 'Aggregator swap failed (slippage too tight or bad route)';
        } else if (errorMsg.includes('insufficient')) {
          reason = 'Insufficient balance';
        } else if (errorMsg.includes('allowance')) {
          reason = 'Insufficient allowance';
        } else if (errorMsg.includes('revert')) {
          reason = errorMsg.substring(0, 100);
        } else {
          reason = errorMsg.substring(0, 100);
        }
        
        return {
          index: idx,
          success: false,
          swap,
          error: reason,
        };
      }
    });
    
    const results = await Promise.all(simulations);
    
    // Separate passing and failing swaps
    const passing: any[] = [];
    const failing: Array<{ swap: any; error: string }> = [];
    
    results.forEach((result) => {
      if (result.success) {
        passing.push(result.swap);
        console.log(`  ✅ Swap ${result.index + 1}: PASS`);
      } else {
        failing.push({ swap: result.swap, error: result.error || "Unknown error" });
        console.log(`  ❌ Swap ${result.index + 1}: FAIL - ${result.error}`);
      }
    });
    
    console.log(`\n📊 Simulation Results:`);
    console.log(`   Passing: ${passing.length}`);
    console.log(`   Failing: ${failing.length}`);
    
    if (failing.length > 0) {
      console.log(`\n❌ Failed Swaps Details:`);
      failing.forEach((f, i) => {
        const tokenIn = f.swap.tokenIn;
        console.log(`   ${i + 1}. Token: ${tokenIn}`);
        console.log(`      Reason: ${f.error}`);
        console.log(`      Slippage: ${f.swap.slippageBps / 100}%`);
        console.log(`      Amount: ${f.swap.amountIn.toString()}`);
      });
    }
    
    return { passing, failing };
  };

  const executeSwapFlow = async (targetTokenAddr: string) => {
      console.log(`\n🚀 === STARTING SWAP FLOW ===`);
      setFailedTokens([]);  // Reset failed tokens list
    
      setProgressStep("Fetching token list from registry...");
      
      // 1. Fetch Registry Tokens
      console.log(`\n📋 Step 1: Fetching tokens (Registry + JSON)...`);
      const registryTokens = await fetchRegistryTokens();
      console.log(`Found ${registryTokens.length} tokens in registry`);
      
      // 2. Fetch JSON Tokens (This ensures we see what we just claimed)
      let jsonTokens: string[] = [];
      try {
          const jsonData = await fetchRewardsFromJson(account || "");
          jsonTokens = jsonData.map(j => j.token);
          console.log(`Found ${jsonTokens.length} tokens in JSON file`);
      } catch (e) {
          console.warn("Could not merge JSON tokens into swap flow", e);
      }

      // 3. Merge and Deduplicate
      const allTokens = Array.from(new Set([
          ...registryTokens.map(t => t.toLowerCase()), 
          ...jsonTokens.map(t => t.toLowerCase())
      ]));

      console.log(`Total unique tokens to check: ${allTokens.length}`);
      
      console.log(`\n📊 Step 2: Enriching token data...`);
      const enriched = await enrichTokens(registryTokens);
      console.log(`Enriched ${enriched.length} tokens`);
      
      // ✅ Get current wallet balances using multicall (much faster!)
      console.log(`\n💼 Step 3: Checking wallet balances (multicall)...`);
      
      const balanceCalls = enriched.map(t => ({
          address: t.address as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'balanceOf' as const,
          args: [account as `0x${string}`]
      }));
      
      const balanceResults = await publicClient?.multicall({ contracts: balanceCalls });
      
      const updatedRows: Array<{ address: string; symbol: string; decimals: number; walletBN: bigint }> = [];
      
      enriched.forEach((t, idx) => {
          const balResult = balanceResults?.[idx];
          const bal = balResult?.status === 'success' ? (balResult.result as bigint) : 0n;
          
          if (bal > 0n) {
              updatedRows.push({ 
                  address: t.address,
                  symbol: t.symbol, 
                  decimals: t.decimals, 
                  walletBN: bal 
              });
              console.log(`  ✓ ${t.symbol}: ${formatBigNumber(bal, t.decimals, 4)}`);
          }
      });

      if (updatedRows.length === 0) {
          throw new Error("No tokens with balance found in wallet");
      }
      
      console.log(`\n✅ Found ${updatedRows.length} tokens with balance`);
      
      // ✅ NEW: Step 4: PRE-SCREEN tokens to filter out scams BEFORE approvals
      console.log(`\n🔍 Step 4: Pre-screening tokens...`);
      const { validTokens, priceMap } = await preScreenTokens(updatedRows);  // ← Destructure both

      if (validTokens.length === 0) {
          throw new Error("No valid tokens found after pre-screening");
      }

      console.log(`\n✅ ${validTokens.length}/${updatedRows.length} tokens passed pre-screening`);

      // ✅ Step 5: Approve
      console.log(`\n🔐 Step 5: Approving ${validTokens.length} validated tokens...`);
      setProgressStep(`Approving ${validTokens.length} validated tokens...`);
      await ensureApprovals(validTokens);

      // ✅ Step 6: Execute in batches with FRESH quotes per batch
      const totalTokens = validTokens.length;
      let successfulSwaps = 0;
      let totalBatches = Math.ceil(totalTokens / BATCH_SIZE);

      console.log(`\n📦 Processing ${totalTokens} tokens in ${totalBatches} batches`);

      for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
        const batchStart = batchNum * BATCH_SIZE;
        const batchEnd = Math.min(batchStart + BATCH_SIZE, totalTokens);
        const batchTokens = validTokens.slice(batchStart, batchEnd);
        
        console.log(`\n🔄 === BATCH ${batchNum + 1}/${totalBatches} ===`);
        console.log(`Processing tokens ${batchStart + 1}-${batchEnd} of ${totalTokens}`);
        
        try {
          // Fetch fresh quotes
          setProgressStep(`Batch ${batchNum + 1}/${totalBatches}: Fetching fresh quotes...`);
          console.log(`💱 Fetching fresh quotes for batch...`);
          
          const batchPlan = await buildSwapPlan(targetTokenAddr, batchTokens, priceMap);
          
          if (batchPlan.length === 0) {
            console.log(`⏭️  Batch ${batchNum + 1}: No valid quotes, skipping`);
            continue;
          }
          
          console.log(`✅ Built plan with ${batchPlan.length} swaps for this batch`);
          
          // ✅ NEW: Simulate each swap individually
          setProgressStep(`Batch ${batchNum + 1}/${totalBatches}: Simulating ${batchPlan.length} swaps...`);
          console.log(`🧪 Simulating swaps...`);
          
          const { passing, failing } = await simulateSwaps(batchPlan, account as `0x${string}`);
          
          // Track failing swaps
          failing.forEach(({ swap, error }) => {
            // Find the token symbol from batchTokens
            const token = batchTokens.find(t => t.address.toLowerCase() === swap.tokenIn.toLowerCase());
            if (token) {
              trackFailedToken(
                token.address,
                token.symbol,
                error,
                'simulation_failed'
              );
            }
          });
          
          if (passing.length === 0) {
            console.log(`⏭️  Batch ${batchNum + 1}: All swaps failed simulation, skipping`);
            showToast(`Batch ${batchNum + 1}: All swaps failed simulation`, "warning");
            continue;
          }
          
          console.log(`✅ ${passing.length}/${batchPlan.length} individual swaps passed simulation`);
          
          // ✅ FIX 3: Simulate the ENTIRE BATCH together
          try {
            setProgressStep(`Batch ${batchNum + 1}/${totalBatches}: Simulating full batch...`);
            console.log(`📦 Simulating full batch of ${passing.length} swaps together...`);
            
            await publicClient?.simulateContract({
              address: SWAPPER_ADDRESS as `0x${string}`,
              abi: SWAPPER_ABI,
              functionName: 'executePlanFromCaller',
              args: [passing, account as `0x${string}`],
              account: account as `0x${string}`,
            });
            
            console.log(`✅ Full batch simulation passed!`);
            
          } catch (batchError: any) {
            console.error(`❌ Full batch simulation failed:`, batchError.message);
            
            // Try to identify the problematic swap(s)
            console.log(`🔍 Testing smaller batches to isolate issue...`);
            
            // Split into two halves and test
            if (passing.length > 1) {
              const mid = Math.floor(passing.length / 2);
              const firstHalf = passing.slice(0, mid);
              const secondHalf = passing.slice(mid);
              
              let workingSwaps: any[] = [];
              
              // Test first half
              try {
                await publicClient?.simulateContract({
                  address: SWAPPER_ADDRESS as `0x${string}`,
                  abi: SWAPPER_ABI,
                  functionName: 'executePlanFromCaller',
                  args: [firstHalf, account as `0x${string}`],
                  account: account as `0x${string}`,
                });
                console.log(`  ✅ First half (${firstHalf.length} swaps) passed`);
                workingSwaps.push(...firstHalf);
              } catch {
                console.log(`  ❌ First half failed`);
              }
              
              // Test second half
              try {
                await publicClient?.simulateContract({
                  address: SWAPPER_ADDRESS as `0x${string}`,
                  abi: SWAPPER_ABI,
                  functionName: 'executePlanFromCaller',
                  args: [secondHalf, account as `0x${string}`],
                  account: account as `0x${string}`,
                });
                console.log(`  ✅ Second half (${secondHalf.length} swaps) passed`);
                workingSwaps.push(...secondHalf);
              } catch {
                console.log(`  ❌ Second half failed`);
              }
              
              if (workingSwaps.length === 0) {
                console.log(`⏭️  No swaps passed batch simulation, skipping batch`);
                showToast(`Batch ${batchNum + 1}: Failed batch simulation`, "error");
                
                // Track all tokens as failed
                passing.forEach(swap => {
                  const token = batchTokens.find(t => t.address.toLowerCase() === swap.tokenIn.toLowerCase());
                  if (token) {
                    trackFailedToken(token.address, token.symbol, `Batch simulation failed: ${batchError.message}`, 'batch_simulation_failed');
                  }
                });
                
                continue;
              }
              
              // Update passing to only include working swaps
              passing.length = 0;
              passing.push(...workingSwaps);
              console.log(`✅ Proceeding with ${passing.length} working swaps`);
            } else {
              // Single swap that passed individual but failed batch - should not happen
              console.log(`⏭️  Single swap failed batch simulation (unexpected), skipping`);
              continue;
            }
          }
          
          // Execute only the passing swaps
          setProgressStep(`Batch ${batchNum + 1}/${totalBatches}: Executing ${passing.length} swaps...`);
          console.log(`🔄 Executing batch ${batchNum + 1} with ${passing.length} swaps...`);
          
          const hash = await writeContractAsync({
            address: SWAPPER_ADDRESS,
            abi: SWAPPER_ABI,
            functionName: 'executePlanFromCaller',
            args: [passing, account as `0x${string}`], 
          });

          await publicClient?.waitForTransactionReceipt({ hash });
          successfulSwaps += passing.length;
          console.log(`  ✅ Batch ${batchNum + 1} executed successfully (${passing.length} swaps)`);
          
        } catch (e: any) {
          console.error(`  ❌ Batch ${batchNum + 1} execution failed:`, e.message);
          
          // Track all tokens in failed batch
          batchTokens.forEach((token) => {
            trackFailedToken(
              token.address, 
              token.symbol, 
              `Batch ${batchNum + 1} execution failed: ${e.message}`,
              'batch_execution'
            );
          });
          
          showToast(`Batch ${batchNum + 1} failed - continuing with remaining tokens`, "warning");
        }
      }

      console.log(`\n✅ === SWAP FLOW COMPLETE ===`);
      console.log(`Successful: ${successfulSwaps}/${totalTokens} swaps`);
  
      if (failedTokens.length > 0) {
        console.log(`\n⚠️  === FAILED TOKENS REPORT ===`);
        console.log(`${failedTokens.length} tokens failed during the swap process:\n`);
        
        // Group by reason for easier analysis
        const byStep: Record<string, typeof failedTokens> = {};
        failedTokens.forEach(token => {
          if (!byStep[token.step]) byStep[token.step] = [];
          byStep[token.step].push(token);
        });
        
        Object.entries(byStep).forEach(([step, tokens]) => {
          console.log(`\n📋 Failed during: ${step.toUpperCase()}`);
          tokens.forEach(t => {
            console.log(`  • ${t.symbol}`);
            console.log(`    Address: ${t.address}`);
            console.log(`    Reason: ${t.reason}\n`);
          });
        });
        
        // Master list for easy copy-paste
        console.log(`\n📝 === ADDRESSES TO DE-REGISTER ===`);
        console.log(`Copy this list to remove from your token registry:\n`);
        failedTokens.forEach(t => {
          console.log(`${t.address}  // ${t.symbol} - ${t.reason}`);
        });
        console.log(`\n=================================\n`);
        
        showToast(
          `Swap complete! ${successfulSwaps}/${totalTokens} succeeded. ${failedTokens.length} failed - check console for details`,
          failedTokens.length === totalTokens ? "error" : "warning"
        );
      } else {
        console.log(`✅ All ${successfulSwaps} tokens swapped successfully!\n`);
        showToast(`All ${successfulSwaps} tokens swapped successfully!`, "success");
      }
    };

  // --- Handlers ---
  const handleClaimAndConvert = async () => {
    if (!account) return;
    if (SWAPPER_ADDRESS.includes("YOUR_DEPLOYED")) { showToast("Swapper not configured!", "error"); return; }
    setIsProcessing(true);
    try {
      // 1. Check & Claim
      const tokensToClaim = rows
        .filter(r => (r.claimableBN || 0n) > 0n)
        .map(r => r.address);
        
      if (tokensToClaim.length > 0) {
        setProgressStep(`Claiming ${tokensToClaim.length} rewards first...`);
        await new Promise<void>((resolve, reject) => {
            claimSelected(tokensToClaim, {
                onProgress: (m: string) => setProgressStep(m),
                onSuccess: () => { 
                    showToast("Claimed! Refreshing...", "success");
                    handleRefresh().then(resolve); 
                },
                onError: (e: any) => reject(e)
            });
        });
      }

      // 2. Swap (Uses internal refresh)
      const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; 
      await executeSwapFlow(USDC_ADDR);
      
      await handleRefresh(); 
    } catch (e: any) {
      if (!e.message?.includes("User rejected")) { console.error(e); showToast(msgFromError(e, "Process failed"), "error"); }
    } finally { setIsProcessing(false); setProgressStep(""); }
  };

  const handleClaimAndCompound = async () => {
    if (!account) return;
    if (SWAPPER_ADDRESS.includes("YOUR_DEPLOYED")) { showToast("Swapper not configured!", "error"); return; }
    setIsProcessing(true);
    try {
      // 1. Claim
      const tokensToClaim = rows
        .filter(r => (r.claimableBN || 0n) > 0n)
        .map(r => r.address);

      if (tokensToClaim.length > 0) {
         setProgressStep(`Claiming ${tokensToClaim.length} rewards first...`);
         await new Promise<void>((resolve, reject) => {
             claimSelected(tokensToClaim, { 
                 onProgress: (m: string) => setProgressStep(m), 
                 onSuccess: () => { handleRefresh().then(resolve); }, 
                 onError: (e: any) => reject(e) 
             });
         });
      }

      // 2. Swap
      await executeSwapFlow(IAERO_ADDR);
      
      await handleRefresh(); 
    } catch (e: any) {
      if (!e.message?.includes("User rejected")) { console.error(e); showToast(msgFromError(e, "Process failed"), "error"); }
    } finally { setIsProcessing(false); setProgressStep(""); }
  };

  // [NEW] Handler for Just Swapping (No Claim)
  const handleSwapAllRewards = async () => {
    if (!account) return;
    if (SWAPPER_ADDRESS.includes("YOUR_DEPLOYED")) { showToast("Swapper not configured!", "error"); return; }
    setIsProcessing(true);
    try {
      const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; 
      await executeSwapFlow(USDC_ADDR);
      await handleRefresh(); 
    } catch (e: any) {
      if (!e.message?.includes("User rejected")) { console.error(e); showToast(msgFromError(e, "Swap failed"), "error"); }
    } finally { setIsProcessing(false); setProgressStep(""); }
  };

  const handleSweepToIAERO = async () => {
    if (!account) return;
    if (SWAPPER_ADDRESS.includes("YOUR_DEPLOYED")) { showToast("Swapper not configured!", "error"); return; }
    
    setIsProcessing(true);
    try {
      // ---------------------------------------------------------
      // STEP 1: Sweep rewards to AERO (using 0x Aggregator)
      // ---------------------------------------------------------
      console.log("🔄 Step 1: Sweeping rewards to AERO...");
      setProgressStep("Step 1/2: Sweeping rewards to AERO...");
      
      const startAERO = await publicClient?.readContract({
          address: AERO_ADDR as `0x${string}`,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [account as `0x${string}`]
      }) as bigint || 0n;

      await executeSwapFlow(AERO_ADDR);
      
      // ---------------------------------------------------------
      // STEP 2: Wait for AERO Balance Update
      // ---------------------------------------------------------
      console.log("🔄 Waiting for AERO balance to update...");
      setProgressStep("Waiting for blockchain to index...");
      
      let aeroBalance = 0n;
      let attempts = 0;
      const maxAttempts = 10;

      while (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 2000));
          aeroBalance = await publicClient?.readContract({
              address: AERO_ADDR as `0x${string}`,
              abi: ERC20_ABI,
              functionName: 'balanceOf',
              args: [account as `0x${string}`]
          }) as bigint || 0n;

          if (aeroBalance > startAERO) break;
          attempts++;
      }

      if (aeroBalance <= 0n) {
          console.warn("⚠️ No AERO balance found. Aborting Step 2.");
          showToast("Sweep partial: Rewards moved to AERO, but balance didn't update.", "warning");
          return;
      }

      console.log(`💰 AERO Balance to Swap: ${formatBigNumber(aeroBalance, 18, 4)}`);

      // ---------------------------------------------------------
      // STEP 3: Direct Swap (AERO -> iAERO) on Aerodrome
      // ---------------------------------------------------------
      console.log("🔄 Step 3: Swapping AERO -> iAERO via Aerodrome...");
      setProgressStep("Step 2/2: Aerodrome Swap (AERO->iAERO)...");

      // A. Approve Router
      const currentAllowance = await publicClient?.readContract({
          address: AERO_ADDR as `0x${string}`,
          abi: ERC20_FULL_ABI,
          functionName: 'allowance',
          args: [account as `0x${string}`, AERODROME_ROUTER as `0x${string}`],
      }) as bigint;

      if (currentAllowance < aeroBalance) {
          console.log("📝 Approving Aerodrome Router...");
          const approveHash = await writeContractAsync({
              address: AERO_ADDR as `0x${string}`,
              abi: ERC20_FULL_ABI,
              functionName: 'approve',
              args: [AERODROME_ROUTER as `0x${string}`, aeroBalance],
          });
          await publicClient?.waitForTransactionReceipt({ hash: approveHash });
          console.log("✅ Approved");
      }

      // B. Define Route with Explicit Casting
      const routes = [
          { 
            from: AERO_ADDR as `0x${string}`, 
            to: IAERO_ADDR as `0x${string}`, 
            stable: false, 
            factory: AERODROME_FACTORY as `0x${string}` 
          }
      ];

      // C. Calculate Min Output
      let amountOutMin = 0n;
      try {
          const amounts = await publicClient?.readContract({
              address: AERODROME_ROUTER as `0x${string}`,
              abi: AERODROME_ABI,
              functionName: 'getAmountsOut',
              args: [aeroBalance, routes]
          }) as readonly bigint[]; // viem returns readonly
          
          if (amounts && amounts.length > 0) {
              const expected = amounts[amounts.length - 1];
              amountOutMin = (expected * 9500n) / 10000n; 
              console.log(`📊 Expected: ${formatBigNumber(expected, 18, 4)} iAERO`);
          }
      } catch (err) {
          console.warn("⚠️ Quote failed, defaulting to 0 min output", err);
      }

      // D. Execute Swap
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200); 
      
      const hash = await writeContractAsync({
          address: AERODROME_ROUTER as `0x${string}`,
          abi: AERODROME_ABI,
          functionName: 'swapExactTokensForTokens',
          args: [aeroBalance, amountOutMin, routes, account as `0x${string}`, deadline],
      });

      await publicClient?.waitForTransactionReceipt({ hash });
      
      showToast("Successfully swept all rewards to iAERO!", "success");
      await handleRefresh(); 

    } catch (e: any) {
      if (!e.message?.includes("User rejected")) { 
          console.error(e); 
          showToast(msgFromError(e, "Sweep failed"), "error"); 
      }
    } finally { 
      setIsProcessing(false); 
      setProgressStep(""); 
    }
  };

  async function preflight(items: any[], account: `0x${string}`, distributor: `0x${string}`) {
      try {
        const pc = publicClient as unknown as PublicClient<Transport, Chain> | undefined;
        if (!pc) return { keep: items.map(it => ({ ...it, preview: 0n })), drop: [] };
        
        const calls = items.flatMap(it => ([
          { address: distributor, abi: PREVIEW_ABI, functionName: 'previewClaim', args: [account, it.address, it.epoch] },
          { address: it.address as `0x${string}`,     abi: ERC20_ABI,  functionName: 'balanceOf',      args: [distributor] }
        ]));
        
        const res = await pc.multicall({ contracts: calls });
        const keep: any[] = [], drop: any[] = [];
        
        for (let i = 0; i < items.length; i++) {
          const previewRes = res[2 * i];
          const balRes = res[2 * i + 1];
          
          const p = previewRes.status === 'success' ? (previewRes.result as bigint) : 0n;
          const b = balRes.status === 'success' ? (balRes.result as bigint) : 0n;

          if (p > 0n) {
              // ✅ SMART FILTERING:
              // If distributor has enough funds (b >= p), add to 'keep'.
              // If distributor is broke, add to 'drop'.
              if (b >= p) {
                  keep.push({ ...items[i], preview: p });
              } else {
                  console.warn(`⚠️ Skipping ${items[i].symbol}: Distributor empty (Need ${p}, has ${b})`);
                  drop.push({ ...items[i], preview: p, bal: b, reason: 'Protocol Insufficient Funds' });
              }
          }
        }
        return { keep, drop };
      } catch (err) {
        console.error("Preflight check failed:", err);
        return { keep: items.map(it => ({ ...it, preview: 0n })), drop: [] };
      }
  }

  // --------- Render ----------
  async function claimSelected(tokens: string[], { onProgress, onSuccess, onError }: any) {
      try {
        // 1. Prepare the list of tokens to check
        const selected = rows
          .filter((r: any) => (r.rawBN ?? 0n) > 0n && tokens.includes(r.address) && r.address !== ZERO)
          .map(r => {
              const epochToUse = typeof r.epoch === 'bigint' ? r.epoch : (lastEpoch || 0n);
              return {
                  address: r.address as `0x${string}`,
                  epoch: epochToUse, 
                  hadExplicitEpoch: true, 
                  symbol: r.symbol,
              };
          });

        const missingEpochs = selected.some(x => !x.hadExplicitEpoch);
        if (missingEpochs && lastEpoch) showToast(`Using funded epoch ${lastEpoch.toString()} for batch claim.`, "info");
        
        if (selected.length === 0) { onProgress?.('No claimable rewards.'); onSuccess?.(); return; }

        // 2. Run Smart Preflight (Filter out empty distributor wallets)
        // ✅ CHANGE: Destructure 'drop' to see what failed
        const { keep, drop } = await preflight(selected, account as `0x${string}`, distAddr as `0x${string}`);

        // ✅ CHANGE: Notify user if tokens were dropped
        if (drop.length > 0) {
            const skippedNames = drop.map((d: any) => d.symbol).join(", ");
            // Warn the user, but don't throw an error. We will proceed with the 'keep' list.
            showToast(`Skipping ${drop.length} tokens (Protocol Wallet Empty): ${skippedNames}`, "warning");
        }

        // ✅ CHANGE: If nothing is left to claim, exit gracefully
        if (keep.length === 0) { 
            onProgress?.('No tokens available with sufficient protocol liquidity.'); 
            onSuccess?.(); 
            return; 
        }

        // 3. Execute Claim (Only for 'keep' items)
        const haveAllEpochs = keep.every(x => typeof x.epoch === 'bigint');
        const MAX = 50;

        if (distAddr && haveAllEpochs) {
          for (let i = 0; i < keep.length; i += MAX) {
            const slice = keep.slice(i, i + MAX);
            
            onProgress?.(`Submitting batch claim ${Math.floor(i / MAX) + 1}/${Math.ceil(keep.length / MAX)}…`);
            
            let gas: bigint | undefined;
            try {
              gas = await publicClient?.estimateContractGas({
                account: account as `0x${string}`,
                address: distAddr as `0x${string}`,
                abi: EPOCH_DIST_ABI,
                functionName: 'claimMany',
                args: [slice.map(x => x.address), slice.map(x => x.epoch as bigint)],
              });
            } catch { gas = 200_000n + BigInt(slice.length) * 120_000n; }
            
            const hash = await writeContractAsync({
              address: distAddr as `0x${string}`,
              abi: EPOCH_DIST_ABI,
              functionName: 'claimMany',
              args: [slice.map(x => x.address), slice.map(x => x.epoch as bigint)],
              ...(gas ? { gas } : {}),
            });
            await publicClient?.waitForTransactionReceipt({ hash });
          }
          onSuccess?.();
          return;
        }

        // Fallback: Claim one by one (using 'keep' list)
        for (let i = 0; i < keep.length; i++) {
          onProgress?.(keep.length > 1 ? `Claiming ${i + 1}/${keep.length} tokens…` : "Claiming token…");
          await claimReward(
              keep[i].address, 
              (receipt: any) => { if (i === keep.length - 1) onSuccess?.(receipt); }, 
              (e: any) => { onError?.(e); }, 
              (m?: string) => onProgress?.(m)
          );
        }
      } catch (e) { onError?.(e); throw e; }
  }

  const handleClaimAll = async () => {
    if (!hasRewards) return showToast("No rewards to claim", "info");
    if (!(await checkGasBalance())) return;
    setIsProcessing(true);
    setProgressStep("Preparing claim…");
    try {
      const selected = rows.filter((r: any) => (r.rawBN ?? 0n) > 0n).map(r => r.address);
      await claimSelected(selected, {
        onProgress: (msg: any) => setProgressStep(msg ?? ""),
        onSuccess: (receipt: any) => {
          setShowSuccess(true);
          setTimeout(() => setShowSuccess(false), 3000);
          addToHistory("claimAll", rows.map((r) => r.symbol), rows.map((r) => formatBigNumber(r.amountBN, r.decimals, 4)), totalRewardsUSD, receipt?.transactionHash);
          showToast(`Successfully claimed all rewards! Total value: ${formatUSD(totalRewardsUSD, 6)}`, "success");
          void (async () => { try { await handleRefresh(); } catch {} })();
        },
        onError: (e: any) => showToast(msgFromError(e, "Claim failed"), "error"),
      });
    } finally { setIsProcessing(false); setProgressStep(""); }
  };

  const handleClaimSpecific = async (address: string, symbol: string, decimals: number, amountBN: bigint, usdValue: number) => {
    if (!amountBN || amountBN === 0n) return showToast(`No ${symbol} rewards to claim`, "info");
    setClaimingSpecific(address);
    setProgressStep(`Claiming ${symbol}…`);
    try {
      await claimSelected([address], {
        onProgress: (msg: any) => setProgressStep(msg ?? ""),
        onSuccess: (receipt: any) => {
          const pretty = formatBigNumber(amountBN, decimals, 4);
          setShowSuccess(true);
          setTimeout(() => setShowSuccess(false), 3000);
          addToHistory("claim", [symbol], [pretty], usdValue, receipt?.transactionHash);
          showToast(`Successfully claimed ${pretty} ${symbol}!`, "success");
          void (async () => { try { await handleRefresh(); } catch {} })();
        },
        onError: (e: any) => showToast(msgFromError(e, `${symbol} claim failed`), "error"),
      });
    } finally { setClaimingSpecific(null); setProgressStep(""); }
  };

  if (!connected || !networkSupported) {
    return (
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-6">
        <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
          <CardContent className="p-8 text-center">
            <Gift className="w-12 h-12 text-slate-400 mx-auto mb-4" />
            <h3 className="text-xl font-semibold text-white mb-2">Connect Wallet</h3>
            <p className="text-slate-400">Connect your wallet and stake iAERO to start earning rewards</p>
          </CardContent>
        </Card>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-6">
      <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-white flex items-center space-x-2">
              <Gift className="w-6 h-6" />
              <span>Your Rewards</span>
              {loading?.balances && <Loader2 className="w-4 h-4 animate-spin ml-2" />}
            </CardTitle>
            <div className="flex items-center gap-3">
              {apyLoading ? (
                <span className="text-slate-400 text-sm flex items-center gap-1">
                  <Loader2 className="w-4 h-4 animate-spin" /> APY
                </span>
              ) : apyError ? (
                <span className="text-slate-400 text-sm">APY —</span>
              ) : apyPct !== null ? (
                <div className="px-2 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-sm flex items-center gap-1">
                  <TrendingUp className="w-4 h-4" />
                  {apyPct.toFixed(2)}%
                </div>
              ) : null}
              <Button
                onClick={handleRefresh}
                disabled={isRefreshing || isProcessing || rewardsLoading || pricesLoading}
                variant="ghost"
                size="sm"
                className="text-slate-400 hover:text-white"
              >
                <RefreshCw className={`w-4 h-4 ${isRefreshing ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>
        </CardHeader>

        <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 mb-4">
          <div className="flex items-start space-x-3">
            <Clock className="w-5 h-5 text-blue-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-base text-slate-300">
                Rewards will be distributed and claimable after epoch ends sometime
                after 11:59am UTC every Thursday
              </p>
            </div>
          </div>
        </div>

        {(rewardsLoading || pricesLoading) && (
          <div className="bg-slate-700/30 border border-slate-600/30 rounded-xl p-3 mx-6 mb-2">
            <div className="flex items-center gap-2 text-sm text-slate-300">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading your rewards…</span>
            </div>
          </div>
        )}

        <CardContent className="space-y-6">
          {stakedIAeroBN === 0n && (
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4">
              <div className="flex items-center space-x-3">
                <Clock className="w-5 h-5 text-blue-400" />
                <div>
                  <p className="font-medium text-blue-400">Start Earning Rewards</p>
                  <p className="text-sm text-slate-300 mt-1">Stake your iAERO tokens to start earning AERO and other rewards</p>
                </div>
              </div>
            </div>
          )}

          {(rewardsLoading || pricesLoading) ? (
            <div className="rounded-xl overflow-hidden border border-slate-700/40">
              <div className="grid grid-cols-12 bg-slate-900/70 px-4 py-3 text-slate-400 text-xs">
                <div className="col-span-4">Token</div>
                <div className="col-span-4 text-right">Amount</div>
                <div className="col-span-3 text-right">Value</div>
                <div className="col-span-1"></div>
              </div>
              {[...Array(3)].map((_, i) => (
                <div key={i} className="grid grid-cols-12 items-center px-4 py-3 border-t border-slate-800/50">
                  <div className="col-span-4">
                    <div className="h-4 w-24 bg-slate-700/50 rounded animate-pulse mb-1" />
                    <div className="h-3 w-40 bg-slate-800/50 rounded animate-pulse" />
                  </div>
                  <div className="col-span-4 text-right">
                    <div className="h-4 w-24 bg-slate-700/50 rounded ml-auto animate-pulse" />
                  </div>
                  <div className="col-span-3 text-right">
                    <div className="h-4 w-20 bg-slate-700/50 rounded ml-auto animate-pulse" />
                  </div>
                  <div className="col-span-1" />
                </div>
              ))}
            </div>
          ) : rows.length > 0 ? (
            <>
              <div className="rounded-xl overflow-hidden border border-slate-700/40">
                <div className="grid grid-cols-12 bg-slate-900/70 px-4 py-3 text-slate-400 text-xs">
                  <div className="col-span-4">Token</div>
                  <div className="col-span-4 text-right">Amount</div>
                  <div className="col-span-3 text-right">Value</div>
                  <div className="col-span-1"></div>
                </div>

                {rows.map((r, idx) => (
                  <div key={`${r.address}-${idx}`} className="grid grid-cols-12 items-center px-4 py-3 border-t border-slate-800/50 hover:bg-slate-900/60 transition">
                    <div className="col-span-4 flex items-center gap-2 truncate">
                      <span className="text-xl">{r.icon}</span>
                      <div className="min-w-0">
                        <div className="text-white font-medium truncate">{r.symbol}</div>
                        <div className="text-[11px] text-slate-400 truncate">{r.address}</div>
                      </div>
                    </div>
                    <div className="col-span-4 text-right text-white">
                        <div className="flex flex-col items-end">
                            <span>{formatBigNumber(r.amountBN, r.decimals, 6)}</span>
                            {(r.walletBN > 0n) && (
                                <span className="text-[10px] text-slate-500 flex items-center gap-1">
                                    <Wallet className="w-3 h-3" /> {formatBigNumber(r.walletBN, r.decimals, 2)} held
                                </span>
                            )}
                        </div>
                    </div>
                    <div className="col-span-3 text-right"><span className="text-emerald-400 font-medium">{r.usdValue ? `$${r.usdValue.toLocaleString(undefined, { maximumFractionDigits: 6 })}` : '$0'}</span></div>
                    <div className="col-span-1 flex justify-end">
                      {(r.claimableBN > 0n) ? (
                        <Button size="sm" variant="outline" className="h-8 px-2 border-slate-600 text-slate-200 hover:bg-slate-700" disabled={Boolean(claimingSpecific) || isProcessing || rewardsLoading || pricesLoading} onClick={() => handleClaimSpecific(r.address, r.symbol, r.decimals, r.claimableBN, r.usdValue)}>
                          {claimingSpecific === r.address ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Claiming…</> : 'Claim'}
                        </Button>
                      ) : (
                        <span className="text-xs text-slate-500 py-1">In Wallet</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3 mt-4">
                <Button onClick={handleClaimAll} disabled={!hasRewards || isProcessing || stakingLoading || Boolean(claimingSpecific) || rewardsLoading || pricesLoading} className="col-span-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 py-6 text-lg">
                  {isProcessing ? <div className="flex items-center justify-center space-x-2"><Loader2 className="w-5 h-5 animate-spin" /><span>{progressStep || "Processing..."}</span></div> : <><Gift className="w-5 h-5 mr-2" />{hasRewards ? `Claim All Rewards (${formatUSD(totalRewardsUSD, 6)})` : "No Rewards to Claim"}</>}
                </Button>
                
                <Button variant="secondary" onClick={handleClaimAndConvert} disabled={!hasRewards || isProcessing} className="bg-slate-700 text-blue-200 hover:bg-slate-600 border border-slate-600">
                  <RefreshCw className="w-4 h-4 mr-2" />Convert to USDC
                </Button>
                
                <Button variant="secondary" onClick={handleClaimAndCompound} disabled={!hasRewards || isProcessing} className="bg-slate-700 text-purple-200 hover:bg-slate-600 border border-slate-600">
                  <TrendingUp className="w-4 h-4 mr-2" />Compound (iAERO)
                </Button>
              </div>
            </>
          ) : (
            <div className="bg-slate-900/30 rounded-xl p-8 border border-slate-700/20 text-center">
              <Gift className="w-12 h-12 text-slate-500 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-slate-400 mb-2">No Rewards Yet</h3>
              <p className="text-sm text-slate-500">{stakedIAeroBN > 0n ? "Your rewards will appear here once they're distributed" : "Stake iAERO to start earning rewards"}</p>
            </div>
          )}

          {/* NEW: Independent Swap Button (Always visible if configured) */}
          <div className="mt-6 border-t border-slate-800/50 pt-6">
              <h4 className="text-white font-medium mb-3 flex items-center gap-2">
                  <Coins className="w-4 h-4 text-yellow-400" />
                  Swap Tools
              </h4>
              <div className="grid grid-cols-2 gap-3">
                  <Button 
                      onClick={handleSwapAllRewards}
                      disabled={isProcessing}
                      // Added: h-auto, py-6, whitespace-normal, leading-tight
                      className="h-auto py-6 whitespace-normal leading-tight bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white border-0"
                  >
                      <div className="flex flex-col items-center gap-1">
                        {isProcessing && progressStep.includes("Fetching") ? <Loader2 className="w-5 h-5 animate-spin mb-1"/> : <RefreshCw className="w-5 h-5 mb-1" />}
                        <span>Sweep ALL reward tokens in wallet to USDC</span>
                      </div>
                  </Button>
                  
                  <Button 
                      onClick={handleSweepToIAERO}
                      disabled={isProcessing}
                      // Added: h-auto, py-6, whitespace-normal, leading-tight
                      className="h-auto py-6 whitespace-normal leading-tight bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white border-0"
                  >
                      <div className="flex flex-col items-center gap-1">
                        {isProcessing && progressStep.includes("Fetching") ? <Loader2 className="w-5 h-5 animate-spin mb-1"/> : <TrendingUp className="w-5 h-5 mb-1" />}
                        <span>Sweep ALL reward tokens in wallet to iAERO</span>
                      </div>
                  </Button>
              </div>
          </div>

          {txHistory.length > 0 && (
            <div className="bg-slate-900/30 rounded-xl p-4 border border-slate-700/20 mt-6">
              <h4 className="text-white font-medium mb-3 flex items-center"><History className="w-4 h-4 mr-2" />Recent Claims</h4>
              <div className="space-y-2">
                {txHistory.map((tx, i) => (
                  <div key={i} className="flex items-center justify-between text-sm p-2 bg-slate-900/50 rounded">
                    <div className="flex items-center space-x-3">
                      <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
                      <div>
                        <span className="text-slate-300">{tx.type === "claimAll" ? "Claimed All" : `Claimed ${tx.tokens.join(", ")}`}</span>
                        <span className="text-slate-500 text-xs ml-2">{formatTimeAgo(tx.timestamp)}</span>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-emerald-400 font-medium">{formatUSD(tx.totalValue, 6)}</span>
                      {tx.txHash && (<a href={`${txBaseUrl}${tx.txHash}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">↗</a>)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          
          {isProcessing && (
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4 mt-4">
              <Progress value={75} className="mb-2" />
              <p className="text-sm text-slate-300">{progressStep}</p>
            </div>
          )}

          <AnimatePresence>
            {showSuccess && (
              <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} className="flex items-center justify-center py-4">
                <div className="bg-emerald-500/20 rounded-full p-4">
                  <CheckCircle className="w-12 h-12 text-emerald-400" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="text-xs text-slate-500 text-center mt-4">
            <span>Press </span><kbd className="px-1.5 py-0.5 bg-slate-700 rounded">R</kbd><span> to refresh • </span>
            <kbd className="px-1.5 py-0.5 bg-slate-700 rounded">⌘</kbd><span> + </span><kbd className="px-1.5 py-0.5 bg-slate-700 rounded">Enter</kbd><span> to claim all</span>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}