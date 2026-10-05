// src/lib/rift/names.ts
//
// Rift's "formatted" answers name the tokens on its published list (`arbitrum.usdt0`) instead of giving their
// address. rift-tokens.ts is a snapshot of that list; a name it lacks (a token Rift listed later, or iAERO itself
// if Rift lists it) would make every answer for that token look like the wrong token. Such a name is resolved
// with one "raw" quote for the same request, which answers with canonical ids (`evm:42161.0x…`), and remembered
// in this browser (quote-check.ts). Only a name Rift gave to exactly the address asked for is learned, and only a
// name nobody knows yet: a known name is never re-pointed (a formatted answer naming a known token for another
// address is refused), and Rift's published list always wins. Rift says names "may be reassigned": a learned name
// is forgotten after a week, so a reassignment heals itself, and a reassigned listed name waits for the list to
// be regenerated.
// Pure, with no imports, so `node --test` can run it (tests/rift/).

const KEY = 'iaero.rift.names.v2';
/** A learned name is used this long, then looked up again if Rift still uses it. */
const LEARNED_TTL_MS = 7 * 24 * 3600_000;
const CHAIN_IDS: Readonly<Record<string, number>> = { ethereum: 1, arbitrum: 42161, base: 8453 };
/** A token name on a chain this app pays from or delivers to (not an address, not the native coin). */
const NAME_RE = /^(ethereum|arbitrum|base)\.(?!0x[0-9a-f]{40}$)(?!eth$)[a-z0-9][a-z0-9._-]{0,40}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const chainOf = (asset: string) => asset.slice(0, asset.indexOf('.'));

/** HyperCore spot token index per source asset (spotMeta; the same as hypercore.ts HYPERCORE_TOKENS). */
export const HYPERCORE_SPOT_INDEX: Readonly<Record<string, number>> = {
  'hyperliquid.usdc': 0, 'hyperliquid.hype': 150, 'hyperliquid.btc': 197, 'hyperliquid.eth': 221,
};

/** The raw answer must identify the requested source even when the formatted answer already uses its address,
 *  or a quote for another source could vouch for a destination name. Raw ids seen from Rift (2026-10-05):
 *  `evm:42161.0x…` for a token, `evm:42161.eth` for the native coin, `bitcoin.btc`, and `hyperliquid.spot:0` for
 *  HyperCore USDC. Anything else fails closed. */
function rawSourceMatches(id: unknown, asked: string): boolean {
  if (typeof id !== 'string') return false;
  const raw = id.toLowerCase(), want = asked.toLowerCase();
  if (canonicalToAsset(raw) === want || raw === want) return true;
  const chainId = CHAIN_IDS[chainOf(want)];
  if (chainId && want === `${chainOf(want)}.eth`) return raw === `evm:${chainId}.eth` || raw === `evm:${chainId}.native`;
  const spot = HYPERCORE_SPOT_INDEX[want];
  return spot !== undefined && raw === `hyperliquid.spot:${spot}`;
}

/** `evm:<chainId>.<address>` (a raw answer's id) as `<chain>.<address>`; null for anything else. */
export function canonicalToAsset(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const m = /^evm:(\d+)\.(0x[0-9a-fA-F]{40})$/.exec(id);
  if (!m) return null;
  const chain = Object.keys(CHAIN_IDS).find(k => CHAIN_IDS[k] === Number(m[1]));
  return chain ? `${chain}.${m[2].toLowerCase()}` : null;
}

/** The names in a formatted answer's `from` and `to` that `names` does not know. */
export function unknownNames(answer: unknown, names: Readonly<Record<string, string>>): string[] {
  const a = (answer && typeof answer === 'object' ? answer : {}) as { from?: unknown; to?: unknown };
  return [a.from, a.to]
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.toLowerCase())
    .filter(v => NAME_RE.test(v) && names[v] === undefined);
}

/** What the unknown names in a formatted answer would have to stand for to make it the quote asked for
 *  (`asked`: source and destination as `<chain>.<id>`): each the token asked for in its place, when it is on that
 *  token's chain. If the answer fails even with these, no lookup could make it pass. */
export function guessNames(answer: unknown, asked: { from: string; to: string }, names: Readonly<Record<string, string>>): Record<string, string> {
  const a = (answer && typeof answer === 'object' ? answer : {}) as { from?: unknown; to?: unknown };
  const out: Record<string, string> = {};
  for (const [v, want] of [[a.from, asked.from], [a.to, asked.to]] as const) {
    if (typeof v !== 'string') continue;
    const n = v.toLowerCase(), w = want.toLowerCase(), id = w.slice(w.indexOf('.') + 1);
    if (NAME_RE.test(n) && names[n] === undefined && out[n] === undefined && chainOf(n) === chainOf(w) && ADDRESS_RE.test(id)) out[n] = id;
  }
  return out;
}

/**
 * Name -> address pairs to learn from a formatted and a raw answer to the same request (`asked`: the source and
 * destination as `<chain>.<id>`), or null when a name can't be tied to exactly the asset asked for: the raw
 * answer is for another asset, or the name is on another chain.
 */
export function namesToLearn(formatted: unknown, raw: unknown, asked: { from: string; to: string }): Record<string, string> | null {
  const f = (formatted && typeof formatted === 'object' ? formatted : {}) as { from?: unknown; to?: unknown };
  const r = (raw && typeof raw === 'object' ? raw : {}) as { from?: unknown; to?: unknown };
  if (!rawSourceMatches(r.from, asked.from) || canonicalToAsset(r.to) !== asked.to.toLowerCase()) return null;
  const out: Record<string, string> = {};
  for (const [name, rawId, want] of [[f.from, r.from, asked.from], [f.to, r.to, asked.to]] as const) {
    if (typeof name !== 'string') return null;
    const n = name.toLowerCase(), w = want.toLowerCase();
    if (n === w) continue; // already the asset asked for
    const asset = canonicalToAsset(rawId);
    if (asset !== w || !NAME_RE.test(n) || chainOf(n) !== chainOf(asset)) return null;
    out[n] = asset.slice(asset.indexOf('.') + 1);
  }
  return out;
}

type Learned = Record<string, { a: string; at: number }>;
/** Learned on this page, for when storage is blocked. */
let memo: Learned = {};

/** Learned names still in date, with when they were learned (checked entry by entry). */
function learned(now = Date.now()): Learned {
  const out: Learned = {};
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, { a?: unknown; at?: unknown }>)) {
        if (NAME_RE.test(k) && v && typeof v.a === 'string' && ADDRESS_RE.test(v.a) && typeof v.at === 'number') out[k] = { a: v.a, at: v.at };
      }
    }
  } catch { /* storage blocked: this page's own */ }
  const all = { ...out, ...memo };
  return Object.fromEntries(Object.entries(all).filter(([, v]) => v.at <= now && now - v.at < LEARNED_TTL_MS));
}

/** Names learned in this browser and still in date: name -> address. */
export function learnedNames(now = Date.now()): Record<string, string> {
  return Object.fromEntries(Object.entries(learned(now)).map(([k, v]) => [k, v.a]));
}

/** Adds names nobody knows yet (pairs come from namesToLearn); a name in date is never re-pointed. */
export function rememberNames(pairs: Record<string, string>, now = Date.now()) {
  const known = learned(now);
  const fresh = Object.fromEntries(Object.entries(pairs).filter(([k]) => !known[k]).map(([k, a]) => [k, { a, at: now }]));
  memo = { ...memo, ...fresh };
  try { window.localStorage.setItem(KEY, JSON.stringify({ ...known, ...fresh })); } catch { /* this page only */ }
}
