// ==============================================
// src/components/protocol/StakeSection.tsx (updated to use PriceContext)
// ==============================================
import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ethers } from "ethers";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Coins, TrendingUp, Zap, Loader2, CheckCircle, History, Info, RefreshCw } from "lucide-react";
import { usePublicClient } from 'wagmi';
import { useProtocol } from "@/components/contexts/ProtocolContext";
import { useStaking } from "../contracts/hooks/useStaking";
import { parseInputToBigNumber, formatBigNumber, sanitizeDecimalInput, useDebounce, validateTokenAmount, calculateYield } from "../lib/defi-utils";
import { useSwitchChain } from 'wagmi';
import { baseSepolia } from 'wagmi/chains';
import { usePrices } from "@/components/contexts/PriceContext";



interface StakeSectionProps {
  showToast: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void;
  formatNumber: (value: string | number) => string;
}

interface TxHistory { type: "stake" | "unstake"; amount: string; timestamp: number; txHash?: string; }
const MIN_STAKE_AMOUNT = ethers.parseUnits("0.01", 18);

const DEFAULT_STAKING_APR =
  Number(process.env.NEXT_PUBLIC_DEFAULT_STAKING_APR ?? '30');
  
const msgFromError = (e: any, fallback = "Transaction failed") => {
  if (e?.code === 4001) return "Transaction rejected by user";
  const m = String(e?.message || "").toLowerCase();
  if (m.includes("insufficient funds")) return "Insufficient ETH for gas fees";
  if (m.includes("insufficient balance")) return "Insufficient balance";
  return fallback;
};

const formatTimeAgo = (ts: number) => { 
  const s = Math.floor((Date.now() - ts) / 1000); 
  if (s < 60) return "just now"; 
  if (s < 3600) return `${Math.floor(s/60)}m ago`; 
  if (s < 86400) return `${Math.floor(s/3600)}h ago`; 
  return `${Math.floor(s/86400)}d ago`; 
};

const getAmountError = (amount: string, balance: bigint) => { 
  if (!amount) return null; 
  const bn = parseInputToBigNumber(amount); 
  if (bn === 0n) return null; 
  if (bn < MIN_STAKE_AMOUNT) return "Minimum 0.01 iAERO"; 
  if (bn > balance) return "Insufficient balance"; 
  return null; 
};

