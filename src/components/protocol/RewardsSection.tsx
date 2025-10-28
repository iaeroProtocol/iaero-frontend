// ==============================================
// src/components/protocol/RewardsSection.tsx
// ==============================================
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { usePublicClient } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { parseAbi, getAddress as toChecksum } from 'viem';
import {
  Gift,
  TrendingUp,
  Loader2,
  Clock,
  RefreshCw,
  History,
  CheckCircle,
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

// ---------- Types ----------
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
}

interface TxHistory {
  type: "claim" | "claimAll";
  tokens: string[];
  amounts: string[];
  totalValue: number;
  timestamp: number;
  txHash?: string;
}

// ---------- Gas estimates ----------
const GAS_ESTIMATES = {
  claimSingle: 120000n,
  claimAll: 200000n,
};

// ---------- Helpers ----------
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

// ---------- Component ----------
export default function RewardsSection({ showToast, formatNumber }: RewardsSectionProps) {
  const {
    connected,
    networkSupported,
    chainId,
    account,
    balances,
    loading,
  } = useProtocol();

  const publicClient = usePublicClient();

  // only the methods we actually use
  const {
    claimReward,
    loading: stakingLoading,
    calculateStakingAPR,
  } = useStaking();

  const { prices } = usePrices();

  // canonical rows (from off-chain JSON)
  const [pending, setPending] = useState<Array<{ token: string; amount: string; symbol?: string; decimals?: number }>>([]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [progressStep, setProgressStep] = useState("");
  const [claimingSpecific, setClaimingSpecific] = useState<string | null>(null);
  const [stakingAPR, setStakingAPR] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [txHistory, setTxHistory] = useState<TxHistory[]>([]);
  const [estimatedGasCost, setEstimatedGasCost] = useState<string>("0");

  // visible flags
  const [rewardsLoading, setRewardsLoading] = useState(false);
  const [pricesLoading, setPricesLoading] = useState(false);

  // APY state (unchanged logic)
  const [apyPct, setApyPct] = useState<number | null>(null);
  const [apyLoading, setApyLoading] = useState<boolean>(false);
  const [apyError,   setApyError]   = useState<string | null>(null);

  // 1e18 helpers for APY math
  const E18 = 10n ** 18n;
  const toE18 = (num: number) => BigInt(Math.round(num * 1e18));

  const formatUSD = (v: number, max = 6) => {
    if (!isFinite(v) || v === 0) return "$0";
    const tiny = 1e-6;
    if (v > 0 && v < tiny) {
      const threshold = tiny.toLocaleString(undefined, { maximumFractionDigits: max });
      return `< $${threshold}`;
    }
    return `$${v.toLocaleString(undefined, {
      minimumFractionDigits: v < 1 ? Math.min(max, 6) : 2,
      maximumFractionDigits: max,
    })}`;
  };

  const txBaseUrl = useMemo(
    () =>
      chainId === 84532
        ? "https://sepolia.basescan.org/tx/"
        : chainId === 8453
        ? "https://basescan.org/tx/"
        : "https://etherscan.io/tx/",
    [chainId]
  );

  const stakedIAeroBN = useMemo(
    () => parseInputToBigNumber(balances?.stakedIAero || "0"),
    [balances?.stakedIAero]
  );

  const ZERO = "0x0000000000000000000000000000000000000000";
  const DEFAULT_WETH_BASE = "0x4200000000000000000000000000000000000006";

  // --------- Price fetching for rows ----------
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
    } catch {
      return {};
    }
  }

  // --------- Off-chain per-staker rewards JSON ----------
  const STAKER_REWARDS_URL =
    process.env.NEXT_PUBLIC_STAKER_REWARDS_URL
    || "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/staker_rewards.json";

  type PendingJsonItem = {
    token: string;
    decimals?: number;
    amount?: string;
    amountHuman?: number;
    priceUsd?: number;
    usd?: number;
    symbol?: string;
  };

  function normalizeOffchain(list: PendingJsonItem[]) {
    return list.map((it) => {
      const human =
        typeof it.amountHuman === "number"
          ? String(it.amountHuman)
          : it.amount
          ? (Number(it.amount) / 10 ** (it.decimals ?? 18)).toString()
          : "0";
      return {
        token: it.token,
        amount: human,
        symbol: it.symbol,
        decimals: typeof it.decimals === "number" ? it.decimals : 18,
      };
    });
  }

  async function fetchOffchainPending(addr: string): Promise<PendingJsonItem[]> {
    const r = await fetch(STAKER_REWARDS_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`staker_rewards.json ${r.status}`);
    const j = await r.json();
    const lower = addr.toLowerCase();

    // Shape A: { holders: [{ address, pending: [...] }, ...] }
    if (Array.isArray(j?.holders)) {
      const h = j.holders.find((x: any) => (x?.address || "").toLowerCase() === lower);
      return Array.isArray(h?.pending) ? h.pending : [];
    }
    // Shape B: { [address]: { pending: [...] } }
    const maybe = j[lower] || j[addr] || null;
    if (maybe?.pending && Array.isArray(maybe.pending)) return maybe.pending;

    // Shape C: { pending: [...] }
    if (Array.isArray(j?.pending)) return j.pending;

    return [];
  }

  // --------- APY (unchanged) ----------
  const REWARDS_JSON_URL =
    process.env.NEXT_PUBLIC_REWARDS_JSON_URL ||
    "https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/estimated_rewards_usd.json";

  async function fetchStakersWeeklyUSD(): Promise<bigint> {
    const r = await fetch(REWARDS_JSON_URL, { cache: "no-store" });
    if (!r.ok) throw new Error(`rewards json ${r.status}`);
    const j = await r.json();
    if (j?.stakersWeeklyUSD_1e18) return BigInt(j.stakersWeeklyUSD_1e18);
    if (j?.estimatedWeeklyUSD_1e18) return (BigInt(j.estimatedWeeklyUSD_1e18) * 8000n) / 10000n;
    throw new Error("missing stakersWeeklyUSD");
  }

  const DIST_ABI = parseAbi(['function totalStaked() view returns (uint256)']);

  function addrOrEmpty(key: string) {
    try {
      const name = key as unknown as ContractName;
      return (getContractAddress(name, chainId || 8453) || '').toLowerCase();
    } catch {
      return '';
    }
  }

  const iAeroAddr = useMemo(() => (addrOrEmpty('iAERO') || addrOrEmpty('IAERO')).toLowerCase(), [chainId]);
  const distAddr  = useMemo(() => (addrOrEmpty('EPOCH_DIST') || addrOrEmpty('StakingDistributor') || addrOrEmpty('EPOCH_STAKING_DISTRIBUTOR')).toLowerCase(), [chainId]);

  useEffect(() => {
    if (!connected || !networkSupported) return;
    (async () => {
      try {
        const apr = await calculateStakingAPR();
        setStakingAPR(Number((apr as any)?.aero || 0));
      } catch (e) {
        console.error("calculateStakingAPR", e);
      }
    })();
  }, [connected, networkSupported, calculateStakingAPR]);

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

  useEffect(() => {
    if (connected && networkSupported) {
      estimateGasCost("all").then(setEstimatedGasCost);
    }
  }, [connected, networkSupported, estimateGasCost, pending]); // key off the new pending set

  // --------- Load OFF-CHAIN pending rewards for the connected wallet ----------
  useEffect(() => {
    if (!connected || !networkSupported || !account) return;
    (async () => {
      setRewardsLoading(true);
      try {
        const list = await fetchOffchainPending(account);
        const normalized = normalizeOffchain(list);
        setPending(normalized as any);

        // Preload any prices present in the file
        const preloaded: Record<string, number> = {};
        for (const it of list) {
          const k = (it.token || "").toLowerCase();
          if (k && typeof it.priceUsd === "number" && isFinite(it.priceUsd)) preloaded[k] = it.priceUsd;
        }
        if (Object.keys(preloaded).length) setPriceByAddr(prev => ({ ...prev, ...preloaded }));
      } catch (e) {
        console.error("load off-chain pending rewards failed", e);
        setPending([]);
      } finally {
        setRewardsLoading(false);
      }
    })();
  }, [connected, networkSupported, chainId, account]);

  const aeroAddr = useMemo(() => {
    try { return (getContractAddress("AERO", chainId || 8453) || "").toLowerCase(); }
    catch { return ""; }
  }, [chainId]);

  const liqAddr = useMemo(() => {
    try { return (getContractAddress("LIQ", chainId || 8453) || "").toLowerCase(); }
    catch { return ""; }
  }, [chainId]);

  // --------- Price map (with loading flag) ----------
  const [priceByAddr, setPriceByAddr] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!connected || !networkSupported) return;
    const list = pending.map(p => (p.token || '').toLowerCase()).filter(Boolean);
    if (!list.length) { setPriceByAddr({}); return; }
    (async () => {
      setPricesLoading(true);
      try {
        const map = await fetchPricesForAddrs(list, chainId ?? 8453);
        setPriceByAddr(map);
      } catch (e) {
        console.error('price fetch failed', e);
        setPriceByAddr({});
      } finally {
        setPricesLoading(false);
      }
    })();
  }, [connected, networkSupported, chainId, pending]);

  // --------- APY calc (unchanged logic) ----------
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

        if (!totalStakedRaw || totalStakedRaw === 0n) {
          setApyPct(0);
          setApyLoading(false);
          return;
        }

        let iaeroUsdNum = Number(prices?.iAERO?.usd ?? 0);
        if (!isFinite(iaeroUsdNum) || iaeroUsdNum <= 0) iaeroUsdNum = Number(prices?.AERO?.usd ?? 0);
        if (!isFinite(iaeroUsdNum) || iaeroUsdNum <= 0) throw new Error("iAERO/AERO price unavailable");
        const iaeroUsd_1e18 = toE18(iaeroUsdNum);

        const annualUSD_1e18 = stakersWeeklyUSD_1e18 * 52n;
        const tvlUSD_1e18 = (totalStakedRaw * iaeroUsd_1e18) / E18;
        if (tvlUSD_1e18 === 0n) {
          setApyPct(0);
          setApyLoading(false);
          return;
        }

        const apyRatio_1e18 = (annualUSD_1e18 * E18) / tvlUSD_1e18;
        const apyPct_1e18 = apyRatio_1e18 * 100n;
        const apyPctNum = Number(apyPct_1e18) / 1e18;
        setApyPct(apyPctNum);
      } catch (e: any) {
        console.error('APY calc error:', e?.message || e);
        setApyError('APY unavailable');
        setApyPct(null);
      } finally {
        setApyLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, networkSupported, publicClient, chainId, iAeroAddr, distAddr, prices]);

  // --------- Build rows ----------
  const rows: RewardTokenRow[] = useMemo(() => {
    const out: RewardTokenRow[] = [];
    for (const p of pending) {
      const addr = (p.token || '').toLowerCase();
      if (!addr) continue;
      const isETH = addr === ZERO;
      const decimals = typeof p.decimals === 'number' ? p.decimals : (isETH ? 18 : 18);
      const symbol = p.symbol || (isETH ? 'ETH' : (addr === aeroAddr ? 'AERO' : addr === liqAddr ? 'LIQ' : 'TOKEN'));
      let amountBN: bigint = 0n;
      try {
        const human = p.amount || '0';
        const parts = human.split('.');
        const whole = parts[0] || '0';
        const frac = (parts[1] || '').padEnd(decimals, '0').slice(0, decimals);
        amountBN = BigInt(whole + (decimals ? frac : ''));
      } catch {}
      const humanFloat = Number(p.amount || '0') || 0;
      const price = priceByAddr[addr] ?? 0;
      const usdValue = humanFloat * price;

      let icon = '💰', gradient = 'from-slate-600 to-slate-700';
      if (symbol === 'AERO') { icon = '🚀'; gradient = 'from-blue-500 to-cyan-500'; }
      else if (symbol === 'ETH') { icon = '⚡'; gradient = 'from-purple-500 to-indigo-500'; }
      else if (symbol === 'LIQ') { icon = '🟣'; gradient = 'from-fuchsia-500 to-purple-600'; }

      out.push({ address: addr, symbol, decimals, amountBN, usdValue, icon, gradient });
    }
    return out;
  }, [pending, priceByAddr, aeroAddr, liqAddr]);

  const hasRewards = useMemo(() => rows.some((r) => r.amountBN > 0n), [rows]);
  const totalRewardsUSD = useMemo(() => rows.reduce((s, r) => s + r.usdValue, 0), [rows]);

  const dailyRewardsPretty = useMemo(() => {
    if (stakedIAeroBN === 0n || stakingAPR === 0) return "0";
    const dailyYieldBN = calculateYield(stakedIAeroBN, stakingAPR, 1, 18);
    return formatBigNumber(dailyYieldBN, 18, 4);
  }, [stakedIAeroBN, stakingAPR]);

  const addToHistory = (
    type: TxHistory["type"],
    tokens: string[],
    amounts: string[],
    totalValue: number,
    txHash?: string
  ) =>
    setTxHistory((prev) => [
      { type, tokens, amounts, totalValue, timestamp: Date.now(), txHash },
      ...prev.slice(0, 4),
    ]);

  // --------- Refresh (off-chain) ----------
  const handleRefresh = async () => {
    if (!account) return;
    setIsRefreshing(true);
    try {
      const list = await fetchOffchainPending(account);
      setPending(normalizeOffchain(list) as any);

      // preload any prices
      const preloaded: Record<string, number> = {};
      for (const it of list) {
        const k = (it.token || "").toLowerCase();
        if (k && typeof it.priceUsd === "number" && isFinite(it.priceUsd)) preloaded[k] = it.priceUsd;
      }
      if (Object.keys(preloaded).length) setPriceByAddr(prev => ({ ...prev, ...preloaded }));

      showToast("Rewards refreshed", "info");
    } catch {
      showToast("Failed to refresh rewards", "error");
    } finally {
      setIsRefreshing(false);
    }
  };

  // --------- Gas sanity check ----------
  const checkGasBalance = async (): Promise<boolean> => {
    try {
      if (!publicClient) return true;
      const gasPrice = await publicClient.getGasPrice();
      const gasLimit = GAS_ESTIMATES.claimAll;
      const gasCost = gasPrice * gasLimit;
      const ethBal = parseInputToBigNumber(balances.ethBalance || "0");
      if (ethBal < gasCost) {
        showToast(`Insufficient ETH for gas. Need ~${formatBigNumber(gasCost, 18, 4)} ETH`, "warning");
        return false;
      }
      return true;
    } catch {
      return true;
    }
  };

  // --------- NEW: claim only the tokens we actually show ----------
  async function claimSelected(
    tokens: string[],
    {
      onProgress,
      onSuccess,
      onError,
    }: { onProgress?: (m?: string) => void; onSuccess?: (r?: any) => void; onError?: (e: any) => void }
  ) {
    try {
      const n = tokens.length;
      for (let i = 0; i < n; i++) {
        const t = tokens[i];
        onProgress?.(n > 1 ? `Claiming ${i + 1}/${n} tokens…` : "Claiming token…");
        await claimReward(
          t,
          (receipt: any) => { if (i === n - 1) onSuccess?.(receipt); },
          (e: any) => { onError?.(e); },
          (m?: string) => onProgress?.(m)
        );
      }
    } catch (e) {
      onError?.(e);
      throw e;
    }
  }

  // --------- Claim all (only currently-visible tokens) ----------
  const handleClaimAll = async () => {
    if (!hasRewards) return showToast("No rewards to claim", "info");
    if (!(await checkGasBalance())) return;

    setIsProcessing(true);
    setProgressStep("Preparing claim…");
    try {
      const selected = rows.filter(r => r.amountBN > 0n).map(r => r.address);
      await claimSelected(selected, {
        onProgress: (msg) => setProgressStep(msg ?? ""),
        onSuccess: (receipt) => {
          setShowSuccess(true);
          setTimeout(() => setShowSuccess(false), 3000);
          addToHistory(
            "claimAll",
            rows.map((r) => r.symbol),
            rows.map((r) => formatBigNumber(r.amountBN, r.decimals, 4)),
            totalRewardsUSD,
            receipt?.transactionHash
          );
          showToast(`Successfully claimed all rewards! Total value: ${formatUSD(totalRewardsUSD, 6)}`, "success");

          // refresh from off-chain file
          void (async () => {
            try {
              const list = await fetchOffchainPending(account!);
              setPending(normalizeOffchain(list) as any);
            } catch {}
          })();
        },
        onError: (e) => showToast(msgFromError(e, "Claim failed"), "error"),
      });
    } finally {
      setIsProcessing(false);
      setProgressStep("");
    }
  };

  // --------- Claim specific token ----------
  const handleClaimSpecific = async (
    address: string,
    symbol: string,
    decimals: number,
    amountBN: bigint,
    usdValue: number
  ) => {
    if (!amountBN || amountBN === 0n) return showToast(`No ${symbol} rewards to claim`, "info");

    setClaimingSpecific(address);
    setProgressStep(`Claiming ${symbol}…`);
    try {
      await claimSelected([address], {
        onProgress: (msg) => setProgressStep(msg ?? ""),
        onSuccess: (receipt) => {
          const pretty = formatBigNumber(amountBN, decimals, 4);
          setShowSuccess(true);
          setTimeout(() => setShowSuccess(false), 3000);
          addToHistory("claim", [symbol], [pretty], usdValue, receipt?.transactionHash);
          showToast(`Successfully claimed ${pretty} ${symbol}!`, "success");

          // refresh from off-chain file
          void (async () => {
            try {
              const list = await fetchOffchainPending(account!);
              setPending(normalizeOffchain(list) as any);
            } catch {}
          })();
        },
        onError: (e) => showToast(msgFromError(e, `${symbol} claim failed`), "error"),
      });
    } finally {
      setClaimingSpecific(null);
      setProgressStep("");
    }
  };

  // --------- Render ----------
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
            // Skeleton table
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
                  <div
                    key={`${r.address}-${idx}`}
                    className="grid grid-cols-12 items-center px-4 py-3 border-t border-slate-800/50 hover:bg-slate-900/60 transition"
                  >
                    <div className="col-span-4 flex items-center gap-2 truncate">
                      <span className="text-xl">{r.icon}</span>
                      <div className="min-w-0">
                        <div className="text-white font-medium truncate">{r.symbol}</div>
                        <div className="text-[11px] text-slate-400 truncate">{r.address}</div>
                      </div>
                    </div>

                    <div className="col-span-4 text-right text-white">
                      {formatBigNumber(r.amountBN, r.decimals, 6)}
                    </div>

                    <div className="col-span-3 text-right">
                      <span className="text-emerald-400 font-medium">
                        {r.usdValue ? `$${r.usdValue.toLocaleString(undefined, { maximumFractionDigits: 6 })}` : '$0'}
                      </span>
                    </div>

                    <div className="col-span-1 flex justify-end">
                      {r.amountBN > 0n && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 px-2 border-slate-600 text-slate-200 hover:bg-slate-700"
                          disabled={Boolean(claimingSpecific) || isProcessing || rewardsLoading || pricesLoading}
                          onClick={() => handleClaimSpecific(r.address, r.symbol, r.decimals, r.amountBN, r.usdValue)}
                        >
                          {claimingSpecific === r.address ? (
                            <>
                              <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                              Claiming…
                            </>
                          ) : (
                            'Claim'
                          )}
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <Button
                onClick={handleClaimAll}
                disabled={!hasRewards || isProcessing || stakingLoading || Boolean(claimingSpecific) || rewardsLoading || pricesLoading}
                className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 disabled:opacity-50 py-3 text-lg"
              >
                {isProcessing ? (
                  <div className="flex items-center justify-center space-x-2">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>{progressStep || "Processing..."}</span>
                  </div>
                ) : (
                  <>
                    <Gift className="w-5 h-5 mr-2" />
                    {hasRewards ? `Claim All Rewards (${formatUSD(totalRewardsUSD, 6)})` : "No Rewards to Claim"}
                  </>
                )}
              </Button>

              {isProcessing && (
                <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4">
                  <Progress value={progressStep ? 75 : 25} className="mb-2" />
                  <p className="text-sm text-slate-300">{progressStep}</p>
                </div>
              )}

              <AnimatePresence>
                {showSuccess && (
                  <motion.div
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.8, opacity: 0 }}
                    className="flex items-center justify-center py-4"
                  >
                    <div className="bg-emerald-500/20 rounded-full p-4">
                      <CheckCircle className="w-12 h-12 text-emerald-400" />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          ) : (
            <div className="bg-slate-900/30 rounded-xl p-8 border border-slate-700/20 text-center">
              <Gift className="w-12 h-12 text-slate-500 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-slate-400 mb-2">No Rewards Yet</h3>
              <p className="text-sm text-slate-500">
                {stakedIAeroBN > 0n
                  ? "Your rewards will appear here once they're distributed"
                  : "Stake iAERO to start earning rewards"}
              </p>
            </div>
          )}

          {txHistory.length > 0 && (
            <div className="bg-slate-900/30 rounded-xl p-4 border border-slate-700/20">
              <h4 className="text-white font-medium mb-3 flex items-center">
                <History className="w-4 h-4 mr-2" />
                Recent Claims
              </h4>
              <div className="space-y-2">
                {txHistory.map((tx, i) => (
                  <div key={i} className="flex items-center justify-between text-sm p-2 bg-slate-900/50 rounded">
                    <div className="flex items-center space-x-3">
                      <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
                      <div>
                        <span className="text-slate-300">
                          {tx.type === "claimAll" ? "Claimed All" : `Claimed ${tx.tokens.join(", ")}`}
                        </span>
                        <span className="text-slate-500 text-xs ml-2">{formatTimeAgo(tx.timestamp)}</span>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-emerald-400 font-medium">{formatUSD(tx.totalValue, 6)}</span>
                      {tx.txHash && (
                        <a href={`${txBaseUrl}${tx.txHash}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">↗</a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="text-xs text-slate-500 text-center">
            <span>Press </span>
            <kbd className="px-1.5 py-0.5 bg-slate-700 rounded">R</kbd>
            <span> to refresh • </span>
            <kbd className="px-1.5 py-0.5 bg-slate-700 rounded">⌘</kbd>
            <span> + </span>
            <kbd className="px-1.5 py-0.5 bg-slate-700 rounded">Enter</kbd>
            <span> to claim all</span>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
