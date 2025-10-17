'use client';

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Activity, Server, Network, Trophy, Database, Search } from 'lucide-react';

const API_BASE = process.env.NEXT_PUBLIC_POINTS_API || '';

type Health = {
  ok: boolean;
  name: string;
  chainId: number | null;
  checkpoint: string | number | null; 
  head: string | number | null;      
  lag: number | null;
  targets: string[];
};


type Meta = {
  wallets: number;
  daily: number;
  leaderboard: number;
  claims: number;
  claimers: number;
};

type LbItem = { address: string; points: string };

type WalletInfo = {
  address: string;
  points: string;
  lastBalance: string | number | bigint;
  lastTimestamp: number;
  rank?: number | null;
};

export default function StatusPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [top, setTop] = useState<LbItem[]>([]);
  const [err, setErr] = useState<string | null>(null);

  // wallet lookup state
  const [addrInput, setAddrInput] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [result, setResult] = useState<WalletInfo | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const fetchAll = async () => {
    try {
      setErr(null);

      // /health (required)
      const hRes = await fetch(`${API_BASE}/health`, { cache: 'no-store' });
      if (hRes.ok) {
        const h = (await hRes.json()) as Health;
        setHealth(h);
      } else {
        setHealth(null);
      }

      // /meta (optional)
      try {
        const mRes = await fetch(`${API_BASE}/meta`, { cache: 'no-store' });
        if (mRes.ok) {
          const m = (await mRes.json()) as Meta;
          if (m && typeof m === 'object') setMeta(m);
        }
      } catch {
        /* ignore */
      }

      // /leaderboard
      const lbRes = await fetch(`${API_BASE}/leaderboard?limit=10`, { cache: 'no-store' });
      if (lbRes.ok) {
        const lb = await lbRes.json();
        setTop(Array.isArray(lb) ? lb : []);
      } else {
        setTop([]);
      }
    } catch (e: any) {
      setErr(String(e?.message || e));
    }
  };

  useEffect(() => {
    fetchAll();
    const id = setInterval(fetchAll, 30_000);
    return () => clearInterval(id);
  }, []);

  // numeric derivations
  const head = useMemo(() => {
    try { return BigInt(health?.head != null ? String(health.head) : '0'); }
    catch { return 0n; }
  }, [health]);
  
  const chk = useMemo(() => {
    try { return BigInt(health?.checkpoint != null ? String(health.checkpoint) : '0'); }
    catch { return 0n; }
  }, [health]);
  
  const lag = (health?.lag ?? Number(head - chk)) || 0; // keep this
  


  const progPct = useMemo(() => {
    const L = Number(lag || 0);
    if (!isFinite(L)) return 0;
    if (L <= 0) return 100;
    return Math.max(0, Math.min(100, 100 - (L / 100) * 5));
  }, [lag]);

  // wallet lookup
  const isHexAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
  const fmtTime = (unix: number) => (unix ? new Date(unix * 1000).toLocaleString() : '—');

  const doLookup = async () => {
    setLookupError(null);
    setResult(null);

    const a = addrInput.trim();
    if (!isHexAddress(a)) {
      setLookupError('Enter a valid 0x-address');
      return;
    }
    setLookupLoading(true);
    try {
      const r = await fetch(`${API_BASE}/points/${a.toLowerCase()}`, { cache: 'no-store' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error || `Lookup failed (${r.status})`);
      }
      const data = (await r.json()) as WalletInfo;
      setResult(data);
      // opportunistic refresh
      fetchAll();
    } catch (e: any) {
      setLookupError(String(e?.message || e));
    } finally {
      setLookupLoading(false);
    }
  };

  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') doLookup();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900/20 to-slate-900 p-6 md:p-10">
      <div className="max-w-7xl mx-auto space-y-8">
        <h1 className="text-3xl md:text-4xl font-bold text-white">Points Status</h1>

        {err && (
          <div className="text-red-300 bg-red-900/20 border border-red-700/40 rounded-lg p-3">
            {err}
          </div>
        )}

        {/* TOP: Leaderboard + Wallet Lookup */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Leaderboard (spans 2) */}
          <Card className="bg-slate-800/50 border-slate-700/50 lg:col-span-2">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-white">
                <Trophy className="w-5 h-5" /> Top Leaderboard
              </CardTitle>
            </CardHeader>
            <CardContent>
              {/* Outer keeps horizontal scroll if needed */}
              <div className="overflow-x-auto">
                {/* Inner adds vertical scroll + height cap */}
                <div className="overflow-y-auto max-h-[60vh] lg:max-h-[520px] rounded-md">
                <table className="min-w-full text-left">
                    <thead
                    className="
                        sticky top-0 z-10
                        text-slate-300
                        bg-slate-900/60 backdrop-blur
                        supports-[backdrop-filter]:bg-slate-900/40
                    "
                    >
                    <tr className="border-b border-slate-700/40">
                        <th className="py-2 pr-4">#</th>
                        <th className="py-2 pr-4">Address</th>
                        <th className="py-2 pr-4">Points</th>
                    </tr>
                    </thead>
                    <tbody className="text-slate-200">
                    {top.map((row, i) => (
                        <tr key={row.address} className="border-t border-slate-700/40">
                        <td className="py-2 pr-4">{i + 1}</td>
                        <td className="py-2 pr-4">
                            <span className="font-mono break-all">{row.address}</span>
                        </td>
                        <td className="py-2 pr-4">{row.points}</td>
                        </tr>
                    ))}
                    {top.length === 0 && (
                        <tr className="border-t border-slate-700/40">
                        <td colSpan={3} className="py-4 text-slate-400">
                            No entries yet.
                        </td>
                        </tr>
                    )}
                    </tbody>
                  </table>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Wallet Lookup */}
          <Card className="bg-slate-800/50 border-slate-700/50">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-white">
                <Search className="w-5 h-5" /> Lookup Wallet Points
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col md:flex-row gap-3">
                <input
                  className="flex-1 bg-slate-900/60 border border-slate-700/60 rounded-md px-3 py-2 text-slate-200 outline-none focus:ring-2 focus:ring-indigo-600"
                  placeholder="0xabc... (Base address)"
                  value={addrInput}
                  onChange={(e) => setAddrInput(e.target.value)}
                  onKeyDown={onEnter}
                  spellCheck={false}
                />
                <button
                  onClick={doLookup}
                  disabled={lookupLoading}
                  className="inline-flex items-center justify-center px-4 py-2 rounded-md bg-gradient-to-r from-indigo-600 to-fuchsia-600 text-white disabled:opacity-60"
                >
                  {lookupLoading ? 'Checking…' : 'Go'}
                </button>
              </div>

              {lookupError && (
                <div className="text-red-300 bg-red-900/20 border border-red-700/40 rounded-md px-3 py-2">
                  {lookupError}
                </div>
              )}

              {result && (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left">
                    <thead className="text-slate-400">
                      <tr>
                        <th className="py-2 pr-4">Rank</th> 
                        <th className="py-2 pr-4">Address</th>
                        <th className="py-2 pr-4">Points</th>
                        <th className="py-2 pr-4">Last Balance (wei)</th>
                        <th className="py-2 pr-4">Last Timestamp</th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-200">
                      <tr className="border-t border-slate-700/40">
                        <td className="py-2 pr-4">
                          {result.rank != null ? `#${result.rank}` : '—'}
                        </td>
                        <td className="py-2 pr-4">
                          <span className="font-mono break-all">{result.address}</span>
                        </td>
                        <td className="py-2 pr-4">{result.points}</td>
                        <td className="py-2 pr-4">{String(result.lastBalance)}</td>
                        <td className="py-2 pr-4">{fmtTime(result.lastTimestamp)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* SECONDARY: Chain/Targets + Head/Checkpoint + Sync */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <Card className="bg-slate-800/50 border-slate-700/50">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-white">
                <Network className="w-5 h-5" /> Chain / Targets
              </CardTitle>
            </CardHeader>
            <CardContent className="text-slate-300">
              <div>
                Chain ID:{' '}
                <span className="text-white font-semibold">{health?.chainId ?? '—'}</span>
              </div>
              <div className="mt-2">
                Targets:
                <ul className="mt-1 list-disc ml-5 text-sm">
                  {(health?.targets || []).map((t) => (
                    <li key={t} className="break-all">
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700/50">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-white">
                <Server className="w-5 h-5" /> Head & Checkpoint
              </CardTitle>
            </CardHeader>
            <CardContent className="text-slate-300">
              <div>
                Head: <span className="text-white font-semibold">{health?.head ?? '—'}</span>
              </div>
              <div>
                Checkpoint:{' '}
                <span className="text-white font-semibold">{health?.checkpoint ?? '—'}</span>
              </div>
              <div>
                Lag:{' '}
                <span className="text-white font-semibold">{lag ?? '—'}</span> blocks
              </div>
            </CardContent>
          </Card>

          <Card className="bg-slate-800/50 border-slate-700/50">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-white">
                <Activity className="w-5 h-5" /> Sync Progress
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="w-full h-3 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-3 bg-gradient-to-r from-indigo-500 to-fuchsia-500"
                  style={{ width: `${progPct}%` }}
                />
              </div>
              <div className="mt-3 text-slate-300">
                Estimated {Math.round(progPct)}% synced
              </div>
            </CardContent>
          </Card>
        </div>

        {/* TERTIARY: Table Counts */}
        <div>
          <Card className="bg-slate-800/50 border-slate-700/50">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-white">
                <Database className="w-5 h-5" /> Table Counts
              </CardTitle>
            </CardHeader>
            <CardContent className="text-slate-300">
              {meta ? (
                <ul className="space-y-1">
                  <li>
                    Wallets: <span className="text-white font-semibold">{meta.wallets}</span>
                  </li>
                  <li>
                    Daily: <span className="text-white font-semibold">{meta.daily}</span>
                  </li>
                  <li>
                    Leaderboard:{' '}
                    <span className="text-white font-semibold">{meta.leaderboard}</span>
                  </li>
                  <li>
                    Claims: <span className="text-white font-semibold">{meta.claims}</span>
                  </li>
                  <li>
                    Claimers: <span className="text-white font-semibold">{meta.claimers}</span>
                  </li>
                </ul>
              ) : (
                <div className="text-slate-400">/meta not available — counts hidden</div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
