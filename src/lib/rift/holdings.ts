// src/lib/rift/holdings.ts
//
// What the connected wallet holds on the EVM chains Rift can pay from, valued in USD, so the "Get iAERO"
// picker can list the user's own tokens, largest first. Balances and USD rates come from each chain's public
// Blockscout API (no key); tokens Blockscout cannot price are looked up on DeFiLlama (also keyless).
// Pure parsing here; the fetching runs server side in /api/rift/holdings.

export type HoldingChain = 'ethereum' | 'arbitrum' | 'base' | 'hyperliquid';

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
  icon?: string;
}

/** EVM chains read through Blockscout; HyperCore spot balances come from Hyperliquid's API (hypercore.ts). */
export const HOLDING_CHAINS: { chain: HoldingChain; blockscout: string; llama: string }[] = [
  { chain: 'ethereum', blockscout: 'https://eth.blockscout.com', llama: 'ethereum' },
  { chain: 'arbitrum', blockscout: 'https://arbitrum.blockscout.com', llama: 'arbitrum' },
  { chain: 'base', blockscout: 'https://base.blockscout.com', llama: 'base' },
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

/** ERC-20 balances from Blockscout's /token-balances. Unpriced tokens get priceUsd 0 for now. */
export function parseTokenBalances(chain: HoldingChain, json: unknown, exclude: string[] = []): Holding[] {
  if (!Array.isArray(json)) return [];
  const out: Holding[] = [];
  for (const row of json as BlockscoutTokenBalance[]) {
    const t = row?.token;
    const address = (t?.address_hash ?? t?.address ?? '').toLowerCase();
    if (!t || t.type !== 'ERC-20' || !/^0x[0-9a-f]{40}$/.test(address)) continue;
    if (t.reputation && t.reputation !== 'ok') continue; // flagged as scam
    const decimals = Number(t.decimals ?? '');
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) continue;
    const balanceRaw = String(row.value ?? '0');
    if (!/^\d+$/.test(balanceRaw) || balanceRaw === '0') continue;
    const asset = `${chain}.${address}`;
    if (exclude.includes(asset)) continue;
    const priceUsd = Number(t.exchange_rate ?? 0) || 0;
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
  const priceUsd = Number(j?.exchange_rate ?? 0) || 0;
  return {
    chain, asset: `${chain}.eth`, symbol: 'ETH', name: 'Ether', decimals: 18, balanceRaw, priceUsd,
    valueUsd: priceUsd * rawToNumber(balanceRaw, 18),
  };
}

/** Fill in prices from a DeFiLlama /prices/current response keyed `<llamaChain>:<address>`. */
export function applyLlamaPrices(holdings: Holding[], json: unknown, llamaChainOf: (c: HoldingChain) => string): Holding[] {
  const coins = (json as { coins?: Record<string, { price?: number }> } | null)?.coins ?? {};
  return holdings.map(h => {
    if (h.priceUsd > 0 || !h.address) return h;
    const price = coins[`${llamaChainOf(h.chain)}:${h.address}`]?.price;
    return typeof price === 'number' && price > 0 ? { ...h, priceUsd: price, valueUsd: price * rawToNumber(h.balanceRaw, h.decimals) } : h;
  });
}

/** Holdings worth listing, largest USD value first. */
export const rankHoldings = (holdings: Holding[]) =>
  holdings.filter(h => h.valueUsd >= MIN_VALUE_USD).sort((a, b) => b.valueUsd - a.valueUsd);

/** Route checks use at most this much of a holding, so a big balance does not fail on liquidity alone. */
export const PROBE_USD = 100;

/** The amount to check with: the balance, capped near $100 so a big holding does not fail on liquidity alone. */
export function probeAmount(h: Pick<Holding, 'balanceRaw' | 'decimals' | 'priceUsd'>): string {
  const balance = BigInt(h.balanceRaw);
  let raw = balance;
  if (h.priceUsd > 0) {
    // $100 worth, in base units, computed with 8 decimals of price precision.
    const capped = (BigInt(PROBE_USD) * 10n ** BigInt(h.decimals) * 10n ** 8n) / BigInt(Math.max(1, Math.round(h.priceUsd * 1e8)));
    if (capped > 0n && capped < raw) raw = capped;
  }
  const s = raw.toString().padStart(h.decimals + 1, '0');
  const int = s.slice(0, s.length - h.decimals) || '0';
  // At most 18 decimals: the quote API takes no more, and the cut is far below a token's smallest real value.
  const frac = s.slice(s.length - h.decimals).slice(0, 18).replace(/0+$/, '');
  return frac ? `${int}.${frac}` : int === '0' ? '0.000000000000000001' : int;
}
