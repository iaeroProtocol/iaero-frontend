// src/lib/rift/names.ts
//
// Rift's "formatted" answers name the tokens on its published list (`arbitrum.usdt0`) instead of giving their
// address. rift-tokens.ts is a snapshot of that list; a name it lacks (a token Rift listed later, or iAERO itself
// if Rift lists it) would make every answer for that token look like the wrong token. Such a name is resolved
// with one "raw" quote for the same request, which answers with canonical ids (`evm:42161.0x…`), and remembered
// in this browser (quote-check.ts). Only a name Rift gave to exactly the address asked for is learned.
// Pure, with no imports, so `node --test` can run it (tests/rift/).

const KEY = 'iaero.rift.names.v1';
const CHAIN_IDS: Readonly<Record<string, number>> = { ethereum: 1, arbitrum: 42161, base: 8453 };
/** A token name on a chain this app pays from or delivers to (not an address, not the native coin). */
const NAME_RE = /^(ethereum|arbitrum|base)\.(?!0x[0-9a-f]{40}$)(?!eth$)[a-z0-9][a-z0-9._-]{0,40}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const chainOf = (asset: string) => asset.slice(0, asset.indexOf('.'));

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

/**
 * Name -> address pairs to learn from a formatted and a raw answer to the same request (`asked`: the source and
 * destination as `<chain>.<id>`), or null when a name can't be tied to exactly the asset asked for: the raw
 * answer is for another asset, or the name is on another chain.
 */
export function namesToLearn(formatted: unknown, raw: unknown, asked: { from: string; to: string }): Record<string, string> | null {
  const f = (formatted && typeof formatted === 'object' ? formatted : {}) as { from?: unknown; to?: unknown };
  const r = (raw && typeof raw === 'object' ? raw : {}) as { from?: unknown; to?: unknown };
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

/** Adds names not known yet; a name once learned is not re-pointed. */
export function rememberNames(pairs: Record<string, string>) {
  const known = learnedNames();
  memo = { ...memo, ...Object.fromEntries(Object.entries(pairs).filter(([k]) => known[k] === undefined)) };
  try { window.localStorage.setItem(KEY, JSON.stringify(learnedNames())); } catch { /* this page only */ }
}