export default function StakeSection({ showToast, formatNumber }: StakeSectionProps) {
  const { connected, networkSupported, balances, loading, chainId, loadBalances } = useProtocol();
  const { stakeIAero, unstakeIAero, calculateStakingAPR, getStakingStats, checkIAeroApproval, approveIAero, loading: stakingLoading } = useStaking() as any;
  const { getPriceInUSD } = usePrices();
  const { switchChain } = useSwitchChain();
  const publicClient = usePublicClient();
  // State declarations - moved up before they're used
  const [stakingAPR, setStakingAPR] = useState<{ aero: number; total: number }>({ aero: 0, total: 0 });
  const [stakingStats, setStakingStats] = useState<{ totalStaked: string; rewardTokensCount: number }>({ totalStaked: '0', rewardTokensCount: 0 });
  const [stakeAmount, setStakeAmount] = useState("");
  const [unstakeAmount, setUnstakeAmount] = useState("");
  const [needsApproval, setNeedsApproval] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressStep, setProgressStep] = useState("");
  const [activeOperation, setActiveOperation] = useState<"stake" | "unstake" | "">("");
  const [mode, setMode] = useState<"stake" | "unstake">("stake");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showAPRBreakdown, setShowAPRBreakdown] = useState(false);
  const [txHistory, setTxHistory] = useState<TxHistory[]>([]);
  const [showSuccess, setShowSuccess] = useState(false);

  const latestApprovalCheck = useRef(0);
  const debouncedStakeAmount = useDebounce(stakeAmount, 300);
  const debouncedUnstakeAmount = useDebounce(unstakeAmount, 300);

  const iAeroBN = useMemo(() => parseInputToBigNumber(balances?.iAero ?? "0"), [balances.iAero]);
  const stakedIAeroBN = useMemo(() => parseInputToBigNumber(balances?.stakedIAero ?? "0"), [balances.stakedIAero]);
  const stakeAmountBN = parseInputToBigNumber(stakeAmount);
  const unstakeAmountBN = parseInputToBigNumber(unstakeAmount);

  const stakeError = getAmountError(stakeAmount, iAeroBN);
  const unstakeError = getAmountError(unstakeAmount, stakedIAeroBN);

  const dailyRewardsPretty = useMemo(() => {
    const apr = stakingAPR?.aero ?? 0;
    if (stakedIAeroBN === 0n || apr === 0) return "0";
    const daily = calculateYield(stakedIAeroBN, apr, 1, 18);
    return formatBigNumber(daily, 18, 4);
  }, [stakedIAeroBN, stakingAPR]);

  const positionValue = useMemo(() => {
    const staked = parseFloat(formatBigNumber(stakedIAeroBN, 18, 6));
    return getPriceInUSD('iAERO', staked);
  }, [stakedIAeroBN, getPriceInUSD]);

  const ApprovalBadge = () => {
    if (mode === "stake" && stakeAmountBN > 0n && !needsApproval) return <Badge className="border-green-500/30 text-green-400 bg-green-500/10">✓ Approved</Badge>;
    if (mode === "stake" && needsApproval) return <Badge className="border-yellow-500/30 text-yellow-400 bg-yellow-500/10">Approval Required</Badge>;
    return null;
  };

  const addToHistory = (type: TxHistory["type"], amount: string, txHash?: string) => setTxHistory(prev => [{ type, amount, timestamp: Date.now(), txHash }, ...prev.slice(0,4)]);

  useEffect(() => {
    const run = async () => {
      try {
        const [apr, stats] = await Promise.all([calculateStakingAPR(), getStakingStats()]);
        setStakingAPR(apr);
        setStakingStats(stats);
      } catch (e) { console.error('Failed to load staking data', e); }
    };
    if (connected && networkSupported) run();
  }, [connected, networkSupported, calculateStakingAPR, getStakingStats]);

  useEffect(() => {
    if (mode !== 'stake') { setNeedsApproval(false); return; }
    const check = async () => {
      if (!debouncedStakeAmount || parseFloat(debouncedStakeAmount) <= 0) { setNeedsApproval(false); return; }
      const id = ++latestApprovalCheck.current;
      try { const ok = await checkIAeroApproval(debouncedStakeAmount); if (id === latestApprovalCheck.current) setNeedsApproval(!ok); }
      catch { if (id === latestApprovalCheck.current) setNeedsApproval(false); }
    };
    check();
  }, [mode, debouncedStakeAmount, checkIAeroApproval]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (mode === 'stake' && !isStakeButtonDisabled()) handleStakeIAero();
        else if (mode === 'unstake' && !isUnstakeButtonDisabled()) handleUnstakeIAero();
      }
      if (e.key === 'Escape') { setStakeAmount(''); setUnstakeAmount(''); }
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey) handleRefresh();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, stakeAmount, unstakeAmount]);

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([loadBalances(), calculateStakingAPR().then(setStakingAPR), getStakingStats().then(setStakingStats)]);
      showToast('Data refreshed', 'info');
    } catch (e) { console.error('Refresh failed', e); }
    finally { setIsRefreshing(false); }
  }, [loadBalances, calculateStakingAPR, getStakingStats, showToast]);

  const estimateGasForAction = async (_: 'stake' | 'unstake') => {
    try {
      if (!publicClient) return true;
      const gasPrice = await publicClient.getGasPrice();
      const gasLimit = 150000n;
      const gasCost = gasPrice * gasLimit;
      const ethBal = parseInputToBigNumber(balances.ethBalance || '0');
      if (ethBal < gasCost) {
        showToast(`Insufficient ETH for gas. Need ~${formatBigNumber(gasCost, 18, 4)} ETH`, 'warning');
        return false;
      }
      return true;
    } catch {
      return true;
    }
  };

  const handleStakeAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => setStakeAmount(sanitizeDecimalInput(e.target.value));
  const handleUnstakeAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => setUnstakeAmount(sanitizeDecimalInput(e.target.value));
  const handleMaxStake = () => {
    // Leave a small buffer to account for rounding differences
    const buffer = ethers.parseUnits("0.01", 18); // 0.01 iAERO buffer
    const maxAmount = iAeroBN > buffer ? iAeroBN - buffer : 0n;
    setStakeAmount(ethers.formatUnits(maxAmount, 18));
  };
  const handleMaxUnstake = () => {
    const buffer = ethers.parseUnits("0.01", 18);
    const maxAmount = stakedIAeroBN > buffer ? stakedIAeroBN - buffer : 0n;
    setUnstakeAmount(ethers.formatUnits(maxAmount, 18));
  };

  const handleStakeIAero = async () => {
    const v = validateTokenAmount(stakeAmount, iAeroBN, 18, MIN_STAKE_AMOUNT); 
    if (!v.valid) return showToast(v.error || 'Invalid amount', 'error');
    if (!(await estimateGasForAction('stake'))) return;
    setIsProcessing(true); 
    setActiveOperation('stake');
    try {
      if (needsApproval && typeof approveIAero === 'function') {
        setProgressStep('Approving iAERO spending...');
        await approveIAero(stakeAmount);
        setNeedsApproval(false);
      }
      setProgressStep('Staking iAERO...');
      await stakeIAero(
        stakeAmount,
        async (receipt: any) => {
          setStakeAmount(''); 
          setShowSuccess(true); 
          setTimeout(() => setShowSuccess(false), 3000);
          addToHistory('stake', stakeAmount, receipt?.transactionHash);
          showToast(`Successfully staked ${stakeAmount} iAERO! You're now earning rewards.`, 'success');
          await loadBalances();
        },
        (err: any) => showToast(msgFromError(err, 'Staking failed'), 'error'),
        (p: string) => setProgressStep(p)
      );
    } finally { 
      setIsProcessing(false); 
      setActiveOperation(''); 
      setProgressStep(''); 
    }
  };

  const handleUnstakeIAero = async () => {
    const v = validateTokenAmount(unstakeAmount, stakedIAeroBN, 18, MIN_STAKE_AMOUNT); 
    if (!v.valid) return showToast(v.error || 'Invalid amount', 'error');
    if (!(await estimateGasForAction('unstake'))) return;
    setIsProcessing(true); 
    setActiveOperation('unstake');
    try {
      await unstakeIAero(
        unstakeAmount,
        async (receipt: any) => {
          setUnstakeAmount(''); 
          setShowSuccess(true); 
          setTimeout(() => setShowSuccess(false), 3000);
          addToHistory('unstake', unstakeAmount, receipt?.transactionHash);
          showToast(`Successfully unstaked ${unstakeAmount} iAERO!`, 'success');
          await loadBalances();
        },
        (err: any) => showToast(msgFromError(err, 'Unstaking failed'), 'error'),
        (p: string) => setProgressStep(p)
      );
    } finally { 
      setIsProcessing(false); 
      setActiveOperation(''); 
      setProgressStep(''); 
    }
  };

  const getStakeButtonText = () => {
    if (isProcessing && activeOperation === 'stake') return progressStep || 'Processing...';
    if (!connected) return 'Connect Wallet';
    if (!networkSupported) return 'Switch Network';
    if (stakeAmountBN === 0n) return 'Enter Amount';
    if (stakeError) return stakeError;
    return needsApproval ? 'Approve & Stake iAERO' : 'Stake iAERO';
  };

  const getUnstakeButtonText = () => {
    if (isProcessing && activeOperation === 'unstake') return progressStep || 'Processing...';
    if (!connected) return 'Connect Wallet';
    if (!networkSupported) return 'Switch Network';
    if (unstakeAmountBN === 0n) return 'Enter Amount';
    if (unstakeError) return unstakeError;
    return 'Unstake iAERO';
  };

  const isStakeButtonDisabled = () => (!connected || !networkSupported || stakeAmountBN === 0n || !!stakeError || isProcessing || stakingLoading);
  const isUnstakeButtonDisabled = () => (!connected || !networkSupported || unstakeAmountBN === 0n || !!unstakeError || isProcessing || stakingLoading);

  const txBaseUrl = useMemo(() => (chainId === 84532 ? 'https://sepolia.basescan.org/tx/' : chainId === 8453 ? 'https://basescan.org/tx/' : 'https://etherscan.io/tx/'), [chainId]);

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex space-x-2 p-1 bg-slate-900/50 rounded-lg flex-1 max-w-sm">
          <button onClick={() => setMode('stake')} disabled={isProcessing} className={`flex-1 px-4 py-2 rounded-md font-medium transition-all ${mode === 'stake' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'} ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}>Stake</button>
          <button onClick={() => setMode('unstake')} disabled={isProcessing} className={`flex-1 px-4 py-2 rounded-md font-medium transition-all ${mode === 'unstake' ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'} ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}`}>Unstake</button>
        </div>
        {connected && networkSupported && (
          <Button onClick={handleRefresh} disabled={isRefreshing || isProcessing} variant="ghost" size="sm" className="text-slate-400 hover:text-white"><RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} /></Button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
          <CardHeader>
            <CardTitle className="text-white flex items-center space-x-2">{mode === 'stake' ? (<><Zap className="w-5 h-5 text-indigo-400" /><span>Stake iAERO</span></>) : (<><Coins className="w-5 h-5 text-purple-400" /><span>Unstake iAERO</span></>)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {mode === 'stake' ? (
              <>
                <div className="space-y-2">
                  <Label className="text-slate-300">Amount to Stake</Label>
                  <div className="relative">
                    <Input type="text" inputMode="decimal" placeholder="0.0" value={stakeAmount} onChange={handleStakeAmountChange} className={`bg-slate-900/50 border-slate-600 text-white placeholder-slate-400 pr-16 ${stakeError ? 'border-red-500/50' : ''}`} disabled={isProcessing} />
                    <Button variant="ghost" size="sm" onClick={handleMaxStake} disabled={isProcessing || loading.balances} className="absolute right-2 top-1/2 transform -translate-y-1/2 text-indigo-400 hover:text-indigo-300 h-8">MAX</Button>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className={stakeError ? 'text-red-400' : 'text-slate-400'}>{stakeError || `Available: ${loading.balances ? 'Loading...' : formatBigNumber(iAeroBN) + ' iAERO'}`}</span>
                    <ApprovalBadge />
                  </div>
                </div>
                <Button onClick={handleStakeIAero} disabled={isStakeButtonDisabled()} className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 disabled:opacity-50">{(isProcessing && activeOperation === 'stake') ? (<div className="flex items-center space-x-2"><Loader2 className="w-4 h-4 animate-spin" /><span>{getStakeButtonText()}</span></div>) : (getStakeButtonText())}</Button>
              </>
            ) : (
              <>
                <div className="space-y-2">
                  <Label className="text-slate-300">Amount to Unstake</Label>
                  <div className="relative">
                    <Input type="text" inputMode="decimal" placeholder="0.0" value={unstakeAmount} onChange={handleUnstakeAmountChange} className={`bg-slate-900/50 border-slate-600 text-white placeholder-slate-400 pr-16 ${unstakeError ? 'border-red-500/50' : ''}`} disabled={isProcessing} />
                    <Button variant="ghost" size="sm" onClick={handleMaxUnstake} disabled={isProcessing || loading.balances} className="absolute right-2 top-1/2 transform -translate-y-1/2 text-purple-400 hover:text-purple-300 h-8">MAX</Button>
                  </div>
                  <p className={`text-sm ${unstakeError ? 'text-red-400' : 'text-slate-400'}`}>{unstakeError || `Staked: ${loading.balances ? 'Loading...' : formatBigNumber(stakedIAeroBN) + ' iAERO'}`}</p>
                </div>
                <Button onClick={handleUnstakeIAero} disabled={isUnstakeButtonDisabled()} className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 disabled:opacity-50">{(isProcessing && activeOperation === 'unstake') ? (<div className="flex items-center space-x-2"><Loader2 className="w-4 h-4 animate-spin" /><span>{getUnstakeButtonText()}</span></div>) : (getUnstakeButtonText())}</Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-white flex items-center space-x-2"><TrendingUp className="w-5 h-5 text-emerald-400" /><span>Staking Stats</span></CardTitle>
              <Button onClick={() => setShowAPRBreakdown(s => !s)} variant="ghost" size="sm" className="text-slate-400 hover:text-white"><Info className="w-4 h-4" /></Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/30">
              <div className="flex justify-between items-center mb-2"><span className="text-slate-400">Current APR</span><span className="text-emerald-400 font-semibold text-xl">{stakingAPR?.aero?.toFixed ? stakingAPR.aero.toFixed(1) : '0.0'}%</span></div>
              {showAPRBreakdown && (
                <div className="mt-3 pt-3 border-t border-slate-700/50 text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-slate-500">Base APR:</span><span className="text-slate-400">30.0%</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Boost:</span><span className="text-emerald-400">+{((stakingAPR?.aero ?? 0) - 30).toFixed(1)}%</span></div>
                  <div className="text-slate-500 mt-2 italic">Stake more to increase rewards</div>
                </div>
              )}
              <div className="flex justify-between items-center mb-2"><span className="text-slate-400">Total Staked</span><span className="text-white">{formatNumber(stakingStats.totalStaked)} iAERO</span></div>
              <div className="flex justify-between items-center"><span className="text-slate-400">Reward Tokens</span><span className="text-white">{stakingStats.rewardTokensCount}</span></div>
            </div>
            {connected && stakedIAeroBN > 0n && (
              <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/30">
                <h4 className="text-white font-medium mb-3">Your Position</h4>
                <div className="space-y-2">
                  <div className="flex justify-between items-center"><span className="text-slate-400">Staked</span><span className="text-white font-medium">{formatBigNumber(stakedIAeroBN)} iAERO</span></div>
                  <div className="flex justify-between items-center"><span className="text-slate-400">Daily Rewards</span><span className="text-emerald-400 font-medium">~{dailyRewardsPretty} AERO</span></div>
                  <div className="flex justify-between items-center"><span className="text-slate-400">Value</span><span className="text-white">≈ ${formatNumber(positionValue)}</span></div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {isProcessing && (
        <Card className="bg-blue-500/10 border border-blue-500/20">
          <CardContent className="p-4">
            <div className="flex items-center space-x-3 mb-2"><Loader2 className="w-5 h-5 text-blue-400 animate-spin" /><span className="text-blue-400 font-medium">Processing {activeOperation === 'stake' ? 'Stake' : 'Unstake'} Transaction</span></div>
            <p className="text-sm text-slate-300 mb-2">{progressStep}</p>
            <Progress value={progressStep ? 75 : 25} />
          </CardContent>
        </Card>
      )}

      <AnimatePresence>{showSuccess && (<motion.div initial={{ scale: .8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: .8, opacity: 0 }} className="flex items-center justify-center py-4"><div className="bg-emerald-500/20 rounded-full p-4"><CheckCircle className="w-12 h-12 text-emerald-400" /></div></motion.div>)}</AnimatePresence>

      {connected && !networkSupported && (
        <Card className="bg-amber-500/10 border border-amber-500/20"><CardContent className="p-4"><div className="flex items-center justify-between"><div><p className="text-amber-400 font-medium">Wrong Network</p><p className="text-sm text-slate-300 mt-1">Please switch to Base Sepolia to continue</p></div><Button onClick={async () => { try { switchChain({ chainId: baseSepolia.id }); } catch (e) { showToast('Network switch failed', 'error'); } }} className="bg-amber-600 hover:bg-amber-700">Switch to Base Sepolia</Button></div></CardContent></Card>
      )}

      {txHistory.length > 0 && (
        <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50"><CardHeader><CardTitle className="text-white flex items-center space-x-2 text-lg"><History className="w-5 h-5" /><span>Recent Transactions</span></CardTitle></CardHeader><CardContent><div className="space-y-3">{txHistory.map((tx, i) => (<div key={i} className="flex justify-between items-center text-sm p-2 bg-slate-900/30 rounded"><div className="flex items-center space-x-3"><div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" /><div><span className="text-slate-300">{tx.type === 'stake' ? 'Staked' : 'Unstaked'}</span><span className="text-slate-500 text-xs ml-2">{formatTimeAgo(tx.timestamp)}</span></div></div><div className="flex items-center space-x-3"><span className="text-white font-medium">{tx.amount} iAERO</span>{tx.txHash && (<a href={`${txBaseUrl}${tx.txHash}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">↗</a>)}</div></div>))}</div></CardContent></Card>
      )}

      <div className="text-xs text-slate-500 text-center"><span>Press </span><kbd className="px-1.5 py-0.5 bg-slate-700 rounded">R</kbd><span> to refresh • </span><kbd className="px-1.5 py-0.5 bg-slate-700 rounded">⌘</kbd><span> + </span><kbd className="px-1.5 py-0.5 bg-slate-700 rounded">Enter</kbd><span> to submit • </span><kbd className="px-1.5 py-0.5 bg-slate-700 rounded">Esc</kbd><span> to clear</span></div>
    </motion.div>
  );
}
