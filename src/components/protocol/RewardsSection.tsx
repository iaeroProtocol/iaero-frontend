// ==============================================
// src/components/protocol/RewardsSection.tsx
// IMPROVED VERSION - Ported swap logic from Token Sweeper page.tsx
// WITH POST-TRADE RESULTS MODAL
// ==============================================
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePublicClient, useWriteContract } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { parseAbi, encodeAbiParameters, parseUnits, formatUnits } from 'viem';
import type { PublicClient, Transport, Chain, Address } from 'viem';

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
  AlertTriangle,
  X,
  XCircle,
  ExternalLink,
  ArrowRight,
  Trophy,
  Zap,
} from "lucide-react";

import { useProtocol } from "@/components/contexts/ProtocolContext";
import { useStaking } from "../contracts/hooks/useStaking";
import { getContractAddress, type ContractName } from "../contracts/addresses";
import {
  parseInputToBigNumber,
  formatBigNumber,
} from "../lib/defi-utils";
import { usePrices } from "@/components/contexts/PriceContext";

// --------------------------------------------------------------------------
// 1. CONFIGURATION & ABIS
// --------------------------------------------------------------------------
const SWAPPER_ADDRESS = "0x25f11f947309df89bf4d36da5d9a9fb5f1e186c1" as Address;
const REGISTRY_ADDRESS = "0xd3e32B22Da6Bf601A5917ECd344a7Ec46BCA072c" as Address;

// ✅ AERODROME CONFIGURATION
const AERODROME_ROUTER = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as Address;
const AERODROME_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Address;

const AERO_ADDR = "0x940181a94A35A4569E4529A3CDfB74e38FD98631" as Address;
const IAERO_ADDR = "0x81034Fb34009115F215f5d5F564AAc9FfA46a1Dc" as Address;
const USDC_ADDR = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const USDC_DECIMALS = 6;

// ✅ STAKING DISTRIBUTOR - auto-stake after sweep to iAERO
const STAKING_DISTRIBUTOR = "0x781A80fA817b5a146C440F03EF8643f4aca6588A" as Address;

const STAKING_ABI = [
  {
    name: 'stake',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: []
  }
] as const;

// Validation check (will log error if not configured)
if (SWAPPER_ADDRESS.includes("YOUR_DEPLOYED")) {
    console.error("🚨 SWAPPER_ADDRESS not set in RewardsSection.tsx");
}

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

const REWARDS_JSON_URL = process.env.NEXT_PUBLIC_REWARDS_JSON_URL || "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/estimated_rewards_usd.json";
const STAKER_REWARDS_JSON_URL = process.env.NEXT_PUBLIC_STAKER_REWARDS_JSON_URL || "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/staker_rewards.json";
const SPAM_BLOCKLIST_URL = process.env.NEXT_PUBLIC_SPAM_BLOCKLIST_URL || 
  "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/spam_tokens_base.json";

// Cache for spam blocklist
let spamBlocklistCache: {
  addresses: Set<string>;
  patterns: string[];
  lastFetch: number;
} | null = null;

const BLOCKLIST_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)', 
  'function decimals() view returns (uint8)', 
  'function symbol() view returns (string)'
]);

const ERC20_FULL_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
]);

const PREVIEW_ABI = parseAbi(['function previewClaim(address user, address token, uint256 epoch) view returns (uint256)']);
const EPOCH_DIST_ABI = parseAbi(['function claimMany(address[] tokens, uint256[] epochs) external']);
const DIST_ABI = parseAbi(['function totalStaked() view returns (uint256)']);
const REGISTRY_ABI = parseAbi(['function allTokens() view returns (address[])']);

const GAS_ESTIMATES = { claimSingle: 120000n, claimAll: 200000n };
const ZERO = "0x0000000000000000000000000000000000000000";
const DUST_USD = 0.01; 
const dustRawThreshold = (dec: number) => (dec >= 12 ? 10n ** BigInt(dec - 12) : 0n); 

// Router kind for aggregator swaps (matched to Solidity enum)
const RouterKind = { AERODROME: 0, UNIV3: 1, AGGREGATOR: 2 };

// ============================================================================
// BATCH CONFIGURATION - Ported from page.tsx
// ============================================================================
const QUOTE_BATCH_SIZE = 5;          // Number of quotes to fetch in parallel
const QUOTE_BATCH_DELAY = 1500;      // ms delay between quote batches
const EXECUTION_BATCH_SIZE = 5;      // Number of swaps per execution batch

