// ==============================================
// src/components/protocol/AutoVaultSection.tsx
// Deposit iAERO → auto-staked, weekly USDC rewards auto-converted by the
// keeper. Users claim USDC with one click.
// ==============================================
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ethers } from 'ethers';
import { usePublicClient, useWriteContract, useAccount } from 'wagmi';
import { formatUnits, parseAbi, type Address } from 'viem';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Vault, ArrowDownToLine, ArrowUpFromLine, DollarSign,
  Loader2, RefreshCw, CheckCircle, Info, Gift,
  ExternalLink, Clock, TrendingUp, Sparkles,
} from 'lucide-react';

import { useProtocol } from '@/components/contexts/ProtocolContext';
import { usePrices } from '@/components/contexts/PriceContext';
import {
  parseInputToBigNumber, formatBigNumber, sanitizeDecimalInput,
  useDebounce, validateTokenAmount,
} from '../lib/defi-utils';
import { getContractAddress } from '../contracts/addresses';

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const MIN_DEPOSIT = ethers.parseUnits('0.01', 18);
const WEEK = 7 * 24 * 60 * 60;
const EPOCHS_LOOKBACK = 26;   // scan last ~6 months of epochs for pending/claimed lookups
const APR_LOOKBACK   = 4;     // weeks used to compute APR
const KEEPER_LAG_SECONDS = 3600;  // keeper runs ~1h after epoch boundary

const VAULT_ABI = parseAbi([
  // user
  'function deposit(uint256 amount) external',
  'function withdraw(uint256 amount) external',
  'function claimUSDC(uint256[] epochs) external',
  // views
  'function sharesOf(address) view returns (uint256)',
  'function totalShares() view returns (uint256)',
  'function previewUSDC(address user, uint256 epoch) view returns (uint256)',
  'function previewUSDCMany(address user, uint256[] epochs) view returns (uint256[] amounts, uint256 total)',
  'function usdcForEpoch(uint256) view returns (uint256)',
  'function epochFinalized(uint256) view returns (bool)',
  'function claimedByUser(address, uint256) view returns (uint256)',
  'function supplySnapAtEpoch(uint256) view returns (uint256)',
]);

const BASESCAN_BASE = 'https://basescan.org';

