'use client';

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
 Lock, Zap, Gift, Shield, Sparkles, TrendingUp, Coins, Banknote,
 MessageCircle, Twitter, BookOpen
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

// Custom Discord icon component (since Lucide doesn't have Discord)
const DiscordIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0a12.64 12.64 0 0 0-.617-1.25a.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.078.078 0 0 0 .084-.028a14.09 14.09 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13.107 13.107 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10.2 10.2 0 0 0 .372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127a12.299 12.299 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028a19.839 19.839 0 0 0 6.002-3.03a.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418z"/>
  </svg>
);

// Custom X (Twitter) icon component
const XIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
  </svg>
);

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
                 <h1 className="text-xl md:text-2xl font-bold text-white">iAERO Protocol</h1>
                 <p className="text-xs text-slate-400">Liquid Staking on Base</p>
               </div>
             </div>
             
             <nav className="hidden md:flex items-center space-x-6">
               <a 
                 href="https://docs.iaero.finance" 
                 target="_blank" 
                 rel="noopener noreferrer"
                 className="text-slate-300 hover:text-white transition-colors text-sm lg:text-base flex items-center gap-2"
               >
                 <BookOpen className="w-4 h-4" />
                 <span>Docs</span>
               </a>
               <a 
                 href="https://discord.gg/YypP6DG3" 
                 target="_blank" 
                 rel="noopener noreferrer"
                 className="text-slate-300 hover:text-white transition-colors"
                 aria-label="Join our Discord"
               >
                 <DiscordIcon className="w-5 h-5" />
               </a>
               <a 
                 href="https://x.com/iaeroProtocol" 
                 target="_blank" 
                 rel="noopener noreferrer"
                 className="text-slate-300 hover:text-white transition-colors"
                 aria-label="Follow us on X"
               >
                 <XIcon className="w-5 h-5" />
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
         <h2 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white mb-4">
           Unlock Liquidity from Your veAERO
         </h2>
         <p className="text-lg text-slate-300 max-w-3xl mx-auto">
           Deposit veAERO or AERO and receive liquid iAERO tokens plus LIQ rewards. 
           Stake iAERO to earn additional yield from protocol fees.
         </p>
         
         {/* Social Links for Mobile */}
         <div className="flex md:hidden items-center justify-center gap-4 mt-6">
           <a 
             href="https://docs.iaero.finance" 
             target="_blank" 
             rel="noopener noreferrer"
             className="text-slate-300 hover:text-white transition-colors p-2 rounded-lg bg-slate-800/50 backdrop-blur"
             aria-label="Documentation"
           >
             <BookOpen className="w-5 h-5" />
           </a>
           <a 
             href="https://discord.gg/Tb9Z4Jvq" 
             target="_blank" 
             rel="noopener noreferrer"
             className="text-slate-300 hover:text-white transition-colors p-2 rounded-lg bg-slate-800/50 backdrop-blur"
             aria-label="Join our Discord"
           >
             <DiscordIcon className="w-5 h-5" />
           </a>
           <a 
             href="https://x.com/iaeroProtocol" 
             target="_blank" 
             rel="noopener noreferrer"
             className="text-slate-300 hover:text-white transition-colors p-2 rounded-lg bg-slate-800/50 backdrop-blur"
             aria-label="Follow us on X"
           >
             <XIcon className="w-5 h-5" />
           </a>
         </div>
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
           <TabsList className="flex flex-wrap w-full mb-8 gap-1">
            <TabsTrigger value="lock" className="flex-1 min-w-[70px] text-xs px-2 py-1.5">
              <div className="flex flex-col md:flex-row items-center justify-center md:gap-1">
                <Lock className="w-4 h-4 mb-0.5 md:mb-0" />
                <span>Lock</span>
              </div>
            </TabsTrigger>
            <TabsTrigger value="stake" className="flex-1 min-w-[70px] text-xs px-2 py-1.5">
              <div className="flex flex-col md:flex-row items-center justify-center md:gap-1">
                <Zap className="w-4 h-4 mb-0.5 md:mb-0" />
                <span>Stake</span>
              </div>
            </TabsTrigger>
            <TabsTrigger value="rewards" className="flex-1 min-w-[70px] text-xs px-2 py-1.5">
              <div className="flex flex-col md:flex-row items-center justify-center md:gap-1">
                <Gift className="w-4 h-4 mb-0.5 md:mb-0" />
                <span>Rewards</span>
              </div>
            </TabsTrigger>
            <TabsTrigger value="stake-liq" className="flex-1 min-w-[70px] text-xs px-2 py-1.5">
              <div className="flex flex-col md:flex-row items-center justify-center md:gap-1">
                <Coins className="w-4 h-4 mb-0.5 md:mb-0" />
                <span>LIQ</span>
              </div>
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
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mt-12 w-full max-w-7xl mx-auto">
          <Card className="bg-slate-800/30 backdrop-blur border-slate-700/50">
            <CardContent className="p-6">
              <Shield className="w-8 h-8 text-indigo-400 mb-4" />
              <h3 className="text-lg font-semibold text-white mb-2">Secure & Audited</h3>
              <p className="text-sm text-slate-400">
                Smart contracts audited extensively
              </p>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/30 backdrop-blur border-slate-700/50">
            <CardContent className="p-6">
              <TrendingUp className="w-8 h-8 text-emerald-400 mb-4" />
              <h3 className="text-lg font-semibold text-white mb-2">Earn Yield</h3>
              <p className="text-sm text-slate-400">
                Stake iAERO and LIQ to earn veAERO rewards & protocol fees
              </p>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/30 backdrop-blur border-slate-700/50">
            <CardContent className="p-6">
              <Coins className="w-8 h-8 text-purple-400 mb-4" />
              <h3 className="text-lg font-semibold text-white mb-2">Liquid Staking</h3>
              <p className="text-sm text-slate-400">
                Earn veAERO yield on iAero or sell partial or full positions anytime on DEXes
              </p>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/30 backdrop-blur border-slate-700/50">
            <CardContent className="p-6">
              <Banknote className="w-8 h-8 text-yellow-400 mb-4" />
              <h3 className="text-lg font-semibold text-white mb-2">Collateral & Lending</h3>
              <p className="text-sm text-slate-400">
                Use stiAERO as collateral to borrow assets while earning staking rewards
              </p>
            </CardContent>
          </Card>
        </div>

       {/* Footer with Social Links */}
       <footer className="mt-16 py-8 border-t border-slate-800/50">
         <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
           <p className="text-sm text-slate-400">
             © 2024 iAERO Protocol. All rights reserved.
           </p>
           <div className="flex items-center gap-4">
             <a 
               href="https://docs.iaero.finance" 
               target="_blank" 
               rel="noopener noreferrer"
               className="text-slate-400 hover:text-white transition-colors"
             >
               Docs
             </a>
             <a 
               href="https://discord.gg/Tb9Z4Jvq" 
               target="_blank" 
               rel="noopener noreferrer"
               className="text-slate-400 hover:text-white transition-colors"
             >
               Discord
             </a>
             <a 
               href="https://x.com/iaeroProtocol" 
               target="_blank" 
               rel="noopener noreferrer"
               className="text-slate-400 hover:text-white transition-colors"
             >
               X
             </a>
           </div>
         </div>
       </footer>
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
