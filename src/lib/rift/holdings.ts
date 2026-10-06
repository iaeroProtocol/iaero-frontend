// src/lib/rift/holdings.ts
//
// What the connected wallet holds on the EVM chains Rift can pay from, valued in USD, so the "Get iAERO"
// picker can list the user's own tokens, largest first. Blockscout (no key) says which tokens the wallet has
// held and prices most of them; the balances themselves are read on-chain, because Blockscout's can be stale
// (on 2026-10-02 it showed 1,402.6 USDC on Base for a wallet holding none, and missed its cbBTC). Tokens
// Blockscout cannot price are looked up on DeFiLlama (also keyless).
// Pure parsing here; the fetching runs server side in /api/rift/holdings.

export type EvmHoldingChain = 'ethereum' | 'arbitrum' | 'base';
export type HoldingChain = EvmHoldingChain | 'hyperliquid';

export interface Holding {
  chain: HoldingChain;
  /** Rift asset id: `<chain>.eth` for ETH, `<chain>.<0xaddress>` (lowercase) for ERC-20s. */
  asset: string;
  symbol: string;
  name: string;
  decimals: number;
  address?: `0x${string}`;
  balanceRaw: string;
  priceUsd: number;
  valueUsd: number;
  /** No price could be had (a price source was down): listed without a value rather than hidden. */
  priceMissing?: boolean;
  icon?: string;
}

/** EVM chains read through Blockscout; HyperCore spot balances come from Hyperliquid's API (hypercore.ts). */
export const HOLDING_CHAINS: { chain: EvmHoldingChain; chainId: 1 | 42161 | 8453; blockscout: string; llama: string }[] = [
  { chain: 'ethereum', chainId: 1, blockscout: 'https://eth.blockscout.com', llama: 'ethereum' },
  { chain: 'arbitrum', chainId: 42161, blockscout: 'https://arbitrum.blockscout.com', llama: 'arbitrum' },
  { chain: 'base', chainId: 8453, blockscout: 'https://base.blockscout.com', llama: 'base' },
];

/** Below this a holding is dust and not worth listing. */
export const MIN_VALUE_USD = 1;

/** Decimals a real token has: an integer from 0 to 36. A token's own decimals() is untrusted and can answer
 *  any number; a huge one would make the string arithmetic below allocate hundreds of megabytes, or throw. */
export const validDecimals = (d: unknown): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 36;

/** Decimals as Blockscout gives them (digits, sometimes a number), or null when missing or odd: `Number('')` and
 *  `Number(null)` are 0, which would size every amount wrongly. */
export function parseDecimals(v: unknown): number | null {
  const d = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,2}$/.test(v) ? Number(v) : NaN;
  return validDecimals(d) ? d : null;
}


/**
 * `calls` read again after a batch of all of them was refused as a whole: in halves, and any half whose every
 * call failed in halves again, down to single calls, so a call that breaks its batch (a token answering with
 * megabytes of data) fails alone. At most `maxReads` reads; a half is read only while `mayRead()` (time is left).
 * A read that throws, or answers for other calls, counts as every call in it failing (`failed`).
 */
export async function splitRead<C, R extends { status: string }>(
  calls: readonly C[], read: (part: readonly C[]) => Promise<readonly R[]>, failed: () => R,
  { maxReads, mayRead }: { maxReads: number; mayRead: () => boolean },
): Promise<R[]> {
  let reads = 0;
  const split = async (part: readonly C[]): Promise<R[]> => {
    if (part.length < 2 || reads + 2 > maxReads || !mayRead()) return part.map(failed);
    reads += 2;
    const mid = Math.ceil(part.length / 2);
    const halves = await Promise.all([part.slice(0, mid), part.slice(mid)].map(async half => {
      let out: readonly R[] = [];
      try { out = await read(half); } catch { /* every call in it failed */ }
      if (out.length !== half.length) out = half.map(failed);
      return out.every(r => r.status === 'failure') ? split(half) : [...out];
    }));
    return halves.flat();
  };
  return split(calls);
}

