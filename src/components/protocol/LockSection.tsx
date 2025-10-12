// src/components/protocol/LockSection.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Lock, AlertTriangle, Loader2, CheckCircle, History } from "lucide-react";
import { useProtocol } from "../contexts/ProtocolContext";
import { useVault } from "../contracts/hooks/useVault";
import {
  parseInputToBigNumber,
  formatBigNumber,
  sanitizeDecimalInput,
  sanitizeIntegerInput,
  useDebounce,
  validateTokenAmount,
} from "../lib/defi-utils";
import { useSwitchChain } from 'wagmi';
import { baseSepolia } from 'wagmi/chains';
import { usePublicClient } from 'wagmi';
import { getContractAddress } from '@/components/contracts/addresses';
import { ABIS } from '@/components/contracts/abis';

interface LockSectionProps {
  showToast: (message: string, type: "success" | "error" | "info" | "warning") => void;
  formatNumber: (value: string | number) => string;
}

interface TxHistory {
  type: "deposit" | "depositNFT";
  amount: string;
  timestamp: number;
  txHash?: string;
}

// Constants
const WEEK = 7 * 24 * 60 * 60;
const MIN_LOCK_AMOUNT = BigInt(10000000000000000); // 0.01 in wei
const MAX_DUST = BigInt(1000000000000000);

// Helpers
const msgFromError = (e: any, fallback = "Transaction failed") => {
  if (e?.code === 4001) return "Transaction rejected by user";
  const m = String(e?.message || "").toLowerCase();
  if (m.includes("insufficient funds")) return "Insufficient ETH for gas fees";
  return fallback;
};

const formatUnlockDate = (weeks: number): string => {
  const now = Math.floor(Date.now() / 1000);
  const aligned = Math.ceil((now + weeks * WEEK) / WEEK) * WEEK;
  const unlockDate = new Date(aligned * 1000);
  const nowDate = new Date();
  const daysUntil = Math.floor((unlockDate.getTime() - nowDate.getTime()) / (1000 * 60 * 60 * 24));
  if (daysUntil <= 30) {
    return `${daysUntil} days (${unlockDate.toLocaleDateString()})`;
  }
  const options: Intl.DateTimeFormatOptions =
    unlockDate.getFullYear() !== nowDate.getFullYear()
      ? { year: "numeric", month: "short", day: "numeric" }
      : { month: "short", day: "numeric" };
  return unlockDate.toLocaleDateString(undefined, options);
};

const txBaseUrl = (chainId?: number) =>
  chainId === 84532 ? "https://sepolia.basescan.org/tx/" :
  chainId === 8453  ? "https://basescan.org/tx/" :
                      "https://etherscan.io/tx/";

const calculateVeNFTRewards = (nft: any) => {
  if (!nft?.locked) return { iAero: '0', liq: '0' };
  const locked = parseFloat(nft.locked);
  const iAeroAmount = locked * 0.95; // 95% after fee
  const liqAmount = locked * 0.95; // Assuming 1:1 LIQ ratio (adjust based on actual emission rate)
  return {
    iAero: iAeroAmount.toFixed(2),
    liq: liqAmount.toFixed(2)
  };
};    

