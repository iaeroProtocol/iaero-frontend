"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { fetchPricesWithCache } from '@/lib/client-prices';

// ---------- Types (KEEP THESE) ----------
export interface TokenPrice {
  usd: number;
  change24h?: number;
  lastUpdated: number;
}

export interface PriceData {
  AERO: TokenPrice;
  iAERO: TokenPrice;
  LIQ: TokenPrice;
  ETH: TokenPrice;
  USDC: TokenPrice;
  [key: string]: TokenPrice | undefined;
}

export interface TokenHolding {
  token: keyof PriceData;
  amount: string | number;
  decimals?: number;
}

export interface PriceContextValue {
  prices: PriceData;
  loading: boolean;
  error: string | null;
  lastUpdate: number | null;
  updateInterval: number;
  setUpdateInterval: (ms: number) => void;
  refreshPrices: () => Promise<void>;
  getPriceInUSD: (token: keyof PriceData, amount: string | number) => number;
  getFormattedPrice: (token: keyof PriceData, decimals?: number) => string;
  getTotalValueUSD: (holdings: TokenHolding[]) => number;
}

// ---------- Defaults ----------
const DEFAULT_UPDATE_INTERVAL = 300000; // 5 minutes

const MOCKS: PriceData = {
  AERO: { usd: 1.1, lastUpdated: Date.now() },
  iAERO: { usd: 1.0, lastUpdated: Date.now() },
  LIQ: { usd: 0.15, lastUpdated: Date.now() },
  ETH: { usd: 4000, lastUpdated: Date.now() },
  USDC: { usd: 1.0, lastUpdated: Date.now() },
};

// ---------- Context ----------
const PriceContext = createContext<PriceContextValue | null>(null);

// ---------- Provider ----------
export function PriceProvider({
  children,
  updateInterval = DEFAULT_UPDATE_INTERVAL,
}: {
  children: React.ReactNode;
  updateInterval?: number;
}) {
  const [prices, setPrices] = useState<PriceData>(MOCKS);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [intervalMs, setIntervalMs] = useState<number>(updateInterval);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mounted = useRef(true);

  const formatUSD = (n: number, decimals = 2) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: decimals,
    }).format(n);

  // NEW: Client-side price fetching
  const refreshPrices = useCallback(async () => {
    if (!mounted.current) return;
    setLoading(true);
    setError(null);
    
    try {
      const data = await fetchPricesWithCache();
      
      if (mounted.current) {
        setPrices({
          AERO: { 
            usd: data.aeroUsd, 
            change24h: data.aeroChange24h,
            lastUpdated: data.updatedAt 
          },
          iAERO: { 
            usd: data.iaeroUsd, 
            lastUpdated: data.updatedAt 
          },
          LIQ: { 
            usd: data.liqUsd, 
            lastUpdated: data.updatedAt 
          },
          ETH: { 
            usd: data.ethUsd, 
            lastUpdated: data.updatedAt 
          },
          USDC: { 
            usd: data.usdcUsd, 
            lastUpdated: data.updatedAt 
          },
        });
        
        setLastUpdate(data.updatedAt);
        setError(null);
      }
    } catch (error: any) {
      console.error('Price fetch failed:', error);
      if (mounted.current) {
        setError('Using cached prices');
        // Keep existing prices on error
      }
    } finally {
      if (mounted.current) {
        setLoading(false);
      }
    }
  }, []);

  // Initial load
  useEffect(() => { 
    refreshPrices(); 
  }, [refreshPrices]);

  // Set up interval
  useEffect(() => {
    if (intervalMs > 0) {
      intervalRef.current = setInterval(refreshPrices, intervalMs);
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }
  }, [intervalMs, refreshPrices]);

  // Pause when tab hidden (KEEP THIS)
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } else if (intervalMs > 0) {
        refreshPrices();
        intervalRef.current = setInterval(refreshPrices, intervalMs);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [intervalMs, refreshPrices]);

  // Cleanup
  useEffect(() => {
    return () => {
      mounted.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  // Helper functions (KEEP THESE)
  const getPriceInUSD = useCallback(
    (token: keyof PriceData, amount: string | number) => {
      const p = prices[token]?.usd ?? 0;
      const q = typeof amount === "number" ? amount : parseFloat(String(amount) || "0");
      return (isFinite(q) ? q : 0) * p;
    },
    [prices]
  );

  const getFormattedPrice = useCallback(
    (token: keyof PriceData, decimals = 2) => {
      const p = prices[token]?.usd ?? 0;
      return formatUSD(p, decimals);
    },
    [prices]
  );

  const getTotalValueUSD = useCallback(
    (holdings: TokenHolding[]) =>
      holdings.reduce((sum, h) => {
        const price = prices[h.token]?.usd ?? 0;
        const qty = typeof h.amount === "number"
          ? h.amount
          : parseFloat(String(h.amount) || "0");
        return sum + (isFinite(qty) ? qty : 0) * price;
      }, 0),
    [prices]
  );

  const value: PriceContextValue = {
    prices,
    loading,
    error,
    lastUpdate,
    updateInterval: intervalMs,
    setUpdateInterval: setIntervalMs,
    refreshPrices,
    getPriceInUSD,
    getFormattedPrice,
    getTotalValueUSD,
  };

  return <PriceContext.Provider value={value}>{children}</PriceContext.Provider>;
}

// ---------- Hooks (KEEP THESE) ----------
export function usePrices() {
  const ctx = useContext(PriceContext);
  if (!ctx) throw new Error("usePrices must be used within a PriceProvider");
  return ctx;
}

export function useTokenPrice(token: keyof PriceData) {
  const { prices } = usePrices();
  return prices[token];
}

export function useTokenValue(
  token: keyof PriceData,
  amount: string | number,
) {
  const { getPriceInUSD } = usePrices();
  return useMemo(() => {
    const q = typeof amount === "number" ? amount : parseFloat(String(amount) || "0");
    return isFinite(q) ? getPriceInUSD(token, q) : 0;
  }, [token, amount, getPriceInUSD]);
}

export function usePortfolioValue(holdings: TokenHolding[]) {
  const { getTotalValueUSD } = usePrices();
  return useMemo(() => getTotalValueUSD(holdings), [holdings, getTotalValueUSD]);
}
