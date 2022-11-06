// =============================
// src/components/protocol/LiqStaking.tsx
// =============================
import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Coins, TrendingUp, Clock, Gift, AlertCircle, Loader2 } from "lucide-react";
import { useProtocol } from '@/components/contexts/ProtocolContext';
import { parseTokenAmount } from '@/components/lib/ethereum';
import { usePrices } from '@/components/contexts/PriceContext';

interface StakingStats {
  totalStaked: string;
  apy: number;
  userStaked: string;
  userRewards: string;
  canUnstake: boolean;
  timeUntilUnlock: number;
}

interface LiqStakingProps {
  showToast: (message: string, type: "success" | "error" | "info" | "warning") => void;
  formatNumber: (value: string | number) => string;
}

export default function LiqStaking({ showToast, formatNumber }: LiqStakingProps) {
  const { 
    account,
    connected,
    networkSupported,
    balances,
    getContracts,
    loadBalances,
    dispatch
  } = useProtocol();

  const { prices } = usePrices();

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
    apy: 25.5,
    userStaked: "0",
    userRewards: "0",
    canUnstake: false,
    timeUntilUnlock: 0
  });
  const [liqBalance, setLiqBalance] = useState("0");
  const [allowance, setAllowance] = useState("0");
  const [needsApproval, setNeedsApproval] = useState(false);

  const isLocked = stakingStats.timeUntilUnlock > 0;
  // Load staking stats
  const loadStakingStats = async () => {
    if (!connected || !networkSupported || !account) return;
  
    try {
      const contracts = await getContracts();
      if (!contracts?.LIQStakingDistributor) return;
  
      // 1) totals
      let totalSupply: bigint = 0n;
      try {
        // Try calling it as a function first
        totalSupply = await contracts.LIQStakingDistributor.totalLIQStaked();
      } catch (error) {
        // If that fails, try as a property
        try {
          totalSupply = await contracts.LIQStakingDistributor.totalLIQStaked;
        } catch (error2) {
          console.log("Could not fetch total supply:", error2);
        }
      }

      console.log("totalLIQStaked raw value:", totalSupply);
      console.log("totalLIQStaked formatted:", ethers.formatEther(totalSupply ?? 0n));
      
      // 2) user stake
      const userBalance: bigint = await contracts.LIQStakingDistributor.balanceOf(account);
  
      // 3) pending rewards (sum across tokens)
      let rewards: bigint = 0n;
      try {
        const [tokens, amounts]: [string[], bigint[]] =
          await contracts.LIQStakingDistributor.getPendingRewards(account);
        if (amounts?.length) {
          for (const a of amounts) rewards += (a ?? 0n);
        }
      } catch (e) {
        console.log("Error getting pending rewards:", e);
      }
      
      // 4) lock state
      let canUnstake = false;
      let timeUntilUnlock = 0;
      try {
        // The contract has unlockTime(address) which returns the timestamp when user can unstake
        const unlockTimestamp = await contracts.LIQStakingDistributor.unlockTime(account);
        const now = Math.floor(Date.now() / 1000);
        
        if (Number(unlockTimestamp) > now) {
          timeUntilUnlock = Number(unlockTimestamp) - now;
          canUnstake = false;
        } else {
          timeUntilUnlock = 0;
          canUnstake = true;
        }
      } catch (error) {
        console.log("Error checking unlock time:", error);
        // If we can't determine lock status, default to safe assumption
        canUnstake = false;
        timeUntilUnlock = 7 * 24 * 60 * 60; // 7 days default
      }
  
      setStakingStats({
        totalStaked: ethers.formatEther(totalSupply ?? 0n),
        apy: 25.5,
        userStaked: ethers.formatEther(userBalance ?? 0n),
        userRewards: ethers.formatEther(rewards),
        canUnstake,
        timeUntilUnlock
      });
    } catch (error) {
      console.error("Error loading staking stats:", error);
    }
  };

  // Load LIQ balance and check allowance
  const loadLiqBalance = async () => {
    if (!connected || !networkSupported || !account) return;
    
    try {
      const contracts = await getContracts();
      if (!contracts?.LIQ || !contracts?.LIQStakingDistributor) return;
      
      const balance = await contracts.LIQ.balanceOf(account);
      setLiqBalance(ethers.formatEther(balance));
      
      // Check allowance
      const stakingAddr = await contracts.LIQStakingDistributor.getAddress();
      const allow = await contracts.LIQ.allowance(account, stakingAddr);
      setAllowance(ethers.formatEther(allow));
    } catch (error) {
      console.error("Error loading LIQ balance:", error);
    }
  };

  // Check if approval is needed
  useEffect(() => {
    if (stakeAmount && parseFloat(stakeAmount) > 0) {
      setNeedsApproval(parseFloat(stakeAmount) > parseFloat(allowance));
    } else {
      setNeedsApproval(false);
    }
  }, [stakeAmount, allowance]);

  // Load data on mount and when wallet connects
  useEffect(() => {
    if (connected && networkSupported) {
      loadStakingStats();
      loadLiqBalance();
      
      const interval = setInterval(() => {
        loadStakingStats();
        loadLiqBalance();
      }, 30000); // Refresh every 30 seconds
      
      return () => clearInterval(interval);
    }
  }, [connected, networkSupported, account]);

  const handleApprove = async () => {
    if (!connected || !account) return;
    
    const txId = 'approveLiq';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    setLoading(true);
    
    try {
      const contracts = await getContracts(true); // Get signer
      if (!contracts?.LIQ || !contracts?.LIQStakingDistributor) throw new Error("Contracts not initialized");
      
      const stakingAddr = await contracts.LIQStakingDistributor.getAddress();
      const tx = await contracts.LIQ.approve(stakingAddr, ethers.MaxUint256);
      
      showToast("Approving LIQ...", "info");
      await tx.wait();
      showToast("LIQ approved!", "success");
      
      await loadLiqBalance();
    } catch (error: any) {
      console.error("Approval error:", error);
      showToast(error.message || "Approval failed", "error");
    } finally {
      setLoading(false);
      dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: false } });
    }
  };

  const handleStake = async () => {
    if (!connected || !account || !stakeAmount) return;
    
    const txId = 'stakeLiq';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    setLoading(true);
    
    try {
      const contracts = await getContracts(true); // Get signer
      if (!contracts?.LIQStakingDistributor) throw new Error("LIQ Staking contract not initialized");
      
      // Check if approval needed
      if (needsApproval) {
        await handleApprove();
      }
      
      const amount = parseTokenAmount(stakeAmount);
      const tx = await contracts.LIQStakingDistributor.stake(amount);
      
      showToast("Staking LIQ...", "info");
      await tx.wait();
      showToast(`Staked ${stakeAmount} LIQ!`, "success");
      
      setStakeAmount("");
      await loadStakingStats();
      await loadLiqBalance();
      await loadBalances();
    } catch (error: any) {
      console.error("Staking error:", error);
      showToast(error.message || "Staking failed", "error");
    } finally {
      setLoading(false);
      dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: false } });
    }
  };

  const handleUnstake = async () => {
    if (!connected || !account || !unstakeAmount) return;
    
    const txId = 'unstakeLiq';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    setLoading(true);
    
    try {
      const contracts = await getContracts(true); // Get signer
      if (!contracts?.LIQStakingDistributor) throw new Error("LIQ Staking contract not initialized");
      
      const amount = parseTokenAmount(unstakeAmount);
      const tx = await contracts.LIQStakingDistributor.unstake(amount);
      
      showToast("Unstaking LIQ...", "info");
      await tx.wait();
      showToast(`Unstaked ${unstakeAmount} LIQ!`, "success");
      
      setUnstakeAmount("");
      await loadStakingStats();
      await loadLiqBalance();
      await loadBalances();
    } catch (error: any) {
      console.error("Unstaking error:", error);
      showToast(error.message || "Unstaking failed", "error");
    } finally {
      setLoading(false);
      dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: false } });
    }
  };

  const handleClaimRewards = async () => {
    if (!connected || !account) return;
    
    const txId = 'claimLiqRewards';
    dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: true } });
    setLoading(true);
    
    try {
      const contracts = await getContracts(true); // Get signer
      if (!contracts?.LIQStakingDistributor) throw new Error("LIQ Staking contract not initialized");
      
      const tx = await contracts.LIQStakingDistributor.claimRewards();
      
      showToast("Claiming rewards...", "info");
      await tx.wait();
      showToast("Rewards claimed!", "success");
      
      await loadStakingStats();
      await loadBalances();
    } catch (error: any) {
      console.error("Claim error:", error);
      showToast(error.message || "Claim failed", "error");
    } finally {
      setLoading(false);
      dispatch({ type: 'SET_TRANSACTION_LOADING', payload: { id: txId, loading: false } });
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
                <p className="text-2xl font-bold text-white">
                  {formatNumber(stakingStats.totalStaked)} LIQ
                </p>
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
                <p className="text-2xl font-bold text-emerald-400">
                  {stakingStats.apy.toFixed(1)}%
                </p>
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
                <p className="text-2xl font-bold text-white">
                  {formatNumber(stakingStats.userStaked)} LIQ
                </p>
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
                <p className="text-2xl font-bold text-white">
                  ${formatNumber(parseFloat(stakingStats.userRewards) * Number(prices?.LIQ?.usd ?? 0))}
                </p>
              </div>
              <Gift className="w-8 h-8 text-yellow-400" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Staking Interface */}
      <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
        <CardHeader>
          <CardTitle className="text-xl font-bold flex items-center gap-2">
            <Coins className="w-6 h-6 text-purple-400" />
            Stake LIQ
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="stake" className="w-full">
            <TabsList className="grid w-full grid-cols-2 bg-slate-700/50">
              <TabsTrigger value="stake">Stake</TabsTrigger>
              <TabsTrigger value="unstake">Unstake</TabsTrigger>
            </TabsList>

            <TabsContent value="stake" className="space-y-4">
              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm text-slate-400">Amount to Stake</label>
                  <span className="text-sm text-slate-400">
                    Available: {formatNumber(liqBalance)} LIQ
                  </span>
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
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : null}
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
              {/* Lock warning - show this FIRST if tokens are locked */}
              {stakingStats.timeUntilUnlock > 0 && (
                <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
                  <div className="flex items-start space-x-3">
                    <Clock className="w-5 h-5 text-amber-400 mt-0.5" />
                    <div>
                      <p className="font-medium text-amber-400">Tokens Locked</p>
                      <p className="text-sm text-slate-300 mt-1">
                        You can unstake in {fmtLock(stakingStats.timeUntilUnlock)}
                      </p>
                      <p className="text-xs text-slate-400 mt-2">
                        Lock period: 7 days from last stake
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Unstake input form - always show this */}
              <div>
                <div className="flex justify-between mb-2">
                  <label className="text-sm text-slate-400">Amount to Unstake</label>
                  <span className="text-sm text-slate-400">
                    Staked: {formatNumber(stakingStats.userStaked)} LIQ
                  </span>
                </div>
                <div className="flex gap-2">
                  <Input
                    type="number"
                    placeholder="0.0"
                    value={unstakeAmount}
                    onChange={(e) => setUnstakeAmount(e.target.value)}
                    className="bg-slate-700/50 border-slate-600"
                    disabled={loading || isLocked}  // Disable if locked
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

              {/* Unstake button */}
              <Button
                onClick={handleUnstake}
                disabled={loading || !unstakeAmount || parseFloat(unstakeAmount) <= 0 || isLocked}
                className="w-full bg-purple-600 hover:bg-purple-700"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : null}
                {isLocked
                  ? `Locked for ${fmtLock(stakingStats.timeUntilUnlock)}`
                  : "Unstake LIQ"}
              </Button>
            </TabsContent>
          </Tabs>

          {/* Claim Rewards Section */}
          {parseFloat(stakingStats.userRewards) > 0 && (
            <div className="mt-6 p-4 bg-gradient-to-r from-purple-900/20 to-pink-900/20 rounded-lg border border-purple-700/30">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-slate-400">Claimable Rewards</p>
                  <p className="text-lg font-bold text-white">
                    ${formatNumber(parseFloat(stakingStats.userRewards) * Number(prices?.LIQ?.usd ?? 0))}
                  </p>
                </div>
                <Button
                  onClick={handleClaimRewards}
                  disabled={loading}
                  className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  ) : (
                    <Gift className="w-4 h-4 mr-2" />
                  )}
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