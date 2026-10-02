// src/lib/rift/support.ts
//
// Which of the wallet's tokens Rift can turn into iAERO.
// - Our curated tokens and every token on Rift's published list (rift-tokens.ts) count as supported.
// - Tokens that would arrive short (rebasing or fee-on-transfer) are left out: the order would be
//   underfunded.
// - Any other token gets one fast quote, at the lowest priority of Rift's per-browser budget (client.ts): at
//   most one every 15 s, only while few other calls are being made, never in a hidden tab, and paused for a
//   minute after a rate limit. Small Ethereum balances are not checked: Rift's gas charge there would take
//   most of them.
//
// Only real answers are cached: "no route" for 30 minutes and "unknown asset" for 6 hours. Rift's "could not be
// priced" answer means an outage or no route for this token; a control quote tells which. Outages and rate
// limits are not cached, and a token is asked again a little later. A negative answer from a small check is
// asked again once the holding is worth several times more. The queue and its back-offs live outside the
// component, so a balance refresh does not restart them.

'use client';

import { useEffect, useRef, useState } from 'react';
import { classifyRiftError, fetchQuote, riftBudget, riftPricing } from './client';
import { CURATED_TOKENS } from './config';
import { RIFT_LISTED } from './rift-tokens';
import { probeAmount, PROBE_USD, type Holding } from './holdings';

export type Support = 'supported' | 'unsupported' | 'checking';

const KEY = 'iaero.rift.support.v2';
const OK_TTL_MS = 24 * 3600_000;
const NO_ROUTE_TTL_MS = 30 * 60_000;
const UNSUPPORTED_TTL_MS = 6 * 3600_000;
const RETRY_LATER_MS = 2 * 60_000;
/** Ethereum holdings below this that would need a route check are not offered. */
const MIN_ETHEREUM_CHECK_USD = 25;

/**
 * Tokens whose transfers arrive short of the amount sent, which would leave the order underfunded:
 * stETH and AMPL rebase; Aave V3 deposit tokens (aTokens, on Rift's list) can arrive 1 wei short through
 * their rounding. Withdraw or wrap them first (wstETH is fine).
 */
