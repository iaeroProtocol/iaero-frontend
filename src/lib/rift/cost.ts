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

/** Below this the "cost" says the market prices disagree with Rift's quote, not that the route is better. */
export const COST_DISAGREE_PCT = -2;

export type CostCheck =
  | { kind: 'ok'; pct: number; level: CostLevel }
  | { kind: 'unknown' }        // no market price to compare with
  | { kind: 'disagree'; pct: number }; // market prices and the quote are too far apart to trust either

/**
 * The cost to show, and whether it needs the user's confirmation. An expected output of zero or less (the
 * gas charge exceeds the order) is a 100% cost; an unknown cost or prices that disagree also need a tick,
 * since then there is nothing to warn with.
 */
export function assessCost(usdIn: number | null, usdOut: number | null): CostCheck {
  if (usdIn === null || !(usdIn > 0) || usdOut === null || !Number.isFinite(usdOut)) return { kind: 'unknown' };
  if (usdOut <= 0) return { kind: 'ok', pct: 100, level: 'high' };
  const pct = (1 - usdOut / usdIn) * 100;
  if (pct < COST_DISAGREE_PCT) return { kind: 'disagree', pct };
  return { kind: 'ok', pct, level: costLevel(pct) };
}

/** Whether a cost found when paying from an order card needs the review Buy would ask for, beyond what was accepted
 *  when the order was made: high now, and more than half a point worse than then (what a tick at Buy covers). */
export function costWorseThanAccepted(nowPct: number, thenPct: number | null): boolean {
  if (costLevel(nowPct) !== 'high') return false;
  return thenPct === null || nowPct > thenPct + 0.5;
}

/** Whether Buy needs the confirmation tick for this cost. */
export const costNeedsTick = (c: CostCheck) => c.kind !== 'ok' || c.level === 'high';

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
  const hyper: Record<string, string> = {
    'hyperliquid.hype': 'coingecko:hyperliquid', 'hyperliquid.usdc': 'coingecko:usd-coin',
    'hyperliquid.btc': 'coingecko:bitcoin', 'hyperliquid.eth': 'coingecko:ethereum',
  };
  if (hyper[asset.toLowerCase()]) return hyper[asset.toLowerCase()];
  const m = /^(ethereum|arbitrum|base)\.(eth|0x[0-9a-f]{40})$/.exec(asset.toLowerCase());
  if (!m) return null;
  return m[2] === 'eth' ? 'coingecko:ethereum' : `${m[1]}:${m[2]}`;
}

/** Prices over 30 minutes old, or below DeFiLlama's 0.9 confidence, are left out: no number beats a wrong one.
 *  (DeFiLlama refreshes liquid tokens every couple of minutes and thin ones every 10-15.) */
export const PRICE_MAX_AGE_SEC = 1800;

/** A price and when DeFiLlama last updated it (seconds). */
export interface LlamaQuote { price: number; ts: number }

/** USD prices with their timestamps by DeFiLlama id from a /prices/current response. `referenceId`: a liquid coin
 *  (ETH) asked for alongside, whose accepted price dates the answer: with this computer's clock running slow, a price
 *  hours old would otherwise pass. (Not one of the others: a single odd entry must not age the rest out. The server,
 *  whose clock is right, passes none.) */
export function parseLlamaQuotes(json: unknown, nowMs: number, referenceId?: string): Record<string, LlamaQuote> {
  const coins = (json as { coins?: Record<string, { price?: unknown; timestamp?: unknown; confidence?: unknown }> } | null)?.coins;
  const out: Record<string, LlamaQuote> = {};
  if (!coins || typeof coins !== 'object') return out;
  const ref = referenceId ? coins[referenceId] : undefined;
  const refTs = Number(ref?.timestamp);
  const refOk = !!ref && Number(ref.price) > 0 && (ref.confidence === undefined || Number(ref.confidence) >= 0.9)
    && Number.isFinite(refTs) && refTs * 1000 <= nowMs + 864e5;
  const nowSec = Math.max(nowMs / 1000, refOk ? refTs : 0);
  for (const [id, c] of Object.entries(coins)) {
    const price = Number(c?.price);
    const ts = Number(c?.timestamp);
    if (!(price > 0) || !Number.isFinite(price)) continue;
    if (!(ts > 0) || nowSec - ts > PRICE_MAX_AGE_SEC) continue;
    if (c?.confidence !== undefined && !(Number(c.confidence) >= 0.9)) continue;
    out[id] = { price, ts };
  }
  return out;
}

/** USD prices by DeFiLlama id from a /prices/current response. */
export function parseLlamaPrices(json: unknown, nowMs: number): Record<string, number> {
  return Object.fromEntries(Object.entries(parseLlamaQuotes(json, nowMs)).map(([id, q]) => [id, q.price]));
}