function formatCountdown(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return 'soon';
  const days = Math.floor(secondsRemaining / 86400);
  const hours = Math.floor((secondsRemaining % 86400) / 3600);
  const mins = Math.floor((secondsRemaining % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

interface AutoVaultSectionProps {
  showToast: (m: string, t: 'success' | 'error' | 'info' | 'warning') => void;
  formatNumber: (v: string | number) => string;
}

interface TxHistoryItem {
  type: 'deposit' | 'withdraw' | 'claim';
  amount: string;
  symbol: string;
  timestamp: number;
  txHash?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────

export default function AutoVaultSection({ showToast }: AutoVaultSectionProps) {
  const { connected, networkSupported, balances, chainId, loadBalances } = useProtocol();
  const { getPriceInUSD } = usePrices();
  const { address: account } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  // Default to Base mainnet when chainId is null (pre-connect render path).
  const resolvedChainId = chainId ?? 8453;
  const VAULT_ADDR  = useMemo<Address>(() => getContractAddress('AutoUSDCVault', resolvedChainId) as Address, [resolvedChainId]);
  const IAERO_ADDR  = useMemo<Address>(() => getContractAddress('iAERO',         resolvedChainId) as Address, [resolvedChainId]);

  // ---- State ----
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit');
  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [needsApproval, setNeedsApproval] = useState(false);

  const [shares, setShares] = useState<bigint>(0n);
  const [totalShares, setTotalShares] = useState<bigint>(0n);
  const [pendingUSDC, setPendingUSDC] = useState<bigint>(0n);
  const [pendingEpochs, setPendingEpochs] = useState<bigint[]>([]);
  const [claimedAllTime, setClaimedAllTime] = useState<bigint>(0n);
  const [vaultUsdcLast4w, setVaultUsdcLast4w] = useState<bigint>(0n);
  const [aprPct, setAprPct] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState<number>(() => Math.floor(Date.now() / 1000));

  const [isProcessing, setIsProcessing] = useState(false);
  const [progressStep, setProgressStep] = useState('');
  const [activeOperation, setActiveOperation] = useState<'deposit' | 'withdraw' | 'claim' | ''>('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  const [txHistory, setTxHistory] = useState<TxHistoryItem[]>([]);

  const debouncedDepositAmount = useDebounce(depositAmount, 300);
  const iAeroBN = useMemo(() => parseInputToBigNumber(balances?.iAero ?? '0'), [balances?.iAero]);
  const depositAmountBN = parseInputToBigNumber(depositAmount);
  const withdrawAmountBN = parseInputToBigNumber(withdrawAmount);

  const positionUsd = useMemo(() => {
    const sh = parseFloat(formatBigNumber(shares, 18, 6));
    return getPriceInUSD('iAERO', sh);
  }, [shares, getPriceInUSD]);

  // ---- Data fetchers ----

  /** Load shares + totalShares from the vault. */
  const loadShares = useCallback(async () => {
    if (!publicClient || !account || !VAULT_ADDR) return;
    try {
      const [s, t] = await Promise.all([
        publicClient.readContract({ address: VAULT_ADDR, abi: VAULT_ABI, functionName: 'sharesOf', args: [account] }) as Promise<bigint>,
        publicClient.readContract({ address: VAULT_ADDR, abi: VAULT_ABI, functionName: 'totalShares' }) as Promise<bigint>,
      ]);
      setShares(s);
      setTotalShares(t);
    } catch (e) {
      console.warn('[AutoVault] shares load failed', e);
    }
  }, [publicClient, account, VAULT_ADDR]);

  /**
   * Scan the last EPOCHS_LOOKBACK weekly epochs and ask the vault how much
   * USDC each one owes the user (pending) + how much they've already claimed
   * from each (all-time). Also pulls vault-wide USDC for last APR_LOOKBACK
   * epochs so we can estimate APR.
   */
  const loadPendingUSDC = useCallback(async () => {
    if (!publicClient || !account || !VAULT_ADDR) return;
    try {
      const now = Math.floor(Date.now() / 1000);
      const currentEpoch = Math.floor(now / WEEK) * WEEK;
      const epochs: bigint[] = [];
      for (let i = 1; i <= EPOCHS_LOOKBACK; i++) {
        epochs.push(BigInt(currentEpoch - i * WEEK));
      }

      // Pending USDC (per-epoch + total)
      const [amounts, total] = (await publicClient.readContract({
        address: VAULT_ADDR,
        abi: VAULT_ABI,
        functionName: 'previewUSDCMany',
        args: [account, epochs],
      })) as readonly [readonly bigint[], bigint];
      setPendingUSDC(total);
      const nonZero = epochs.filter((_, i) => amounts[i] > 0n);
      setPendingEpochs(nonZero);

      // All-time claimed: sum claimedByUser[user][epoch] across lookback
      const claimedPromises = epochs.map(e =>
        publicClient.readContract({
          address: VAULT_ADDR, abi: VAULT_ABI,
          functionName: 'claimedByUser', args: [account, e],
        }) as Promise<bigint>
      );
      const claimedArr = await Promise.all(claimedPromises);
      const claimedSum = claimedArr.reduce((s, x) => s + x, 0n);
      setClaimedAllTime(claimedSum);

      // Vault-wide USDC for last APR_LOOKBACK weeks (used for APR calc)
      const aprEpochs = epochs.slice(0, APR_LOOKBACK);
      const usdcPromises = aprEpochs.map(e =>
        publicClient.readContract({
          address: VAULT_ADDR, abi: VAULT_ABI,
          functionName: 'usdcForEpoch', args: [e],
        }) as Promise<bigint>
      );
      const usdcArr = await Promise.all(usdcPromises);
      setVaultUsdcLast4w(usdcArr.reduce((s, x) => s + x, 0n));
    } catch (e) {
      console.warn('[AutoVault] pending/claimed/APR load failed', e);
    }
  }, [publicClient, account, VAULT_ADDR]);

  const refreshAll = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([loadShares(), loadPendingUSDC(), loadBalances?.()]);
    } finally {
      setIsRefreshing(false);
    }
  }, [loadShares, loadPendingUSDC, loadBalances]);

  useEffect(() => {
    if (connected && networkSupported && account) {
      refreshAll();
    }
  }, [connected, networkSupported, account, refreshAll]);

  // 1-minute tick so the countdown stays fresh without rapid re-renders.
  useEffect(() => {
    const t = setInterval(() => setNowTs(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(t);
  }, []);

  // Compute APR estimate whenever inputs change.
  useEffect(() => {
    if (totalShares === 0n || vaultUsdcLast4w === 0n) {
      setAprPct(null);
      return;
    }
    const iAeroPrice = getPriceInUSD('iAERO', 1) || 0;
    if (iAeroPrice <= 0) { setAprPct(null); return; }

    const tvlUsd  = Number(formatUnits(totalShares, 18)) * iAeroPrice;
    const usdcUsd = Number(formatUnits(vaultUsdcLast4w, 6)); // USDC ≈ $1
    if (tvlUsd <= 0) { setAprPct(null); return; }

    const weeklyAvg = usdcUsd / APR_LOOKBACK;
    const apr = (weeklyAvg / tvlUsd) * 52 * 100;
    setAprPct(apr);
  }, [totalShares, vaultUsdcLast4w, getPriceInUSD]);

  // Next harvest = next Thursday 00:00 UTC + keeper lag.
  const nextHarvestTs = useMemo(() => {
    const currentEpoch = Math.floor(nowTs / WEEK) * WEEK;
    return currentEpoch + WEEK + KEEPER_LAG_SECONDS;
  }, [nowTs]);
  const secondsToHarvest = Math.max(0, nextHarvestTs - nowTs);

  // Approval check for deposit
  useEffect(() => {
    if (mode !== 'deposit' || !publicClient || !account || !VAULT_ADDR || !IAERO_ADDR) {
      setNeedsApproval(false);
      return;
    }
    if (!debouncedDepositAmount || parseFloat(debouncedDepositAmount) <= 0) {
      setNeedsApproval(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const allowance = (await publicClient.readContract({
          address: IAERO_ADDR, abi: ERC20_ABI, functionName: 'allowance', args: [account, VAULT_ADDR],
        })) as bigint;
        const need = parseInputToBigNumber(debouncedDepositAmount);
        if (!cancelled) setNeedsApproval(allowance < need);
      } catch {
        if (!cancelled) setNeedsApproval(false);
      }
    })();
    return () => { cancelled = true; };
  }, [mode, debouncedDepositAmount, publicClient, account, VAULT_ADDR, IAERO_ADDR]);

  // ---- Helpers ----

  const addToHistory = (type: TxHistoryItem['type'], amount: string, symbol: string, txHash?: string) =>
    setTxHistory(prev => [{ type, amount, symbol, timestamp: Date.now(), txHash }, ...prev.slice(0, 4)]);

  const handleMaxDeposit = () => {
    const buffer = ethers.parseUnits('0.01', 18);
    const max = iAeroBN > buffer ? iAeroBN - buffer : 0n;
    setDepositAmount(ethers.formatUnits(max, 18));
  };
  const handleMaxWithdraw = () => {
    setWithdrawAmount(ethers.formatUnits(shares, 18));
  };

  // ---- Actions ----

  const handleDeposit = async () => {
    const v = validateTokenAmount(depositAmount, iAeroBN, 18, MIN_DEPOSIT);
    if (!v.valid) return showToast(v.error || 'Invalid amount', 'error');
    if (!account || !VAULT_ADDR || !IAERO_ADDR) return;

    setIsProcessing(true);
    setActiveOperation('deposit');
    try {
      if (needsApproval) {
        setProgressStep('Approving iAERO spending...');
        const approveHash = await writeContractAsync({
          address: IAERO_ADDR,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [VAULT_ADDR, ethers.MaxUint256],
        });
        await publicClient!.waitForTransactionReceipt({ hash: approveHash });
        setNeedsApproval(false);
      }

      setProgressStep('Depositing iAERO into vault...');
      const hash = await writeContractAsync({
        address: VAULT_ADDR,
        abi: VAULT_ABI,
        functionName: 'deposit',
        args: [depositAmountBN],
      });
      await publicClient!.waitForTransactionReceipt({ hash });

      showToast(`Deposited ${depositAmount} iAERO into auto-vault`, 'success');
      addToHistory('deposit', depositAmount, 'iAERO', hash);
      setDepositAmount('');
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
      await refreshAll();
    } catch (e: any) {
      const msg = e?.shortMessage || e?.message || 'Deposit failed';
      if (msg.includes('User rejected') || msg.includes('user denied')) {
        showToast('Transaction cancelled', 'info');
      } else {
        showToast(msg, 'error');
      }
    } finally {
      setIsProcessing(false);
      setActiveOperation('');
      setProgressStep('');
    }
  };

  const handleWithdraw = async () => {
    const v = validateTokenAmount(withdrawAmount, shares, 18, 1n);
    if (!v.valid) return showToast(v.error || 'Invalid amount', 'error');
    if (!account || !VAULT_ADDR) return;

    setIsProcessing(true);
    setActiveOperation('withdraw');
    try {
      setProgressStep('Withdrawing iAERO from vault...');
      const hash = await writeContractAsync({
        address: VAULT_ADDR,
        abi: VAULT_ABI,
        functionName: 'withdraw',
        args: [withdrawAmountBN],
      });
      await publicClient!.waitForTransactionReceipt({ hash });

      showToast(`Withdrew ${withdrawAmount} iAERO`, 'success');
      addToHistory('withdraw', withdrawAmount, 'iAERO', hash);
      setWithdrawAmount('');
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
      await refreshAll();
    } catch (e: any) {
      const msg = e?.shortMessage || e?.message || 'Withdraw failed';
      if (msg.includes('User rejected') || msg.includes('user denied')) {
        showToast('Transaction cancelled', 'info');
      } else {
        showToast(msg, 'error');
      }
    } finally {
      setIsProcessing(false);
      setActiveOperation('');
      setProgressStep('');
    }
  };

  const handleClaimUSDC = async () => {
    if (!account || !VAULT_ADDR) return;
    if (pendingEpochs.length === 0 || pendingUSDC === 0n) {
      showToast('No USDC to claim', 'info');
      return;
    }
    setIsProcessing(true);
    setActiveOperation('claim');
    try {
      setProgressStep(`Claiming ${formatBigNumber(pendingUSDC, 6, 4)} USDC...`);
      const hash = await writeContractAsync({
        address: VAULT_ADDR,
        abi: VAULT_ABI,
        functionName: 'claimUSDC',
        args: [pendingEpochs],
      });
      await publicClient!.waitForTransactionReceipt({ hash });

      const usdcStr = formatBigNumber(pendingUSDC, 6, 4);
      showToast(`Claimed ${usdcStr} USDC`, 'success');
      addToHistory('claim', usdcStr, 'USDC', hash);
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
      await refreshAll();
    } catch (e: any) {
      const msg = e?.shortMessage || e?.message || 'Claim failed';
      if (msg.includes('User rejected') || msg.includes('user denied')) {
        showToast('Transaction cancelled', 'info');
      } else {
        showToast(msg, 'error');
      }
    } finally {
      setIsProcessing(false);
      setActiveOperation('');
      setProgressStep('');
    }
  };

  // ---- Validation gates ----

  const depositError = useMemo(() => {
    if (!depositAmount) return null;
    const bn = parseInputToBigNumber(depositAmount);
    if (bn === 0n) return null;
    if (bn < MIN_DEPOSIT) return 'Minimum 0.01 iAERO';
    if (bn > iAeroBN) return 'Insufficient iAERO balance';
    return null;
  }, [depositAmount, iAeroBN]);

  const withdrawError = useMemo(() => {
    if (!withdrawAmount) return null;
    const bn = parseInputToBigNumber(withdrawAmount);
    if (bn === 0n) return null;
    if (bn > shares) return 'More than your share';
    return null;
  }, [withdrawAmount, shares]);

  const depositDisabled =
    !connected || !networkSupported || isProcessing ||
    !depositAmount || depositAmountBN === 0n || !!depositError;
  const withdrawDisabled =
    !connected || !networkSupported || isProcessing ||
    !withdrawAmount || withdrawAmountBN === 0n || !!withdrawError;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  if (!connected) {
    return (
      <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
        <CardContent className="p-8 text-center">
          <Vault className="w-12 h-12 mx-auto text-indigo-400 mb-4" />
          <h3 className="text-xl font-semibold text-white mb-2">Auto-USDC Vault</h3>
          <p className="text-slate-400">Connect your wallet to deposit iAERO and earn USDC weekly.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* ─── Brief intro (always shown) ─── */}
      <div className="bg-slate-900/30 border border-slate-700/30 rounded-lg px-4 py-3 text-sm text-slate-300">
        Deposit iAERO once. Every Thursday the keeper claims all your reward
        tokens and converts them to USDC — claim with one click whenever you
        want. Withdrawals are instant.
      </div>

      {/* ─── Pending USDC banner ─── */}
      <AnimatePresence>
        {pendingUSDC > 0n && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <Card className="bg-gradient-to-r from-emerald-500/10 to-emerald-500/5 border-emerald-500/30">
              <CardContent className="p-6 flex items-center justify-between gap-4 flex-wrap">
                <div className="flex items-center gap-4">
                  <div className="rounded-full bg-emerald-500/20 p-3">
                    <Gift className="w-6 h-6 text-emerald-400" />
                  </div>
                  <div>
                    <div className="text-sm text-emerald-200/80">Pending USDC ready to claim</div>
                    <div className="text-3xl font-bold text-emerald-300">
                      ${formatBigNumber(pendingUSDC, 6, 4)}
                    </div>
                    <div className="text-xs text-emerald-200/60 mt-1">
                      across {pendingEpochs.length} epoch{pendingEpochs.length === 1 ? '' : 's'}
                    </div>
                  </div>
                </div>
                <Button
                  onClick={handleClaimUSDC}
                  disabled={isProcessing}
                  className="bg-emerald-500 hover:bg-emerald-400 text-white min-w-[140px]"
                >
                  {activeOperation === 'claim' ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Claiming…
                    </>
                  ) : (
                    <>
                      <DollarSign className="w-4 h-4 mr-2" />
                      Claim USDC
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ─── Position card ─── */}
      <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-white">
              <Vault className="w-5 h-5 text-indigo-400" />
              Your Auto-Vault Position
              <a
                href={`${BASESCAN_BASE}/address/${VAULT_ADDR}`}
                target="_blank" rel="noopener noreferrer"
                title="Open vault contract on Basescan"
                className="text-slate-500 hover:text-indigo-300 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </CardTitle>
            <div className="flex items-center gap-2">
              {aprPct !== null && aprPct > 0 && (
                <Badge className="border-indigo-500/30 text-indigo-300 bg-indigo-500/10">
                  <TrendingUp className="w-3 h-3 mr-1" />
                  ~{aprPct.toFixed(1)}% APR
                </Badge>
              )}
              <Button
                variant="ghost" size="sm"
                onClick={refreshAll}
                disabled={isRefreshing}
                className="text-slate-400 hover:text-white"
              >
                <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-slate-900/40 rounded-lg p-4">
              <div className="text-xs text-slate-400 uppercase tracking-wide mb-1">Your deposit</div>
              <div className="text-2xl font-bold text-white">
                {formatBigNumber(shares, 18, 4)}
              </div>
              <div className="text-xs text-slate-500 mt-1">iAERO</div>
              {positionUsd > 0 && (
                <div className="text-xs text-slate-400 mt-1">≈ ${positionUsd.toFixed(2)}</div>
              )}
            </div>
            <div className="bg-slate-900/40 rounded-lg p-4">
              <div className="text-xs text-slate-400 uppercase tracking-wide mb-1">Pending USDC</div>
              <div className="text-2xl font-bold text-emerald-300">
                ${formatBigNumber(pendingUSDC, 6, 4)}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {pendingEpochs.length} epoch{pendingEpochs.length === 1 ? '' : 's'}
              </div>
            </div>
            <div className="bg-slate-900/40 rounded-lg p-4">
              <div className="text-xs text-slate-400 uppercase tracking-wide mb-1">Claimed all-time</div>
              <div className="text-2xl font-bold text-white">
                ${formatBigNumber(claimedAllTime, 6, 4)}
              </div>
              <div className="text-xs text-slate-500 mt-1">USDC</div>
            </div>
            <div className="bg-slate-900/40 rounded-lg p-4">
              <div className="text-xs text-slate-400 uppercase tracking-wide mb-1">Vault TVL</div>
              <div className="text-2xl font-bold text-white">
                {formatBigNumber(totalShares, 18, 2)}
              </div>
              <div className="text-xs text-slate-500 mt-1">iAERO total</div>
              {totalShares > 0n && shares > 0n && (
                <div className="text-xs text-slate-400 mt-1">
                  Your share: {(Number(shares * 10000n / totalShares) / 100).toFixed(2)}%
                </div>
              )}
            </div>
          </div>

          {/* Next harvest countdown — informational, always shown */}
          <div className="mt-4 flex items-center justify-between bg-slate-900/30 border border-slate-700/30 rounded-lg p-3 text-sm">
            <div className="flex items-center gap-2 text-slate-300">
              <Clock className="w-4 h-4 text-indigo-400" />
              <span>Next keeper harvest</span>
            </div>
            <div className="text-right">
              <div className="text-white font-medium">in {formatCountdown(secondsToHarvest)}</div>
              <div className="text-xs text-slate-500">
                {new Date(nextHarvestTs * 1000).toUTCString().replace('GMT', 'UTC')}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ─── Empty-state explainer when user has no position ─── */}
      {shares === 0n && (
        <Card className="bg-gradient-to-br from-indigo-500/10 to-slate-900/40 border-indigo-500/20">
          <CardContent className="p-6">
            <div className="flex items-start gap-4">
              <div className="rounded-full bg-indigo-500/20 p-3 shrink-0">
                <Sparkles className="w-5 h-5 text-indigo-300" />
              </div>
              <div className="space-y-2">
                <h3 className="text-white font-semibold">How it works</h3>
                <ul className="text-sm text-slate-300 space-y-1 list-disc list-inside marker:text-indigo-400">
                  <li>Deposit iAERO — it's auto-staked into the epoch distributor for you.</li>
                  <li>Every Thursday, the keeper claims all your reward tokens and converts them to USDC.</li>
                  <li>Your share of the USDC accrues per epoch — claim with one click whenever you want.</li>
                  <li>Withdraw any time, no cooldown. Past USDC stays claimable even after withdrawing.</li>
                </ul>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ─── Deposit / Withdraw ─── */}
      <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-white">
              {mode === 'deposit' ? 'Deposit iAERO' : 'Withdraw iAERO'}
            </CardTitle>
            <div className="flex bg-slate-900/60 rounded-lg p-1">
              <button
                onClick={() => setMode('deposit')}
                className={`px-3 py-1 rounded text-xs font-medium transition ${
                  mode === 'deposit' ? 'bg-indigo-500 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                <ArrowDownToLine className="w-3 h-3 inline mr-1" />
                Deposit
              </button>
              <button
                onClick={() => setMode('withdraw')}
                className={`px-3 py-1 rounded text-xs font-medium transition ${
                  mode === 'withdraw' ? 'bg-indigo-500 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                <ArrowUpFromLine className="w-3 h-3 inline mr-1" />
                Withdraw
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {mode === 'deposit' ? (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-slate-300">Amount</Label>
                  <span className="text-xs text-slate-400">
                    Balance: {formatBigNumber(iAeroBN, 18, 4)} iAERO
                  </span>
                </div>
                <div className="relative">
                  <Input
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(sanitizeDecimalInput(e.target.value))}
                    disabled={isProcessing}
                    className="bg-slate-900/60 border-slate-700 text-white pr-16 text-lg"
                  />
                  <Button
                    type="button" size="sm" variant="ghost"
                    onClick={handleMaxDeposit}
                    disabled={isProcessing}
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-indigo-300 hover:text-indigo-200"
                  >
                    MAX
                  </Button>
                </div>
                {depositError && <p className="text-xs text-red-400">{depositError}</p>}
                {needsApproval && depositAmountBN > 0n && !depositError && (
                  <Badge className="border-yellow-500/30 text-yellow-400 bg-yellow-500/10">
                    Approval Required
                  </Badge>
                )}
              </div>
              <Button
                onClick={handleDeposit}
                disabled={depositDisabled}
                className="w-full bg-indigo-500 hover:bg-indigo-400 text-white"
              >
                {isProcessing && activeOperation === 'deposit' ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {progressStep || 'Processing...'}
                  </>
                ) : (
                  <>
                    <ArrowDownToLine className="w-4 h-4 mr-2" />
                    {needsApproval ? 'Approve & Deposit' : 'Deposit'}
                  </>
                )}
              </Button>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-slate-300">Amount</Label>
                  <span className="text-xs text-slate-400">
                    Available: {formatBigNumber(shares, 18, 4)} iAERO
                  </span>
                </div>
                <div className="relative">
                  <Input
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={withdrawAmount}
                    onChange={(e) => setWithdrawAmount(sanitizeDecimalInput(e.target.value))}
                    disabled={isProcessing}
                    className="bg-slate-900/60 border-slate-700 text-white pr-16 text-lg"
                  />
                  <Button
                    type="button" size="sm" variant="ghost"
                    onClick={handleMaxWithdraw}
                    disabled={isProcessing}
                    className="absolute right-1 top-1/2 -translate-y-1/2 text-indigo-300 hover:text-indigo-200"
                  >
                    MAX
                  </Button>
                </div>
                {withdrawError && <p className="text-xs text-red-400">{withdrawError}</p>}
              </div>
              <p className="text-xs text-slate-400 flex items-center gap-1">
                <Info className="w-3 h-3" />
                Withdrawals are instant. Any pending USDC from prior epochs remains claimable after withdrawing.
              </p>
              <Button
                onClick={handleWithdraw}
                disabled={withdrawDisabled}
                className="w-full bg-indigo-500 hover:bg-indigo-400 text-white"
              >
                {isProcessing && activeOperation === 'withdraw' ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {progressStep || 'Processing...'}
                  </>
                ) : (
                  <>
                    <ArrowUpFromLine className="w-4 h-4 mr-2" />
                    Withdraw
                  </>
                )}
              </Button>
            </>
          )}

          {/* Recent activity */}
          {txHistory.length > 0 && (
            <div className="border-t border-slate-700/50 pt-4 mt-2">
              <div className="text-xs text-slate-400 uppercase tracking-wide mb-2">Recent activity</div>
              <div className="space-y-1">
                {txHistory.map((h, i) => (
                  <div key={i} className="flex items-center justify-between text-xs">
                    <span className="text-slate-300 capitalize">
                      {h.type}: {h.amount} {h.symbol}
                    </span>
                    {h.txHash && (
                      <a
                        href={`https://basescan.org/tx/${h.txHash}`}
                        target="_blank" rel="noopener noreferrer"
                        className="text-indigo-300 hover:text-indigo-200"
                      >
                        view
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <AnimatePresence>
        {showSuccess && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed bottom-4 right-4 bg-emerald-500 text-white px-4 py-2 rounded-lg flex items-center gap-2 shadow-lg z-50"
          >
            <CheckCircle className="w-4 h-4" />
            Success!
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