/** Base units -> number, precise enough for display and sorting; 0 for decimals no real token has. */
export function rawToNumber(raw: string, decimals: number): number {
  if (!/^\d+$/.test(raw) || !validDecimals(decimals)) return 0;
  const s = raw.padStart(decimals + 1, '0');
  return Number(`${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals)}`);
}

interface BlockscoutTokenBalance {
  value?: string;
  token?: {
    address_hash?: string; address?: string; symbol?: string | null; name?: string | null;
    decimals?: string | null; exchange_rate?: string | null; icon_url?: string | null; type?: string; reputation?: string | null;
  };
}

/** A Blockscout field as text, or '' when it is anything else (a damaged row must not throw). */
const text = (v: unknown) => (typeof v === 'string' ? v : '');
/** A Blockscout amount in base units as text ('0' when it is anything else). */
const amountText = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : '0');
/** A Blockscout number given as text or a number, or NaN. */
const numeric = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN);
/** A USD price worth using: finite, positive and below what any token is worth (a broken or hostile source can say
 *  anything, and an infinite value would break the page). 0: unpriced. */
export const usdPrice = (v: unknown) => { const n = numeric(v); return Number.isFinite(n) && n > 0 && n < 1e9 ? n : 0; };
/** A holding's USD value, or 0 when it can't be a real one (an absurd balance: more than all the money there is). */
export const usdValue = (price: number, raw: string, decimals: number) => { const v = price * rawToNumber(raw, decimals); return Number.isFinite(v) && v < 1e15 ? v : 0; };

/** A Blockscout token row's contract address, lowercase ('' when it has none). */
export function tokenRowAddress(row: unknown): string {
  const t = (row as BlockscoutTokenBalance | null)?.token;
  return (text(t?.address_hash) || text(t?.address)).toLowerCase();
}

/** A token list cut short by a failed page, completed from an older one: every fresh row, then the older
 *  rows for tokens the fresh pages did not reach. Balances are read on-chain afterwards, so the list only
 *  decides which tokens are read. */
export function mergeTokenRows(fresh: unknown[], older: unknown[]): unknown[] {
  const have = new Set(fresh.map(tokenRowAddress).filter(Boolean));
  return [...fresh, ...older.filter(row => {
    const address = tokenRowAddress(row);
    return !!address && !have.has(address);
  })];
}

/** ERC-20 balances from Blockscout's /token-balances. Unpriced tokens get priceUsd 0 for now. */
export function parseTokenBalances(chain: HoldingChain, json: unknown, exclude: string[] = []): Holding[] {
  if (!Array.isArray(json)) return [];
  const out: Holding[] = [];
  const seen = new Set<string>();
  for (const row of json as BlockscoutTokenBalance[]) {
    const t = row?.token;
    const address = tokenRowAddress(row);
    if (!t || t.type !== 'ERC-20' || !/^0x[0-9a-f]{40}$/.test(address)) continue;
    if (t.reputation && t.reputation !== 'ok') continue; // flagged as scam
    const decimals = parseDecimals(t.decimals);
    if (decimals === null) continue;
    const balanceRaw = amountText(row.value);
    if (!/^\d+$/.test(balanceRaw) || balanceRaw === '0') continue;
    const asset = `${chain}.${address}`;
    if (exclude.includes(asset) || seen.has(address)) continue;
    seen.add(address);
    const priceUsd = usdPrice(t.exchange_rate);
    const symbol = text(t.symbol).trim() || `${address.slice(0, 6)}…`;
    out.push({
      chain, asset, symbol: symbol.slice(0, 16), name: (text(t.name) || symbol).slice(0, 48), decimals,
      address: address as `0x${string}`, balanceRaw, priceUsd,
      valueUsd: usdValue(priceUsd, balanceRaw, decimals), icon: safeIcon(t.icon_url),
    });
  }
  return out;
}

/** Token icons are shown only from the image hosts Blockscout's metadata uses (CoinGecko, token lists on GitHub): an
 *  icon from anywhere else would tell that host who looks at which token. */
const ICON_HOSTS = new Set(['assets.coingecko.com', 'coin-images.coingecko.com', 'raw.githubusercontent.com']);
export function safeIcon(v: unknown): string | undefined {
  const s = text(v);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && ICON_HOSTS.has(u.hostname) ? u.href : undefined;
  } catch { return undefined; }
}