/** A quote's price if it is still young enough to use at `nowMs` (prices are checked when used, not only
 *  when fetched: a failed refresh keeps the last answer on screen). */
export const freshPrice = (q: LlamaQuote | undefined, nowMs: number): number | undefined =>
  q && nowMs / 1000 - q.ts <= PRICE_MAX_AGE_SEC ? q.price : undefined;

// --- Rift's gas desk ---
// On each EVM chain where a route step runs as `evm_gas_desk`, Rift's gas desk fronts that chain's gas to
// the order's vault and is repaid out of the order, in whatever token the vault holds there. Measured on
// three orders on 2026-10-02: it fronted about 3.5x the gas the vault used and charged all of it (the rest
// stays in the vault), once per chain, and Rift's quote included none of it. On a $14 order from Ethereum
// that was 2.7%. These estimates keep the page's expectation honest; if Rift's quotes start to include the
// charge, delivered-vs-expected comes out about this much high and they should go.

/** Gas the desk fronts on Ethereum, in gas units (its charge over the gas price: 1.2M and 2.0M). */
export const ETHEREUM_GAS_DESK_UNITS = 1_600_000;
/** When Ethereum's gas price can't be read, the "too small" check still assumes at least this (0.5 gwei), so
 *  an order the gas charge would certainly swallow is refused rather than ticked through. */
export const ETHEREUM_GAS_FLOOR_WEI = 500_000_000n;
/** Typical charge per Layer 2 chain, in USD (Arbitrum $0.11; Base $0.03-$0.11, mostly L1 data fees). */
export const L2_GAS_DESK_USD = 0.1;

/** Chains whose steps run on the gas desk; it charges once per chain. */
export const gasDeskChains = (route: { execution?: { mode: string; chain?: number } }[]): number[] =>
  [...new Set(route.flatMap(s => (s.execution?.mode === 'evm_gas_desk' && Number.isSafeInteger(s.execution.chain) && s.execution.chain! > 0 ? [s.execution.chain!] : [])))];

/** The gas desk's expected Ethereum charge in wei (0 when the route doesn't run on Ethereum): an order paid in ETH is
 *  compared with it directly, with no market price needed. */
export const ethereumGasDeskWei = (chains: number[], ethGasPriceWei: bigint): bigint =>
  chains.includes(1) ? ethGasPriceWei * BigInt(ETHEREUM_GAS_DESK_UNITS) : 0n;

/**
 * Whether the gas desk's charge would take the whole order, from what is known, without needing iAERO's price:
 * paid in ETH or WETH (`payWei`), the Ethereum charge against the amount itself; otherwise the charge in USD against
 * the payment's USD value (`payUsd`, when its price and ETH's are known). An unknown Ethereum gas price counts as
 * ETHEREUM_GAS_FLOOR_WEI: an order that would certainly be swallowed is refused, not ticked through.
 */
export function gasSwallows(x: { chains: number[]; gasWei?: bigint; ethUsd?: number; payWei?: bigint; payUsd?: number | null }): boolean {
  // A gas price of zero (a node answering nonsense) counts as unknown.
  const gas = x.gasWei !== undefined && x.gasWei > 0n ? x.gasWei : ETHEREUM_GAS_FLOOR_WEI;
  if (x.payWei !== undefined) {
    // The Layer 2 charges (in USD) too, when ETH's price is known.
    const l2Usd = x.chains.filter(c => c !== 1).length * L2_GAS_DESK_USD;
    const l2Wei = x.ethUsd && x.ethUsd > 0 ? BigInt(Math.ceil((l2Usd / x.ethUsd) * 1e18)) : 0n;
    return x.payWei <= ethereumGasDeskWei(x.chains, gas) + l2Wei;
  }
  const usd = gasDeskUsd(x.chains, gas, x.ethUsd);
  return x.payUsd != null && x.payUsd > 0 && usd !== null && usd > 0 && usd >= x.payUsd;
}

/** Expected gas-desk charge in USD, or null when Ethereum is involved and its gas price or ETH price is unknown. */
export function gasDeskUsd(chains: number[], ethGasPriceWei: bigint | undefined, ethUsd: number | undefined): number | null {
  let usd = 0;
  for (const chain of chains) {
    if (chain !== 1) { usd += L2_GAS_DESK_USD; continue; }
    if (!ethGasPriceWei || !ethUsd) return null;
    usd += (Number(ethGasPriceWei) * ETHEREUM_GAS_DESK_UNITS / 1e18) * ethUsd;
  }
  return usd;
}
