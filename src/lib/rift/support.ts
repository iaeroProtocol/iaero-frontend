// src/lib/rift/support.ts
//
// Which of the wallet's tokens Rift can turn into iAERO. Well-known tokens are taken as supported; any
// other token gets one fast quote (about 1.5 s), and the answer is cached in this browser for a day.

'use client';

import { useEffect, useState } from 'react';
import { RiftApiError, fetchQuote } from './client';
import { CURATED_TOKENS } from './config';
import { probeAmount, type Holding } from './holdings';

export type Support = 'supported' | 'unsupported' | 'checking';

const KEY = 'iaero.rift.support.v1';
const OK_TTL_MS = 24 * 3600_000;
const NO_ROUTE_TTL_MS = 6 * 3600_000;
const CONCURRENCY = 3;
const KNOWN = new Set(CURATED_TOKENS.map(t => t.asset.toLowerCase()));

type Cache = Record<string, { ok: boolean; at: number }>;
const load = (): Cache => {
  try { return JSON.parse(window.localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; }
};
const remember = (asset: string, ok: boolean) => {
  try {
    const c = load();
    c[asset] = { ok, at: Date.now() };
    window.localStorage.setItem(KEY, JSON.stringify(c));
  } catch { /* storage blocked: checks simply repeat next time */ }
};

export function useRiftSupport(holdings: Holding[]): Record<string, Support> {
  const [state, setState] = useState<Record<string, Support>>({});
  const key = holdings.map(h => h.asset).join(',');

  useEffect(() => {
    let stop = false;
    const cache = load();
    const now = Date.now();
    const initial: Record<string, Support> = {};
    const queue: Holding[] = [];
    for (const h of holdings) {
      const c = cache[h.asset];
      if (KNOWN.has(h.asset)) initial[h.asset] = 'supported';
      else if (c && now - c.at < (c.ok ? OK_TTL_MS : NO_ROUTE_TTL_MS)) initial[h.asset] = c.ok ? 'supported' : 'unsupported';
      else { initial[h.asset] = 'checking'; queue.push(h); }
    }
    setState(initial);

    const worker = async () => {
      while (!stop && queue.length) {
        const h = queue.shift()!;
        let result: Support;
        try {
          await fetchQuote({ from: h.asset, from_amount: probeAmount(h), quote_mode: 'fast' });
          result = 'supported';
          remember(h.asset, true);
        } catch (e) {
          // Only "no route" and "unknown asset" are answers; anything else (timeouts, outages) is not cached.
          result = 'unsupported';
          if (e instanceof RiftApiError && (e.status === 422 || e.status === 400)) remember(h.asset, false);
        }
        if (!stop) setState(s => ({ ...s, [h.asset]: result }));
      }
    };
    for (let i = 0; i < CONCURRENCY; i++) worker();
    return () => { stop = true; };
    // `key` captures the holdings that matter; the array itself is a new object on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}
