// src/lib/rift/names.ts
//
// Rift's "formatted" answers name the tokens on its published list (`arbitrum.usdt0`) instead of giving their
// address. rift-tokens.ts is a snapshot of that list; a name it lacks (a token Rift listed later, or iAERO itself
// if Rift lists it) would make every answer for that token look like the wrong token. Such a name is resolved
// with one "raw" quote for the same request, which answers with canonical ids (`evm:42161.0x…`), and remembered
// in this browser (quote-check.ts). Only a name Rift gave to exactly the address asked for is learned. Rift says
// names "may be reassigned": a known name that stands for another address than the one asked for is resolved
// the same way, and the raw answer re-points it.
// Pure, with no imports, so `node --test` can run it (tests/rift/).

const KEY = 'iaero.rift.names.v1';
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

/** The names in a formatted answer's `from` and `to` that `names` knows, but for another address than the one
 *  asked for (`asked`: source and destination as `<chain>.<id>`): Rift may have reassigned them. */
export function mismatchedNames(answer: unknown, asked: { from: string; to: string }, names: Readonly<Record<string, string>>): string[] {
  const a = (answer && typeof answer === 'object' ? answer : {}) as { from?: unknown; to?: unknown };
  const out: string[] = [];
  for (const [v, want] of [[a.from, asked.from], [a.to, asked.to]] as const) {
    if (typeof v !== 'string') continue;
    const n = v.toLowerCase(), w = want.toLowerCase();
    if (!NAME_RE.test(n) || names[n] === undefined) continue;
    if (`${chainOf(n)}.${names[n]}` !== w) out.push(n);
  }
  return out;
}

/** The names in a formatted answer's `from` and `to` that `names` does not know. */
export function unknownNames(answer: unknown, names: Readonly<Record<string, string>>): string[] {
  const a = (answer && typeof answer === 'object' ? answer : {}) as { from?: unknown; to?: unknown };
  return [a.from, a.to]
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.toLowerCase())
    .filter(v => NAME_RE.test(v) && names[v] === undefined);
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

/** Learned on this page, for when storage is blocked. */
let memo: Record<string, string> = {};

/** Names learned in this browser (checked entry by entry). */
export function learnedNames(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? '{}');
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) if (NAME_RE.test(k) && typeof v === 'string' && ADDRESS_RE.test(v)) out[k] = v;
    }
  } catch { /* storage blocked: this page's own */ }
  return { ...out, ...memo };
}

/** Adds or re-points names. Every pair comes from a raw answer for exactly the asset asked for (namesToLearn),
 *  which is newer than any copy of Rift's list. */
export function rememberNames(pairs: Record<string, string>) {
  memo = { ...memo, ...pairs };
  try { window.localStorage.setItem(KEY, JSON.stringify(learnedNames())); } catch { /* this page only */ }
}
