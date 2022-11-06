"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  BarChart3,
  Lock,
  Coins,
  Gift,
  Zap,
  Users,
  AlertTriangle,
  Wifi,
  WifiOff
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";

import { usePrices } from "@/components/contexts/PriceContext";
import { useProtocol } from "@/components/contexts/ProtocolContext";

// sections
import StatsCards from "@/components/protocol/StatsCards";
import LockSection from "@/components/protocol/LockSection";
import StakeSection from "@/components/protocol/StakeSection";
import RewardsSection from "@/components/protocol/RewardsSection";
import WalletConnection from "@/components/protocol/WalletConnection";
import ToastNotification from "@/components/protocol/ToastNotification";

function DashboardContent() {
  const {
    connected,
    account,
    networkSupported,
    balances,
    stats,
    loading,
    error
  } = useProtocol();

  const { prices } = usePrices();

  // ----- derived prices / figures -----
  const aeroPrice = prices?.AERO?.usd ?? 0;
  const iaeroPrice = prices?.iAERO?.usd ?? 0;
  const liqPrice = prices?.LIQ?.usd ?? 0;

  const pegRatio = (prices as any)?.pegIAEROinAERO ?? (prices as any)?.pegIAERO ?? 0;
  const pegPct = pegRatio > 0 ? pegRatio * 100 : 0;

  const liqSupply = parseFloat(stats?.liqSupply || "0");
  const liqMcap = liqPrice * liqSupply;

  // ----- local UI state -----
  const [activeTab, setActiveTab] = useState<"dashboard" | "lock" | "stake" | "rewards">("dashboard");
  const [toasts, setToasts] = useState<{id:number; message:string; type: 'success' | 'error' | 'info' | 'warning'; show?:boolean}[]>([]);

  const showToast = (message: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type, show: true }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  };

  const formatNumber = (num: string | number) => {
    const n = typeof num === "number" ? num : parseFloat(num || "0");
    if (!isFinite(n)) return "0.00";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(2) + "K";
    return n.toFixed(2);
  };

  const fmtUsd = (n: number, d = 2) =>
    (isFinite(n) ? n : 0).toLocaleString(undefined, {
      minimumFractionDigits: d,
      maximumFractionDigits: d
    });

  // connection banners
  const getConnectionStatus = () => {
    if (!connected) {
      return (
        <Alert className="mb-6 border-blue-500/30 bg-blue-500/10">
          <Wifi className="h-5 w-5 text-blue-400" />
          <AlertDescription className="text-blue-300 text-base">
            Connect your wallet to start using iAERO Protocol
          </AlertDescription>
        </Alert>
      );
    }
    if (!networkSupported) {
      return (
        <Alert className="mb-6 border-red-500/30 bg-red-500/10">
          <WifiOff className="h-5 w-5 text-red-400" />
          <AlertDescription className="text-red-300 text-base">
            Please switch to Base (or Base Sepolia in test) to use the protocol
          </AlertDescription>
        </Alert>
      );
    }
    return null;
  };

  const getErrorAlert = () => {
    if (!error) return null;
    return (
      <Alert className="mb-6 border-red-500/30 bg-red-500/10">
        <AlertTriangle className="h-5 w-5 text-red-400" />
        <AlertDescription className="text-red-300 text-base">
          {error}
        </AlertDescription>
      </Alert>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900/20 to-slate-800">
      {/* Top Nav */}
      <nav className="sticky top-0 z-50 backdrop-blur-xl bg-slate-900/80 border-b border-slate-700/50">
        <div className="w-full px-4 sm:px-6 lg:px-8 xl:px-12 2xl:px-16">
          <div className="flex items-center justify-between h-16">
            <motion.div
              className="flex items-center space-x-3"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
            >
              <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center">
                <Zap className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-3xl font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">
                  iAERO
                </h1>
                <p className="text-sm text-slate-400 -mt-1">Liquid Staking Protocol</p>
              </div>
            </motion.div>

            <div className="hidden md:flex items-center space-x-1">
              {[
                { id: "dashboard", label: "Dashboard", icon: BarChart3 },
                { id: "lock", label: "Lock", icon: Lock },
                { id: "stake", label: "Stake", icon: Coins },
                { id: "rewards", label: "Rewards", icon: Gift }
              ].map((tab) => (
                <Button
                  key={tab.id}
                  variant={activeTab === tab.id ? "default" : "ghost"}
                  onClick={() => setActiveTab(tab.id as any)}
                  className={`flex items-center space-x-2 px-4 py-2 text-base transition-all duration-200 ${
                    activeTab === tab.id
                      ? "bg-gradient-to-r from-indigo-600 to-purple-600 text-white"
                      : "text-slate-300 hover:text-white hover:bg-slate-800/50"
                  }`}
                >
                  <tab.icon className="w-5 h-5" />
                  <span>{tab.label}</span>
                </Button>
              ))}
            </div>

            <WalletConnection />
          </div>
        </div>
      </nav>

      {/* Main */}
      <div className="w-full px-4 sm:px-6 lg:px-8 xl:px-12 2xl:px-16 py-8">
        {getConnectionStatus()}
        {getErrorAlert()}

        <AnimatePresence mode="wait">
          {activeTab === "dashboard" && (
            <motion.div
              key="dashboard"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              {/* Stats cards */}
              <StatsCards
                stats={stats}
                formatNumber={formatNumber}
                loading={loading.stats}
              />

              {/* Portfolio */}
              {connected && networkSupported && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2 }}
                >
                  <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50 w-full max-w-7xl mx-auto">
                    <CardHeader>
                      <CardTitle className="text-white text-xl flex items-center space-x-2">
                        <Users className="w-6 h-6" />
                        <span>Your Portfolio</span>
                        {loading.balances && (
                          <div className="w-4 h-4 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin ml-2" />
                        )}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {/* iAERO */}
                        <div className="bg-slate-900/50 rounded-xl p-6 border border-slate-700/30">
                          <div className="text-slate-400 text-base mb-2">iAERO Balance</div>
                          <div className="text-3xl font-bold text-white">
                            {formatNumber(balances.iAero)}
                          </div>
                          <div className="text-slate-400 text-base mt-2">
                            ≈ ${fmtUsd((parseFloat(balances.iAero || "0") || 0) * iaeroPrice, 2)}
                          </div>
                        </div>

                        {/* LIQ */}
                        <div className="bg-slate-900/50 rounded-xl p-6 border border-slate-700/30">
                          <div className="text-slate-400 text-base mb-2">LIQ Balance</div>
                          <div className="text-3xl font-bold text-white">
                            {formatNumber(balances.liq)}
                          </div>
                          <div className="text-slate-400 text-base mt-2">
                            ≈ ${fmtUsd((parseFloat(balances.liq || "0") || 0) * liqPrice, 2)}
                          </div>
                        </div>

                        {/* Staked iAERO */}
                        <div className="bg-slate-900/50 rounded-xl p-6 border border-slate-700/30">
                          <div className="text-slate-400 text-base mb-2">Staked iAERO</div>
                          <div className="text-3xl font-bold text-white">
                            {formatNumber(balances.stakedIAero)}
                          </div>
                          <div className="text-slate-400 text-base mt-2">
                            Earning rewards
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              )}
            </motion.div>
          )}

          {activeTab === "lock" && (
            <div className="w-full max-w-7xl mx-auto">
              <LockSection key="lock" showToast={showToast} formatNumber={formatNumber} />
            </div>
          )}

          {activeTab === "stake" && (
            <div className="w-full max-w-7xl mx-auto">
              <StakeSection key="stake" showToast={showToast} formatNumber={formatNumber} />
            </div>
          )}

          {activeTab === "rewards" && (
            <div className="w-full max-w-7xl mx-auto">
              <RewardsSection key="rewards" showToast={showToast} formatNumber={formatNumber} />
            </div>
          )}
        </AnimatePresence>
      </div>

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 space-y-2 z-50">
        <AnimatePresence>
          {toasts.map((t) => (
            <ToastNotification key={t.id} toast={t} />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default function Dashboard() {
  return <DashboardContent />;
}