// =============================
// src/components/protocol/StatsCards.tsx
// =============================
import React from "react";
import { motion } from "framer-motion";
import { Card, CardContent } from "@/components/ui/card";
import { TrendingUp, DollarSign, Lock, Coins, ArrowUpRight, Loader2 } from "lucide-react";
import { usePrices } from '@/components/contexts/PriceContext';

type StatsShape = {
  aeroLocked?: string | number;
  emissionRate?: string | number;
  iAeroSupply?: string | number;
  liqSupply?: string | number;
  // REMOVED totalStaked - this doesn't belong here
};

interface StatsCardsProps {
  stats: StatsShape;
  formatNumber: (value: string | number) => string;
  loading?: boolean;
}

export default function StatsCards({ stats, formatNumber, loading }: StatsCardsProps) {
  // Get prices from context
  const { prices } = usePrices();


  const iAeroPrice = Number(prices?.iAERO?.usd ?? 0);
  const liqPrice = Number(prices?.LIQ?.usd ?? 0);
  const aeroPrice  = Number(prices?.AERO?.usd ?? 0);

  const tvlUSD = Number(stats?.aeroLocked ?? 0) * aeroPrice;

  const liqSupply = Number(stats?.liqSupply ?? 0);
  const liqMcapUSD = liqSupply * (prices.LIQ.usd || 0);


  const cards = [
    {
      title: "Total Value Locked",
      value: `$${formatNumber(tvlUSD)}`,
      subtitle: `veAERO & Protocol Owned Liquidity`,
      icon: DollarSign,
      gradient: "from-emerald-500 to-teal-600",
      loading,
    },
    {
      title: "veAERO Owned By Protocol",
      value: formatNumber(stats?.aeroLocked ?? 0),
      subtitle: `80% of revenue goes to iAero stakers`,
      icon: Lock,
      gradient: "from-blue-500 to-cyan-600",
      loading,
    },
    {
      title: "iAERO Price",
      value: `$${iAeroPrice.toFixed(3)}`,
      subtitle: `Supply: ${formatNumber(stats?.iAeroSupply ?? 0)}`,
      icon: Coins,
      gradient: "from-indigo-500 to-purple-600",
      loading,
    },
    {
      title: "LIQ Market Cap",
      value: `$${formatNumber(liqMcapUSD)}`,
      subtitle: `Circulating: ${formatNumber(liqSupply)} LIQ`,
      icon: TrendingUp,
      gradient: "from-purple-500 to-pink-600",
      loading,
    },
  ] as const;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      {cards.map((card, index) => (
        <motion.div key={card.title} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.1 }}>
          <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50 hover:bg-slate-800/70 transition-all duration-300 group relative overflow-hidden">
            <CardContent className="p-6 relative">
              {/* Background Gradient */}
              <div className={`absolute top-0 right-0 w-20 h-20 bg-gradient-to-br ${card.gradient} opacity-10 rounded-full transform translate-x-6 -translate-y-6 group-hover:scale-110 transition-transform duration-300`} />

              <div className="flex items-start justify-between relative z-10">
                <div className="space-y-2 flex-1">
                  <p className="text-slate-400 text-sm font-medium">{card.title}</p>

                  {card.loading ? (
                    <div className="flex items-center space-x-2">
                      <Loader2 className="w-5 h-5 text-slate-400 animate-spin" />
                      <span className="text-lg font-bold text-slate-400">Loading...</span>
                    </div>
                  ) : (
                    <p className="text-2xl font-bold text-white">{card.value}</p>
                  )}

                  {card.subtitle && !card.loading && (
                    <p className="text-slate-400 text-sm">{card.subtitle}</p>
                  )}
                </div>

                <div className={`w-12 h-12 bg-gradient-to-br ${card.gradient} rounded-xl flex items-center justify-center opacity-80 group-hover:opacity-100 transition-opacity duration-300 ml-4`}>
                  <card.icon className="w-6 h-6 text-white" />
                </div>
              </div>

              {/* Extra metrics */}
              {card.title === "Total Value Locked" && !card.loading && (
                <div className="mt-4 pt-4 border-t border-slate-700/30">
                  <div className="flex justify-between text-xs text-slate-400">
                    <span>Protocol Fee</span>
                    <span>5%</span>
                  </div>
                </div>
              )}

              {card.title === "veAERO Owned By Protocol" && !card.loading && (
                <div className="mt-4 pt-4 border-t border-slate-700/30">
                  <div className="flex justify-between text-xs text-slate-400">
                    <span>Lock Duration</span>
                    <span>Permanent</span>
                  </div>
                </div>
              )}

              {card.title === "iAERO Price" && !card.loading && (
                <div className="mt-4 pt-4 border-t border-slate-700/30">
                  <div className="flex justify-between text-xs text-slate-400">
                    <span>Peg Ratio</span>
                    <span className={`${iAeroPrice / prices.AERO.usd > 0.99 ? "text-emerald-400" : "text-yellow-400"}`}>
                      {((iAeroPrice / prices.AERO.usd) * 100).toFixed(1)}%
                    </span>
                  </div>
                </div>
              )}

              {card.title === "LIQ Market Cap" && !card.loading && (
                <div className="mt-4 pt-4 border-t border-slate-700/30">
                  <div className="flex justify-between text-xs text-slate-400">
                    <span>Price</span>
                    <span>{liqPrice > 0 ? `$${liqPrice.toFixed(3)}` : "—"}</span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      ))}
    </div>
  );
}