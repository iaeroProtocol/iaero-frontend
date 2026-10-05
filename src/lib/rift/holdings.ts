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

/** Base units -> number, precise enough for display and sorting. */
export function rawToNumber(raw: string, decimals: number): number {
  if (!/^\d+$/.test(raw)) return 0;
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

/** A Blockscout token row's contract address, lowercase ('' when it has none). */
export function tokenRowAddress(row: unknown): string {
  const t = (row as BlockscoutTokenBalance | null)?.token;
  return String(t?.address_hash ?? t?.address ?? '').toLowerCase();
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
    const decimals = Number(t.decimals ?? '');
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    const balanceRaw = String(row.value ?? '0');
    if (!/^\d+$/.test(balanceRaw) || balanceRaw === '0') continue;
    const asset = `${chain}.${address}`;
    if (exclude.includes(asset) || seen.has(address)) continue;
    seen.add(address);
    const quotedPrice = Number(t.exchange_rate ?? 0);
    const priceUsd = Number.isFinite(quotedPrice) && quotedPrice > 0 ? quotedPrice : 0;
    const symbol = (t.symbol ?? '').trim() || `${address.slice(0, 6)}…`;
    out.push({
      chain, asset, symbol: symbol.slice(0, 16), name: (t.name ?? symbol).slice(0, 48), decimals,
      address: address as `0x${string}`, balanceRaw, priceUsd,
      valueUsd: priceUsd * rawToNumber(balanceRaw, decimals), icon: t.icon_url ?? undefined,
    });
  }
  return out;
}

/** Native ETH from Blockscout's /addresses/{address}. */
export function parseNative(chain: HoldingChain, json: unknown): Holding | null {
  const j = json as { coin_balance?: string | null; exchange_rate?: string | null } | null;
  const balanceRaw = String(j?.coin_balance ?? '0');
  if (!/^\d+$/.test(balanceRaw) || balanceRaw === '0') return null;
  const quotedPrice = Number(j?.exchange_rate ?? 0);
  const priceUsd = Number.isFinite(quotedPrice) && quotedPrice > 0 ? quotedPrice : 0;
  return {
    chain, asset: `${chain}.eth`, symbol: 'ETH', name: 'Ether', decimals: 18, balanceRaw, priceUsd,
    valueUsd: priceUsd * rawToNumber(balanceRaw, 18),
  };
}

/** Fill in prices from DeFiLlama prices (cost.ts parseLlamaPrices: recent and confident only), keyed
 *  `<llamaChain>:<address>`. */
export function applyLlamaPrices(holdings: Holding[], prices: Record<string, number>, llamaChainOf: (c: HoldingChain) => string): Holding[] {
  return holdings.map(h => {
    if (h.priceUsd > 0 || !h.address) return h;
    const price = prices[`${llamaChainOf(h.chain)}:${h.address}`];
    return typeof price === 'number' && price > 0 ? { ...h, priceUsd: price, valueUsd: price * rawToNumber(h.balanceRaw, h.decimals) } : h;
  });
}

/** Holdings worth listing, largest USD value first; those whose price is missing come after, unvalued. */
export const rankHoldings = (holdings: Holding[]) => [
  ...holdings.filter(h => !h.priceMissing && h.valueUsd >= MIN_VALUE_USD).sort((a, b) => b.valueUsd - a.valueUsd),
  ...holdings.filter(h => h.priceMissing && h.balanceRaw !== '0').sort((a, b) => a.symbol.localeCompare(b.symbol)),
];

/** Route checks use at most this much of a holding, so a big balance does not fail on liquidity alone. */
export const PROBE_USD = 100;

/** The amount to check with: the balance, capped near $100 so a big holding does not fail on liquidity alone. */
export function probeAmount(h: Pick<Holding, 'balanceRaw' | 'decimals' | 'priceUsd'>): string {
  const balance = BigInt(h.balanceRaw);
  let raw = balance;
  if (h.priceUsd > 0) {
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
export function blockscoutCandidates(json: unknown, exclude: string[] = [], onTruncate?: () => void): TokenCandidate[] {
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
    const decimals = Number(t.decimals ?? '');
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    if (seen.has(address)) continue; // a balance changing during pagination can appear on two pages
    const symbol = ((t.symbol ?? '').trim() || `${address.slice(0, 6)}…`).slice(0, 16);
    const quotedPrice = Number(t.exchange_rate ?? 0);
    const c: TokenCandidate = {
      address: address as `0x${string}`, symbol, name: (t.name ?? symbol).slice(0, 48), decimals,
      priceUsd: Number.isFinite(quotedPrice) && quotedPrice > 0 ? quotedPrice : 0,
      icon: t.icon_url ?? undefined,
    };
    if (c.priceUsd > 0) { priced.push(c); seen.add(address); }
    else {
      const raw = String(row.value ?? '0');
      if (/^\d+$/.test(raw) && raw !== '0') { unpriced.push({ c, held: rawToNumber(raw, decimals) }); seen.add(address); }
    }
  }
  unpriced.sort((a, b) => b.held - a.held);
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
      valueUsd: c.priceUsd * rawToNumber(balanceRaw, c.decimals), icon: c.icon,
    });
  });
  return out;
}

/** Native ETH from an on-chain balance. */
export function nativeHolding(chain: HoldingChain, balance: bigint, priceUsd: number): Holding | null {
  if (balance <= 0n) return null;
  const balanceRaw = balance.toString();
  return { chain, asset: `${chain}.eth`, symbol: 'ETH', name: 'Ether', decimals: 18, balanceRaw, priceUsd, valueUsd: priceUsd * rawToNumber(balanceRaw, 18) };
}
