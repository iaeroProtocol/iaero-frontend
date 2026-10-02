// src/lib/rift/cost.ts
//
// What a Rift order costs against market prices, and how far a price may move before we stop and ask.
// Rift's API takes no minimum output, so this is what the app can do: show the all-in cost (bridge, swap
// and network costs together) before you commit, refuse a quote that got worse than your tolerance
// between the moment you looked and the moment you clicked, and show what was really delivered.
// Pure, with no imports, so `node --test` can run it (tests/rift/).

export type CostLevel = 'low' | 'medium' | 'high';

/** At or above these percentages the cost is shown amber, then red with an explicit confirmation. */
export const COST_MEDIUM_PCT = 1;
export const COST_HIGH_PCT = 3;

export const TOLERANCE_CHOICES = [0.5, 1, 2, 3] as const;
export const DEFAULT_TOLERANCE_PCT = 1;

/** Percent of the input's USD value lost on the way (negative: better than the reference prices). */
export function costVsMarketPct(inputUsd: number, outputUsd: number): number | null {
  if (!(inputUsd > 0) || !(outputUsd > 0) || !Number.isFinite(inputUsd) || !Number.isFinite(outputUsd)) return null;
  return (1 - outputUsd / inputUsd) * 100;
}

export const costLevel = (pct: number): CostLevel => (pct >= COST_HIGH_PCT ? 'high' : pct >= COST_MEDIUM_PCT ? 'medium' : 'low');

/** How much worse (in %) a fresh quote is than the one shown; negative when it improved. */
export function priceDropPct(shownOut: string, freshOut: string): number {
  const shown = Number(shownOut), fresh = Number(freshOut);
  if (!(shown > 0) || !Number.isFinite(fresh)) return 0;
  return (1 - fresh / shown) * 100;
}

/** Delivered against quoted, in %: positive when more iAERO arrived than quoted. */
export function deliveredVsQuotedPct(amountOut: string | null | undefined, estimatedOut: string): number | null {
  const out = Number(amountOut), est = Number(estimatedOut);
  if (!amountOut || !(out > 0) || !(est > 0)) return null;
  return (out / est - 1) * 100;
}

/** "0.8%", "12%", "<0.1%". */
export function formatPct(pct: number): string {
  const a = Math.abs(pct);
  if (a < 0.1) return '<0.1%';
  return `${a >= 10 ? a.toFixed(0) : a.toFixed(1)}%`;
}

/** A cost for display. At or below zero it reads "about 0%": market prices are only accurate to a fraction
 *  of a percent, so "better than market" would be a claim the data cannot make. */
export const costText = (pct: number) => (pct > 0 ? formatPct(pct) : 'about 0%');

// --- iAERO's market price: its Aerodrome pools on Base (iAERO/AERO, iAERO is token0, both 18 decimals) ---

/** AERO per iAERO at a concentrated-liquidity (Slipstream) pool's current price. */
export function clAeroPerIaero(sqrtPriceX96: bigint): number {
  const r = Number(sqrtPriceX96) / 2 ** 96;
  return r * r;
}

/** AERO per iAERO from a classic pool's reserves. */
export const v2AeroPerIaero = (reserveIaero: bigint, reserveAero: bigint): number =>
  reserveIaero > 0n ? Number(reserveAero) / Number(reserveIaero) : 0;

// --- Market prices (DeFiLlama, keyless, allows browser requests) ---

/** DeFiLlama coin id for a Rift asset id: natives by CoinGecko id, ERC-20s by `<chain>:<address>`. */
export function llamaIdOf(asset: string): string | null {
  if (asset === 'bitcoin.btc') return 'coingecko:bitcoin';
  const m = /^(ethereum|arbitrum|base)\.(eth|0x[0-9a-f]{40})$/.exec(asset.toLowerCase());
  if (!m) return null;
  return m[2] === 'eth' ? 'coingecko:ethereum' : `${m[1]}:${m[2]}`;
}

/** Prices over 30 minutes old, or below DeFiLlama's 0.9 confidence, are left out: no number beats a wrong one.
 *  (DeFiLlama refreshes liquid tokens every couple of minutes and thin ones every 10-15.) */
export const PRICE_MAX_AGE_SEC = 1800;

/** USD prices by DeFiLlama id from a /prices/current response. */
export function parseLlamaPrices(json: unknown, nowMs: number): Record<string, number> {
  const coins = (json as { coins?: Record<string, { price?: unknown; timestamp?: unknown; confidence?: unknown }> } | null)?.coins;
  const out: Record<string, number> = {};
  if (!coins || typeof coins !== 'object') return out;
  for (const [id, c] of Object.entries(coins)) {
    const price = Number(c?.price);
    const ts = Number(c?.timestamp);
    if (!(price > 0) || !Number.isFinite(price)) continue;
    if (!(ts > 0) || nowMs / 1000 - ts > PRICE_MAX_AGE_SEC) continue;
    if (c?.confidence !== undefined && !(Number(c.confidence) >= 0.9)) continue;
    out[id] = price;
  }
  return out;
}
