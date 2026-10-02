// src/lib/rift/support.ts
//
// Which of the wallet's tokens Rift can turn into iAERO.
// - Our curated tokens and every token on Rift's published list (rift-tokens.ts) count as supported.
// - Tokens that would arrive short (rebasing or fee-on-transfer) are left out: the order would be
//   underfunded.
// - Any other token gets one fast quote, one at a time with a pause (Rift rate-limits each browser).
//
// Only real answers are cached: "no route" for 30 minutes and "unknown asset" for 6 hours. Outages and rate
// limits are not cached, and checks after an outage try again a little later. A negative answer from a small
// check is asked again once the holding is worth several times more.

'use client';

import { useEffect, useState } from 'react';
import { classifyRiftError, fetchQuote } from './client';
import { CURATED_TOKENS } from './config';
import { RIFT_LISTED } from './rift-tokens';
import { probeAmount, PROBE_USD, type Holding } from './holdings';

export type Support = 'supported' | 'unsupported' | 'checking';

const KEY = 'iaero.rift.support.v2';
const OK_TTL_MS = 24 * 3600_000;
const NO_ROUTE_TTL_MS = 30 * 60_000;
const UNSUPPORTED_TTL_MS = 6 * 3600_000;
const SPACING_MS = 7000;
const RETRY_AFTER_OUTAGE_MS = 2 * 60_000;
const RATE_LIMIT_PAUSE_MS = 60_000;

/** stETH rebases (a transfer arrives 1–2 wei short); AMPL rebases. A short deposit leaves the order underfunded. */
const ARRIVES_SHORT = new Set([
  'ethereum.0xae7ab96520de3a18e5e111b5eaab095312d7fe84', // stETH: use wstETH
  'ethereum.0xd46ba6d942050d489dbd938a2c909a5d5039a161', // AMPL
]);
const KNOWN = new Set([...CURATED_TOKENS.map(t => t.asset.toLowerCase()), ...RIFT_LISTED]);

type Entry = { ok: boolean; at: number; ttl: number; usd: number };
type Cache = Record<string, Entry>;
const load = (): Cache => {
  try { return JSON.parse(window.localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { return {}; }
};
const remember = (asset: string, e: Entry) => {
  try {
    const c = load();
    c[asset] = e;
    window.localStorage.setItem(KEY, JSON.stringify(c));
  } catch { /* storage blocked: checks simply repeat next time */ }
};
const checkedUsd = (h: Holding) => Math.min(h.valueUsd, PROBE_USD);
const sleep = (ms: number, stopped: () => boolean) =>
  new Promise<void>(resolve => { const t = setInterval(() => { if (stopped()) { clearInterval(t); resolve(); } }, 250); setTimeout(() => { clearInterval(t); resolve(); }, ms); });

/** Support per holding. Checks run only while `enabled` (the tab is open). */
export function useRiftSupport(holdings: Holding[], enabled = true): Record<string, Support> {
  const [state, setState] = useState<Record<string, Support>>({});
  const key = holdings.map(h => `${h.asset}:${Math.round(h.valueUsd)}`).join(',');

  useEffect(() => {
    let stop = false;
    const stopped = () => stop;
    const cache = load();
    const now = Date.now();
    const initial: Record<string, Support> = {};
    const queue: Holding[] = [];
    for (const h of holdings) {
      const asset = h.asset.toLowerCase();
      const c = cache[asset];
      if (ARRIVES_SHORT.has(asset)) initial[h.asset] = 'unsupported';
      else if (KNOWN.has(asset)) initial[h.asset] = 'supported';
      else if (c && now - c.at < c.ttl && (c.ok || checkedUsd(h) < 3 * c.usd)) initial[h.asset] = c.ok ? 'supported' : 'unsupported';
      else { initial[h.asset] = 'checking'; queue.push(h); }
    }
    setState(initial);
    if (!enabled || !queue.length) return () => { stop = true; };

    (async () => {
      const later: Holding[] = [];
      while (!stop && queue.length) {
        const h = queue.shift()!;
        try {
          await fetchQuote({ from: h.asset, from_amount: probeAmount(h), quote_mode: 'fast' });
          remember(h.asset.toLowerCase(), { ok: true, at: Date.now(), ttl: OK_TTL_MS, usd: checkedUsd(h) });
          if (!stop) setState(s => ({ ...s, [h.asset]: 'supported' }));
        } catch (e) {
          const kind = classifyRiftError(e);
          if (kind === 'no_route' || kind === 'unsupported') {
            remember(h.asset.toLowerCase(), { ok: false, at: Date.now(), ttl: kind === 'no_route' ? NO_ROUTE_TTL_MS : UNSUPPORTED_TTL_MS, usd: checkedUsd(h) });
            if (!stop) setState(s => ({ ...s, [h.asset]: 'unsupported' }));
          } else if (kind === 'rate_limited') {
            queue.unshift(h);
            await sleep(RATE_LIMIT_PAUSE_MS, stopped);
            continue;
          } else {
            // Rift is down or unreachable: hide for now, ask again later, cache nothing.
            later.push(h);
            if (!stop) setState(s => ({ ...s, [h.asset]: 'unsupported' }));
          }
        }
        if (!queue.length && later.length && !stop) {
          await sleep(RETRY_AFTER_OUTAGE_MS, stopped);
          queue.push(...later.splice(0));
        } else {
          await sleep(SPACING_MS, stopped);
        }
      }
    })();
    return () => { stop = true; };
    // `key` captures the holdings that matter; the array itself is a new object on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return state;
}