export default function LockSection({ showToast, formatNumber }: LockSectionProps) {
  const { connected, networkSupported, balances, allowances, loading, chainId, account } = useProtocol();
  const { switchChain } = useSwitchChain();
  const {
    depositAero,
    calculateLiqRewards,
    checkAeroApproval,
    approveAero,
    getVaultStatus,
    getUserVeNFTs,
    depositVeNFT,
    loading: vaultLoading,
  } = useVault();
  const publicClient = usePublicClient();
  // Tabs: deposit iAERO + LIQ, deposit existing veNFT, add to existing veNFT
  const [lockType, setLockType] = useState<"deposit" | "depositNFT">("deposit");

  // Deposit AERO state
  const [depositAmount, setDepositAmount] = useState("");
  const [expectedLiq, setExpectedLiq] = useState("0");

  // Deposit veNFT state - NEW: dedicated tokenId state
  const [veNFTTokenId, setVeNFTTokenId] = useState("");

  // Add to existing state
  const [selectedNFT, setSelectedNFT] = useState<number | null>(null);
  const [addAmount, setAddAmount] = useState("");

  // Common
  const [needsApproval, setNeedsApproval] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressStep, setProgressStep] = useState("");
  const [userVeNFTs, setUserVeNFTs] = useState<any[]>([]);
  const [maxWeeks, setMaxWeeks] = useState<number>(208);

  // UX extras
  const [txHistory, setTxHistory] = useState<TxHistory[]>([]);
  const [showSuccess, setShowSuccess] = useState(false);

  const latestApprovalCheck = useRef(0);
  const latestRewardCalc = useRef(0);

  // Debounced values
  const debouncedDepositAmount = useDebounce(depositAmount, 300);
  const debouncedAddAmount = useDebounce(addAmount, 300);

  // BigNumbers
  const aeroBN = parseInputToBigNumber(balances.aero);
  const depositAmountBN = parseInputToBigNumber(depositAmount);
  const addAmountBN = parseInputToBigNumber(addAmount);
  const allowanceBN = parseInputToBigNumber(allowances.aeroToVault);

  // Validation errors
  const getAmountError = (amount: string, balance: bigint): string | null => {
    if (!amount) return null;
    const amountBN = parseInputToBigNumber(amount);
    if (amountBN === 0n) return null;
    if (amountBN < MIN_LOCK_AMOUNT) return "Minimum 0.01 AERO";
    if (amountBN > balance) return "Insufficient balance";
    return null;
  };
  const depositError = getAmountError(depositAmount, aeroBN);
  const addError = getAmountError(addAmount, aeroBN);

  const allowanceLoading = Boolean((loading as any)?.allowances ?? (loading as any)?.balances ?? false);

  const verifyVaultReceived = async (type: 'AERO' | 'veNFT', tokenId?: number) => {
    if (!publicClient || !chainId) return false;
    
    try {
      const vaultAddress = getContractAddress('PermalockVault', chainId);
      
      if (type === 'AERO') {
        const aeroAddress = getContractAddress('AERO', chainId);
        const vaultAeroBalance = await publicClient.readContract({
          address: aeroAddress,
          abi: ABIS.AERO,
          functionName: 'balanceOf',
          args: [vaultAddress],
        }) as bigint;
        
        console.log('Vault AERO balance:', formatBigNumber(vaultAeroBalance));
        return vaultAeroBalance > 0n;
      } else if (type === 'veNFT' && tokenId) {
        const veAddress = getContractAddress('VeAERO', chainId) || getContractAddress('MockVeAERO', chainId);
        if (!veAddress) return false;
        
        const owner = await publicClient.readContract({
          address: veAddress,
          abi: ABIS.VeAERO,
          functionName: 'ownerOf',
          args: [BigInt(tokenId)],
        }) as string;
        
        console.log(`veNFT #${tokenId} owner:`, owner);
        const isVaultOwner = owner.toLowerCase() === vaultAddress.toLowerCase();
        
        if (isVaultOwner) {
          showToast(`✅ Verified: Vault received veNFT #${tokenId}`, 'success');
        } else {
          showToast(`⚠️ Warning: veNFT #${tokenId} not found in vault`, 'warning');
        }
        return isVaultOwner;
      }
      return false;
    } catch (error) {
      console.error('Verification failed:', error);
      return false;
    }
  };
  // Current selected NFT
  const currentNft = useMemo(() => userVeNFTs.find((n) => Number(n.id) === selectedNFT) ?? null, [userVeNFTs, selectedNFT]);

  // Approval badge
  const ApprovalBadge = () => {
    const hasAmount =
      (lockType === "deposit" && depositAmountBN > 0n);
    if (hasAmount && !needsApproval) {
      return <Badge className="border-green-500/30 text-green-400 bg-green-500/10">✓ Approved</Badge>;
    }
    if (needsApproval) {
      return <Badge className="border-yellow-500/30 text-yellow-400 bg-yellow-500/10">Approval Required</Badge>;
    }
    return null;
  };

  // Keyboard shortcuts with fresh refs
  const submitRef = useRef<() => void>(() => {});
  const clearRef = useRef<() => void>(() => {});
  useEffect(() => {
    submitRef.current = () => {
      if (isPrimaryDisabled()) return;
      if (lockType === "deposit") handleDepositAero();
      else if (lockType === "depositNFT") handleDepositVeNFT();
    };
    clearRef.current = () => {
      setDepositAmount("");
      setVeNFTTokenId("");
      setAddAmount("");
    };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitRef.current();
      if (e.key === "Escape") clearRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Init: vault status + user veNFTs
  useEffect(() => {
    if (!connected || !networkSupported) return;
    (async () => {
      try {
        const [status, nfts] = await Promise.all([getVaultStatus(), getUserVeNFTs()]);
        if (status?.MAXTIME) setMaxWeeks(Math.max(1, Math.floor(Number(status.MAXTIME) / WEEK)));
        setUserVeNFTs(Array.isArray(nfts) ? nfts : []);
        
        // Auto-select first NFT for both deposit and add tabs
        if (Array.isArray(nfts) && nfts.length > 0) {
          if (selectedNFT == null) setSelectedNFT(Number(nfts[0].id));
          if (!veNFTTokenId) setVeNFTTokenId(nfts[0].id);
        }
      } catch (e) {
        console.error("init load", e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, networkSupported]);

  // Debounced expected LIQ
  useEffect(() => {
    if (!connected || !networkSupported) return;
    const calc = async () => {
      if (!debouncedDepositAmount || parseFloat(debouncedDepositAmount) <= 0) {
        setExpectedLiq("0");
        return;
      }
      const calcId = ++latestRewardCalc.current;
      try {
        const result = await calculateLiqRewards(debouncedDepositAmount);
        if (calcId === latestRewardCalc.current) setExpectedLiq(result.liqToUser);
      } catch (e) {
        console.error("calculateLiqRewards", e);
        if (calcId === latestRewardCalc.current) setExpectedLiq("0");
      }
    };
    calc();
  }, [connected, networkSupported, debouncedDepositAmount, calculateLiqRewards]);

  // Debounced approval check
  useEffect(() => {
    if (!connected || !networkSupported) return;
    const run = async () => {
      let amountToCheck = "0";
      if (lockType === "deposit" && debouncedDepositAmount) amountToCheck = debouncedDepositAmount;
      // Note: depositNFT doesn't need AERO approval
      if (!amountToCheck || parseFloat(amountToCheck) <= 0) {
        setNeedsApproval(false);
        return;
      }
      const checkId = ++latestApprovalCheck.current;
      try {
        const ok = await checkAeroApproval(amountToCheck);
        if (checkId === latestApprovalCheck.current) setNeedsApproval(!ok);
      } catch (e) {
        console.error("checkAeroApproval", e);
        if (checkId === latestApprovalCheck.current) setNeedsApproval(false);
      }
    };
    run();
  }, [connected, networkSupported, lockType, debouncedDepositAmount, debouncedAddAmount, checkAeroApproval]);

  // Reset approval on tab switch
  useEffect(() => { setNeedsApproval(false); }, [lockType]);

  // Inputs
  const handleDepositAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => setDepositAmount(sanitizeDecimalInput(e.target.value));

  // MAX buttons
  const handleMaxDeposit = () => { 
    const buffer = BigInt(1000000000000000); // 0.001 in wei
    const max = aeroBN > buffer ? aeroBN - buffer : 0n; 
    setDepositAmount((Number(max) / 1e18).toString()); 
  };
  
  const handleMaxAdd = () => { 
    const buffer = BigInt(1000000000000000); // 0.001 in wei
    const max = aeroBN > buffer ? aeroBN - buffer : 0n; 
    setAddAmount((Number(max) / 1e18).toString()); 
  };

  // Gas check
  const estimateGasForAction = async (action: "deposit" | "depositNFT") => {
    try {
      if (!publicClient) return true;
      
      // Viem uses different method for gas price
      const gasPrice = await publicClient.getGasPrice();
      const gasLimit = action === "depositNFT" ? 300000n : 150000n;
      const gasCost = gasPrice * gasLimit;
  
      let ethBalanceBN = parseInputToBigNumber(balances?.ethBalance || "0", 18);
      if (!balances?.ethBalance && account) {
        try {
          const onchainBal = await publicClient.getBalance({ address: account as `0x${string}` });
          ethBalanceBN = onchainBal;
        } catch {}
      }
      if (ethBalanceBN < gasCost) {
        showToast(`Insufficient ETH for gas. Need ~${formatBigNumber(gasCost, 18, 4)} ETH`, "warning");
        return false;
      }
      return true;
    } catch (e) {
      console.error("Gas estimation failed:", e);
      return true;
    }
  };

  // Tx history helper
  const addToHistory = (type: TxHistory["type"], amount: string, txHash?: string) => {
    setTxHistory((prev) => [{ type, amount, timestamp: Date.now(), txHash }, ...prev.slice(0, 4)]);
  };

  // Actions
  const handleDepositAero = async () => {
    const validation = validateTokenAmount(depositAmount, aeroBN, 18, MIN_LOCK_AMOUNT);
    if (!validation.valid) return showToast(validation.error || "Invalid amount", "error");
    const hasGas = await estimateGasForAction("deposit"); 
    if (!hasGas) return;

    setIsProcessing(true);
    try {
      if (needsApproval) {
        setProgressStep("Approving AERO spending...");
        await approveAero(depositAmount);
        setNeedsApproval(false);
      }
      setProgressStep("Depositing AERO to vault...");
      await depositAero(
        depositAmount,
        async (receipt: any) => {
          const liqView = expectedLiq; 
          const amtView = depositAmount;
          setDepositAmount(""); 
          setExpectedLiq("0");
          setShowSuccess(true); 
          setTimeout(() => setShowSuccess(false), 2000);
          addToHistory("deposit", amtView, receipt?.transactionHash);
          showToast(`Successfully deposited ${amtView} AERO! You received iAERO and ${liqView} LIQ tokens.`, "success");
          await verifyVaultReceived('AERO');
        },
        (e: any) => showToast(msgFromError(e), "error"),
        setProgressStep
      );
    } catch (e) {
      console.error("handleDepositAero", e);
    } finally {
      setIsProcessing(false); 
      setProgressStep("");
    }
  };

  const handleDepositVeNFT = async () => {
    if (!veNFTTokenId || isNaN(Number(veNFTTokenId))) {
      return showToast("Please enter a valid veNFT ID", "error");
    }
    
    const hasGas = await estimateGasForAction("depositNFT");
    if (!hasGas) return;
  
    setIsProcessing(true);
    try {
      setProgressStep("Depositing veNFT to vault...");
      
      await depositVeNFT(
        veNFTTokenId,
        async (receipt: any) => {
          setVeNFTTokenId("");
          setShowSuccess(true);
          setTimeout(() => setShowSuccess(false), 2000);
          addToHistory("depositNFT", `NFT #${veNFTTokenId}`, receipt?.transactionHash);
          showToast(`Successfully deposited veNFT #${veNFTTokenId}! You received iAERO and LIQ tokens.`, "success");
          await verifyVaultReceived('veNFT', Number(veNFTTokenId));
        },
        (e: any) => showToast(msgFromError(e, "Failed to deposit veNFT"), "error"),
        setProgressStep
      );
    } catch (e: any) {
      const msg = String(e?.message || "");
      if (msg.includes("attached") || msg.includes("votes")) {
        showToast("This veNFT is attached/voting. Reset votes in Aerodrome then try again.", "warning");
      } else if (msg.includes("approve")) {
        showToast("Please approve the vault to manage your veNFT and try again.", "warning");
      } else {
        showToast("Failed to deposit veNFT", "error");
      }
    }
    
  };

  // CTA label + disabled logic
  const getPrimaryCta = () => {
    if (isProcessing) return progressStep || "Processing...";
    if (!connected) return "Connect Wallet";
    if (!networkSupported) return "Switch Network";
    if (lockType === "deposit") {
      if (depositAmountBN === 0n) return "Enter Amount";
      if (depositAmountBN > aeroBN) return "Insufficient Balance";
      if (depositError) return depositError;
      return needsApproval ? "Approve & Deposit" : "Deposit AERO";
    }
    if (lockType === "depositNFT") {
      if (!veNFTTokenId) return "Enter veNFT ID";
      if (isNaN(Number(veNFTTokenId))) return "Invalid Token ID";
      return "Deposit veNFT";
    }
    if (addAmountBN === 0n) return "Enter Amount";
    if (addAmountBN > aeroBN) return "Insufficient Balance";
    if (addError) return addError;
    if (selectedNFT == null) return "Select veNFT";
    return needsApproval ? "Approve & Add" : "Add to Lock";
  };

  const isPrimaryDisabled = () => {
    if (!connected || !networkSupported || isProcessing || vaultLoading) return true;
    if (lockType === "deposit") return depositAmountBN === 0n || depositAmountBN > aeroBN || !!depositError;
    if (lockType === "depositNFT") return !veNFTTokenId || isNaN(Number(veNFTTokenId));
    return addAmountBN === 0n || addAmountBN > aeroBN || selectedNFT == null || !!addError;
  };

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="max-w-2xl mx-auto space-y-6">
      <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
        <CardHeader>
          <CardTitle className="text-white flex items-center space-x-2">
            <Lock className="w-5 h-5" />
            <span>Lock AERO</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <Tabs value={lockType} onValueChange={(v) => setLockType(v as any)}>
            <TabsList className="grid grid-cols-2 w-full">
              <TabsTrigger value="deposit" disabled={isProcessing}>Deposit AERO</TabsTrigger>
              <TabsTrigger value="depositNFT" disabled={isProcessing}>Deposit veNFT</TabsTrigger>
            </TabsList>

            {/* Deposit AERO */}
            <TabsContent value="deposit" className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label className="text-slate-300">Amount to Deposit</Label>
                <div className="relative">
                  <Input
                    type="text"
                    inputMode="decimal"
                    placeholder="0.0"
                    value={depositAmount}
                    onChange={handleDepositAmountChange}
                    className={`bg-slate-900/50 border-slate-600 text-white placeholder-slate-400 pr-16 ${depositError ? "border-red-500/50" : ""}`}
                    disabled={isProcessing}
                  />
                  <Button variant="ghost" size="sm" onClick={handleMaxDeposit} disabled={isProcessing || (loading as any)?.balances} className="absolute right-2 top-1/2 transform -translate-y-1/2 text-indigo-400 hover:text-indigo-300 h-8">MAX</Button>
                </div>
                <div className="flex justify-between text-sm">
                  <span className={depositError ? "text-red-400" : "text-slate-400"}>{depositError || `Balance: ${(loading as any)?.balances ? "Loading..." : formatBigNumber(aeroBN) + " AERO"}`}</span>
                  <ApprovalBadge />
                </div>
              </div>

              <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/30">
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400">You receive (iAERO)</span>
                    <span className="text-white font-medium">
                      {depositAmount ? (parseFloat(depositAmount) * 0.95).toFixed(4) : "0"} iAERO
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400">Bonus LIQ rewards</span>
                    <span className="text-emerald-400 font-medium">{formatNumber(expectedLiq)} LIQ</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-slate-400">Protocol fee</span>
                    <span className="text-slate-400">5%</span>
                  </div>
                </div>
              </div>

              <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
                <div className="flex items-start space-x-3">
                  <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5" />
                  <div>
                    <p className="font-medium text-amber-400">Permanent Lock</p>
                    <p className="text-sm text-slate-300 mt-1">AERO will be permanently locked. Exit liquidity available by trading iAERO.</p>
                  </div>
                </div>
              </div>
            </TabsContent>
            

            {/* Deposit veNFT */}
              <TabsContent value="depositNFT" className="space-y-4 mt-4">
                {userVeNFTs.length > 0 ? (
                  <>
                    <div className="space-y-2">
                      <Label className="text-slate-300">Select veNFT to Deposit</Label>
                      <select 
                        value={veNFTTokenId} 
                        onChange={(e) => setVeNFTTokenId(e.target.value)} 
                        className="w-full px-3 py-2 bg-slate-900/50 border border-slate-600 rounded-lg text-white" 
                        disabled={isProcessing}
                      >
                        <option value="">Select a veNFT...</option>
                        {userVeNFTs.map((nft) => (
                          <option key={nft.id} value={nft.id}>
                            veNFT #{nft.id} - {formatNumber(nft.locked || 0)} AERO locked
                            {nft.isPermanent ? ' (Permanent)' : ` (Expires: ${nft.unlockDate})`}
                          </option>
                        ))}
                      </select>
                      <p className="text-sm text-slate-400">Select the veNFT you want to deposit to the vault</p>
                    </div>

                    {veNFTTokenId && userVeNFTs.find(n => n.id === veNFTTokenId) && (
                      <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/30">
                        <h4 className="text-white font-medium mb-2">veNFT Details</h4>
                        <div className="space-y-2 text-sm">
                          <div className="flex justify-between">
                            <span className="text-slate-400">Token ID</span>
                            <span className="text-white">#{veNFTTokenId}</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400">AERO Locked</span>
                            <span className="text-white">{formatNumber(userVeNFTs.find(n => n.id === veNFTTokenId)?.locked || 0)} AERO</span>
                          </div>
                          <div className="flex justify-between">
                            <span className="text-slate-400">Lock Status</span>
                            <span className={userVeNFTs.find(n => n.id === veNFTTokenId)?.isPermanent ? "text-purple-400" : "text-yellow-400"}>
                              {userVeNFTs.find(n => n.id === veNFTTokenId)?.isPermanent 
                                ? 'Permanently Locked' 
                                : `Expires: ${userVeNFTs.find(n => n.id === veNFTTokenId)?.unlockDate}`}
                            </span>
                          </div>
                          <div className="border-t border-slate-700/50 pt-2 mt-2">
                            <div className="flex justify-between">
                              <span className="text-slate-400">You will receive (iAERO)</span>
                              <span className="text-white font-medium">
                                {calculateVeNFTRewards(userVeNFTs.find(n => n.id === veNFTTokenId)).iAero} iAERO
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Plus LIQ tokens</span>
                              <span className="text-emerald-400 font-medium">
                                {calculateVeNFTRewards(userVeNFTs.find(n => n.id === veNFTTokenId)).liq} LIQ
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-slate-400">Protocol fee</span>
                              <span className="text-slate-400">5%</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4">
                      <div className="flex items-start space-x-3">
                        <AlertTriangle className="w-5 h-5 text-amber-400 mt-0.5" />
                        <div>
                          <p className="font-medium text-amber-400">Permanent Transfer</p>
                          <p className="text-sm text-slate-300 mt-1">
                            Your veNFT will be permanently transferred to the vault. This action cannot be undone.
                          </p>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="text-center py-8 space-y-4">
                    <div className="text-slate-400">
                      <p className="mb-2">No veNFTs found in your wallet.</p>
                      <p className="text-sm">You need to have an existing veNFT to deposit.</p>
                    </div>
                    <div className="bg-slate-900/50 rounded-xl p-4 border border-slate-700/30">
                      <p className="text-xs text-slate-500">
                        veNFTs are created by locking AERO tokens on Aerodrome. 
                        Once you have a veNFT, you can deposit it here to receive liquid iAERO tokens.
                      </p>
                    </div>
                  </div>
                )}
              </TabsContent>
            </Tabs>  

          {/* Primary Action Button */}
          <Button 
            onClick={lockType === "deposit" ? handleDepositAero : handleDepositVeNFT} 
            disabled={isPrimaryDisabled()} 
            className="w-full bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >  
          
            {isProcessing ? (
              <div className="flex items-center justify-center space-x-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>{getPrimaryCta()}</span>
              </div>
            ) : (
              getPrimaryCta()
            )}
          </Button>

          {/* Progress */}
          {isProcessing && (
            <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-4">
              <div className="flex items-center space-x-3 mb-2">
                <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
                <span className="text-blue-400 font-medium">Processing Transaction</span>
              </div>
              <Progress value={progressStep ? 75 : 25} className="mb-2" />
              <p className="text-sm text-slate-300">{progressStep}</p>
            </div>
          )}

          {/* Success animation */}
          <AnimatePresence>
            {showSuccess && (
              <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} className="flex items-center justify-center py-4">
                <div className="bg-emerald-500/20 rounded-full p-4">
                  <CheckCircle className="w-12 h-12 text-emerald-400" />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Keyboard hints */}
          <div className="text-xs text-slate-500 text-center">
            <span>Press </span>
            <kbd className="px-1.5 py-0.5 bg-slate-700 rounded">⌘</kbd>
            <span> + </span>
            <kbd className="px-1.5 py-0.5 bg-slate-700 rounded">Enter</kbd>
            <span> to submit • </span>
            <kbd className="px-1.5 py-0.5 bg-slate-700 rounded">Esc</kbd>
            <span> to clear</span>
          </div>
        </CardContent>
      </Card>

      {/* Network Helper */}
      {connected && !networkSupported && (
        <Card className="bg-amber-500/10 border border-amber-500/20">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-amber-400 font-medium">Wrong Network</p>
                <p className="text-sm text-slate-300 mt-1">Please switch to Base Sepolia to continue</p>
              </div>
              <Button
                onClick={async () => { 
                  try { 
                    switchChain({ chainId: baseSepolia.id });
                  } catch (e) { 
                    console.error(e); 
                    showToast("Network switch failed", "error"); 
                  } 
                }}
                className="bg-amber-600 hover:bg-amber-700"
              >
                Switch to Base Sepolia
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Approval Status */}
      {connected && networkSupported && (
        <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
          <CardHeader>
            <CardTitle className="text-white flex items-center space-x-2 text-lg">
              <CheckCircle className="w-5 h-5" />
              <span>Approval Status</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-slate-400">Current Allowance</span>
                <span className="text-white">{allowanceLoading ? "Loading..." : `${formatBigNumber(allowanceBN)} AERO`}</span>
              </div>
              {needsApproval && <p className="text-sm text-yellow-400">Approval required for this transaction</p>}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Transaction History */}
      {txHistory.length > 0 && (
        <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
          <CardHeader>
            <CardTitle className="text-white flex items-center space-x-2 text-lg">
              <History className="w-5 h-5" />
              <span>Recent Transactions</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {txHistory.map((tx, i) => (
                <div key={i} className="flex justify-between items-center text-sm p-2 bg-slate-900/30 rounded">
                  <div className="flex items-center space-x-3">
                    <div className="w-2 h-2 bg-emerald-400 rounded-full" />
                    <span className="text-slate-400">
                      {tx.type === "deposit" ? "Deposited" : tx.type === "depositNFT" ? "Deposited veNFT" : "Added to Lock"}
                    </span>
                  </div>
                  <div className="flex items-center space-x-3">
                    <span className="text-white font-medium">{tx.amount} {tx.type === "depositNFT" ? "" : "AERO"}</span>
                    {tx.txHash && (
                      <a href={`${txBaseUrl(chainId || 8453)}${tx.txHash}`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">↗</a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </motion.div>
  );
}