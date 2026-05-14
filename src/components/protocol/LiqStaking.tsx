// =============================
// src/components/protocol/LiqStaking.tsx
// =============================
import React, { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Coins, TrendingUp, Clock, Gift, AlertCircle, Loader2 } from "lucide-react";
import { useProtocol } from "@/components/contexts/ProtocolContext";
import { useAccount, useChainId, useWriteContract, usePublicClient } from 'wagmi';
import { getContractAddress } from '@/components/contracts/addresses';
import { ABIS } from '@/components/contracts/abis';
import { parseTokenAmount } from "@/components/lib/ethereum";
import { usePrices } from "@/components/contexts/PriceContext";
import { formatUnits } from 'viem';
import { useStaking } from "../contracts/hooks/useStaking";


const ZERO = "0x0000000000000000000000000000000000000000";
const DEFAULT_WETH_BASE = "0x4200000000000000000000000000000000000006";

// Safely coerce viem `unknown` returns into bigint without throwing on {}
const toBigintSafe = (x: unknown): bigint => {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number' || typeof x === 'string' || typeof x === 'boolean') return BigInt(x as any);
  try { return BigInt(x as any); } catch { return 0n; }
};

async function fetchPricesForAddrs(addrs: string[], chainId = 8453): Promise<Record<string, number>> {
  const unique = Array.from(new Set(addrs.map((a) => a.toLowerCase()).filter(Boolean)));
  if (!unique.length) return {};

  // 1) Internal API
  try {
    const q = new URLSearchParams({ chainId: String(chainId), addresses: unique.join(",") });
    const res = await fetch(`/api/prices/token?${q}`, { cache: "no-store" });
    if (res.ok) {
      const j = await res.json();
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries<any>(j?.prices || {})) out[k.toLowerCase()] = Number(v) || 0;
      if (Object.keys(out).length) return out;
    }
  } catch {}

  // 2) DeFi Llama fallback
  try {
    const baseWeth = DEFAULT_WETH_BASE.toLowerCase();
    const forLlama = unique.map((a) => (a === ZERO ? baseWeth : a));
    const ids = forLlama.map((a) => `base:${a}`).join(",");
    const r = await fetch(`https://coins.llama.fi/prices/current/${ids}`);
    if (!r.ok) return {};
    const data = await r.json();
    const out: Record<string, number> = {};
    for (const [key, val] of Object.entries<any>(data.coins || {})) {
      const addr = key.split(":")[1]?.toLowerCase();
      const px = Number(val?.price);
      if (addr && isFinite(px)) out[addr] = px;
    }
    if (!out[ZERO] && out[baseWeth]) out[ZERO] = out[baseWeth];
    return out;
  } catch {
    return {};
  }
}

interface StakingStats {
  totalStaked: string;
  apy: number;
  userStaked: string;
  canUnstake: boolean;
  timeUntilUnlock: number;
}

interface LiqStakingProps {
  showToast: (message: string, type: "success" | "error" | "info" | "warning") => void;
  formatNumber: (value: string | number) => string;
}

type BaseRow = { address: string; symbol: string; decimals: number; amountBN: bigint };
type RowWithUsd = BaseRow & { usd: number };