const ARRIVES_SHORT = new Set([
  'ethereum.0xae7ab96520de3a18e5e111b5eaab095312d7fe84', // stETH
  'ethereum.0xd46ba6d942050d489dbd938a2c909a5d5039a161', // AMPL
  // Aave V3 aTokens on Rift's token list (2026-10-02).
  'arbitrum.0x724dc807b04555b71ed48a6896b6f41593b8c637', 'arbitrum.0x078f358208685046a11c85e8ad32895ded33a249',
  'arbitrum.0x8437d7c167dfb82ed4cb79cd44b7a32a1dd95c77', 'arbitrum.0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8',
  'arbitrum.0x513c7e3a9c69ca3e22550ef58ac1c0088e918fff', 'base.0xbdb9300b7cde636d9cd4aff00f6f009ffbbc8ee6',
  'base.0xcf3d55c10db69f28fd1a75bd73f3d8a2d9c595ad', 'base.0x4e65fe4dba92790696d040ac24aa414708f5c0ab',
  'base.0xd4a0e0b9149bcee3c920d2e00b5de09138fd8bb7', 'ethereum.0xa700b4eb416be35b2911fd5dee80678ff64ff6c9',
  'ethereum.0x5c647ce0ae10658ec44fa4e11a51c96e94efd1dd', 'ethereum.0x018008bfb33d285247a21d44e50697654f754e63',
  'ethereum.0xc035a7cf15375ce2706766804551791ad035e0c2', 'ethereum.0x5e8c8a7243651db1384c0ddfdbe39761e8e7e51a',
  'ethereum.0x927709711794f3de5ddbf1d176bee2d55ba13c21', 'ethereum.0xcc9ee9483f662091a1de4795249e24ac0ac2630f',
  'ethereum.0x4579a27af00a62c0eb156349f31b345c08386419', 'ethereum.0x10ac93971cdb1f5c778144084242374473c350da',
  'ethereum.0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c', 'ethereum.0x4f5923fc5fd4a93352581b38b7cd26943012decf',
  'ethereum.0x23878914efe38d27c4d67ab83ed1b93a74d4086a', 'ethereum.0x5ee5bf7ae06d1be5997a1a72006fe6c607ec6de8',
  'ethereum.0xbdfa7b7893081b35fb54027489e2bc7a38275129', 'ethereum.0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8',
  'ethereum.0x0b925ed163218f6662a35e0f0371ac234f9e9371',
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

/** Asked again no earlier than this (after an outage or an unclear answer), per asset, for this page's life. */
const retryAt = new Map<string, number>();

/** What is known without asking Rift; undefined if a check is needed. */
function knownSupport(h: Holding, cache: Cache, now: number): Support | undefined {
  const asset = h.asset.toLowerCase();
  if (ARRIVES_SHORT.has(asset)) return 'unsupported';
  if (KNOWN.has(asset)) return 'supported';
  const c = cache[asset];
  if (c && now - c.at < c.ttl && (c.ok || checkedUsd(h) < 3 * c.usd)) return c.ok ? 'supported' : 'unsupported';
  if (h.chain === 'ethereum' && h.valueUsd < MIN_ETHEREUM_CHECK_USD) return 'unsupported';
  return undefined;
}

/** Support per holding. Checks run only while `enabled` (the tab is open). */
export function useRiftSupport(holdings: Holding[], enabled = true): Record<string, Support> {
  const [state, setState] = useState<Record<string, Support>>({});
  const holdingsRef = useRef(holdings);
  holdingsRef.current = holdings;
  // The set of tokens, not their values: a refresh that only moves prices changes nothing here (except a small
  // Ethereum holding crossing the size worth checking).
  const key = [...new Set(holdings.map(h => `${h.asset}${h.chain === 'ethereum' && h.valueUsd >= MIN_ETHEREUM_CHECK_USD ? '+' : ''}`))].sort().join(',');

  useEffect(() => {
    let stop = false;
    const sleep = (ms: number) => new Promise<void>(resolve => {
      const end = Date.now() + ms;
      const t = setInterval(() => { if (stop || Date.now() >= end) { clearInterval(t); resolve(); } }, 250);
    });
    const cache = load();
    const now = Date.now();
    const initial: Record<string, Support> = {};
    const queue: string[] = [];
    for (const h of holdingsRef.current) {
      const s = knownSupport(h, cache, now);
      if (s) initial[h.asset] = s;
      else { initial[h.asset] = 'checking'; queue.push(h.asset); }
    }
    setState(initial);
    if (!enabled || !queue.length) return () => { stop = true; };

    const settle = (asset: string, s: Support) => { if (!stop) setState(prev => ({ ...prev, [asset]: s })); };
    (async () => {
      while (!stop && queue.length) {
        // Wait for a turn: a visible tab, a free slot in Rift's budget, and this token's back-off.
        const ready = queue.findIndex(a => (retryAt.get(a) ?? 0) <= Date.now());
        if (ready < 0 || document.hidden || !riftBudget('probe')) { await sleep(2000); continue; }
        const [asset] = queue.splice(ready, 1);
        const h = holdingsRef.current.find(x => x.asset === asset);
        if (!h) continue;
        try {
          await fetchQuote({ from: h.asset, from_amount: probeAmount(h), quote_mode: 'fast' }, undefined, 'probe');
          remember(asset.toLowerCase(), { ok: true, at: Date.now(), ttl: OK_TTL_MS, usd: checkedUsd(h) });
          settle(asset, 'supported');
        } catch (e) {
          let kind = classifyRiftError(e);
          // "Could not be priced": an outage, or no route for this token. Rift pricing other routes says which.
          if (kind === 'unavailable') {
            const up = await riftPricing();
            if (up === true) kind = 'no_route';
          }
          if (kind === 'no_route' || kind === 'unsupported') {
            remember(asset.toLowerCase(), { ok: false, at: Date.now(), ttl: kind === 'no_route' ? NO_ROUTE_TTL_MS : UNSUPPORTED_TTL_MS, usd: checkedUsd(h) });
            settle(asset, 'unsupported');
          } else {
            // Rate limited, down or unreachable: hidden for now, asked again later, nothing cached.
            retryAt.set(asset, Date.now() + RETRY_LATER_MS);
            queue.push(asset);
            settle(asset, 'unsupported');
          }
        }
      }
    })();
    return () => { stop = true; };
    // `key` is the set of tokens; the list itself is read through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return state;
}