/** Native ETH from Blockscout's /addresses/{address}. */
export function parseNative(chain: HoldingChain, json: unknown): Holding | null {
  const j = json as { coin_balance?: string | null; exchange_rate?: string | null } | null;
  const balanceRaw = amountText(j?.coin_balance);
  if (!/^\d+$/.test(balanceRaw) || balanceRaw === '0') return null;
  const priceUsd = usdPrice(j?.exchange_rate);
  return {
    chain, asset: `${chain}.eth`, symbol: 'ETH', name: 'Ether', decimals: 18, balanceRaw, priceUsd,
    valueUsd: usdValue(priceUsd, balanceRaw, 18),
  };
}

/** Fill in prices from DeFiLlama prices (cost.ts parseLlamaPrices: recent and confident only), keyed
 *  `<llamaChain>:<address>`. `prefer`: holdings whose price DeFiLlama's replaces (our major tokens: a wrong tiny
 *  price from Blockscout would hide a real balance). */
export function applyLlamaPrices(
  holdings: Holding[], prices: Record<string, number>, llamaChainOf: (c: HoldingChain) => string, prefer: (h: Holding) => boolean = () => false,
): Holding[] {
  return holdings.map(h => {
    if ((h.priceUsd > 0 && !prefer(h)) || !h.address) return h;
    const price = prices[`${llamaChainOf(h.chain)}:${h.address}`];
    const p = usdPrice(price);
    return p > 0 ? { ...h, priceUsd: p, valueUsd: usdValue(p, h.balanceRaw, h.decimals) } : h;
  });
}

/** Holdings worth listing, largest USD value first; those whose price is missing come after, unvalued. */
export const rankHoldings = (all: Holding[]) => rankFinite(all.filter(h => Number.isFinite(h.valueUsd) && Number.isFinite(h.priceUsd)));
const rankFinite = (holdings: Holding[]) => [
  ...holdings.filter(h => !h.priceMissing && h.valueUsd >= MIN_VALUE_USD).sort((a, b) => b.valueUsd - a.valueUsd),
  ...holdings.filter(h => h.priceMissing && h.balanceRaw !== '0').sort((a, b) => a.symbol.localeCompare(b.symbol)),
];

/** Route checks use at most this much of a holding, so a big balance does not fail on liquidity alone. */
export const PROBE_USD = 100;

/** The amount to check with: the balance, capped near $100 so a big holding does not fail on liquidity alone. */
export function probeAmount(h: Pick<Holding, 'balanceRaw' | 'decimals' | 'priceUsd'>): string {
  const balance = BigInt(h.balanceRaw);
  let raw = balance;
  if (Number.isFinite(h.priceUsd) && h.priceUsd > 0) {
    // $100 worth, in base units, with 18 decimals of price precision (a $1e-11 token must not round to $1e-8).
    const scaled = BigInt(Math.round(h.priceUsd * 1e18));
    if (scaled > 0n) {
      const capped = (BigInt(PROBE_USD) * 10n ** BigInt(h.decimals) * 10n ** 18n) / scaled;
      if (capped > 0n && capped < raw) raw = capped;
    }
  }
  const s = raw.toString().padStart(h.decimals + 1, '0');
  const int = s.slice(0, s.length - h.decimals) || '0';
  // At most 18 decimals: the quote API takes no more, and the cut is far below a token's smallest real value.
  const frac = s.slice(s.length - h.decimals).slice(0, 18).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int === '0' ? '0.000000000000000001' : int;
}

// --- On-chain balances ---

/** A token whose balance is worth reading on-chain. */
export interface TokenCandidate {
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  /** USD price if known (Blockscout); 0 to look up later. */
  priceUsd: number;
  icon?: string;
}

/** At most this many tokens Blockscout cannot price are read (and then looked up on DeFiLlama). */
export const MAX_UNPRICED_CANDIDATES = 60;

