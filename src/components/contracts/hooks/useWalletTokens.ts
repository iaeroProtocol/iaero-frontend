"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useProtocol } from "@/components/contexts/ProtocolContext";

export type WalletToken = {
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
  balanceRaw: string;
  balanceFormatted: string;
  priceUsd: number;
  valueUsd: number;
  logo?: string;
};

export function useWalletTokens(pollMs = 30000) {
  const { account, chainId, networkSupported, connected } = useProtocol();
  const [tokens, setTokens] = useState<WalletToken[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const fetchTokens = useCallback(async () => {
    if (!connected || !networkSupported || !account || !chainId) return;
    setLoading(true);
    setError(null);
    setWarning(null);

    try {
      const res = await fetch(`/api/wallet/${account}/tokens?chainId=${chainId}`, { cache: "no-store" });

      // Always try to read JSON so we can surface warnings or error text
      const json = await res.json().catch(() => ({} as any));

      if (!res.ok) {
        const msg = json?.error ? `HTTP ${res.status} ${json.error}` : `HTTP ${res.status} ${res.statusText}`;
        console.warn("wallet tokens API (server error):", msg);
        setTokens([]);
        setError(msg);
        return;
      }

      setTokens(Array.isArray(json?.tokens) ? json.tokens : []);
      if (json?.warning) {
        console.warn("wallet tokens API warning:", json.warning);
        setWarning(String(json.warning));
      }
    } catch (e: any) {
      console.warn("useWalletTokens: fetch failed:", e?.message || e);
      setTokens([]);
      setError(e?.message || "Failed to load wallet tokens");
    } finally {
      setLoading(false);
    }
  }, [connected, networkSupported, account, chainId]);

  useEffect(() => { fetchTokens(); }, [fetchTokens]);

  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(fetchTokens, pollMs);
    return () => clearInterval(id);
  }, [fetchTokens, pollMs]);

  const totals = useMemo(() => {
    const totalUsd = tokens.reduce((s, t) => s + (t.valueUsd || 0), 0);
    return { totalUsd };
  }, [tokens]);

  return { tokens, totals, loading, error, warning, refresh: fetchTokens };
}