// --------------------------------------------------------------------------
// 2. TYPES
// --------------------------------------------------------------------------
interface RewardsSectionProps {
  showToast: (m: string, t: "success" | "error" | "info" | "warning") => void;
  formatNumber?: (v: string | number) => string;
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

// Token type for swapping (ported from page.tsx)
interface TokenForSwap {
  address: Address;
  symbol: string;
  decimals: number;
  walletBN: bigint;      // Amount to swap (may be custom or full)
  fullBalanceBN: bigint; // Original full wallet balance (for useAll comparison)
  valueUsd?: number;
}

// Swap step for contract execution
interface SwapStep {
  kind: number;
  tokenIn: Address;
  outToken: Address;
  useAll: boolean;
  amountIn: bigint;
  quotedIn: bigint;
  quotedOut: bigint;
  slippageBps: number;
  data: `0x${string}`;
  viaPermit2: boolean;
  permitSig: `0x${string}`;
  permitAmount: bigint;
  permitDeadline: bigint;
  permitNonce: bigint;
}

// Validates SwapStep has all required fields, then returns args for viem
function makeSwapArgs(steps: SwapStep[], recipient: Address) {
  const validated = steps.map(s => ({
    kind: s.kind,
    tokenIn: s.tokenIn,
    outToken: s.outToken,
    useAll: s.useAll,
    amountIn: s.amountIn,
    quotedIn: s.quotedIn,
    quotedOut: s.quotedOut,
    slippageBps: s.slippageBps,
    data: s.data,
    viaPermit2: s.viaPermit2,
    permitSig: s.permitSig,
    permitAmount: s.permitAmount,
    permitDeadline: s.permitDeadline,
    permitNonce: s.permitNonce,
  }));

  // as const ensures this is a tuple and not widened to (any[] | Address)[]
  return [validated, recipient] as const;
}

// Quote Preview Types (ported from sweeper)
interface SwapQuote {
  token: TokenForSwap;
  buyAmount: bigint;
  buyAmountFormatted: string;
  transactionTo: Address;
  transactionData: `0x${string}`;
  priceImpact: number;
}

interface QuotePreviewItem {
  token: TokenForSwap;
  inputValueUsd: number;      // From reference quote (market rate)
  quotedOutputUsd: number;    // From full amount quote
  lossPercent: number;        // Price impact
  lossUsd: number;
  quote: SwapQuote;
  selected: boolean;
  forceHighSlippage?: boolean;
}

interface FailedQuoteItem {
  token: TokenForSwap;
  error: string;
}

// Discriminated union for quote batch results
type QuoteBatchResult = 
  | {
      success: true;
      token: TokenForSwap;
      inputValueUsd: number;
      quotedOutputUsd: number;
      lossPercent: number;
      lossUsd: number;
      quote: SwapQuote;
    }
  | {
      success: false;
      token: TokenForSwap;
      error: string;
    };

interface QuotePreviewData {
  quotes: QuotePreviewItem[];
  failedQuotes: FailedQuoteItem[];
  outputToken: 'USDC' | 'AERO' | 'iAERO';
  outputPrice: number;
  outputDecimals: number;
  _mode?: 'USDC' | 'iAERO';
  _priceMap?: Record<string, number>;
}

// ============================================================================
// POST-TRADE RESULT TYPES
// ============================================================================
interface TradeResultItem {
  address: string;
  symbol: string;
  decimals: number;
  inputAmount: string;
  inputValueUsd: number;
  outputAmount?: string;
  outputValueUsd?: number;
  status: 'success' | 'failed' | 'skipped';
  reason?: string;
  txHash?: string;
}

interface PostTradeData {
  mode: 'USDC' | 'iAERO';
  outputToken: string;
  outputDecimals: number;
  totalInputUsd: number;
  totalOutputUsd: number;
  totalReceived: string;
  totalReceivedFormatted: string;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  results: TradeResultItem[];
  txHashes: string[];
  timestamp: number;
  didStake?: boolean;
  stakedAmount?: string;
  userCancelled?: boolean;
}

interface JsonRewardItem {
  token: string;
  symbol: string;
  decimals: number;
  amount: string;
  epoch: number;
  priceUsd: number;
}

// --------------------------------------------------------------------------
// 3. HELPERS
// --------------------------------------------------------------------------
const msgFromError = (e: any, fallback = "Transaction failed") => {
  if (e?.code === 4001) return "Transaction rejected by user";
  const m = String(e?.message || "").toLowerCase();
  if (m.includes("insufficient funds")) return "Insufficient ETH for gas fees";
  if (m.includes("no pending rewards")) return "No rewards available to claim";
  return fallback;
};

/**
 * Parse swap errors into user-friendly messages (ported from page.tsx)
 */
function parseSwapError(error: any): { reason: string; details: string; suggestion: string } {
  const msg = String(error?.message || error || '').toLowerCase();
  const shortMessage = error?.shortMessage || '';
  
  let revertReason = '';
  const revertMatch = msg.match(/reverted with the following reason:\s*([^\n]+)/i);
  if (revertMatch) {
    revertReason = revertMatch[1].trim();
  }
  
  if (msg.includes('agg swap fail') || revertReason.includes('agg swap fail')) {
    return {
      reason: 'Aggregator swap failed',
      details: 'The 0x aggregator route failed on-chain',
      suggestion: 'Quote may be stale, or liquidity changed. Will retry with fresh quote.'
    };
  }
  
  if (msg.includes('slippage') || msg.includes('too little received') || msg.includes('insufficient output')) {
    return {
      reason: 'Slippage exceeded',
      details: 'Price moved beyond allowed slippage tolerance',
      suggestion: 'Increase slippage or try smaller amount'
    };
  }
  
  if (msg.includes('insufficient') && msg.includes('balance')) {
    return {
      reason: 'Insufficient balance',
      details: 'Token balance is less than swap amount',
      suggestion: 'Check wallet balance'
    };
  }
  
  if (msg.includes('allowance') || msg.includes('approved')) {
    return {
      reason: 'Allowance issue',
      details: 'Token not approved or allowance too low',
      suggestion: 'Re-approve token'
    };
  }
  
  if (msg.includes('transfer') && (msg.includes('fail') || msg.includes('revert'))) {
    return {
      reason: 'Transfer failed',
      details: 'Token transfer reverted (possible fee-on-transfer or blacklist)',
      suggestion: 'This token may have transfer restrictions'
    };
  }
  
  if (msg.includes('expired') || msg.includes('deadline')) {
    return {
      reason: 'Quote expired',
      details: 'Transaction deadline passed',
      suggestion: 'Quote was too old when executed'
    };
  }
  
  if (msg.includes('liquidity') || msg.includes('no route')) {
    return {
      reason: 'No liquidity',
      details: 'Insufficient liquidity for this trade',
      suggestion: 'Try smaller amount or different route'
    };
  }
  
  if (msg.includes('user rejected') || msg.includes('user denied') || error?.code === 4001) {
    return {
      reason: 'User rejected',
      details: 'Transaction was rejected in wallet',
      suggestion: ''
    };
  }
  
  if (msg.includes('gas') && msg.includes('estimate')) {
    return {
      reason: 'Gas estimation failed',
      details: 'Transaction would likely revert',
      suggestion: 'Swap parameters may be invalid'
    };
  }
  
  return {
    reason: revertReason || shortMessage || 'Unknown error',
    details: msg.substring(0, 150),
    suggestion: 'Check console for full error'
  };
}

function logSwapError(prefix: string, token: { symbol: string; address: string }, error: any) {
  const parsed = parseSwapError(error);
  console.log(`${prefix} ❌ ${token.symbol} FAILED`);
  console.log(`${prefix}    Reason: ${parsed.reason}`);
  console.log(`${prefix}    Details: ${parsed.details}`);
  if (parsed.suggestion) {
    console.log(`${prefix}    💡 ${parsed.suggestion}`);
  }
  console.log(`${prefix}    Address: ${token.address}`);
  return parsed;
}

const formatTimeAgo = (t: number) => {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const formatNumber = (num: number, decimals: number = 2): string => {
  if (num === 0) return '0';
  if (num < 0.0001) return '< 0.0001';
  if (num < 1) return num.toFixed(Math.min(decimals + 2, 6));
  if (num < 1000) return num.toFixed(decimals);
  if (num < 1000000) return `${(num / 1000).toFixed(1)}K`;
  return `${(num / 1000000).toFixed(2)}M`;
};

/**
 * Calculate slippage based on price impact (ported from page.tsx)
 * Base slippage of 30 bps (0.3%), scales up with impact, capped at 500 bps (5%)
 */
function calculateSlippage(priceImpactPercent: number, forceHighSlippage: boolean = false): number {
  const priceImpactBps = Math.ceil(priceImpactPercent * 100);
  
  if (forceHighSlippage) {
    // Force mode: impact + 10%, min 5%, max 99%
    return Math.min(9900, Math.max(500, priceImpactBps + 1000));
  }
  
  // Normal mode: base 0.3% + 1.5x impact, capped at 5%
  return Math.min(500, Math.max(30, 30 + Math.ceil(priceImpactBps * 1.5)));
}

/**
 * Fetch spam blocklist from GitHub (cached)
 */
async function fetchSpamBlocklist(): Promise<{ addresses: Set<string>; patterns: string[] }> {
  if (spamBlocklistCache && (Date.now() - spamBlocklistCache.lastFetch) < BLOCKLIST_CACHE_TTL) {
    return spamBlocklistCache;
  }

  try {
    console.log("📋 Fetching spam token blocklist...");
    const response = await fetch(SPAM_BLOCKLIST_URL, { cache: "no-store" });
    
    if (!response.ok) {
      console.warn(`⚠️ Failed to fetch blocklist: ${response.status}`);
      return { addresses: new Set(), patterns: [] };
    }

    const data = await response.json();
    
    const addresses = new Set<string>(
      (data.tokens || []).map((t: { address: string }) => t.address.toLowerCase())
    );
    
    const patterns = data.symbolPatterns || [];

    spamBlocklistCache = {
      addresses,
      patterns,
      lastFetch: Date.now()
    };

    console.log(`✅ Loaded blocklist: ${addresses.size} addresses, ${patterns.length} patterns`);
    return spamBlocklistCache;

  } catch (e) {
    console.error("Error fetching spam blocklist:", e);
    return { addresses: new Set(), patterns: [] };
  }
}

/**
 * Reports spam tokens to the API for blocklist update (background)
 */
async function reportSpamTokens(
  tokens: Array<{ address: string; symbol: string; reason: string }>
): Promise<void> {
  if (tokens.length === 0) return;
  
  try {
    console.log(`📤 Reporting ${tokens.length} spam token(s) to blocklist...`);
    
    const response = await fetch('/api/spam-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens)
    });
    
    if (response.ok) {
      const result = await response.json();
      if (result.added > 0) {
        console.log(`✅ Added ${result.added} new spam token(s) to blocklist`);
      }
    }
  } catch (e) {
    console.warn('⚠️ Could not report spam tokens:', e);
  }
}

/**
 * Check if token is spam
 */
function isSpamToken(
  address: string, 
  symbol: string, 
  blocklist: { addresses: Set<string>; patterns: string[] }
): boolean {
  const addrLower = address.toLowerCase();
  
  if (blocklist.addresses.has(addrLower)) return true;
  
  const symbolLower = symbol.toLowerCase();
  for (const pattern of blocklist.patterns) {
    if (symbolLower.includes(pattern.toLowerCase())) return true;
  }
  
  // Cyrillic characters (fake tokens)
  if (/[\u0400-\u04FF]/.test(symbol)) return true;
  
  // Telegram links
  if (symbol.includes('t.me') || symbol.includes('telegram')) return true;
  
  // "claim" with date pattern
  if (/claim.*\d{2}\.\d{2}\.\d{2}/i.test(symbol)) return true;
  
  return false;
}

/**
 * Fetch 0x quote via API route
 */
async function fetch0xQuote(
  chainId: number,
  sellToken: string,
  buyToken: string,
  sellAmount: bigint,
  taker: string
): Promise<any> {
  const params = new URLSearchParams({
    chainId: String(chainId),
    sellToken,
    buyToken,
    sellAmount: sellAmount.toString(),
    taker
  });
  
  const res = await fetch(`/api/0x/quote?${params}`);
  if (!res.ok) {
    const err = await res.json();
    const errorMsg = err.error || err.reason || err.message || 'Quote failed';
    throw new Error(errorMsg);
  }
  
  return res.json();
}

async function fetchRewardsFromJson(userAddress: string): Promise<JsonRewardItem[]> {
  try {
    console.log(`🌐 Fetching Rewards from: ${STAKER_REWARDS_JSON_URL}`);
    const response = await fetch(STAKER_REWARDS_JSON_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to fetch rewards JSON: ${response.status}`);
    
    const data = await response.json();
    const targetAddr = userAddress.toLowerCase();

    function findUser(obj: any): any {
        if (!obj || typeof obj !== 'object') return null;
        if (obj[targetAddr]) return obj[targetAddr];
        if (obj.address && typeof obj.address === 'string' && obj.address.toLowerCase() === targetAddr) {
            return obj;
        }
        if (Array.isArray(obj)) {
            for (const item of obj) {
                const found = findUser(item);
                if (found) return found;
            }
        }
        for (const key in obj) {
            if (key === 'address' || key === 'pending') continue; 
            if (typeof obj[key] === 'object') {
                const found = findUser(obj[key]);
                if (found) return found;
            }
        }
        return null;
    }

    const userData = findUser(data);

    if (userData) {
        console.log("✅ Found user data!");
        return userData.pending || [];
    }

    console.warn("❌ User not found in staker_rewards.json");
    return [];

  } catch (e) {
    console.error("Error fetching JSON rewards:", e);
    return [];
  }
}

// --------------------------------------------------------------------------
// 4. COMPONENT
// --------------------------------------------------------------------------
export default function RewardsSection({ showToast }: RewardsSectionProps) {
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
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [txHistory, setTxHistory] = useState<TxHistory[]>([]);
  const [failedTokens, setFailedTokens] = useState<Array<{
    address: string;
    symbol: string;
    reason: string;
    step: string;
  }>>([]);
  
  const [rewardsLoading, setRewardsLoading] = useState(false);
  const [pricesLoading, _setPricesLoading] = useState(false);
  const [apyPct, setApyPct] = useState<number | null>(null);
  const [apyLoading, setApyLoading] = useState<boolean>(false);
  const [apyError, setApyError] = useState<string | null>(null);

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

  // Modal States
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [candidates, setCandidates] = useState<TokenForSwap[]>([]);
  const [selectedTokens, setSelectedTokens] = useState<Set<string>>(new Set());
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({});
  
  // Quote preview modal state
  const [showQuotePreview, setShowQuotePreview] = useState(false);
  const [quotePreviewData, setQuotePreviewData] = useState<QuotePreviewData | null>(null);
  
  // POST-TRADE RESULTS MODAL STATE
  const [showPostTradeModal, setShowPostTradeModal] = useState(false);
  const [postTradeData, setPostTradeData] = useState<PostTradeData | null>(null);

  // --- INTERNAL HELPERS ---

  const trackFailedToken = useCallback((address: string, symbol: string, reason: string, step: string) => {
    setFailedTokens(prev => {
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
  const distAddr = useMemo(() => (addrOrEmpty('EPOCH_DIST') || addrOrEmpty('StakingDistributor') || addrOrEmpty('EPOCH_STAKING_DISTRIBUTOR')).toLowerCase(), [chainId]);

  // Toggle quote selection in preview modal
  const toggleQuoteSelection = useCallback((tokenAddress: string) => {
    if (!quotePreviewData) return;
    setQuotePreviewData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        quotes: prev.quotes.map(q => 
          q.token.address.toLowerCase() === tokenAddress.toLowerCase()
            ? { ...q, selected: !q.selected }
            : q
        )
      };
    });
  }, [quotePreviewData]);
  
  // Toggle force high slippage
  const toggleForceSlippage = useCallback((tokenAddress: string) => {
    if (!quotePreviewData) return;
    setQuotePreviewData(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        quotes: prev.quotes.map(q => 
          q.token.address.toLowerCase() === tokenAddress.toLowerCase()
            ? { ...q, forceHighSlippage: !q.forceHighSlippage }
            : q
        )
      };
    });
  }, [quotePreviewData]);

  // ============================================================================
  // PRICE FETCHING
  // ============================================================================
  
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
    
    // Fallback to DefiLlama
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

  // ============================================================================
  // TOKEN FETCHING
  // ============================================================================

  async function fetchRegistryTokens(): Promise<string[]> {
    if (!publicClient) return [];
    try {
      const tokens = await publicClient.readContract({
        address: REGISTRY_ADDRESS,
        abi: REGISTRY_ABI,
        functionName: 'allTokens',
      });
      return (tokens as string[]).map(t => t.toLowerCase());
    } catch (e) {
      console.error("Failed to fetch registry tokens:", e);
      return [];
    }
  }

  async function enrichTokens(tokens: string[]) {
    if (!publicClient) return [];
    const calls = tokens.flatMap(t => [
      { address: t as Address, abi: ERC20_ABI, functionName: 'symbol' as const },
      { address: t as Address, abi: ERC20_ABI, functionName: 'decimals' as const }
    ]);
    
    const res = await publicClient.multicall({ contracts: calls });
    
    return tokens.map((t, i) => {
      const symRes = res[2*i];
      const decRes = res[2*i+1];
      return {
        address: t as Address,
        symbol: (symRes.status === 'success' ? symRes.result : 'TOKEN') as string,
        decimals: (decRes.status === 'success' ? Number(decRes.result) : 18) as number,
        walletBN: 0n,
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

  // Smart Preflight for claims
  async function smartPreflight(items: any[], account: Address, distributor: Address) {
    try {
      const pc = publicClient as unknown as PublicClient<Transport, Chain> | undefined;
      if (!pc) return { results: items.map(it => ({ ...it, claimable: 0n, wallet: 0n })) };
      
      const calls = items.flatMap(it => ([
        { address: distributor, abi: PREVIEW_ABI, functionName: 'previewClaim' as const, args: [account, it.address, it.epoch || 0n] },
        { address: it.address as Address, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [distributor] },
        { address: it.address as Address, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [account] }
      ]));
      
      const res = await pc.multicall({ contracts: calls });
      const results = items.map((it, i) => {
        const previewRes = res[3 * i];
        const distBalRes = res[3 * i + 1];
        const userBalRes = res[3 * i + 2];

        let claimable = (previewRes.status === 'success') ? (previewRes.result as bigint) : 0n;
        const distBal = (distBalRes.status === 'success') ? (distBalRes.result as bigint) : 0n;
        const wallet = (userBalRes.status === 'success') ? (userBalRes.result as bigint) : 0n;

        if (claimable > distBal) {
          console.warn(`❌ Hiding ${it.symbol}`);
          claimable = 0n;
        }

        return { ...it, claimable, wallet, total: claimable + wallet };
      });

      return { results };
    } catch (err) {
      console.error("Smart preflight failed:", err);
      return { results: [] };
    }
  }

  // ============================================================================
  // DATA LOADING
  // ============================================================================
  
  const handleRefresh = useCallback(async () => {
    if (!account || !publicClient) return;

    if (!distAddr) {
      console.error("❌ Staking Distributor Address not found");
      showToast("Contract configuration error", "error");
      return;
    }

    setIsRefreshing(true);
    setRewardsLoading(true);
    
    try {
      console.log("🔄 Refreshing rewards from JSON...");

      const jsonRewards = await fetchRewardsFromJson(account);
      
      if (jsonRewards.length === 0) {
        console.warn("No pending rewards found in JSON");
        setPending([]);
        return;
      }

      // Enrich tokens on-chain for correct decimals
      const tokenAddresses = jsonRewards.map(j => j.token);
      const enrichedData = await enrichTokens(tokenAddresses);
      
      const decimalMap: Record<string, number> = {};
      enrichedData.forEach(t => {
        decimalMap[t.address.toLowerCase()] = t.decimals;
      });

      const tokensToCheck = jsonRewards.map(item => {
        const realDecimals = decimalMap[item.token.toLowerCase()] || item.decimals;
        return {
          address: item.token.toLowerCase(),
          symbol: item.symbol,
          decimals: realDecimals,
          epoch: BigInt(item.epoch), 
          priceUsd: item.priceUsd
        };
      });

      const { results } = await smartPreflight(
        tokensToCheck, 
        account as Address, 
        distAddr as Address
      );

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
          amount: (Number(res.claimable) / 10 ** res.decimals).toString(),
          epoch: res.epoch, 
          priceUsd: res.priceUsd 
        };
      }).filter(Boolean);

      console.log(`✅ Found ${validated.length} claimable tokens`);
      setPending(validated);
      
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

  // Auto-load on mount
  useEffect(() => {
    if (connected && networkSupported && account) {
      handleRefresh();
    }
  }, [connected, networkSupported, chainId, account]);

  useEffect(() => {
    if (!pending.length) return;
    fetchPricesForAddrs(pending.map((p:any)=>p.address), chainId || 8453)
      .then(map => setPriceByAddr(p => ({...p, ...map})));
  }, [pending, chainId]);

  // APY calculation
  useEffect(() => {
    if (!connected || !networkSupported || !publicClient) return;
    (async () => {
      setApyLoading(true);
      setApyError(null);
      try {
        const stakersWeeklyUSD_1e18 = await fetchStakersWeeklyUSD();
        if (!distAddr) throw new Error("staking distributor address missing");
        const totalStakedRaw = await publicClient.readContract({
          address: distAddr as Address,
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
  }, [connected, networkSupported, publicClient, chainId, distAddr, prices]);

  // Build rows for display
  const rows: RewardTokenRow[] = useMemo(() => {
    return pending.map((p:any) => {
      const addr = p.address; 
      const livePrice = priceByAddr[addr];
      const price = (livePrice && livePrice > 0) ? livePrice : (p.priceUsd || 0);
      const human = Number(p.amount);
      const rawBN = BigInt(p.raw); 
      const decimals = p.decimals;
      const usdValue = human * price;
      
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

  // ============================================================================
  // SWAP LOGIC - PORTED FROM page.tsx
  // ============================================================================

  /**
   * Pre-screen tokens for valid prices (spam filter)
   */
  const preScreenTokens = async (tokens: TokenForSwap[]) => {
    console.log(`\n🔍 === PRE-SCREENING PHASE ===`);
    console.log(`Checking prices for ${tokens.length} tokens...`);
    
    setProgressStep(`Pre-screening ${tokens.length} tokens...`);
    
    const addresses = tokens.map(t => t.address);
    const priceMap = await fetchPricesForAddrs(addresses, chainId || 8453);
    
    const validTokens: TokenForSwap[] = [];
    const scamTokens: Array<{ address: string; symbol: string; reason: string }> = [];
    
    const MIN_SWAP_VALUE_USD = 0.10;

    for (const token of tokens) {
      const price = priceMap[token.address.toLowerCase()];
      
      if (!price || price <= 0 || !isFinite(price)) {
        console.log(`  ❌ ${token.symbol}: No valid price`);
        scamTokens.push({
          address: token.address,
          symbol: token.symbol,
          reason: 'No price data'
        });
        trackFailedToken(token.address, token.symbol, 'No valid price data', 'pre_screening');
      } else {
        const usdValue = (Number(token.walletBN) / 10 ** token.decimals) * price;
        
        if (usdValue < MIN_SWAP_VALUE_USD) {
          console.log(`  ⚠️ ${token.symbol}: $${usdValue.toFixed(4)} (dust)`);
          trackFailedToken(token.address, token.symbol, `Value $${usdValue.toFixed(4)} below minimum`, 'dust_filter');
        } else {
          console.log(`  ✓ ${token.symbol}: $${usdValue.toFixed(2)}`);
          validTokens.push({ ...token, valueUsd: usdValue });
        }
      }
    }
    
    console.log(`\n✅ Pre-screening: ${validTokens.length} valid, ${scamTokens.length} filtered`);
    
    if (scamTokens.length > 0) {
      showToast(`Filtered ${scamTokens.length} token(s) with no price data`, "info");
      reportSpamTokens(scamTokens).catch(() => {});
    }
    
    return { validTokens, priceMap };
  };

  /**
   * Scan wallet for swap candidates
   */
  const scanForSwapCandidates = async (): Promise<{ validTokens: TokenForSwap[]; priceMap: Record<string, number> }> => {
    console.log(`\n📋 Scanning for valid swap candidates...`);
    setFailedTokens([]); 
    setProgressStep("Loading spam blocklist...");
    
    const blocklist = await fetchSpamBlocklist();
    
    setProgressStep("Scanning wallet for rewards...");
    
    // Fetch from Registry and JSON
    let registryTokens: string[] = [];
    try { registryTokens = await fetchRegistryTokens(); } catch (e) { console.error(e); }
    
    let jsonTokens: string[] = [];
    try {
      const jsonData = await fetchRewardsFromJson(account || "");
      jsonTokens = jsonData.map(j => j.token);
    } catch (e) { console.warn(e); }

    const allTokens = Array.from(new Set([
      ...registryTokens.map(t => t.toLowerCase()), 
      ...jsonTokens.map(t => t.toLowerCase())
    ]));

    if (allTokens.length === 0) throw new Error("No tokens found");

    // Pre-filter known spam
    const preFilteredTokens = allTokens.filter(addr => !blocklist.addresses.has(addr));
    
    console.log(`📊 Pre-filter: ${allTokens.length} → ${preFilteredTokens.length} tokens`);

    // Enrich tokens
    const enriched = await enrichTokens(preFilteredTokens);
    
    // Symbol filter
    const symbolSpamTokens: Array<{ address: string; symbol: string; reason: string }> = [];
    const symbolFiltered = enriched.filter(t => {
      if (isSpamToken(t.address, t.symbol, blocklist)) {
        console.log(`🚫 Symbol-filtered: ${t.symbol}`);
        symbolSpamTokens.push({ address: t.address, symbol: t.symbol, reason: 'Symbol pattern' });
        return false;
      }
      return true;
    });
    
    if (symbolSpamTokens.length > 0) {
      reportSpamTokens(symbolSpamTokens).catch(() => {});
    }

    // Get balances
    const balanceCalls = symbolFiltered.map(t => ({
      address: t.address as Address,
      abi: ERC20_ABI,
      functionName: 'balanceOf' as const,
      args: [account as Address]
    }));
    
    const balanceResults = await publicClient?.multicall({ contracts: balanceCalls });
    const rawCandidates: TokenForSwap[] = [];
    
    symbolFiltered.forEach((t, idx) => {
      const balResult = balanceResults?.[idx];
      const bal = balResult?.status === 'success' ? (balResult.result as bigint) : 0n;
      if (bal > 0n && t.address.toLowerCase() !== IAERO_ADDR.toLowerCase()) {
        rawCandidates.push({ 
          address: t.address as Address, 
          symbol: t.symbol, 
          decimals: t.decimals, 
          walletBN: bal,
          fullBalanceBN: bal  // Track original balance for useAll comparison
        });
      }
    });

    if (rawCandidates.length === 0) throw new Error("No reward tokens found in wallet");
    
    // Pre-screen for prices
    const { validTokens, priceMap } = await preScreenTokens(rawCandidates);
    
    if (validTokens.length === 0) throw new Error("No valid tokens found");

    return { validTokens, priceMap };
  };

  /**
   * Build quote preview with reference quotes for accurate price impact
   * (Ported from page.tsx)
   */
  const buildQuotePreview = async (
    tokensToSwap: TokenForSwap[], 
    targetTokenAddr: Address, 
    priceMap: Record<string, number>,
    outputTokenName: 'USDC' | 'AERO' | 'iAERO'
  ): Promise<QuotePreviewData | null> => {
    console.log(`\n📋 Building quote preview for ${tokensToSwap.length} tokens...`);
    
    const successfulQuotes: QuotePreviewItem[] = [];
    const failedQuotes: FailedQuoteItem[] = [];
    
    // Output token config
    const outputPrice = targetTokenAddr.toLowerCase() === USDC_ADDR.toLowerCase() ? 1 
      : (priceMap[targetTokenAddr.toLowerCase()] || 1);
    const outputDecimals = targetTokenAddr.toLowerCase() === USDC_ADDR.toLowerCase() ? USDC_DECIMALS : 18;
    
    // Filter out tokens that match the target
    const filteredTokens = tokensToSwap.filter(t => {
      const tokenAddr = t.address.toLowerCase();
      const targetAddr = targetTokenAddr.toLowerCase();
      
      if (tokenAddr === targetAddr) {
        console.log(`  ⏭️ Skipping ${t.symbol}: same as target`);
        return false;
      }
      if (tokenAddr === IAERO_ADDR.toLowerCase()) {
        console.log(`  ⏭️ Skipping ${t.symbol}: already iAERO`);
        return false;
      }
      return true;
    });
    
    console.log(`  📊 ${tokensToSwap.length} → ${filteredTokens.length} after filtering`);
    
    if (filteredTokens.length === 0) return null;
    
    // Batch quote fetching (5 at a time, 1.5s delay)
    const totalBatches = Math.ceil(filteredTokens.length / QUOTE_BATCH_SIZE);
    
    for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
      const batchStart = batchNum * QUOTE_BATCH_SIZE;
      const batchEnd = Math.min(batchStart + QUOTE_BATCH_SIZE, filteredTokens.length);
      const batchTokens = filteredTokens.slice(batchStart, batchEnd);
      
      console.log(`  ⚡ Batch ${batchNum + 1}/${totalBatches}: ${batchTokens.map(t => t.symbol).join(', ')}`);
      setProgressStep(`Fetching quotes (${batchNum + 1}/${totalBatches})...`);
      
      // Fetch main quotes AND reference quotes in parallel for this batch
      const batchPromises: Promise<QuoteBatchResult>[] = batchTokens.map(async (token): Promise<QuoteBatchResult> => {
        try {
          // Main quote (full amount)
          const mainQuote = await fetch0xQuote(
            chainId || 8453,
            token.address,
            targetTokenAddr,
            token.walletBN,
            SWAPPER_ADDRESS
          );
          
          if (!mainQuote?.transaction?.data) {
            return { success: false, token, error: 'No quote available' };
          }
          
          const buyAmountBigInt = BigInt(mainQuote.buyAmount);
          const quotedOutputUsd = Number(formatUnits(buyAmountBigInt, outputDecimals)) * outputPrice;
          
          // Reference quote (small amount ~$1 worth) for market rate
          let inputValueUsd: number;
          let priceImpact: number;
          
          try {
            const tokenPriceEstimate = (token.valueUsd || 0) / Number(formatUnits(token.walletBN, token.decimals));
            const refTokenAmount = Math.max(1, Math.ceil(1 / (tokenPriceEstimate || 1)));
            const refAmount = parseUnits(refTokenAmount.toString(), token.decimals);
            
            const refQuote = await fetch0xQuote(
              chainId || 8453,
              token.address,
              targetTokenAddr,
              refAmount,
              SWAPPER_ADDRESS
            );
            
            if (refQuote?.buyAmount) {
              const refBuyAmount = Number(formatUnits(BigInt(refQuote.buyAmount), outputDecimals));
              const refSellAmount = Number(formatUnits(refAmount, token.decimals));
              const marketPricePerToken = (refBuyAmount / refSellAmount) * outputPrice;
              
              // Calculate input value at market rate
              const sellAmountNum = Number(formatUnits(token.walletBN, token.decimals));
              inputValueUsd = sellAmountNum * marketPricePerToken;
              priceImpact = inputValueUsd > 0 ? Math.max(0, ((inputValueUsd - quotedOutputUsd) / inputValueUsd) * 100) : 0;
              
              console.log(`    ${token.symbol}: impact=${priceImpact.toFixed(2)}%`);
            } else {
              throw new Error('No ref quote');
            }
          } catch {
            // Fallback: use DefiLlama price or output as estimate
            const llamaPrice = priceMap[token.address.toLowerCase()] || 0;
            const sellAmountNum = Number(formatUnits(token.walletBN, token.decimals));
            inputValueUsd = llamaPrice > 0 ? sellAmountNum * llamaPrice : quotedOutputUsd;
            priceImpact = inputValueUsd > 0 ? Math.max(0, ((inputValueUsd - quotedOutputUsd) / inputValueUsd) * 100) : 2;
            console.log(`    ${token.symbol}: ref failed, using fallback (${priceImpact.toFixed(2)}% impact)`);
          }
          
          return {
            success: true,
            token,
            inputValueUsd,
            quotedOutputUsd,
            lossPercent: priceImpact,
            lossUsd: Math.max(0, inputValueUsd - quotedOutputUsd),
            quote: {
              token,
              buyAmount: buyAmountBigInt,
              buyAmountFormatted: formatUnits(buyAmountBigInt, outputDecimals),
              transactionTo: mainQuote.transaction.to as Address,
              transactionData: mainQuote.transaction.data as `0x${string}`,
              priceImpact
            }
          };
          
        } catch (e: any) {
          console.warn(`  ❌ ${token.symbol}: ${e.message}`);
          return { success: false, token, error: e.message || 'Quote failed' };
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      
      for (const result of batchResults) {
        if (result.success) {
          // TypeScript now knows result has all success properties
          successfulQuotes.push({
            token: result.token,
            inputValueUsd: result.inputValueUsd,
            quotedOutputUsd: result.quotedOutputUsd,
            lossPercent: result.lossPercent,
            lossUsd: result.lossUsd,
            quote: result.quote,
            selected: result.lossPercent < 10, // Auto-deselect >10% impact
            forceHighSlippage: false
          });
        } else {
          // TypeScript now knows result has error property
          failedQuotes.push({ token: result.token, error: result.error });
        }
      }
      
      // Delay between batches
      if (batchNum < totalBatches - 1) {
        console.log(`  ⏳ Waiting ${QUOTE_BATCH_DELAY}ms...`);
        await new Promise(r => setTimeout(r, QUOTE_BATCH_DELAY));
      }
    }
    
    console.log(`✅ Quote preview: ${successfulQuotes.length} success, ${failedQuotes.length} failed`);
    
    if (successfulQuotes.length === 0) return null;
    
    return {
      quotes: successfulQuotes,
      failedQuotes,
      outputToken: outputTokenName,
      outputPrice,
      outputDecimals
    };
  };

  /**
   * Ensure approvals for tokens (returns true if any approvals were needed)
   */
  const ensureApprovals = async (tokens: TokenForSwap[]): Promise<{ approvalsNeeded: number; failedTokens: Set<string> }> => {
    const candidates = tokens.filter(t => 
      (t.walletBN || 0n) > 0n && 
      t.address?.startsWith("0x") && 
      t.address?.length === 42
    );
  
    console.log(`\n🔐 Checking ${candidates.length} tokens for approval...`);
    
    let approvalsNeeded = 0;
    const failed = new Set<string>();
    
    for (let i = 0; i < candidates.length; i++) {
      const token = candidates[i];
      console.log(`  [${i+1}/${candidates.length}] ${token.symbol}...`);
      
      try {
        const currentAllowance = await publicClient?.readContract({
          address: token.address,
          abi: ERC20_FULL_ABI,
          functionName: 'allowance',
          args: [account as Address, SWAPPER_ADDRESS],
        }).catch(() => 0n) as bigint;
  
        if (currentAllowance < token.walletBN) {
          approvalsNeeded++;
          
          // Reset if there's existing allowance (USDT requirement)
          if (currentAllowance > 0n) {
            try {
              console.log(`    🔄 Resetting allowance...`);
              const hash0 = await writeContractAsync({
                address: token.address,
                abi: ERC20_FULL_ABI,
                functionName: 'approve',
                args: [SWAPPER_ADDRESS, 0n],
              });
              await publicClient?.waitForTransactionReceipt({ hash: hash0 });
            } catch (e: any) {
              console.warn(`    ⚠️ Reset failed:`, e.message);
            }
          }
  
          setProgressStep(`Approving ${token.symbol}...`);
          console.log(`    📝 Approving...`);
          
          const hash = await writeContractAsync({
            address: token.address,
            abi: ERC20_FULL_ABI,
            functionName: 'approve',
            args: [SWAPPER_ADDRESS, 115792089237316195423570985008687907853269984665640564039457584007913129639935n],
          });
          await publicClient?.waitForTransactionReceipt({ hash });
          console.log(`    ✅ Approved`);
        } else {
          console.log(`    ✅ Already approved`);
        }
      } catch (e: any) {
        console.error(`    ❌ Approval FAILED:`, e.message);
        trackFailedToken(token.address, token.symbol, `Approval failed: ${e.message}`, 'approval');
        failed.add(token.address.toLowerCase());
        showToast(`Skipping ${token.symbol} (Approval Error)`, "warning");
      }
    }
    
    console.log(`✅ Approvals complete: ${approvalsNeeded} needed`);
    return { approvalsNeeded, failedTokens: failed };
  };

  /**
   * Simulate each swap individually in parallel (ported from page.tsx)
   * Returns passing and failing swaps
   */
  const simulateSwapsIndividually = async (
    plan: SwapStep[], 
    recipient: Address
  ): Promise<{ passing: SwapStep[]; failing: Array<{ swap: SwapStep; error: string }> }> => {
    console.log(`\n🧪 === SIMULATION PHASE ===`);
    console.log(`Testing ${plan.length} swaps in parallel...`);
    
    const simulations = plan.map(async (swap, idx) => {
      const isUSDC = swap.tokenIn.toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
      
      try {
        if (isUSDC) {
          console.log(`  📋 Simulating USDC swap...`);
          console.log(`     tokenIn: ${swap.tokenIn}`);
          console.log(`     outToken: ${swap.outToken}`);
          console.log(`     amountIn: ${swap.amountIn.toString()}`);
          console.log(`     quotedOut: ${swap.quotedOut.toString()}`);
          console.log(`     slippageBps: ${swap.slippageBps}`);
        }
        
        const simResult = await publicClient?.simulateContract({
          address: SWAPPER_ADDRESS,
          abi: SWAPPER_ABI,
          functionName: 'executePlanFromCaller',
          args: makeSwapArgs([swap], recipient),
          account: recipient,
        });
        
        if (isUSDC) {
          console.log(`  ✅ USDC simulation passed!`);
        }
        
        return { index: idx, success: true, swap };
        
      } catch (e: any) {
        const errorMsg = String(e.message || e).toLowerCase();
        let reason = 'Unknown error';
        
        if (isUSDC) {
          console.log(`  ❌ USDC simulation FAILED`);
          console.log(`     Raw error: ${errorMsg.substring(0, 300)}`);
        }
        
        if (errorMsg.includes('aggregator') && errorMsg.includes('whitelist')) {
          reason = 'Aggregator not whitelisted';
        } else if (errorMsg.includes('#1002') || errorMsg.includes('agg swap fail')) {
          reason = 'Swap failed - token may have transfer tax or no liquidity';
        } else if (errorMsg.includes('slippage exceeded') || errorMsg.includes('too little received')) {
          reason = 'Slippage exceeded';
        } else if (errorMsg.includes('insufficient') && errorMsg.includes('balance')) {
          reason = 'Insufficient balance';
        } else if (errorMsg.includes('allowance') || errorMsg.includes('approve')) {
          reason = 'Insufficient allowance';
        } else if (errorMsg.includes('transfer') && errorMsg.includes('fail')) {
          reason = 'Token transfer failed';
        } else {
          const revertMatch = errorMsg.match(/reverted with the following reason:\s*([^\n]+)/i);
          if (revertMatch) reason = revertMatch[1].trim();
          else reason = errorMsg.substring(0, 100);
        }
        
        return { index: idx, success: false, swap, error: reason };
      }
    });
    
    const results = await Promise.all(simulations);
    
    const passing: SwapStep[] = [];
    const failing: Array<{ swap: SwapStep; error: string }> = [];
    
    results.forEach((result) => {
      if (result.success) {
        passing.push(result.swap);
        console.log(`  ✅ Swap ${result.index + 1}: PASS`);
      } else {
        failing.push({ swap: result.swap, error: result.error || "Unknown" });
        console.log(`  ❌ Swap ${result.index + 1}: FAIL - ${result.error}`);
      }
    });
    
    console.log(`\n📊 Simulation: ${passing.length} passing, ${failing.length} failing`);
    return { passing, failing };
  };

  /**
   * Isolate problem tokens in a failed batch (ported from page.tsx)
   */
  const isolateProblemTokens = async (
    failedPlan: SwapStep[],
    recipient: Address
  ): Promise<{ workingPlan: SwapStep[]; problemTokens: SwapStep[] }> => {
    console.log(`\n🔍 === PROBLEM TOKEN ISOLATION ===`);
    console.log(`Analyzing ${failedPlan.length} swaps...`);

    const problemTokens: SwapStep[] = [];
    let remainingPlan = [...failedPlan];
    let attempts = 0;
    const maxAttempts = failedPlan.length;

    while (attempts < maxAttempts && remainingPlan.length > 1) {
      attempts++;
      
      try {
        await publicClient?.estimateContractGas({
          address: SWAPPER_ADDRESS,
          abi: SWAPPER_ABI,
          functionName: 'executePlanFromCaller',
          args: makeSwapArgs(remainingPlan, recipient),
          account: recipient,
        });
        
        console.log(`✅ Found working batch with ${remainingPlan.length} tokens`);
        break;
        
      } catch {
        console.log(`❌ Batch of ${remainingPlan.length} fails, isolating...`);
        
        let foundProblem = false;
        
        for (let i = 0; i < remainingPlan.length; i++) {
          const testPlan = remainingPlan.filter((_, idx) => idx !== i);
          const excludedSwap = remainingPlan[i];
          
          if (testPlan.length === 0) continue;
          
          try {
            await publicClient?.estimateContractGas({
              address: SWAPPER_ADDRESS,
              abi: SWAPPER_ABI,
              functionName: 'executePlanFromCaller',
              args: makeSwapArgs(testPlan, recipient),
              account: recipient,
            });
            
            console.log(`🎯 Found problem token: ${excludedSwap.tokenIn}`);
            problemTokens.push(excludedSwap);
            remainingPlan = testPlan;
            foundProblem = true;
            break;
            
          } catch {
            continue;
          }
        }
        
        if (!foundProblem) {
          console.log(`⚠️ Multiple issues - marking all as problem tokens`);
          problemTokens.push(...remainingPlan);
          remainingPlan = [];
          break;
        }
      }
    }

    console.log(`📊 Isolation: ${remainingPlan.length} working, ${problemTokens.length} problematic`);
    return { workingPlan: remainingPlan, problemTokens };
  };

  /**
   * Execute problem tokens individually with higher slippage and fresh quotes
   * Uses default gas when estimation fails
   */
  const executeProblemTokensIndividually = async (
    problemTokens: SwapStep[],
    recipient: Address,
    targetTokenAddr?: Address,
    tradeResults?: TradeResultItem[],
    txHashes?: string[]
  ): Promise<{ successCount: number; successfulAddresses: string[] }> => {
    console.log(`\n🔄 === EXECUTING PROBLEM TOKENS INDIVIDUALLY ===`);
    
    let successCount = 0;
    const successfulAddresses: string[] = [];
    const BOOSTED_SLIPPAGE = 1000; // 10% for problem tokens
    const DEFAULT_GAS = 500000n;   // Default gas when estimation fails
    
    for (const swap of problemTokens) {
      // Find quote data for this token
      const quoteData = quotePreviewData?.quotes.find(
        q => q.token.address.toLowerCase() === swap.tokenIn.toLowerCase()
      );
      
      console.log(`\n  Attempting: ${swap.tokenIn}`);
      console.log(`    Original slippage: ${swap.slippageBps} bps`);
      console.log(`    Boosted slippage: ${Math.max(swap.slippageBps, BOOSTED_SLIPPAGE)} bps`);
      console.log(`    Amount: ${swap.amountIn.toString()}`);
      
      let modifiedSwap = {
        ...swap,
        slippageBps: Math.max(swap.slippageBps, BOOSTED_SLIPPAGE)
      };
      
      try {
        // ALWAYS try to get a fresh quote first
        if (targetTokenAddr) {
          try {
            console.log(`    📡 Fetching fresh quote...`);
            const freshQuote = await fetch0xQuote(
              chainId || 8453,
              swap.tokenIn,
              targetTokenAddr,
              swap.amountIn,
              SWAPPER_ADDRESS
            );
            
            if (freshQuote?.transaction?.to && freshQuote?.transaction?.data) {
              const freshEncodedData = encodeAbiParameters(
                [{ type: 'address' }, { type: 'bytes' }],
                [freshQuote.transaction.to, freshQuote.transaction.data]
              );
              
              modifiedSwap = {
                ...modifiedSwap,
                quotedOut: BigInt(freshQuote.buyAmount),
                data: freshEncodedData as `0x${string}`
              };
              
              console.log(`    ✅ Got fresh quote, new output: ${freshQuote.buyAmount}`);
            }
          } catch (quoteError: any) {
            console.log(`    ⚠️ Fresh quote failed, using original: ${quoteError.message?.substring(0, 50)}`);
          }
        }
        
        // Try gas estimation
        let gas: bigint = DEFAULT_GAS;
        try {
          gas = await publicClient!.estimateContractGas({
            address: SWAPPER_ADDRESS,
            abi: SWAPPER_ABI,
            functionName: 'executePlanFromCaller',
            args: makeSwapArgs([modifiedSwap], recipient),
            account: recipient,
          });
          console.log(`    ⛽ Gas estimate: ${gas.toString()}`);
          gas = (gas * 150n) / 100n;
        } catch (gasError: any) {
          console.log(`    ⚠️ Gas estimation failed, using default: ${DEFAULT_GAS.toString()}`);
          gas = DEFAULT_GAS;
        }
        
        console.log(`    🚀 Submitting transaction...`);
        
        const hash = await writeContractAsync({
          address: SWAPPER_ADDRESS,
          abi: SWAPPER_ABI,
          functionName: 'executePlanFromCaller',
          args: makeSwapArgs([modifiedSwap], recipient),
          gas
        });
        
        console.log(`    ⏳ Waiting for tx: ${hash}`);
        
        // Track tx hash
        if (txHashes) {
          txHashes.push(hash);
        }
        
        const receipt = await publicClient!.waitForTransactionReceipt({ hash });
        
        if (receipt.status === 'reverted') {
          throw new Error('Transaction reverted on-chain');
        }
        
        console.log(`    ✅ Individual swap succeeded!`);
        successCount++;
        successfulAddresses.push(swap.tokenIn.toLowerCase());
        
        // Add to trade results
        if (tradeResults && quoteData) {
          tradeResults.push({
            address: quoteData.token.address,
            symbol: quoteData.token.symbol,
            decimals: quoteData.token.decimals,
            inputAmount: formatUnits(quoteData.token.walletBN, quoteData.token.decimals),
            inputValueUsd: quoteData.inputValueUsd,
            outputAmount: formatUnits(modifiedSwap.quotedOut, quotePreviewData?.outputDecimals || 18),
            outputValueUsd: Number(formatUnits(modifiedSwap.quotedOut, quotePreviewData?.outputDecimals || 18)) * (quotePreviewData?.outputPrice || 1),
            status: 'success',
            txHash: hash
          });
        }
        
      } catch (e: any) {
        const errorMsg = String(e.message || e);
        
        // Don't track user rejections as failures
        if (errorMsg.includes('User rejected') || errorMsg.includes('user denied')) {
          console.log(`    ⏸️ User rejected transaction`);
          
          if (tradeResults && quoteData) {
            tradeResults.push({
              address: quoteData.token.address,
              symbol: quoteData.token.symbol,
              decimals: quoteData.token.decimals,
              inputAmount: formatUnits(quoteData.token.walletBN, quoteData.token.decimals),
              inputValueUsd: quoteData.inputValueUsd,
              status: 'skipped',
              reason: 'User rejected'
            });
          }
        } else {
          console.log(`    ❌ Execution failed: ${errorMsg.substring(0, 100)}`);
          trackFailedToken(swap.tokenIn, quoteData?.token.symbol || 'UNKNOWN', errorMsg.substring(0, 100), 'individual_exec');
          
          if (tradeResults && quoteData) {
            tradeResults.push({
              address: quoteData.token.address,
              symbol: quoteData.token.symbol,
              decimals: quoteData.token.decimals,
              inputAmount: formatUnits(quoteData.token.walletBN, quoteData.token.decimals),
              inputValueUsd: quoteData.inputValueUsd,
              status: 'failed',
              reason: parseSwapError(e).reason
            });
          }
        }
      }
    }
    
    if (successCount > 0) {
      showToast(`Recovered ${successCount}/${problemTokens.length} problem tokens`, "info");
    }
    
    return { successCount, successfulAddresses };
  };

  /**
   * Execute confirmed swaps from quote preview (ported from page.tsx)
   * This is the main execution function with proper flow:
   * 1. Approvals (track if any needed)
   * 2. Re-fetch quotes if approvals caused delay
   * 3. Simulate each swap individually
   * 4. Execute only passing swaps
   * 5. Isolate and retry failures
   * 6. Show post-trade results modal
   */
  const executeConfirmedSwaps = async () => {
    if (!account || !publicClient || !quotePreviewData) return;
    
    const selectedQuotes = quotePreviewData.quotes.filter(q => q.selected);
    if (selectedQuotes.length === 0) {
      showToast('No tokens selected for swap', 'warning');
      return;
    }
    
    // Filter by force requirement
    const executableQuotes = selectedQuotes.filter(q => q.lossPercent <= 5 || q.forceHighSlippage);
    const skippedHighImpact = selectedQuotes.filter(q => q.lossPercent > 5 && !q.forceHighSlippage);
    
    if (executableQuotes.length === 0) {
      showToast('All selected tokens have >5% impact and require "Force"', 'warning');
      return;
    }
    
    setShowQuotePreview(false);
    setIsProcessing(true);
    setFailedTokens([]);
    
    const mode = quotePreviewData._mode || 'USDC';
    const targetTokenAddr = mode === 'iAERO' ? AERO_ADDR : USDC_ADDR;
    const outputDecimals = quotePreviewData.outputDecimals;
    const outputPrice = quotePreviewData.outputPrice;
    
    let totalSuccess = 0;
    let totalFailed = skippedHighImpact.length;
    const successfulTokens = new Set<string>();
    const failedTokensMap = new Map<string, string>();
    
    // Initialize trade results tracking
    const tradeResults: TradeResultItem[] = [];
    const txHashes: string[] = [];
    
    // Pre-populate skipped tokens in results
    for (const sq of skippedHighImpact) {
      trackFailedToken(sq.token.address, sq.token.symbol, `${sq.lossPercent.toFixed(1)}% impact requires Force`, 'high_impact');
      tradeResults.push({
        address: sq.token.address,
        symbol: sq.token.symbol,
        decimals: sq.token.decimals,
        inputAmount: formatUnits(sq.token.walletBN, sq.token.decimals),
        inputValueUsd: sq.inputValueUsd,
        status: 'skipped',
        reason: `${sq.lossPercent.toFixed(1)}% price impact (requires Force)`
      });
    }
    
    try {
      // Get output token balance BEFORE swaps
      const balanceBefore = await publicClient.readContract({
        address: targetTokenAddr,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account as Address]
      }) as bigint;
      
      const tokensToSwap = executableQuotes.map(q => q.token);

      // ═══════════════════════════════════════════════════════════════
      // STEP 1: Approvals (track if any were needed)
      // ═══════════════════════════════════════════════════════════════
      setProgressStep(`Checking approvals...`);
      const { approvalsNeeded, failedTokens: approvalFailures } = await ensureApprovals(tokensToSwap);
      
      // Update failed count and track in results
      for (const addr of approvalFailures) {
        failedTokensMap.set(addr, 'Approval failed');
        totalFailed++;
        
        const token = executableQuotes.find(q => q.token.address.toLowerCase() === addr);
        if (token) {
          tradeResults.push({
            address: token.token.address,
            symbol: token.token.symbol,
            decimals: token.token.decimals,
            inputAmount: formatUnits(token.token.walletBN, token.token.decimals),
            inputValueUsd: token.inputValueUsd,
            status: 'failed',
            reason: 'Approval failed or rejected'
          });
        }
      }
      
      // Filter out approval failures
      let quotesToExecute = executableQuotes.filter(
        q => !approvalFailures.has(q.token.address.toLowerCase())
      );
      
      if (quotesToExecute.length === 0) {
        throw new Error('All token approvals failed');
      }
      
      // ═══════════════════════════════════════════════════════════════
      // STEP 2: ALWAYS re-fetch quotes before execution
      // Quotes from preview modal can be stale - always get fresh data
      // ═══════════════════════════════════════════════════════════════
      setProgressStep('Refreshing quotes before execution...');
      console.log(`\n🔄 Re-fetching ${quotesToExecute.length} quotes (ensuring fresh data)...`);
      if (approvalsNeeded > 0) {
        console.log(`   (${approvalsNeeded} approvals were done, quotes likely stale)`);
      }
      
      const freshQuotes: typeof executableQuotes = [];
      const totalRefreshBatches = Math.ceil(quotesToExecute.length / QUOTE_BATCH_SIZE);
      
      for (let batchStart = 0; batchStart < quotesToExecute.length; batchStart += QUOTE_BATCH_SIZE) {
        const batch = quotesToExecute.slice(batchStart, batchStart + QUOTE_BATCH_SIZE);
        const batchNum = Math.floor(batchStart / QUOTE_BATCH_SIZE) + 1;
        
        setProgressStep(`Refreshing quotes (${batchNum}/${totalRefreshBatches})...`);
        
        const quotePromises = batch.map(async (sq) => {
          try {
            const freshQuote = await fetch0xQuote(
              chainId || 8453,
              sq.token.address,
              targetTokenAddr,
              sq.token.walletBN,
              SWAPPER_ADDRESS
            );
            
            if (!freshQuote?.transaction?.to || !freshQuote?.transaction?.data) {
              throw new Error('Invalid quote response');
            }
            
            return { sq, freshQuote, error: null };
          } catch (err: any) {
            return { sq, freshQuote: null, error: err.message || 'Re-quote failed' };
          }
        });
        
        const results = await Promise.all(quotePromises);
        
        for (const { sq, freshQuote, error } of results) {
          if (freshQuote) {
            const newBuyAmount = BigInt(freshQuote.buyAmount);
            const newQuotedOutputUsd = Number(formatUnits(newBuyAmount, outputDecimals)) * outputPrice;
            
            const priceChange = sq.quotedOutputUsd > 0 
              ? ((newQuotedOutputUsd - sq.quotedOutputUsd) / sq.quotedOutputUsd) * 100 
              : 0;
            
            console.log(`  ${sq.token.symbol}: $${sq.quotedOutputUsd.toFixed(2)} → $${newQuotedOutputUsd.toFixed(2)} (${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%)`);
            
            const newLossPercent = sq.inputValueUsd > 0 
              ? Math.max(0, ((sq.inputValueUsd - newQuotedOutputUsd) / sq.inputValueUsd) * 100) 
              : 0;
            
            freshQuotes.push({
              ...sq,
              quotedOutputUsd: newQuotedOutputUsd,
              lossPercent: newLossPercent,
              lossUsd: Math.max(0, sq.inputValueUsd - newQuotedOutputUsd),
              quote: {
                token: sq.token,
                buyAmount: newBuyAmount,
                buyAmountFormatted: formatUnits(newBuyAmount, outputDecimals),
                transactionTo: freshQuote.transaction.to as Address,
                transactionData: freshQuote.transaction.data as `0x${string}`,
                priceImpact: newLossPercent
              }
            });
          } else {
            console.warn(`  ${sq.token.symbol}: re-quote failed - ${error}`);
            failedTokensMap.set(sq.token.address.toLowerCase(), `Re-quote failed: ${error}`);
            trackFailedToken(sq.token.address, sq.token.symbol, `Re-quote failed: ${error}`, 'requote');
            totalFailed++;
            
            tradeResults.push({
              address: sq.token.address,
              symbol: sq.token.symbol,
              decimals: sq.token.decimals,
              inputAmount: formatUnits(sq.token.walletBN, sq.token.decimals),
              inputValueUsd: sq.inputValueUsd,
              status: 'failed',
              reason: `Quote refresh failed: ${error}`
            });
          }
        }
        
        if (batchStart + QUOTE_BATCH_SIZE < quotesToExecute.length) {
          await new Promise(r => setTimeout(r, 300));
        }
      }
      
      if (freshQuotes.length === 0) {
        throw new Error('All re-quotes failed');
      }
      
      console.log(`✅ Got ${freshQuotes.length} fresh quotes`);
      quotesToExecute = freshQuotes;

      // ═══════════════════════════════════════════════════════════════
      // STEP 3: Build swap plan from quotes
      // ═══════════════════════════════════════════════════════════════
      setProgressStep('Building swap plan...');
      console.log(`\n🔧 Building plan for ${quotesToExecute.length} swaps...`);
      
      // Create a map from tokenIn address to quote data for result tracking
      const quoteByAddress = new Map<string, typeof quotesToExecute[0]>();
      quotesToExecute.forEach(sq => quoteByAddress.set(sq.token.address.toLowerCase(), sq));
      
      const swapPlan: SwapStep[] = quotesToExecute.map(sq => {
        const q = sq.quote;
        const encodedData = encodeAbiParameters(
          [{ type: 'address' }, { type: 'bytes' }],
          [q.transactionTo, q.transactionData]
        );
        
        const slippageBps = calculateSlippage(sq.lossPercent, sq.forceHighSlippage);
        
        // Determine if we're swapping the full balance or a custom amount
        const isFullSweep = sq.token.walletBN >= sq.token.fullBalanceBN;
        
        console.log(`  ${sq.token.symbol}: slippage=${slippageBps/100}%, impact=${sq.lossPercent.toFixed(2)}%, useAll=${isFullSweep}`);
        
        return {
          kind: RouterKind.AGGREGATOR,
          tokenIn: sq.token.address,
          outToken: targetTokenAddr,
          useAll: isFullSweep,
          amountIn: sq.token.walletBN,
          quotedIn: sq.token.walletBN,
          quotedOut: q.buyAmount,
          slippageBps,
          data: encodedData as `0x${string}`,
          viaPermit2: false,
          permitSig: '0x' as `0x${string}`,
          permitAmount: 0n,
          permitDeadline: 0n,
          permitNonce: 0n
        };
      });

      // ═══════════════════════════════════════════════════════════════
      // STEP 4: Execute in batches with per-swap simulation
      // ═══════════════════════════════════════════════════════════════
      const totalBatches = Math.ceil(swapPlan.length / EXECUTION_BATCH_SIZE);
      
      console.log(`\n🚀 Executing ${swapPlan.length} swaps in ${totalBatches} batch(es)...`);
      
      for (let batchStart = 0; batchStart < swapPlan.length; batchStart += EXECUTION_BATCH_SIZE) {
        const batchSwaps = swapPlan.slice(batchStart, batchStart + EXECUTION_BATCH_SIZE);
        const batchNum = Math.floor(batchStart / EXECUTION_BATCH_SIZE) + 1;
        
        console.log(`\n═══════════════════════════════════════════════`);
        console.log(`📦 BATCH ${batchNum}/${totalBatches}`);
        console.log(`═══════════════════════════════════════════════`);
        
        // Simulate this batch
        setProgressStep(`Batch ${batchNum}/${totalBatches}: Simulating...`);
        const { passing, failing } = await simulateSwapsIndividually(batchSwaps, account as Address);
        
        // Mark simulation failures
        for (const { swap, error } of failing) {
          failedTokensMap.set(swap.tokenIn.toLowerCase(), error);
          totalFailed++;
          
          const quoteData = quoteByAddress.get(swap.tokenIn.toLowerCase());
          tradeResults.push({
            address: swap.tokenIn,
            symbol: quoteData?.token.symbol || 'UNKNOWN',
            decimals: quoteData?.token.decimals || 18,
            inputAmount: formatUnits(swap.amountIn, quoteData?.token.decimals || 18),
            inputValueUsd: quoteData?.inputValueUsd || 0,
            status: 'failed',
            reason: `Simulation failed: ${error}`
          });
        }
        
        if (passing.length === 0) {
          console.log(`  ⚠️ Batch ${batchNum}: All swaps failed simulation`);
          continue;
        }
        
        // Validate batch with gas estimation
        setProgressStep(`Batch ${batchNum}/${totalBatches}: Validating...`);
        let planToExecute = passing;
        let problemTokensToRetry: SwapStep[] = [];
        
        try {
          const batchGas = await publicClient.estimateContractGas({
            address: SWAPPER_ADDRESS,
            abi: SWAPPER_ABI,
            functionName: 'executePlanFromCaller',
            args: makeSwapArgs(passing, account as Address),
            account: account as Address,
          });
          console.log(`  ✅ Batch ${batchNum} validated (gas: ${batchGas.toString()})`);
          
        } catch (batchValidationError: any) {
          const batchErrorMsg = String(batchValidationError.message || batchValidationError);
          console.log(`  ❌ Batch ${batchNum} validation failed`);
          console.log(`  📋 Error: ${batchErrorMsg.substring(0, 200)}`);
          
          // Log details about what passed simulation but failed batch validation
          console.log(`  📊 Batch contains ${passing.length} swaps that passed individual simulation:`);
          passing.forEach((swap, idx) => {
            console.log(`     ${idx+1}. ${swap.tokenIn} → slippage=${swap.slippageBps}bps, amount=${swap.amountIn.toString()}`);
          });
          
          // ALWAYS isolate problem tokens - simulation can pass but batch can still fail
          // due to stale quotes, liquidity changes, or token interactions
          console.log(`  🔍 Isolating problem tokens...`);
          
          const { workingPlan, problemTokens } = await isolateProblemTokens(passing, account as Address);
          planToExecute = workingPlan;
          problemTokensToRetry = problemTokens;
          
          if (workingPlan.length === 0) {
            console.log(`  ⚠️ No working batch found, trying all tokens individually with fresh quotes`);
            
            // Try each token individually with JIT quote refresh
            const { successCount, successfulAddresses } = await executeProblemTokensIndividually(
              passing, 
              account as Address, 
              targetTokenAddr,
              tradeResults,
              txHashes
            );
            
            for (const addr of successfulAddresses) {
              successfulTokens.add(addr);
            }
            totalSuccess += successCount;
            
            // Mark failures - find tokens that didn't succeed
            for (const swap of passing) {
              const addr = swap.tokenIn.toLowerCase();
              if (!successfulAddresses.includes(addr)) {
                failedTokensMap.set(addr, 'Batch and individual execution failed');
                totalFailed++;
                
                // Add to trade results if not already there
                const existingResult = tradeResults.find(r => r.address.toLowerCase() === addr);
                if (!existingResult) {
                  const quoteData = quotesToExecute.find(q => q.token.address.toLowerCase() === addr);
                  if (quoteData) {
                    tradeResults.push({
                      address: quoteData.token.address,
                      symbol: quoteData.token.symbol,
                      decimals: quoteData.token.decimals,
                      inputAmount: formatUnits(quoteData.token.walletBN, quoteData.token.decimals),
                      inputValueUsd: quoteData.inputValueUsd,
                      status: 'failed',
                      reason: 'Execution failed after retry'
                    });
                  }
                }
              }
            }
            
            continue; // Move to next batch
          } else {
            console.log(`  ✅ Isolated: ${workingPlan.length} working, ${problemTokens.length} problematic`);
          }
        }
        
        // Execute the working batch
        if (planToExecute.length > 0) {
          setProgressStep(`Batch ${batchNum}/${totalBatches}: Executing ${planToExecute.length} swaps...`);
          
          try {
            // Try gas estimation, fall back to default if it fails
            let gas: bigint;
            const DEFAULT_BATCH_GAS = 300000n + BigInt(planToExecute.length) * 200000n;
            
            try {
              gas = await publicClient.estimateContractGas({
                address: SWAPPER_ADDRESS,
                abi: SWAPPER_ABI,
                functionName: 'executePlanFromCaller',
                args: makeSwapArgs(planToExecute, account as Address),
                account: account as Address,
              });
              gas = (gas * 130n) / 100n;
            } catch (gasEstError: any) {
              // Gas estimation failed - use default and try anyway
              console.log(`  ⚠️ Gas estimation failed, using default: ${DEFAULT_BATCH_GAS.toString()}`);
              gas = DEFAULT_BATCH_GAS;
            }
            
            const hash = await writeContractAsync({
              address: SWAPPER_ADDRESS,
              abi: SWAPPER_ABI,
              functionName: 'executePlanFromCaller',
              args: makeSwapArgs(planToExecute, account as Address),
              gas
            });
            
            // Track this transaction
            txHashes.push(hash);
            
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            
            if (receipt.status === 'reverted') {
              throw new Error('Transaction reverted on-chain');
            }
            
            console.log(`  ✅ Batch ${batchNum} executed: ${planToExecute.length} swaps`);
            
            // Mark all as successful and add to trade results
            for (const swap of planToExecute) {
              const addr = swap.tokenIn.toLowerCase();
              successfulTokens.add(addr);
              totalSuccess++;
              
              // Find quote data for this swap to get amounts
              const quoteData = quotesToExecute.find(q => q.token.address.toLowerCase() === addr);
              if (quoteData) {
                tradeResults.push({
                  address: quoteData.token.address,
                  symbol: quoteData.token.symbol,
                  decimals: quoteData.token.decimals,
                  inputAmount: formatUnits(quoteData.token.walletBN, quoteData.token.decimals),
                  inputValueUsd: quoteData.inputValueUsd,
                  outputAmount: quoteData.quote.buyAmountFormatted,
                  outputValueUsd: quoteData.quotedOutputUsd,
                  status: 'success',
                  txHash: hash
                });
              }
            }
            
          } catch (execError: any) {
            const errorMsg = execError.message || String(execError);
            
            // Don't treat user rejection as failure
            if (errorMsg.includes('User rejected') || errorMsg.includes('user denied')) {
              console.log(`  ⏸️ User rejected batch transaction`);
              // Mark all as skipped
              for (const swap of planToExecute) {
                const quoteData = quotesToExecute.find(q => q.token.address.toLowerCase() === swap.tokenIn.toLowerCase());
                if (quoteData) {
                  tradeResults.push({
                    address: quoteData.token.address,
                    symbol: quoteData.token.symbol,
                    decimals: quoteData.token.decimals,
                    inputAmount: formatUnits(quoteData.token.walletBN, quoteData.token.decimals),
                    inputValueUsd: quoteData.inputValueUsd,
                    status: 'skipped',
                    reason: 'User rejected transaction'
                  });
                }
              }
            } else if (errorMsg.includes('reverted on-chain') || errorMsg.includes('Transaction reverted')) {
              console.error(`  ❌ Batch ${batchNum} reverted, trying tokens individually...`);
              
              // Batch reverted - try each token individually with fresh quotes
              const { successCount, successfulAddresses } = await executeProblemTokensIndividually(
                planToExecute, 
                account as Address, 
                targetTokenAddr,
                tradeResults,
                txHashes
              );
              
              for (const addr of successfulAddresses) {
                successfulTokens.add(addr);
              }
              totalSuccess += successCount;
              
              // Mark failures
              for (const swap of planToExecute) {
                const addr = swap.tokenIn.toLowerCase();
                if (!successfulAddresses.includes(addr)) {
                  failedTokensMap.set(addr, 'Transaction reverted');
                  totalFailed++;
                  
                  const quoteData = quotesToExecute.find(q => q.token.address.toLowerCase() === addr);
                  if (quoteData && !tradeResults.find(r => r.address.toLowerCase() === addr)) {
                    tradeResults.push({
                      address: quoteData.token.address,
                      symbol: quoteData.token.symbol,
                      decimals: quoteData.token.decimals,
                      inputAmount: formatUnits(quoteData.token.walletBN, quoteData.token.decimals),
                      inputValueUsd: quoteData.inputValueUsd,
                      status: 'failed',
                      reason: 'Transaction reverted'
                    });
                  }
                }
              }
            } else {
              console.error(`  ❌ Batch ${batchNum} execution failed:`, errorMsg.slice(0, 100));
              
              // Try individual execution as fallback
              const { successCount, successfulAddresses } = await executeProblemTokensIndividually(
                planToExecute, 
                account as Address, 
                targetTokenAddr,
                tradeResults,
                txHashes
              );
              
              for (const addr of successfulAddresses) {
                successfulTokens.add(addr);
              }
              totalSuccess += successCount;
              
              for (const swap of planToExecute) {
                const addr = swap.tokenIn.toLowerCase();
                if (!successfulAddresses.includes(addr)) {
                  failedTokensMap.set(addr, 'Individual execution failed');
                  totalFailed++;
                  
                  const quoteData = quotesToExecute.find(q => q.token.address.toLowerCase() === addr);
                  if (quoteData && !tradeResults.find(r => r.address.toLowerCase() === addr)) {
                    tradeResults.push({
                      address: quoteData.token.address,
                      symbol: quoteData.token.symbol,
                      decimals: quoteData.token.decimals,
                      inputAmount: formatUnits(quoteData.token.walletBN, quoteData.token.decimals),
                      inputValueUsd: quoteData.inputValueUsd,
                      status: 'failed',
                      reason: 'Execution failed'
                    });
                  }
                }
              }
            }
          }
        }
        
        // Execute problem tokens individually with fresh quotes
        if (problemTokensToRetry.length > 0) {
          console.log(`  🔄 Trying ${problemTokensToRetry.length} problem tokens individually with fresh quotes...`);
          const { successCount, successfulAddresses } = await executeProblemTokensIndividually(
            problemTokensToRetry, 
            account as Address, 
            targetTokenAddr,
            tradeResults,
            txHashes
          );
          
          for (const addr of successfulAddresses) {
            successfulTokens.add(addr);
          }
          totalSuccess += successCount;
          
          for (const swap of problemTokensToRetry) {
            const addr = swap.tokenIn.toLowerCase();
            if (!successfulAddresses.includes(addr)) {
              failedTokensMap.set(addr, 'Individual execution failed');
              totalFailed++;
              
              const quoteData = quotesToExecute.find(q => q.token.address.toLowerCase() === addr);
              if (quoteData && !tradeResults.find(r => r.address.toLowerCase() === addr)) {
                tradeResults.push({
                  address: quoteData.token.address,
                  symbol: quoteData.token.symbol,
                  decimals: quoteData.token.decimals,
                  inputAmount: formatUnits(quoteData.token.walletBN, quoteData.token.decimals),
                  inputValueUsd: quoteData.inputValueUsd,
                  status: 'failed',
                  reason: 'Problem token - execution failed'
                });
              }
            }
          }
        }
        
        // Small delay between batches
        if (batchStart + EXECUTION_BATCH_SIZE < swapPlan.length) {
          await new Promise(r => setTimeout(r, 500));
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // STEP 5: Finalize - Build results and show modal
      // ═══════════════════════════════════════════════════════════════
      setProgressStep('Finalizing...');
      
      // Build unique results (dedupe by address)
      const seenAddresses = new Set<string>();
      const uniqueResults = tradeResults.filter(r => {
        const addr = r.address.toLowerCase();
        if (seenAddresses.has(addr)) return false;
        seenAddresses.add(addr);
        return true;
      });
      
      // FIX: Calculate totals from successful trade results, not balance diff
      // Balance diff can be 0 due to RPC lag or if tokens were already swapped further
      const successfulResults = uniqueResults.filter(r => r.status === 'success');
      const totalOutputFromResults = successfulResults.reduce((sum, r) => {
        return sum + (r.outputAmount ? parseFloat(r.outputAmount) : 0);
      }, 0);
      const totalOutputUsdFromResults = successfulResults.reduce((sum, r) => {
        return sum + (r.outputValueUsd || 0);
      }, 0);
      const totalInputUsdFromResults = uniqueResults.reduce((sum, r) => sum + r.inputValueUsd, 0);
      
      // FIX: Check if nothing was actually executed (user likely rejected all)
      if (totalSuccess === 0 && totalFailed === 0) {
        // Mark all as skipped due to user cancellation
        for (const sq of quotesToExecute) {
          if (!tradeResults.find(r => r.address.toLowerCase() === sq.token.address.toLowerCase())) {
            tradeResults.push({
              address: sq.token.address,
              symbol: sq.token.symbol,
              decimals: sq.token.decimals,
              inputAmount: formatUnits(sq.token.walletBN, sq.token.decimals),
              inputValueUsd: sq.inputValueUsd,
              status: 'skipped',
              reason: 'User cancelled in wallet'
            });
          }
        }
        
        setPostTradeData({
          mode,
          outputToken: mode === 'iAERO' ? 'AERO' : 'USDC',
          outputDecimals,
          totalInputUsd: totalInputUsdFromResults,
          totalOutputUsd: 0,
          totalReceived: '0',
          totalReceivedFormatted: '0',
          successCount: 0,
          failedCount: 0,
          skippedCount: quotesToExecute.length,
          results: tradeResults,
          txHashes: [],
          timestamp: Date.now(),
          userCancelled: true
        });
        setShowPostTradeModal(true);
        setIsProcessing(false);
        setProgressStep('');
        setQuotePreviewData(null);
        return;
      }
      
      console.log(`\n═══════════════════════════════════════════════`);
      console.log(`✅ SWEEP COMPLETE`);
      console.log(`   Successful: ${totalSuccess}/${quotesToExecute.length}`);
      console.log(`   Failed: ${totalFailed}`);
      console.log(`   Total Output: ${totalOutputFromResults.toFixed(4)} ${mode === 'iAERO' ? 'AERO' : 'USDC'}`);
      console.log(`   Value: $${totalOutputUsdFromResults.toFixed(2)}`);
      console.log(`═══════════════════════════════════════════════`);
      
      if (totalSuccess === 0) {
        setPostTradeData({
          mode,
          outputToken: mode === 'iAERO' ? 'AERO' : 'USDC',
          outputDecimals,
          totalInputUsd: totalInputUsdFromResults,
          totalOutputUsd: 0,
          totalReceived: '0',
          totalReceivedFormatted: '0',
          successCount: 0,
          failedCount: totalFailed,
          skippedCount: skippedHighImpact.length,
          results: uniqueResults,
          txHashes,
          timestamp: Date.now()
        });
        setShowPostTradeModal(true);
        showToast("No swaps were executed successfully", "warning");
        await handleRefresh();
        return;
      }
      
      // If iAERO mode, do the AERO -> iAERO step
      let didStake = false;
      let stakedAmount: string | undefined;
      
      if (mode === 'iAERO') {
        try {
          const stakeResult = await performAeroToIaeroStep();
          didStake = stakeResult.success;
          stakedAmount = stakeResult.stakedAmount;
        } catch (stakeError: any) {
          console.error('AERO to iAERO step failed:', stakeError);
          // Don't fail the whole operation - swaps succeeded, staking failed
          showToast('Swaps succeeded but staking failed. Your AERO/iAERO is in your wallet.', 'warning');
        }
      }
      
      // Show post-trade modal with calculated totals
      setPostTradeData({
        mode,
        outputToken: mode === 'iAERO' 
          ? (didStake ? 'Staked iAERO' : 'AERO') 
          : 'USDC',
        outputDecimals,
        totalInputUsd: totalInputUsdFromResults,
        totalOutputUsd: totalOutputUsdFromResults,
        totalReceived: totalOutputFromResults.toString(),
        totalReceivedFormatted: totalOutputFromResults.toFixed(4),
        successCount: totalSuccess,
        failedCount: totalFailed,
        skippedCount: skippedHighImpact.length,
        results: uniqueResults,
        txHashes,
        timestamp: Date.now(),
        didStake,
        stakedAmount
      });
      setShowPostTradeModal(true);
      
      await handleRefresh();
      
    } catch (err: any) {
      if (!err.message?.includes("User rejected")) {
        console.error('Swap execution error:', err);
        showToast(err.message || 'Swap failed', 'error');
      }
    } finally {
      setIsProcessing(false);
      setProgressStep('');
      setQuotePreviewData(null);
    }
  };

  /**
   * AERO -> iAERO step via Aerodrome Router
   * Returns success status and staked amount
   */
  const performAeroToIaeroStep = async (): Promise<{ success: boolean; stakedAmount?: string }> => {
    console.log("\n🔄 Step 2: Waiting for AERO balance update...");
    setProgressStep("Waiting for blockchain to index...");
    
    const startAERO = await publicClient?.readContract({
      address: AERO_ADDR,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account as Address]
    }) as bigint || 0n;

    let aeroBalance = 0n;
    let attempts = 0;
    while (attempts < 10) {
      await new Promise(r => setTimeout(r, 2000));
      aeroBalance = await publicClient?.readContract({
        address: AERO_ADDR,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account as Address]
      }) as bigint || 0n;
      if (aeroBalance > 0n && aeroBalance >= startAERO) break;
      attempts++;
    }

    if (aeroBalance <= 0n) {
      console.warn("Sweep partial: Rewards moved to AERO, but balance didn't update.");
      return { success: false };
    }

    console.log(`💰 AERO Balance to Swap: ${formatBigNumber(aeroBalance, 18, 4)}`);
    console.log("🔄 Step 3: Swapping AERO -> iAERO via Aerodrome Router...");
    setProgressStep("Step 2/3: Aerodrome Swap (AERO->iAERO)...");

    const currentAllowance = await publicClient?.readContract({
      address: AERO_ADDR,
      abi: ERC20_FULL_ABI,
      functionName: 'allowance',
      args: [account as Address, AERODROME_ROUTER],
    }) as bigint;

    if (currentAllowance < aeroBalance) {
      const approveHash = await writeContractAsync({
        address: AERO_ADDR,
        abi: ERC20_FULL_ABI,
        functionName: 'approve',
        args: [AERODROME_ROUTER, aeroBalance],
      });
      await publicClient?.waitForTransactionReceipt({ hash: approveHash });
    }

    const routes = [{ 
      from: AERO_ADDR, 
      to: IAERO_ADDR, 
      stable: false, 
      factory: AERODROME_FACTORY
    }];
    
    let amountOutMin = 0n;
    try {
      const amounts = await publicClient?.readContract({
        address: AERODROME_ROUTER,
        abi: AERODROME_ABI,
        functionName: 'getAmountsOut',
        args: [aeroBalance, routes]
      }) as readonly bigint[];
      if (amounts && amounts.length > 0) amountOutMin = (amounts[amounts.length - 1] * 9500n) / 10000n;
    } catch {}

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
    
    // Capture iAERO balance BEFORE the Aerodrome swap
    const iAeroBalanceBefore = await publicClient?.readContract({
      address: IAERO_ADDR,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account as Address],
    }) as bigint || 0n;
    console.log(`  📊 iAERO balance before swap: ${formatBigNumber(iAeroBalanceBefore, 18, 4)}`);
    
    const hash = await writeContractAsync({
      address: AERODROME_ROUTER,
      abi: AERODROME_ABI,
      functionName: 'swapExactTokensForTokens',
      args: [aeroBalance, amountOutMin, routes, account as Address, deadline],
    });

    await publicClient?.waitForTransactionReceipt({ hash });
    console.log("  ✅ Aerodrome swap confirmed");
    
    // Step 4: Stake iAERO to Staking Distributor
    console.log("🔄 Step 4: Staking iAERO to Staking Distributor...");
    setProgressStep("Step 3/3: Waiting for iAERO balance...");
    
    // Wait for iAERO balance to increase
    let iAeroBalance = iAeroBalanceBefore;
    let iAeroAttempts = 0;
    
    while (iAeroAttempts < 15) {
      await new Promise(r => setTimeout(r, 2000));
      iAeroBalance = await publicClient?.readContract({
        address: IAERO_ADDR,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account as Address],
      }) as bigint || 0n;
      
      // Just check if balance increased at all
      if (iAeroBalance > iAeroBalanceBefore) {
        console.log(`  ✅ iAERO balance updated: ${formatBigNumber(iAeroBalanceBefore, 18, 4)} → ${formatBigNumber(iAeroBalance, 18, 4)}`);
        break;
      }
      
      iAeroAttempts++;
      console.log(`  ⏳ Attempt ${iAeroAttempts}/15: waiting for iAERO balance to update...`);
    }
    
    if (iAeroBalance <= iAeroBalanceBefore) {
      console.warn("⚠️ iAERO balance didn't update after Aerodrome swap - staking existing balance");
      // Still try to stake what's there if > 0
      if (iAeroBalance <= 0n) {
        return { success: false, stakedAmount: '0' };
      }
    }
    
    console.log(`💰 iAERO Balance to Stake: ${formatBigNumber(iAeroBalance, 18, 4)}`);
    const stakedAmountStr = formatBigNumber(iAeroBalance, 18, 4);
    
    // Check allowance for staking
    const stakingAllowance = await publicClient?.readContract({
      address: IAERO_ADDR,
      abi: ERC20_FULL_ABI,
      functionName: 'allowance',
      args: [account as Address, STAKING_DISTRIBUTOR],
    }) as bigint;
    
    // Approve if needed
    if (stakingAllowance < iAeroBalance) {
      console.log("📝 Approving iAERO for staking...");
      setProgressStep("Approving iAERO for staking...");
      const approveHash = await writeContractAsync({
        address: IAERO_ADDR,
        abi: ERC20_FULL_ABI,
        functionName: 'approve',
        args: [STAKING_DISTRIBUTOR, iAeroBalance],
      });
      await publicClient?.waitForTransactionReceipt({ hash: approveHash });
      console.log("✅ iAERO approved for staking");
    }
    
    // Stake full iAERO balance
    console.log(`🎯 Calling stake(${iAeroBalance})...`);
    setProgressStep("Staking iAERO...");
    const stakeHash = await writeContractAsync({
      address: STAKING_DISTRIBUTOR,
      abi: STAKING_ABI,
      functionName: 'stake',
      args: [iAeroBalance],
    });
    
    await publicClient?.waitForTransactionReceipt({ hash: stakeHash });
    console.log("✅ Successfully staked iAERO!");
    
    return { success: true, stakedAmount: stakedAmountStr };
  };

  // ============================================================================
  // BUTTON HANDLERS
  // ============================================================================

  const handleClaimAndConvert = async () => {
    if (!account) return;
    if (SWAPPER_ADDRESS.includes("YOUR_DEPLOYED")) { showToast("Swapper not configured!", "error"); return; }
    
    setIsProcessing(true);
    try {
      // 1. Claim first
      const tokensToClaim = rows.filter(r => (r.claimableBN || 0n) > 0n).map(r => r.address);
        
      if (tokensToClaim.length > 0) {
        setProgressStep(`Claiming ${tokensToClaim.length} rewards first...`);
        await new Promise<void>((resolve, reject) => {
          claimSelected(tokensToClaim, {
            onProgress: (m: string) => setProgressStep(m),
            onSuccess: () => { 
              showToast("Claimed! Scanning wallet...", "success");
              resolve(); 
            },
            onError: (e: any) => reject(e)
          });
        });
        
        await new Promise(r => setTimeout(r, 2000));
      }
  
      // 2. Scan wallet
      setProgressStep("Scanning wallet...");
      const { validTokens, priceMap } = await scanForSwapCandidates();
      
      if (validTokens.length === 0) {
        showToast("No valid tokens found to swap", "info");
        return;
      }
      
      // 3. Build quote preview
      const preview = await buildQuotePreview(validTokens, USDC_ADDR, priceMap, 'USDC');
      
      if (!preview || preview.quotes.length === 0) {
        showToast("Failed to get quotes for any tokens", "error");
        return;
      }
      
      preview._mode = 'USDC';
      preview._priceMap = priceMap;
      
      // 4. Show preview modal
      setQuotePreviewData(preview);
      setShowQuotePreview(true);
      
    } catch (e: any) {
      if (!e.message?.includes("User rejected")) { 
        console.error(e); 
        showToast(msgFromError(e, "Process failed"), "error"); 
      }
    } finally { 
      setIsProcessing(false); 
      setProgressStep(""); 
    }
  };

  const handleClaimAndCompound = async () => {
    if (!account) return;
    if (SWAPPER_ADDRESS.includes("YOUR_DEPLOYED")) { showToast("Swapper not configured!", "error"); return; }
    
    setIsProcessing(true);
    try {
      // 1. Claim first
      const tokensToClaim = rows.filter(r => (r.claimableBN || 0n) > 0n).map(r => r.address);
  
      if (tokensToClaim.length > 0) {
        setProgressStep(`Claiming ${tokensToClaim.length} rewards first...`);
        await new Promise<void>((resolve, reject) => {
          claimSelected(tokensToClaim, { 
            onProgress: (m: string) => setProgressStep(m), 
            onSuccess: () => { 
              showToast("Claimed! Scanning wallet...", "success");
              resolve(); 
            }, 
            onError: (e: any) => reject(e) 
          });
        });
        
        await new Promise(r => setTimeout(r, 2000));
      }
  
      // 2. Scan wallet
      setProgressStep("Scanning wallet...");
      const { validTokens, priceMap } = await scanForSwapCandidates();
      
      if (validTokens.length === 0) {
        showToast("No valid tokens found to swap", "info");
        return;
      }
      
      // 3. Build quote preview (swap to AERO, then Aerodrome to iAERO)
      const preview = await buildQuotePreview(validTokens, AERO_ADDR, priceMap, 'iAERO');
      
      if (!preview || preview.quotes.length === 0) {
        showToast("Failed to get quotes for any tokens", "error");
        return;
      }
      
      preview._mode = 'iAERO';
      preview._priceMap = priceMap;
      
      // 4. Show preview modal
      setQuotePreviewData(preview);
      setShowQuotePreview(true);
      
    } catch (e: any) {
      if (!e.message?.includes("User rejected")) { 
        console.error(e); 
        showToast(msgFromError(e, "Process failed"), "error"); 
      }
    } finally { 
      setIsProcessing(false); 
      setProgressStep(""); 
    }
  };

  const handleSwapAllRewards = async () => {
    if (!account) return;
    if (SWAPPER_ADDRESS.includes("YOUR_DEPLOYED")) { showToast("Swapper not configured!", "error"); return; }
    
    setIsProcessing(true);
    try {
      // 1. Scan for candidates
      setProgressStep("Scanning wallet...");
      const { validTokens, priceMap } = await scanForSwapCandidates();
      
      if (validTokens.length === 0) {
        showToast("No valid tokens found to swap", "info");
        return;
      }
      
      // 2. Build quote preview
      const preview = await buildQuotePreview(validTokens, USDC_ADDR, priceMap, 'USDC');
      
      if (!preview || preview.quotes.length === 0) {
        showToast("Failed to get quotes for any tokens", "error");
        return;
      }
      
      preview._mode = 'USDC';
      preview._priceMap = priceMap;
      
      // 3. Show preview modal
      setQuotePreviewData(preview);
      setShowQuotePreview(true);
      
    } catch (e: any) {
      if (!e.message?.includes("User rejected")) { 
        console.error(e); 
        showToast(msgFromError(e, "Scan failed"), "error"); 
      }
    } finally { 
      setIsProcessing(false); 
      setProgressStep(""); 
    }
  };

  const handleSweepToIAERO = async () => {
    if (!account) return;
    if (SWAPPER_ADDRESS.includes("YOUR_DEPLOYED")) { showToast("Swapper not configured!", "error"); return; }
    
    setIsProcessing(true);
    try {
      // 1. Scan for candidates
      setProgressStep("Scanning wallet...");
      const { validTokens, priceMap } = await scanForSwapCandidates();
      
      if (validTokens.length === 0) {
        showToast("No valid tokens found to swap", "info");
        return;
      }
      
      // 2. Build quote preview (swap to AERO first, then Aerodrome to iAERO)
      const preview = await buildQuotePreview(validTokens, AERO_ADDR, priceMap, 'iAERO');
      
      if (!preview || preview.quotes.length === 0) {
        showToast("Failed to get quotes for any tokens", "error");
        return;
      }
      
      preview._mode = 'iAERO';
      preview._priceMap = priceMap;
      
      // 3. Show preview modal
      setQuotePreviewData(preview);
      setShowQuotePreview(true);
      
    } catch (e: any) {
      if (!e.message?.includes("User rejected")) { 
        console.error(e); 
        showToast(msgFromError(e, "Scan failed"), "error"); 
      }
    } finally { 
      setIsProcessing(false); 
      setProgressStep(""); 
    }
  };

  const handleOpenCustomSweep = async () => {
    if (!account) return;
    if (SWAPPER_ADDRESS.includes("YOUR_DEPLOYED")) { showToast("Swapper not configured!", "error"); return; }
    setIsProcessing(true);
    try {
      const { validTokens } = await scanForSwapCandidates();
      setCandidates(validTokens);
      setSelectedTokens(new Set(validTokens.map(t => t.address)));
      setCustomAmounts({});
      setReviewModalOpen(true);
    } catch (e: any) {
      showToast(msgFromError(e, "Scan failed"), "error");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleConfirmSweep = async (mode: 'USDC' | 'iAERO') => {
    const selectedCandidates = candidates.filter(t => selectedTokens.has(t.address));
    
    if (selectedCandidates.length === 0) {
      showToast("Please select at least one token.", "warning");
      return;
    }

    // Apply custom amounts (preserve fullBalanceBN for useAll comparison)
    const tokensToSwap: TokenForSwap[] = selectedCandidates.map(t => {
      const customInput = customAmounts[t.address];
      if (customInput && customInput !== "") {
        try {
          const cleanInput = customInput.replace(/,/g, '');
          const newAmount = parseUnits(cleanInput, t.decimals);
          if (newAmount > 0n) {
            // Clamp to full balance, but preserve fullBalanceBN
            const safeAmount = newAmount > t.fullBalanceBN ? t.fullBalanceBN : newAmount;
            return { ...t, walletBN: safeAmount };  // fullBalanceBN stays unchanged
          }
        } catch (e) {
          console.warn("Invalid custom amount for", t.symbol, e);
        }
      }
      return t;
    });

    setReviewModalOpen(false); 
    setIsProcessing(true); 

    try {
      const addresses = tokensToSwap.map(t => t.address);
      const priceMap = await fetchPricesForAddrs(addresses, chainId || 8453);
      
      const targetToken = mode === 'iAERO' ? AERO_ADDR : USDC_ADDR;
      const outputName = mode === 'iAERO' ? 'iAERO' : 'USDC';

      setProgressStep("Fetching quotes...");
      const preview = await buildQuotePreview(tokensToSwap, targetToken, priceMap, outputName);
      
      if (!preview || preview.quotes.length === 0) {
        showToast("Failed to get quotes for any tokens", "error");
        return;
      }
      
      preview._mode = mode;
      preview._priceMap = priceMap;
      
      setQuotePreviewData(preview);
      setShowQuotePreview(true);

    } catch (e: any) {
      console.error(e);
      showToast("Failed to fetch quotes", "error");
    } finally {
      setIsProcessing(false);
      setProgressStep("");
    }
  };

  // ============================================================================
  // CLAIM LOGIC (unchanged from original)
  // ============================================================================

  async function preflight(items: any[], account: Address, distributor: Address) {
    try {
      const pc = publicClient as unknown as PublicClient<Transport, Chain> | undefined;
      if (!pc) return { keep: items.map(it => ({ ...it, preview: 0n })), drop: [] };
      
      const calls = items.flatMap(it => ([
        { address: distributor, abi: PREVIEW_ABI, functionName: 'previewClaim' as const, args: [account, it.address, it.epoch] },
        { address: it.address as Address, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [distributor] }
      ]));
      
      const res = await pc.multicall({ contracts: calls });
      const keep: any[] = [], drop: any[] = [];

      const simulatedBalances: Record<string, bigint> = {};

      for (let i = 0; i < items.length; i++) {
        const previewRes = res[2 * i];
        const balRes = res[2 * i + 1];
        
        const p = previewRes.status === 'success' ? (previewRes.result as bigint) : 0n;
        const rawBalance = balRes.status === 'success' ? (balRes.result as bigint) : 0n;
        const tokenAddr = items[i].address.toLowerCase();

        if (simulatedBalances[tokenAddr] === undefined) {
          simulatedBalances[tokenAddr] = rawBalance;
        }

        if (p > 0n) {
          if (simulatedBalances[tokenAddr] >= p) {
            keep.push({ ...items[i], preview: p });
            simulatedBalances[tokenAddr] -= p; 
          } else {
            console.warn(`⚠️ Skipping ${items[i].symbol} (Epoch ${items[i].epoch}): Insufficient remaining funds`);
            drop.push({ 
              ...items[i], 
              preview: p, 
              bal: simulatedBalances[tokenAddr], 
              reason: 'Protocol Insufficient Funds' 
            });
          }
        }
      }
      return { keep, drop };
    } catch (err) {
      console.error("Preflight check failed:", err);
      return { keep: items.map(it => ({ ...it, preview: 0n })), drop: [] };
    }
  }

  async function claimSelected(tokens: string[], { onProgress, onSuccess, onError }: any) {
    try {
      const selected = rows
        .filter((r: any) => (r.rawBN ?? 0n) > 0n && tokens.includes(r.address) && r.address !== ZERO)
        .map(r => {
          const epochToUse = typeof r.epoch === 'bigint' ? r.epoch : (lastEpoch || 0n);
          return {
            address: r.address as Address,
            epoch: epochToUse, 
            hadExplicitEpoch: true, 
            symbol: r.symbol,
          };
        });

      const missingEpochs = selected.some(x => !x.hadExplicitEpoch);
      if (missingEpochs && lastEpoch) showToast(`Using funded epoch ${lastEpoch.toString()} for batch claim.`, "info");
      
      if (selected.length === 0) { onProgress?.('No claimable rewards.'); onSuccess?.(); return; }

      const { keep, drop } = await preflight(selected, account as Address, distAddr as Address);

      if (drop.length > 0) {
        const skippedNames = drop.map((d: any) => d.symbol).join(", ");
        showToast(`Skipping ${drop.length} tokens: ${skippedNames}`, "warning");
      }

      if (keep.length === 0) { 
        onProgress?.('No tokens available with sufficient protocol liquidity.'); 
        onSuccess?.(); 
        return; 
      }

      const haveAllEpochs = keep.every(x => typeof x.epoch === 'bigint');
      const MAX = 50;

      if (distAddr && haveAllEpochs) {
        for (let i = 0; i < keep.length; i += MAX) {
          const slice = keep.slice(i, i + MAX);
          
          onProgress?.(`Submitting batch claim ${Math.floor(i / MAX) + 1}/${Math.ceil(keep.length / MAX)}…`);
          
          let gas: bigint | undefined;
          try {
            gas = await publicClient?.estimateContractGas({
              account: account as Address,
              address: distAddr as Address,
              abi: EPOCH_DIST_ABI,
              functionName: 'claimMany',
              args: [slice.map(x => x.address), slice.map(x => x.epoch as bigint)],
            });
          } catch { gas = 200_000n + BigInt(slice.length) * 120_000n; }
          
          const hash = await writeContractAsync({
            address: distAddr as Address,
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

      // Fallback: Claim one by one
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

  // ============================================================================
  // RENDER
  // ============================================================================

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
                  <TrendingUp className="w-4 h-4 mr-2" />Compound & Stake
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

          {/* Swap Tools Section */}
          <div className="mt-6 border-t border-slate-800/50 pt-6">
            <h4 className="text-white font-medium mb-3 flex items-center gap-2">
              <Coins className="w-4 h-4 text-yellow-400" />
              Swap Tools
            </h4>
            
            <div className="flex flex-col gap-3">
              <Button 
                onClick={handleOpenCustomSweep}
                disabled={isProcessing}
                className="w-full h-12 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white border-0"
              >
                <div className="flex items-center gap-2">
                  {isProcessing && progressStep.includes("Scanning") ? <Loader2 className="w-4 h-4 animate-spin"/> : <History className="w-4 h-4" />}
                  <span>Customise tokens to sweep</span>
                </div>
              </Button>

              <div className="grid grid-cols-2 gap-3">
                <Button 
                  onClick={handleSwapAllRewards}
                  disabled={isProcessing}
                  className="h-auto py-4 whitespace-normal leading-tight bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white border-0"
                >
                  <div className="flex flex-col items-center gap-1">
                    <RefreshCw className="w-5 h-5 mb-1" />
                    <span className="text-xs">Sweep ALL to USDC</span>
                  </div>
                </Button>
                
                <Button 
                  onClick={handleSweepToIAERO}
                  disabled={isProcessing}
                  className="h-auto py-4 whitespace-normal leading-tight bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white border-0"
                >
                  <div className="flex flex-col items-center gap-1">
                    <TrendingUp className="w-5 h-5 mb-1" />
                    <span className="text-xs">Sweep ALL to iAERO & Stake</span>
                  </div>
                </Button>
              </div>
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

      {/* ================================================================
          CUSTOM SWEEP MODAL - Token Selection
          ================================================================ */}
      <AnimatePresence>
        {reviewModalOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onClick={() => setReviewModalOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-slate-800 border border-slate-700 rounded-2xl max-w-lg w-full max-h-[80vh] overflow-hidden"
            >
              <div className="p-4 border-b border-slate-700 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white">Select Tokens to Sweep</h3>
                <Button variant="ghost" size="sm" onClick={() => setReviewModalOpen(false)}>
                  <X className="w-5 h-5" />
                </Button>
              </div>

              <div className="p-4 max-h-[50vh] overflow-y-auto space-y-2">
                {candidates.map((token) => {
                  const isSelected = selectedTokens.has(token.address);
                  const customVal = customAmounts[token.address] ?? "";
                  const fullAmount = formatUnits(token.walletBN, token.decimals);

                  return (
                    <div
                      key={token.address}
                      className={`p-3 rounded-xl border transition-all ${
                        isSelected
                          ? "bg-emerald-500/10 border-emerald-500/40"
                          : "bg-slate-900/50 border-slate-700/50 opacity-60"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <label className="flex items-center gap-2 cursor-pointer flex-1">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => {
                              setSelectedTokens((prev) => {
                                const next = new Set(prev);
                                if (next.has(token.address)) next.delete(token.address);
                                else next.add(token.address);
                                return next;
                              });
                            }}
                            className="w-4 h-4 rounded border-slate-600 text-emerald-500 focus:ring-emerald-500"
                          />
                          <span className="text-white font-medium">{token.symbol}</span>
                        </label>
                        <span className="text-slate-400 text-sm">
                          {token.valueUsd ? `$${token.valueUsd.toFixed(2)}` : ''}
                        </span>
                      </div>

                      {isSelected && (
                        <div className="flex items-center gap-2 mt-2">
                          <input
                            type="text"
                            placeholder={fullAmount}
                            value={customVal}
                            onChange={(e) =>
                              setCustomAmounts((prev) => ({
                                ...prev,
                                [token.address]: e.target.value,
                              }))
                            }
                            className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs border-slate-600"
                            onClick={() =>
                              setCustomAmounts((prev) => ({
                                ...prev,
                                [token.address]: fullAmount,
                              }))
                            }
                          >
                            Max
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="p-4 border-t border-slate-700 space-y-3">
                <div className="text-sm text-slate-400 text-center">
                  {selectedTokens.size} token(s) selected
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Button
                    onClick={() => handleConfirmSweep('USDC')}
                    disabled={selectedTokens.size === 0}
                    className="bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700"
                  >
                    Sweep to USDC
                  </Button>
                  <Button
                    onClick={() => handleConfirmSweep('iAERO')}
                    disabled={selectedTokens.size === 0}
                    className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
                  >
                    Sweep to iAERO
                  </Button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ================================================================
          QUOTE PREVIEW MODAL - Review before execution
          ================================================================ */}
      <AnimatePresence>
        {showQuotePreview && quotePreviewData && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onClick={() => { setShowQuotePreview(false); setQuotePreviewData(null); }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-slate-800 border border-slate-700 rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden"
            >
              <div className="p-4 border-b border-slate-700 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-white">Review Swap Preview</h3>
                  <p className="text-sm text-slate-400">
                    Swapping to {quotePreviewData._mode === 'iAERO' ? 'AERO → iAERO (staked)' : 'USDC'}
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => { setShowQuotePreview(false); setQuotePreviewData(null); }}>
                  <X className="w-5 h-5" />
                </Button>
              </div>

              <div className="p-4 max-h-[55vh] overflow-y-auto">
                {/* Summary stats */}
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div className="bg-slate-900/50 rounded-xl p-3 text-center">
                    <div className="text-2xl font-bold text-white">{quotePreviewData.quotes.length}</div>
                    <div className="text-xs text-slate-400">Tokens</div>
                  </div>
                  <div className="bg-slate-900/50 rounded-xl p-3 text-center">
                    <div className="text-2xl font-bold text-emerald-400">
                      ${quotePreviewData.quotes.filter(q => q.selected).reduce((s, q) => s + q.quotedOutputUsd, 0).toFixed(2)}
                    </div>
                    <div className="text-xs text-slate-400">Est. Output</div>
                  </div>
                  <div className="bg-slate-900/50 rounded-xl p-3 text-center">
                    <div className="text-2xl font-bold text-yellow-400">
                      {quotePreviewData.quotes.filter(q => q.selected && q.lossPercent > 5).length}
                    </div>
                    <div className="text-xs text-slate-400">High Impact</div>
                  </div>
                </div>

                {/* Quote rows */}
                <div className="space-y-2">
                  {quotePreviewData.quotes.map((q, idx) => {
                    const isHighImpact = q.lossPercent > 5;
                    const needsForce = isHighImpact && !q.forceHighSlippage;
                    
                    return (
                      <div
                        key={`${q.token.address}-${idx}`}
                        className={`p-3 rounded-xl border transition-all ${
                          q.selected
                            ? isHighImpact
                              ? "bg-yellow-500/10 border-yellow-500/40"
                              : "bg-emerald-500/10 border-emerald-500/40"
                            : "bg-slate-900/30 border-slate-700/30 opacity-50"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <label className="flex items-center gap-3 cursor-pointer flex-1">
                            <input
                              type="checkbox"
                              checked={q.selected}
                              onChange={() => toggleQuoteSelection(q.token.address)}
                              className="w-4 h-4 rounded border-slate-600 text-emerald-500 focus:ring-emerald-500"
                            />
                            <div>
                              <div className="text-white font-medium">{q.token.symbol}</div>
                              <div className="text-xs text-slate-400">
                                {formatNumber(Number(formatUnits(q.token.walletBN, q.token.decimals)), 4)} tokens
                              </div>
                            </div>
                          </label>
                          
                          <div className="text-right">
                            <div className="text-white font-medium">
                              ${q.quotedOutputUsd.toFixed(2)}
                            </div>
                            <div className={`text-xs ${q.lossPercent > 5 ? 'text-yellow-400' : q.lossPercent > 2 ? 'text-orange-400' : 'text-slate-400'}`}>
                              {q.lossPercent > 0.01 ? `-${q.lossPercent.toFixed(2)}%` : '~0%'} impact
                            </div>
                          </div>
                        </div>
                        
                        {/* Force high slippage toggle for high impact tokens */}
                        {isHighImpact && q.selected && (
                          <div className="mt-2 pt-2 border-t border-slate-700/50 flex items-center justify-between">
                            <div className="flex items-center gap-2 text-xs text-yellow-400">
                              <AlertTriangle className="w-3 h-3" />
                              <span>High price impact ({q.lossPercent.toFixed(1)}%)</span>
                            </div>
                            <label className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={q.forceHighSlippage || false}
                                onChange={() => toggleForceSlippage(q.token.address)}
                                className="w-3 h-3 rounded border-slate-600 text-yellow-500 focus:ring-yellow-500"
                              />
                              <span className="text-xs text-yellow-400">Force swap</span>
                            </label>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Failed quotes section */}
                {quotePreviewData.failedQuotes.length > 0 && (
                  <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl">
                    <div className="flex items-center gap-2 text-red-400 text-sm font-medium mb-2">
                      <XCircle className="w-4 h-4" />
                      <span>Failed to get quotes ({quotePreviewData.failedQuotes.length})</span>
                    </div>
                    <div className="space-y-1">
                      {quotePreviewData.failedQuotes.map((f, idx) => (
                        <div key={idx} className="text-xs text-slate-400 flex justify-between">
                          <span>{f.token.symbol}</span>
                          <span className="text-red-400/70">{f.error}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="p-4 border-t border-slate-700 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-400">
                    {quotePreviewData.quotes.filter(q => q.selected).length} of {quotePreviewData.quotes.length} selected
                  </span>
                  <span className="text-slate-400">
                    {quotePreviewData.quotes.filter(q => q.selected && q.lossPercent > 5 && !q.forceHighSlippage).length > 0 && (
                      <span className="text-yellow-400">
                        ⚠️ {quotePreviewData.quotes.filter(q => q.selected && q.lossPercent > 5 && !q.forceHighSlippage).length} need "Force"
                      </span>
                    )}
                  </span>
                </div>
                
                <Button
                  onClick={executeConfirmedSwaps}
                  disabled={quotePreviewData.quotes.filter(q => q.selected).length === 0}
                  className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 py-3"
                >
                  <Zap className="w-4 h-4 mr-2" />
                  Execute {quotePreviewData.quotes.filter(q => q.selected && (q.lossPercent <= 5 || q.forceHighSlippage)).length} Swap(s)
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ================================================================
          POST-TRADE RESULTS MODAL - Shows what actually happened
          ================================================================ */}
      <AnimatePresence>
        {showPostTradeModal && postTradeData && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4"
            onClick={() => { setShowPostTradeModal(false); setPostTradeData(null); }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-slate-800 border border-slate-700 rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden"
            >
              {/* Header */}
              <div className="p-4 border-b border-slate-700 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {postTradeData.userCancelled ? (
                    <div className="w-10 h-10 rounded-full bg-slate-500/20 flex items-center justify-center">
                      <X className="w-5 h-5 text-slate-400" />
                    </div>
                  ) : postTradeData.successCount > 0 ? (
                    <div className="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center">
                      <Trophy className="w-5 h-5 text-emerald-400" />
                    </div>
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center">
                      <XCircle className="w-5 h-5 text-red-400" />
                    </div>
                  )}
                  <div>
                    <h3 className="text-lg font-semibold text-white">
                      {postTradeData.userCancelled 
                        ? 'Swap Cancelled' 
                        : postTradeData.successCount > 0 
                          ? 'Swap Complete!' 
                          : 'Swap Failed'}
                    </h3>
                    <p className="text-sm text-slate-400">
                      {postTradeData.userCancelled 
                        ? 'Transaction was rejected in wallet'
                        : `${postTradeData.successCount} succeeded, ${postTradeData.failedCount} failed${postTradeData.skippedCount > 0 ? `, ${postTradeData.skippedCount} skipped` : ''}`}
                    </p>
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => { setShowPostTradeModal(false); setPostTradeData(null); }}>
                  <X className="w-5 h-5" />
                </Button>
              </div>

              {/* Summary Cards */}
              {!postTradeData.userCancelled && (
                <div className="p-4 border-b border-slate-700/50">
                  <div className="grid grid-cols-3 gap-3">
                    {/* Total Received */}
                    <div className="bg-gradient-to-br from-emerald-500/10 to-teal-500/10 rounded-xl p-4 border border-emerald-500/20">
                      <div className="text-xs text-slate-400 mb-1">Total Received</div>
                      <div className="text-xl font-bold text-emerald-400">
                        {postTradeData.totalReceivedFormatted}
                      </div>
                      <div className="text-sm text-emerald-400/70">
                        {postTradeData.outputToken}
                      </div>
                    </div>
                    
                    {/* Value */}
                    <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/50">
                      <div className="text-xs text-slate-400 mb-1">USD Value</div>
                      <div className="text-xl font-bold text-white">
                        ${postTradeData.totalOutputUsd.toFixed(2)}
                      </div>
                      {postTradeData.totalInputUsd > 0 && (
                        <div className="text-xs text-slate-500">
                          from ${postTradeData.totalInputUsd.toFixed(2)} input
                        </div>
                      )}
                    </div>
                    
                    {/* Success Rate */}
                    <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/50">
                      <div className="text-xs text-slate-400 mb-1">Success Rate</div>
                      <div className={`text-xl font-bold ${
                        postTradeData.successCount === postTradeData.results.length 
                          ? 'text-emerald-400' 
                          : postTradeData.successCount > 0 
                            ? 'text-yellow-400' 
                            : 'text-red-400'
                      }`}>
                        {postTradeData.results.length > 0 
                          ? Math.round((postTradeData.successCount / postTradeData.results.length) * 100)
                          : 0}%
                      </div>
                      <div className="text-xs text-slate-500">
                        {postTradeData.successCount}/{postTradeData.results.length} tokens
                      </div>
                    </div>
                  </div>
                  
                  {/* Staking indicator */}
                  {postTradeData.didStake && postTradeData.stakedAmount && (
                    <div className="mt-3 bg-purple-500/10 border border-purple-500/30 rounded-xl p-3 flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-purple-500/20 flex items-center justify-center">
                        <TrendingUp className="w-4 h-4 text-purple-400" />
                      </div>
                      <div>
                        <div className="text-sm font-medium text-purple-300">Auto-Staked</div>
                        <div className="text-xs text-purple-400/70">{postTradeData.stakedAmount} iAERO staked to earn rewards</div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Individual Results */}
              <div className="p-4 max-h-[40vh] overflow-y-auto">
                <div className="text-sm font-medium text-slate-400 mb-3">Token Details</div>
                
                <div className="space-y-2">
                  {postTradeData.results.map((result, idx) => (
                    <div
                      key={`${result.address}-${idx}`}
                      className={`p-3 rounded-xl border ${
                        result.status === 'success'
                          ? 'bg-emerald-500/5 border-emerald-500/20'
                          : result.status === 'skipped'
                            ? 'bg-slate-500/5 border-slate-500/20'
                            : 'bg-red-500/5 border-red-500/20'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {/* Status icon */}
                          <div className={`w-6 h-6 rounded-full flex items-center justify-center ${
                            result.status === 'success'
                              ? 'bg-emerald-500/20'
                              : result.status === 'skipped'
                                ? 'bg-slate-500/20'
                                : 'bg-red-500/20'
                          }`}>
                            {result.status === 'success' ? (
                              <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                            ) : result.status === 'skipped' ? (
                              <ArrowRight className="w-3.5 h-3.5 text-slate-400" />
                            ) : (
                              <XCircle className="w-3.5 h-3.5 text-red-400" />
                            )}
                          </div>
                          
                          <div>
                            <div className="font-medium text-white">{result.symbol}</div>
                            <div className="text-xs text-slate-500">
                              {Number(result.inputAmount).toFixed(4)} tokens
                              {result.inputValueUsd > 0 && ` (~$${result.inputValueUsd.toFixed(2)})`}
                            </div>
                          </div>
                        </div>
                        
                        <div className="text-right">
                          {result.status === 'success' ? (
                            <>
                              <div className="text-emerald-400 font-medium">
                                +{result.outputAmount ? Number(result.outputAmount).toFixed(4) : '—'}
                              </div>
                              {result.outputValueUsd && (
                                <div className="text-xs text-emerald-400/70">
                                  ${result.outputValueUsd.toFixed(2)}
                                </div>
                              )}
                            </>
                          ) : result.status === 'skipped' ? (
                            <div className="text-xs text-slate-400">Skipped</div>
                          ) : (
                            <div className="text-xs text-red-400">Failed</div>
                          )}
                        </div>
                      </div>
                      
                      {/* Failure reason */}
                      {result.status !== 'success' && result.reason && (
                        <div className={`mt-2 pt-2 border-t text-xs ${
                          result.status === 'skipped' ? 'border-slate-700/50 text-slate-500' : 'border-red-500/20 text-red-400/80'
                        }`}>
                          {result.reason}
                        </div>
                      )}
                      
                      {/* Tx hash link */}
                      {result.txHash && (
                        <div className="mt-2 pt-2 border-t border-emerald-500/10">
                          <a
                            href={`${txBaseUrl}${result.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
                          >
                            <ExternalLink className="w-3 h-3" />
                            View transaction
                          </a>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                
                {/* Transaction hashes summary */}
                {postTradeData.txHashes.length > 0 && (
                  <div className="mt-4 p-3 bg-slate-900/50 rounded-xl border border-slate-700/50">
                    <div className="text-xs text-slate-400 mb-2">Transaction{postTradeData.txHashes.length > 1 ? 's' : ''}</div>
                    <div className="space-y-1">
                      {postTradeData.txHashes.map((hash, idx) => (
                        <a
                          key={idx}
                          href={`${txBaseUrl}${hash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300"
                        >
                          <ExternalLink className="w-3 h-3" />
                          <span className="font-mono">{hash.slice(0, 10)}...{hash.slice(-8)}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="p-4 border-t border-slate-700">
                <Button
                  onClick={() => { setShowPostTradeModal(false); setPostTradeData(null); }}
                  className="w-full bg-slate-700 hover:bg-slate-600 text-white"
                >
                  Close
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}