/**
 * Tokens from Blockscout's /token-balances worth reading on-chain: every priced ERC-20 whatever balance
 * Blockscout shows (it can be stale either way), plus unpriced ones Blockscout shows a balance for (the
 * long tail of airdropped spam, most of which nothing prices), largest first, capped.
 */
export function blockscoutCandidates(
  json: unknown, exclude: string[] = [], onTruncate?: () => void,
  /** Unpriced tokens to read before the others (on Rift's list or ours): airdropped spam must not crowd them out. */
  prefer: (address: string) => boolean = () => false,
): TokenCandidate[] {
  // `/addresses/{a}/tokens` pages ({ items }, sorted by USD value); the older `/token-balances` is an array.
  if (json && !Array.isArray(json) && Array.isArray((json as { items?: unknown }).items)) json = (json as { items: unknown[] }).items;
  if (!Array.isArray(json)) return [];
  const priced: TokenCandidate[] = [];
  const unpriced: { c: TokenCandidate; held: number }[] = [];
  const seen = new Set<string>();
  for (const row of json as BlockscoutTokenBalance[]) {
    const t = row?.token;
    const address = tokenRowAddress(row);
    if (!t || t.type !== 'ERC-20' || !/^0x[0-9a-f]{40}$/.test(address)) continue;
    if (t.reputation && t.reputation !== 'ok') continue;
    if (exclude.some(e => e.endsWith(`.${address}`))) continue;
    const decimals = parseDecimals(t.decimals);
    if (decimals === null) continue;
    if (seen.has(address)) continue; // a balance changing during pagination can appear on two pages
    const symbol = (text(t.symbol).trim() || `${address.slice(0, 6)}…`).slice(0, 16);
    const c: TokenCandidate = {
      address: address as `0x${string}`, symbol, name: (text(t.name) || symbol).slice(0, 48), decimals,
      priceUsd: usdPrice(t.exchange_rate),
      icon: safeIcon(t.icon_url),
    };
    if (c.priceUsd > 0) { priced.push(c); seen.add(address); }
    else {
      const raw = amountText(row.value);
      if (/^\d+$/.test(raw) && raw !== '0') { unpriced.push({ c, held: rawToNumber(raw, decimals) }); seen.add(address); }
    }
  }
  unpriced.sort((a, b) => Number(prefer(b.c.address)) - Number(prefer(a.c.address)) || b.held - a.held);
  if (unpriced.length > MAX_UNPRICED_CANDIDATES) onTruncate?.();
  return [...priced, ...unpriced.slice(0, MAX_UNPRICED_CANDIDATES).map(u => u.c)];
}

/** The first list plus whatever the second adds (by address). */
export function mergeCandidates(first: TokenCandidate[], more: TokenCandidate[]): TokenCandidate[] {
  const seen = new Set(first.map(c => c.address.toLowerCase()));
  return [...first, ...more.filter(c => !seen.has(c.address.toLowerCase()))];
}

/** Holdings from on-chain balances, in candidate order; a failed read (null) or zero balance is dropped. */
export function candidatesToHoldings(chain: HoldingChain, candidates: TokenCandidate[], balances: (bigint | null)[]): Holding[] {
  const out: Holding[] = [];
  candidates.forEach((c, i) => {
    const bal = balances[i];
    if (bal === null || bal === undefined || bal <= 0n) return;
    const balanceRaw = bal.toString();
    out.push({
      chain, asset: `${chain}.${c.address.toLowerCase()}`, symbol: c.symbol, name: c.name, decimals: c.decimals,
      address: c.address.toLowerCase() as `0x${string}`, balanceRaw, priceUsd: c.priceUsd,
      valueUsd: usdValue(c.priceUsd, balanceRaw, c.decimals), icon: c.icon,
    });
  });
  return out;
}

/** Native ETH from an on-chain balance. */
export function nativeHolding(chain: HoldingChain, balance: bigint, priceUsd: number): Holding | null {
  if (balance <= 0n) return null;
  const balanceRaw = balance.toString();
  return { chain, asset: `${chain}.eth`, symbol: 'ETH', name: 'Ether', decimals: 18, balanceRaw, priceUsd, valueUsd: usdValue(priceUsd, balanceRaw, 18) };
}
