'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
 Lock, Zap, Gift, Shield, Sparkles, TrendingUp, Coins
} from 'lucide-react';

// Import your real components
import { useProtocol } from '@/components/contexts/ProtocolContext';
import WalletConnection from '@/components/protocol/WalletConnection';
import StatsCards from '@/components/protocol/StatsCards';
import LockSection from '@/components/protocol/LockSection';
import StakeSection from '@/components/protocol/StakeSection';
import LiqStaking from '@/components/protocol/LiqStaking';
import RewardsSection from '@/components/protocol/RewardsSection';
import ToastNotification from '@/components/protocol/ToastNotification';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// Utility function
const formatNumber = (num: string | number) => {
 const n = typeof num === 'string' ? parseFloat(num) : num;
 if (n === 0) return '0';
 if (n < 0.01) return '< 0.01';
 if (n < 1000) return n.toFixed(2);
 if (n < 1000000) return `${(n / 1000).toFixed(1)}K`;
 return `${(n / 1000000).toFixed(2)}M`;
};

// Main App Component (No Provider needed here - it's in layout.tsx)
export default function IaeroProtocolApp() {
 const [toasts, setToasts] = useState<Array<{ id: number; message: string; type: 'success' | 'error' | 'info' | 'warning' }>>([]);
 const { stats, loading } = useProtocol() as any;

 let toastCounter = 0;

  const showToast = (message: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') => {
  const id = Date.now() + (++toastCounter); // This creates a number instead of string
  setToasts(prev => [...prev, { id, message, type }]);
  setTimeout(() => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, 5000);
};

 return (
   <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-900 to-indigo-950">
     {/* Animated Background */}
     <div className="fixed inset-0 overflow-hidden pointer-events-none">
       <div className="absolute -top-40 -right-40 w-80 h-80 bg-purple-500 rounded-full mix-blend-multiply filter blur-3xl opacity-10 animate-blob" />
       <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-indigo-500 rounded-full mix-blend-multiply filter blur-3xl opacity-10 animate-blob animation-delay-2000" />
       <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-cyan-500 rounded-full mix-blend-multiply filter blur-3xl opacity-10 animate-blob animation-delay-4000" />
     </div>

     {/* Header */}
     <header className="relative z-10 border-b border-slate-800/50 backdrop-blur-xl bg-slate-900/50">
       <div className="w-full px-4 sm:px-6 lg:px-8 xl:px-12 2xl:px-16 py-4">
         <div className="flex items-center justify-between">
           <div className="flex items-center space-x-8">
             <div className="flex items-center space-x-3">
               <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl flex items-center justify-center">
                 <Sparkles className="w-6 h-6 text-white" />
               </div>
               <div>
                 <h1 className="text-2xl font-bold text-white">iAERO Protocol</h1>
                 <p className="text-xs text-slate-400">Liquid Staking on Base</p>
               </div>
             </div>
             
             <nav className="hidden md:flex items-center space-x-6">
               <a 
                 href="https://docs.iaero.finance" 
                 target="_blank" 
                 rel="noopener noreferrer"
                 className="text-slate-300 hover:text-white transition-colors text-xl"
               >
                 Docs
               </a>
             </nav>
           </div>
           
           <WalletConnection />
         </div>
       </div>
     </header>

     {/* Main Content */}
     <main className="relative z-10 w-full px-4 sm:px-6 lg:px-8 xl:px-12 2xl:px-16 py-8">
       {/* Hero Section */}
       <motion.div 
         initial={{ opacity: 0, y: 20 }}
         animate={{ opacity: 1, y: 0 }}
         className="text-center mb-12"
       >
         <h2 className="text-4xl md:text-5xl font-bold text-white mb-4">
           Unlock Liquidity from Your AERO
         </h2>
         <p className="text-lg text-slate-300 max-w-3xl mx-auto">
           Lock AERO permanently and receive liquid iAERO tokens plus LIQ rewards. 
           Stake iAERO to earn additional yield from protocol fees.
         </p>
       </motion.div>

       {/* Stats Overview */}
       <div className="mb-12">
         <StatsCards 
           stats={stats} 
           formatNumber={formatNumber}
           loading={loading?.stats}
         />
       </div>

       {/* Main Protocol Interface */}
       <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50 w-full max-w-7xl mx-auto">
         <CardContent className="p-8">
           <Tabs defaultValue="lock" className="w-full">
             <TabsList className="grid grid-cols-4 w-full mb-8">
               <TabsTrigger value="lock">
                 <Lock className="w-4 h-4 mr-2" />
                 Lock AERO
               </TabsTrigger>
               <TabsTrigger value="stake">
                 <Zap className="w-4 h-4 mr-2" />
                 Stake iAERO
               </TabsTrigger>
               <TabsTrigger value="rewards">
                 <Gift className="w-4 h-4 mr-2" />
                 Rewards
               </TabsTrigger>
               <TabsTrigger value="stake-liq">
                 <Coins className="w-4 h-4 mr-2" />
                 Stake LIQ
               </TabsTrigger>
             </TabsList>

             <TabsContent value="lock">
               <LockSection showToast={showToast} formatNumber={formatNumber} />
             </TabsContent>

             <TabsContent value="stake">
               <StakeSection showToast={showToast} formatNumber={formatNumber} />
             </TabsContent>

             <TabsContent value="rewards">
               <RewardsSection showToast={showToast} formatNumber={formatNumber} />
             </TabsContent>

             <TabsContent value="stake-liq">
               <LiqStaking showToast={showToast} formatNumber={formatNumber} />
             </TabsContent>
           </Tabs>
         </CardContent>
       </Card>

       {/* Info Cards */}
       <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12 w-full max-w-7xl mx-auto">
         <Card className="bg-slate-800/30 backdrop-blur border-slate-700/50">
           <CardContent className="p-6">
             <Shield className="w-8 h-8 text-indigo-400 mb-4" />
             <h3 className="text-lg font-semibold text-white mb-2">Secure & Audited</h3>
             <p className="text-sm text-slate-400">
               Smart contracts audited by leading security firms
             </p>
           </CardContent>
         </Card>

         <Card className="bg-slate-800/30 backdrop-blur border-slate-700/50">
           <CardContent className="p-6">
             <TrendingUp className="w-8 h-8 text-emerald-400 mb-4" />
             <h3 className="text-lg font-semibold text-white mb-2">Earn Yield</h3>
             <p className="text-sm text-slate-400">
               Stake iAERO to earn protocol fees and rewards
             </p>
           </CardContent>
         </Card>

         <Card className="bg-slate-800/30 backdrop-blur border-slate-700/50">
           <CardContent className="p-6">
             <Coins className="w-8 h-8 text-purple-400 mb-4" />
             <h3 className="text-lg font-semibold text-white mb-2">Liquid Staking</h3>
             <p className="text-sm text-slate-400">
               Trade iAERO on DEXs while earning staking rewards
             </p>
           </CardContent>
         </Card>
       </div>
     </main>

     {/* Toast Container */}
     <div className="fixed bottom-4 right-4 z-50 space-y-2">
       <AnimatePresence>
         {toasts.map(toast => (
           <ToastNotification key={toast.id} toast={toast} />
         ))}
       </AnimatePresence>
     </div>

     <style jsx>{`
       @keyframes blob {
         0% { transform: translate(0px, 0px) scale(1); }
         33% { transform: translate(30px, -50px) scale(1.1); }
         66% { transform: translate(-20px, 20px) scale(0.9); }
         100% { transform: translate(0px, 0px) scale(1); }
       }
       .animate-blob {
         animation: blob 7s infinite;
       }
       .animation-delay-2000 {
         animation-delay: 2s;
       }
       .animation-delay-4000 {
         animation-delay: 4s;
       }
     `}</style>
   </div>
 );
}