export default function LiqStaking({ showToast, formatNumber }: LiqStakingProps) {
  const { connected, networkSupported, loadBalances, setTransactionLoading } = useProtocol();
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { prices } = usePrices();
  const { calculateLiqStakingAPR } = useStaking();


  // Helper to safely format ether
  const safeFormatEther = (value: bigint | undefined): string => {
    if (!value) return '0';
    return (Number(value) / 1e18).toString();
  };

  const fmtLock = (secs: number) => {
    if (secs <= 0) return "Unlocked";
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
  };

  const [stakeAmount, setStakeAmount] = useState("");
  const [unstakeAmount, setUnstakeAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [stakingStats, setStakingStats] = useState<StakingStats>({
    totalStaked: "0",
    apy: 0,
    userStaked: "0",
    canUnstake: false,
    timeUntilUnlock: 0,
  });
  const [liqBalance, setLiqBalance] = useState("0");
  const [allowance, setAllowance] = useState("0");
  const [needsApproval, setNeedsApproval] = useState(false);

  const [baseRows, setBaseRows] = useState<BaseRow[]>([]);
  const [priceByAddr, setPriceByAddr] = useState<Record<string, number>>({});
  const [rewardsLoading, setRewardsLoading] = useState(false);
  const [pricesLoading, setPricesLoading] = useState(false);
  // Bump to force the pending-rewards useEffect to re-fetch from chain.
  const [rewardsRefreshKey, setRewardsRefreshKey] = useState(0);
  // Per-row claim spinner: holds the lowercase address of the token currently being claimed.
  const [claimingAddr, setClaimingAddr] = useState<string | null>(null);

  const isLocked = stakingStats.timeUntilUnlock > 0;

  // Get contract address helper
  const getAddr = (name: any) => {
    try {
      return getContractAddress(name, chainId);
    } catch {
      return undefined;
    }
  };

  // Load staking stats
  const loadStakingStats = async () => {
    if (!connected || !networkSupported || !address || !publicClient) return;
    
    try {
      const liqStakingAddr = getAddr('LIQStakingDistributor');
      if (!liqStakingAddr) return;

      const [totalSupply, userBalance, unlockTimestamp] = await Promise.all([
        publicClient.readContract({
          address: liqStakingAddr,
          abi: ABIS.LIQStakingDistributor,
          functionName: 'totalLIQStaked',
        }).catch(() => 0n),
        publicClient.readContract({
          address: liqStakingAddr,
          abi: ABIS.LIQStakingDistributor,
          functionName: 'balanceOf',
          args: [address],
        }),
        publicClient.readContract({
          address: liqStakingAddr,
          abi: ABIS.LIQStakingDistributor,
          functionName: 'unlockTime',
          args: [address],
        }).catch(() => 0n),
      ]);

      const now = Math.floor(Date.now() / 1000);
      const unlockN = Number(unlockTimestamp);
      const canUnstake = unlockN <= now;
      const timeUntilUnlock = unlockN > now ? unlockN - now : 0;

      const liqApr = await calculateLiqStakingAPR();

      setStakingStats({
        totalStaked: safeFormatEther(totalSupply as bigint),
        apy: Number.isFinite(liqApr) ? liqApr : 0,
        userStaked: safeFormatEther(userBalance as bigint),
        canUnstake,
        timeUntilUnlock,
      });
    } catch (e) {
      console.error("Error loading staking stats:", e);
    }
  };

  // Load LIQ balance
  const loadLiqBalance = async () => {
    if (!connected || !networkSupported || !address || !publicClient) return;
    
    try {
      const liqAddr = getAddr('LIQ');
      const liqStakingAddr = getAddr('LIQStakingDistributor');
      if (!liqAddr || !liqStakingAddr) return;

      const [bal, allow] = await Promise.all([
        publicClient.readContract({
          address: liqAddr,
          abi: ABIS.LIQ,
          functionName: 'balanceOf',
          args: [address],
        }),
        publicClient.readContract({
          address: liqAddr,
          abi: ABIS.LIQ,
          functionName: 'allowance',
          args: [address, liqStakingAddr],
        }),
      ]);

      setLiqBalance(safeFormatEther(bal as bigint));
      setAllowance(safeFormatEther(allow as bigint));
    } catch (e) {
      console.error("Error loading LIQ balance:", e);
    }
  };

  useEffect(() => {
    if (stakeAmount && parseFloat(stakeAmount) > 0) {
      setNeedsApproval(parseFloat(stakeAmount) > parseFloat(allowance));
    } else {
      setNeedsApproval(false);
    }
  }, [stakeAmount, allowance]);

  useEffect(() => {
    if (connected && networkSupported) {
      loadStakingStats();
      loadLiqBalance();
      const t = setInterval(() => {
        loadStakingStats();
        loadLiqBalance();
      }, 30000);
      return () => clearInterval(t);
    }
  }, [connected, networkSupported, address]);

  // Load pending rewards
  useEffect(() => {
    (async () => {
      if (!connected || !networkSupported || !address || !publicClient) {
        console.log('LIQ rewards: Missing requirements');
        setBaseRows([]);
        return;
      }
      setRewardsLoading(true);
      try {
        const liqStakingAddr = getAddr('LIQStakingDistributor');
        console.log('=== LIQ REWARDS DEBUG ===');
        console.log('Contract Address:', liqStakingAddr);
        console.log('User Address:', address);
        
        if (!liqStakingAddr) {
          setBaseRows([]);
          return;
        }

        // ✅ First check if user actually has staked balance
        const userStakedRaw = await publicClient.readContract({
          address: liqStakingAddr,
          abi: ABIS.LIQStakingDistributor,
          functionName: 'balanceOf',
          args: [address],
        });
        const userStaked = toBigintSafe(userStakedRaw);
        console.log('User Staked Balance (raw):', userStaked);
        console.log('User Staked Balance (formatted):', safeFormatEther(userStaked));

        // ✅ Check total staked
        const totalStaked = await publicClient.readContract({
          address: liqStakingAddr,
          abi: ABIS.LIQStakingDistributor,
          functionName: 'totalLIQStaked',
        }).catch(() => 0n);
        console.log('Total LIQ Staked:', totalStaked);

        // ✅ Check accumulator for USDC and cbBTC specifically
        const USDC_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
        const CBBTC_ADDR = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
        
        const [usdcAccRaw, cbbtcAccRaw, usdcDebtRaw, cbbtcDebtRaw] = await Promise.all([
          publicClient.readContract({
            address: liqStakingAddr,
            abi: ABIS.LIQStakingDistributor,
            functionName: 'accRewardPerShare',
            args: [USDC_ADDR],
          }),
          publicClient.readContract({
            address: liqStakingAddr,
            abi: ABIS.LIQStakingDistributor,
            functionName: 'accRewardPerShare',
            args: [CBBTC_ADDR],
          }),
          publicClient.readContract({
            address: liqStakingAddr,
            abi: ABIS.LIQStakingDistributor,
            functionName: 'rewardDebt',
            args: [address, USDC_ADDR],
          }),
          publicClient.readContract({
            address: liqStakingAddr,
            abi: ABIS.LIQStakingDistributor,
            functionName: 'rewardDebt',
            args: [address, CBBTC_ADDR],
          }),
        ]);
        const usdcAcc   = toBigintSafe(usdcAccRaw);
        const cbbtcAcc  = toBigintSafe(cbbtcAccRaw);
        const usdcDebt  = toBigintSafe(usdcDebtRaw);
        const cbbtcDebt = toBigintSafe(cbbtcDebtRaw);

        const queuedUSDCRaw = await publicClient.readContract({
          address: liqStakingAddr,
          abi: ABIS.LIQStakingDistributor,
          functionName: 'queuedRewards',
          args: [USDC_ADDR],
        });
        const queuedUSDC = toBigintSafe(queuedUSDCRaw);
        console.log('🔍 QUEUED USDC:', queuedUSDC, '=', Number(queuedUSDC) / 1e6, 'USDC');

        console.log('USDC accRewardPerShare:', usdcAcc);
        console.log('USDC rewardDebt:', usdcDebt);
        console.log('USDC pending calc:', userStaked, '*', '(', usdcAcc, '-', usdcDebt, ') /', '1e18');
        
        console.log('cbBTC accRewardPerShare:', cbbtcAcc);
        console.log('cbBTC rewardDebt:', cbbtcDebt);
        console.log('cbBTC pending calc:', userStaked, '*', '(', cbbtcAcc, '-', cbbtcDebt, ') /', '1e18');

        if (userStaked > 0n) {
          const usdcPending  = userStaked * (usdcAcc  - usdcDebt)  / 1000000000000000000n;
          const cbbtcPending = userStaked * (cbbtcAcc - cbbtcDebt) / 1000000000000000000n;
          console.log('USDC pending (manual calc):', usdcPending, '=', Number(usdcPending) / 1e6, 'USDC');
          console.log('cbBTC pending (manual calc):', cbbtcPending, '=', Number(cbbtcPending) / 1e8, 'cbBTC');
        }

        // ✅ Now get pending rewards from contract
        // Result is a tuple: (tokens[], amounts[])
        type PendingRewardsResult = readonly [`0x${string}`[], readonly bigint[]];
        const result = await publicClient.readContract({
          address: liqStakingAddr,
          abi: ABIS.LIQStakingDistributor,
          functionName: 'getPendingRewards',
          args: [address],
        }) as unknown as PendingRewardsResult;
        
                console.log('getPendingRewards raw result:', result);
                // viem v2 returns multi-output reads with NAMED outputs as `{ tokens, amounts }`,
                // and with UNNAMED outputs as `[tokens, amounts]`. Handle both so the table
                // populates regardless of ABI shape.
                let tokensRaw: readonly any[] = [];
                let amountsRaw: readonly any[] = [];
                if (Array.isArray(result)) {
                  tokensRaw = (result[0] ?? []) as readonly any[];
                  amountsRaw = (result[1] ?? []) as readonly any[];
                } else if (result && typeof result === 'object') {
                  tokensRaw = ((result as any).tokens ?? []) as readonly any[];
                  amountsRaw = ((result as any).amounts ?? []) as readonly any[];
                }
                const tokens: string[] = Array.from(tokensRaw);
                const amounts: bigint[] = Array.from(amountsRaw).map((x) => toBigintSafe(x));

        console.log('Tokens count:', tokens.length);
        console.log('Amounts count:', amounts.length);
        
        // Find USDC and cbBTC in the results
        const usdcIdx = tokens.findIndex(t => t.toLowerCase() === USDC_ADDR.toLowerCase());
        const cbbtcIdx = tokens.findIndex(t => t.toLowerCase() === CBBTC_ADDR.toLowerCase());
        
        console.log('USDC index:', usdcIdx, 'Amount:', amounts[usdcIdx]);
        console.log('cbBTC index:', cbbtcIdx, 'Amount:', amounts[cbbtcIdx]);
        console.log('========================');

        const out: BaseRow[] = [];
        for (let i = 0; i < tokens.length; i++) {
          const raw = tokens[i] || "";
          const addr = raw.toLowerCase();
          const amt = amounts[i] ?? 0n;
          
          if (!addr || amt === 0n) continue;

          let symbol = "ETH", decimals = 18;
          if (addr !== ZERO) {
            try {
              const [sym, dec] = await Promise.all([
                publicClient.readContract({
                  address: raw as `0x${string}`,
                  abi: ABIS.ERC20,
                  functionName: 'symbol',
                }),
                publicClient.readContract({
                  address: raw as `0x${string}`,
                  abi: ABIS.ERC20,
                  functionName: 'decimals',
                }),
              ]);
              symbol = String(sym);
              decimals = Number(dec);
            } catch {
              symbol = `${raw.slice(0, 6)}...${raw.slice(-4)}`;
              decimals = 18;
            }
          }
          out.push({ address: addr, symbol, decimals, amountBN: amt });
        }
        
        console.log('Final reward rows:', out);
        setBaseRows(out);
      } catch (e) {
        console.error("load LIQ pending rows failed", e);
        setBaseRows([]);
      } finally {
        setRewardsLoading(false);
      }
    })();
  }, [connected, networkSupported, address, publicClient, rewardsRefreshKey]);

  // Fetch prices for reward tokens
  useEffect(() => {
    (async () => {
      const addrs = baseRows.map((r) => r.address);
      if (!addrs.length) {
        setPriceByAddr({});
        return;
      }
      setPricesLoading(true);
      try {
        const map = await fetchPricesForAddrs(addrs, chainId);
        setPriceByAddr(map);
      } finally {
        setPricesLoading(false);
      }
    })();
  }, [baseRows, chainId]);

  const rows: RowWithUsd[] = useMemo(() => {
    return baseRows.map((r) => {
      const price = priceByAddr[r.address] ?? 0;
      const human = Number(r.amountBN) / 10 ** r.decimals;
      return { ...r, usd: human * price };
    });
  }, [baseRows, priceByAddr]);

  const totalRewardsUSD = useMemo(() => rows.reduce((s, r) => s + r.usd, 0), [rows]);

  // Actions
  const handleApprove = async () => {
    if (!connected || !address) return;
    const txId = "approveLiq";
    setTransactionLoading(txId, true);
    setLoading(true);
    
    try {
      const liqAddr = getAddr('LIQ');
      const liqStakingAddr = getAddr('LIQStakingDistributor');
      if (!liqAddr || !liqStakingAddr) throw new Error("Contracts not initialized");

      const hash = await writeContractAsync({
        address: liqAddr,
        abi: ABIS.LIQ,
        functionName: 'approve',
        args: [liqStakingAddr, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')],
        gas: 100_000n,
      });

      showToast("Approving LIQ...", "info");
      const receipt = await publicClient?.waitForTransactionReceipt({ hash });
      if (receipt && receipt.status !== "success") throw new Error(`Approval reverted: ${hash}`);
      showToast("LIQ approved!", "success");
      await loadLiqBalance();
    } catch (e: any) {
      console.error("Approval error:", e);
      showToast(e.message || "Approval failed", "error");
    } finally {
      setLoading(false);
      setTransactionLoading(txId, false);
    }
  };

  const handleStake = async () => {
    if (!connected || !address || !stakeAmount) return;
    const txId = "stakeLiq";
    setTransactionLoading(txId, true);
    setLoading(true);
    
    try {
      const liqStakingAddr = getAddr('LIQStakingDistributor');
      if (!liqStakingAddr) throw new Error("LIQ Staking contract not initialized");

      if (needsApproval) await handleApprove();

      const amount = parseTokenAmount(stakeAmount);
      const hash = await writeContractAsync({
        address: liqStakingAddr,
        abi: ABIS.LIQStakingDistributor,
        functionName: 'stake',
        args: [amount],
        gas: 12_000_000n,
      });

      showToast("Staking LIQ...", "info");
      const receipt = await publicClient?.waitForTransactionReceipt({ hash });
      if (receipt && receipt.status !== "success") throw new Error(`Stake reverted: ${hash}`);
      showToast(`Staked ${stakeAmount} LIQ!`, "success");
      
      setStakeAmount("");
      await Promise.all([loadStakingStats(), loadLiqBalance(), loadBalances()]);
    } catch (e: any) {
      console.error("Staking error:", e);
      showToast(e.message || "Staking failed", "error");
    } finally {
      setLoading(false);
      setTransactionLoading(txId, false);
    }
  };

  const handleUnstake = async () => {
    if (!connected || !address || !unstakeAmount) return;
    const txId = "unstakeLiq";
    setTransactionLoading(txId, true);
    setLoading(true);
    
    try {
      const liqStakingAddr = getAddr('LIQStakingDistributor');
      if (!liqStakingAddr) throw new Error("LIQ Staking contract not initialized");

      const amount = parseTokenAmount(unstakeAmount);
      const hash = await writeContractAsync({
        address: liqStakingAddr,
        abi: ABIS.LIQStakingDistributor,
        functionName: 'unstake',
        args: [amount],
        gas: 12_000_000n,
      });

      showToast("Unstaking LIQ...", "info");
      const receipt = await publicClient?.waitForTransactionReceipt({ hash });
      if (receipt && receipt.status !== "success") throw new Error(`Unstake reverted: ${hash}`);
      showToast(`Unstaked ${unstakeAmount} LIQ!`, "success");
      
      setUnstakeAmount("");
      await Promise.all([loadStakingStats(), loadLiqBalance(), loadBalances()]);
    } catch (e: any) {
      console.error("Unstaking error:", e);
      showToast(e.message || "Unstaking failed", "error");
    } finally {
      setLoading(false);
      setTransactionLoading(txId, false);
    }
  };

  const handleClaimRewards = async () => {
    if (!connected || !address) return;
    if (claimingAddr) return; // Don't race against an in-flight per-row claim.
    const txId = "claimLiqRewards";
    setTransactionLoading(txId, true);
    setLoading(true);

    try {
      const liqStakingAddr = getAddr("LIQStakingDistributor");
      if (!liqStakingAddr) throw new Error("LIQ Staking contract not initialized");
      if (!publicClient) throw new Error("RPC client not available");

      const allTokens = rows
        .filter((r) => r.amountBN > 0n)
        .map((r) => r.address as `0x${string}`);

      if (allTokens.length === 0) {
        showToast("No rewards to claim", "info");
        return;
      }

      const CONTRACT_MAX = 50;

      // ─── Bisection isolation ────────────────────────────────────────────────
      // The contract's claimMany() reverts the entire batch if ANY single token's
      // transfer reverts (most often "transfer amount exceeds balance" when the
      // distributor's internal accumulator drifts past its actual ERC20 balance).
      // Pre-simulate via eth_call and bisect to find the largest claimable subset
      // and the minimal set of "poison" tokens to skip.
      const simulateBatch = async (toks: `0x${string}`[]): Promise<boolean> => {
        if (toks.length === 0) return true;
        try {
          await publicClient.simulateContract({
            account: address,
            address: liqStakingAddr as `0x${string}`,
            abi: ABIS.LIQStakingDistributor,
            functionName: "claimMany",
            args: [toks],
          });
          return true;
        } catch {
          return false;
        }
      };

      const isolate = async (
        toks: `0x${string}`[]
      ): Promise<{ working: `0x${string}`[]; failing: `0x${string}`[] }> => {
        if (toks.length === 0) return { working: [], failing: [] };
        if (await simulateBatch(toks)) return { working: toks, failing: [] };
        if (toks.length === 1) return { working: [], failing: toks };
        const mid = Math.floor(toks.length / 2);
        const left = await isolate(toks.slice(0, mid));
        const right = await isolate(toks.slice(mid));
        return {
          working: [...left.working, ...right.working],
          failing: [...left.failing, ...right.failing],
        };
      };

      showToast(`Validating ${allTokens.length} reward token(s)...`, "info");

      // Isolate within each contract-allowed chunk of 50.
      const working: `0x${string}`[] = [];
      const failing: `0x${string}`[] = [];
      for (let i = 0; i < allTokens.length; i += CONTRACT_MAX) {
        const slice = allTokens.slice(i, i + CONTRACT_MAX);
        const r = await isolate(slice);
        working.push(...r.working);
        failing.push(...r.failing);
      }

      if (failing.length > 0) {
        console.warn("LIQ claim: skipping tokens that revert on claim:", failing);
        showToast(
          `Skipping ${failing.length} token(s) whose transfer reverts (see console for addresses)`,
          "warning"
        );
      }

      if (working.length === 0) {
        showToast("None of your reward tokens are claimable right now", "error");
        return;
      }

      showToast(`Claiming ${working.length} reward token(s)...`, "info");

      // Send the working tokens, respecting the contract's per-call cap.
      let claimed = 0;
      const totalBatches = Math.ceil(working.length / CONTRACT_MAX);
      for (let i = 0; i < working.length; i += CONTRACT_MAX) {
        const slice = working.slice(i, i + CONTRACT_MAX);
        const batchIdx = Math.floor(i / CONTRACT_MAX) + 1;
        showToast(`Claiming batch ${batchIdx} of ${totalBatches}...`, "info");

        const hash = await writeContractAsync({
          address: liqStakingAddr as `0x${string}`,
          abi: ABIS.LIQStakingDistributor,
          functionName: "claimMany",
          args: [slice],
          gas: 8_000_000n,
        });

        // waitForTransactionReceipt does NOT throw on reverted txs — it just
        // returns status: "reverted". We must check it ourselves.
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error(`Claim tx reverted on-chain: ${hash}`);
        }
        claimed += slice.length;
      }

      showToast(`Claimed ${claimed} reward token(s)!`, "success");

      // Refresh from chain — re-fetch pending rewards instead of blanking them,
      // so any leftover poison tokens remain visible (and any new accruals show up).
      await Promise.all([loadStakingStats(), loadBalances()]);
      setRewardsRefreshKey((k) => k + 1);
    } catch (e: any) {
      console.error("Claim error:", e);
      showToast(e?.shortMessage || e?.message || "Claim failed", "error");
    } finally {
      setLoading(false);
      setTransactionLoading(txId, false);
    }
  };

  // Claim a single reward token. Useful for picking through the list when the
  // batch claim has a poison token, or when the user just wants one specific asset.
  const handleClaimOne = async (token: string, symbol: string) => {
    if (!connected || !address) return;
    const tokenLc = token.toLowerCase();
    const txId = `claimLiqRewardOne:${tokenLc}`;
    setTransactionLoading(txId, true);
    setClaimingAddr(tokenLc);

    try {
      const liqStakingAddr = getAddr("LIQStakingDistributor");
      if (!liqStakingAddr) throw new Error("LIQ Staking contract not initialized");
      if (!publicClient) throw new Error("RPC client not available");

      const tokenArg = token as `0x${string}`;

      // Pre-simulate so we surface the revert reason before asking the wallet to sign.
      try {
        await publicClient.simulateContract({
          account: address,
          address: liqStakingAddr as `0x${string}`,
          abi: ABIS.LIQStakingDistributor,
          functionName: "claimReward",
          args: [tokenArg],
        });
      } catch (simErr: any) {
        const reason = simErr?.shortMessage || simErr?.message || "Simulation reverted";
        throw new Error(`${symbol} not claimable: ${reason}`);
      }

      showToast(`Claiming ${symbol}...`, "info");
      const hash = await writeContractAsync({
        address: liqStakingAddr as `0x${string}`,
        abi: ABIS.LIQStakingDistributor,
        functionName: "claimReward",
        args: [tokenArg],
        gas: 1_000_000n,
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        throw new Error(`Claim of ${symbol} reverted: ${hash}`);
      }

      showToast(`Claimed ${symbol}!`, "success");

      await Promise.all([loadStakingStats(), loadBalances()]);
      setRewardsRefreshKey((k) => k + 1);
    } catch (e: any) {
      console.error("Single-token claim error:", e);
      showToast(e?.shortMessage || e?.message || "Claim failed", "error");
    } finally {
      setClaimingAddr(null);
      setTransactionLoading(txId, false);
    }
  };
  
  
  if (!connected || !networkSupported) {
    return (
      <div className="text-center py-12">
        <Coins className="w-12 h-12 text-slate-400 mx-auto mb-4" />
        <h3 className="text-xl font-semibold text-white mb-2">Connect Wallet</h3>
        <p className="text-slate-400">Connect your wallet to stake LIQ tokens</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Staking Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Total Staked</p>
                <p className="text-2xl font-bold text-white">{formatNumber(stakingStats.totalStaked)} LIQ</p>
              </div>
              <Coins className="w-8 h-8 text-purple-400" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Current APY</p>
                <p className="text-2xl font-bold text-emerald-400">{stakingStats.apy.toFixed(1)}%</p>
              </div>
              <TrendingUp className="w-8 h-8 text-emerald-400" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Your Staked</p>
                <p className="text-2xl font-bold text-white">{formatNumber(stakingStats.userStaked)} LIQ</p>
              </div>
              <Clock className="w-8 h-8 text-blue-400" />
            </div>
          </CardContent>
        </Card>
        <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-slate-400 text-sm">Pending Rewards</p>
                <p className="text-2xl font-bold text-white">${formatNumber(totalRewardsUSD)}</p>
              </div>
              <Gift className="w-8 h-8 text-yellow-400" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Staking Card */}
      <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
        <CardHeader>
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <Coins className="w-6 h-6 text-purple-400" />
            Stake LIQ
          </CardTitle>
        </CardHeader>
        <CardContent>
          {(rewardsLoading || pricesLoading) && (
            <div className="bg-slate-700/30 border border-slate-600/30 rounded-xl p-3 mb-4">
              <div className="flex items-center gap-2 text-sm text-slate-300">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Loading your rewards…</span>
              </div>
            </div>
          )}

          <Tabs defaultValue="stake" className="w-full">
            <TabsList className="grid w-full grid-cols-2 bg-slate-700/50">
              <TabsTrigger value="stake">Stake</TabsTrigger>
              <TabsTrigger value="unstake">Unstake</TabsTrigger>
            </TabsList>

            <TabsContent value="stake" className="space-y-4">
              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm text-slate-400">Amount to Stake</label>
                  <span className="text-sm text-slate-400">Available: {formatNumber(liqBalance)} LIQ</span>
                </div>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    placeholder="0.0"
                    value={stakeAmount}
                    onChange={(e) => setStakeAmount(e.target.value)}
                    className="bg-slate-700/50 border-slate-600"
                    disabled={loading}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setStakeAmount(liqBalance)}
                    className="border-slate-600"
                    disabled={loading}
                  >
                    MAX
                  </Button>
                </div>
              </div>
              <Button
                onClick={handleStake}
                disabled={loading || !stakeAmount || parseFloat(stakeAmount) <= 0}
                className="w-full bg-purple-600 hover:bg-purple-700"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                {needsApproval ? "Approve & Stake" : "Stake LIQ"}
              </Button>

              <div className="bg-slate-700/30 rounded-lg p-3">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-yellow-400 mt-0.5" />
                  <div className="text-sm text-slate-400">
                    <p>Stake LIQ to earn protocol fees and rewards.</p>
                    <p className="mt-1">7-day lock period applies to staked LIQ.</p>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="unstake" className="space-y-4">
              {stakingStats.timeUntilUnlock > 0 && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
                  <div className="flex items-start space-x-3">
                    <Clock className="w-5 h-5 text-amber-400 mt-0.5" />
                    <div>
                      <p className="font-medium text-amber-400">Tokens Locked</p>
                      <p className="text-sm text-slate-300 mt-1">
                        You can unstake in {fmtLock(stakingStats.timeUntilUnlock)}
                      </p>
                      <p className="text-xs text-slate-400 mt-2">Lock period: 7 days from last stake</p>
                    </div>
                  </div>
                </div>
              )}

              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm text-slate-400">Amount to Unstake</label>
                  <span className="text-sm text-slate-400">Staked: {formatNumber(stakingStats.userStaked)} LIQ</span>
                </div>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    placeholder="0.0"
                    value={unstakeAmount}
                    onChange={(e) => setUnstakeAmount(e.target.value)}
                    className="bg-slate-700/50 border-slate-600"
                    disabled={loading || isLocked}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setUnstakeAmount(stakingStats.userStaked)}
                    className="border-slate-600"
                    disabled={loading || isLocked}
                  >
                    MAX
                  </Button>
                </div>
              </div>
              <Button
                onClick={handleUnstake}
                disabled={loading || !unstakeAmount || parseFloat(unstakeAmount) <= 0 || isLocked}
                className="w-full bg-purple-600 hover:bg-purple-700"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
                {isLocked ? `Locked for ${fmtLock(stakingStats.timeUntilUnlock)}` : "Unstake LIQ"}
              </Button>
            </TabsContent>
          </Tabs>

          {/* Claimable per-token table */}
          {rewardsLoading || pricesLoading ? (
            <div className="mt-6 p-0 rounded-lg border border-slate-700/40 overflow-hidden">
              <div className="grid grid-cols-12 bg-slate-900/70 px-4 py-3 text-slate-400 text-xs">
                <div className="col-span-4">Token</div>
                <div className="col-span-3 text-right">Amount</div>
                <div className="col-span-2 text-right">Value</div>
                <div className="col-span-3 text-right">Action</div>
              </div>
              {[...Array(3)].map((_, i) => (
                <div key={i} className="grid grid-cols-12 items-center px-4 py-3 border-t border-slate-800/50">
                  <div className="col-span-4">
                    <div className="h-4 w-24 bg-slate-700/50 rounded animate-pulse mb-1" />
                    <div className="h-3 w-40 bg-slate-800/50 rounded animate-pulse" />
                  </div>
                  <div className="col-span-3 text-right">
                    <div className="h-4 w-24 bg-slate-700/50 rounded ml-auto animate-pulse" />
                  </div>
                  <div className="col-span-2 text-right">
                    <div className="h-4 w-20 bg-slate-700/50 rounded ml-auto animate-pulse" />
                  </div>
                  <div className="col-span-3 text-right">
                    <div className="h-8 w-20 bg-slate-700/50 rounded ml-auto animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            rows.length > 0 && (
              <div className="mt-6 p-0 rounded-lg border border-slate-700/40 overflow-hidden">
                <div className="grid grid-cols-12 bg-slate-900/70 px-4 py-3 text-slate-400 text-xs">
                  <div className="col-span-4">Token</div>
                  <div className="col-span-3 text-right">Amount</div>
                  <div className="col-span-2 text-right">Value</div>
                  <div className="col-span-3 text-right">Action</div>
                </div>
                {rows.map((r, i) => {
                  const isThisClaiming = claimingAddr === r.address;
                  const rowDisabled = loading || rewardsLoading || pricesLoading || claimingAddr !== null;
                  return (
                    <div
                      key={r.address + i}
                      className="grid grid-cols-12 items-center px-4 py-3 border-t border-slate-800/50"
                    >
                      <div className="col-span-4">
                        <div className="text-white font-medium">{r.symbol}</div>
                        <div className="text-[11px] text-slate-400 break-all">{r.address}</div>
                      </div>
                      <div className="col-span-3 text-right text-white">
                        {formatUnits(r.amountBN, r.decimals)}
                      </div>
                      <div className="col-span-2 text-right text-emerald-400">
                        {r.usd ? `$${r.usd.toLocaleString(undefined, { maximumFractionDigits: 6 })}` : "$0"}
                      </div>
                      <div className="col-span-3 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="border-slate-600"
                          disabled={rowDisabled || r.amountBN === 0n}
                          onClick={() => handleClaimOne(r.address, r.symbol)}
                        >
                          {isThisClaiming ? (
                            <>
                              <Loader2 className="w-3 h-3 animate-spin mr-1" />
                              Claiming
                            </>
                          ) : (
                            "Claim"
                          )}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          )}

          {rows.some((r) => r.amountBN > 0n) && (
            <div className="mt-6 p-4 bg-gradient-to-r from-purple-900/20 to-pink-900/20 rounded-lg border border-purple-700/30">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-400">Claimable Rewards</p>
                  <p className="text-lg font-bold text-white">${formatNumber(totalRewardsUSD)}</p>
                </div>
                <Button
                  onClick={handleClaimRewards}
                  disabled={loading || rewardsLoading || pricesLoading || claimingAddr !== null}
                  className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Gift className="w-4 h-4 mr-2" />}
                  Claim Rewards
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
