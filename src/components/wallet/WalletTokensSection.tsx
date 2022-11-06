// src/components/wallet/WalletTokensSection.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useWalletTokens } from "@/components/contracts/hooks/useWalletTokens";

export function WalletTokensSection() {
  const { tokens, totals, loading, error, refresh } = useWalletTokens(30000);

  return (
    <Card className="bg-slate-800/50 backdrop-blur-xl border-slate-700/50">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-white">Your Tokens</CardTitle>
        <button onClick={refresh} className="text-sm text-slate-300 hover:underline">
          Refresh
        </button>
      </CardHeader>
      <CardContent>
        {error && <div className="text-red-400 text-sm mb-2">{error}</div>}
        {loading && <div className="text-slate-400 text-sm">Loading…</div>}
        {!loading && tokens.length === 0 && (
          <div className="text-slate-400 text-sm">No ERC‑20 balances found</div>
        )}
        {tokens.length > 0 && (
          <div className="space-y-3">
            <div className="text-slate-300 text-sm">
              Total Value: ${totals.totalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>
            {tokens.map((t) => (
              <div key={t.address} className="flex items-center justify-between bg-slate-900/50 p-3 rounded border border-slate-700/30">
                <div className="flex items-center gap-3">
                  {t.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t.logo} alt="" className="w-6 h-6 rounded" />
                  ) : (
                    <div className="w-6 h-6 rounded bg-slate-700" />
                  )}
                  <div>
                    <div className="text-white font-medium">{t.symbol}</div>
                    <div className="text-slate-400 text-xs">{t.address}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-white">{t.balanceFormatted}</div>
                  <div className="text-slate-400 text-sm">
                    ${t.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                    {t.priceUsd ? (
                      <span className="text-xs text-slate-500">(@ ${t.priceUsd.toFixed(4)})</span>
                    ) : (
                      <span className="text-xs text-slate-500">(no price)</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
