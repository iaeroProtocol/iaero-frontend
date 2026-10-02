// src/lib/rift/hypercore.ts
//
// Hyperliquid's HyperCore spot balances as a way to pay. Rift routes four HyperCore tokens to iAERO: HYPE,
// USDC, UBTC and UETH (not HyperEVM tokens). Paying is not a transaction: the account signs a spot
// transfer (Hyperliquid's EIP-712 "SpotSend", with Arbitrum's chain id in the domain) and posts it to
// Hyperliquid's API, as Rift's docs do. Hyperliquid charges the sender 1 USDC for a transfer to a new
// address, and every Rift deposit address is new, so 1 USDC must stay in the spot balance on top.
// Pure, with no imports, so `node --test` can run it (tests/rift/).

import type { Holding } from './holdings';

export const HL_API = 'https://api.hyperliquid.xyz';
/** Charged by Hyperliquid, in USDC from the spot balance, on every transfer to a Rift deposit address. */
export const HL_NEW_ADDRESS_FEE_USDC = 1;
/** EIP-712 domain chain id for the signature (Arbitrum), as Hyperliquid's own app and Rift's docs use. */
export const HL_SIGNATURE_CHAIN_ID = 42161;

export interface HyperCoreToken {
  /** HyperCore token index (spotMeta). */
  index: number;
  symbol: string;
  name: string;
  /** Rift asset id. */
  asset: string;
  tokenId: string;
  /** HyperCore weiDecimals: the finest amount a transfer takes. */
  decimals: number;
  llamaId: string;
}

// From Hyperliquid's spotMeta and Rift's token list (2026-10-02).
export const HYPERCORE_TOKENS: HyperCoreToken[] = [
  { index: 150, symbol: 'HYPE', name: 'Hyperliquid', asset: 'hyperliquid.hype', tokenId: '0x0d01dc56dcaaca66ad901c959b4011ec', decimals: 8, llamaId: 'coingecko:hyperliquid' },
  { index: 0, symbol: 'USDC', name: 'USD Coin', asset: 'hyperliquid.usdc', tokenId: '0x6d1e7cde53ba9467b783cb7c530ce054', decimals: 8, llamaId: 'coingecko:usd-coin' },
  { index: 197, symbol: 'UBTC', name: 'Unit Bitcoin', asset: 'hyperliquid.btc', tokenId: '0x8f254b963e8468305d409b33aa137c67', decimals: 10, llamaId: 'coingecko:bitcoin' },
  { index: 221, symbol: 'UETH', name: 'Unit Ethereum', asset: 'hyperliquid.eth', tokenId: '0xe1edd30daaf5caac3fe63569e24748da', decimals: 9, llamaId: 'coingecko:ethereum' },
];

export const hyperCoreToken = (asset: string) => HYPERCORE_TOKENS.find(t => t.asset === asset.toLowerCase());

/** The `token` a SpotSend names: "<symbol>:<tokenId>". */
export const spotSendToken = (t: HyperCoreToken) => `${t.symbol}:${t.tokenId}`;

/** "12.5" -> base units at `decimals`, extra digits cut; null if not a plain decimal. */
function decimalToUnits(value: string, decimals: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [int, frac = ''] = value.split('.');
  return BigInt(int) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

const unitsToNumber = (units: bigint, decimals: number) => Number(units) / 10 ** decimals;

/** What Hyperliquid says can leave the account per token index (portfolio-margin accounts), if it says. */
function availableAfterMaintenance(json: unknown): Map<number, string> | null {
  const list = (json as { tokenToAvailableAfterMaintenance?: unknown } | null)?.tokenToAvailableAfterMaintenance;
  if (!Array.isArray(list)) return null;
  const m = new Map<number, string>();
  for (const e of list) if (Array.isArray(e) && typeof e[0] === 'number' && typeof e[1] === 'string') m.set(e[0], e[1]);
  return m;
}

/**
 * Spendable spot balances of the tokens Rift routes, in base units: what the account owns (total minus
 * what open orders hold), and, for portfolio-margin accounts, no more than Hyperliquid says can leave it
 * after maintenance margin. A borrowed (negative) balance is not a holding.
 */
export function parseSpotBalances(json: unknown): { token: HyperCoreToken; availableRaw: bigint }[] {
  const balances = (json as { balances?: unknown } | null)?.balances;
  if (!Array.isArray(balances)) return [];
  const limits = availableAfterMaintenance(json);
  const out: { token: HyperCoreToken; availableRaw: bigint }[] = [];
  for (const b of balances as { coin?: unknown; token?: unknown; total?: unknown; hold?: unknown }[]) {
    const token = HYPERCORE_TOKENS.find(t => t.index === b?.token && t.symbol === b?.coin);
    if (!token) continue;
    const total = decimalToUnits(String(b.total ?? ''), token.decimals);
    const hold = decimalToUnits(String(b.hold ?? '0'), token.decimals) ?? 0n; // negative under portfolio margin: no match, 0
    if (total === null || total <= hold) continue;
    let available = total - hold;
    const limit = limits?.get(token.index);
    if (limit !== undefined) {
      const cap = decimalToUnits(limit, token.decimals);
      if (cap !== null && cap < available) available = cap;
    }
    if (available > 0n) out.push({ token, availableRaw: available });
  }
  return out;
}

/**
 * USDC available for Hyperliquid's 1 USDC new-address fee: under portfolio margin, what Hyperliquid says
 * can leave the account (it may be borrowed against collateral); otherwise the spendable spot USDC.
 */
export function usdcForFee(json: unknown): number {
  const limit = availableAfterMaintenance(json)?.get(0);
  if (limit !== undefined && Number(limit) > 0) return Number(limit);
  const usdc = parseSpotBalances(json).find(b => b.token.symbol === 'USDC');
  return usdc ? Number(usdc.availableRaw) / 10 ** usdc.token.decimals : 0;
}

/** HyperCore balances as picker holdings, priced from DeFiLlama prices by id (cost.ts parseLlamaPrices). A
 *  balance whose price is missing is still listed, unvalued. */
export function hyperCoreHoldings(balances: { token: HyperCoreToken; availableRaw: bigint }[], prices: Record<string, number>): Holding[] {
  return balances.map(({ token, availableRaw }) => {
    const price = prices[token.llamaId];
    const priceUsd = typeof price === 'number' && price > 0 ? price : 0;
    return {
      chain: 'hyperliquid' as const, asset: token.asset, symbol: token.symbol, name: token.name, decimals: token.decimals,
      balanceRaw: availableRaw.toString(), priceUsd, valueUsd: priceUsd * unitsToNumber(availableRaw, token.decimals),
      ...(priceUsd ? {} : { priceMissing: true }),
    };
  });
}

export interface SpotSend { destination: string; token: string; amount: string; time: number }

/** The typed data the wallet signs for a spot transfer. */
export function spotSendTypedData(t: SpotSend) {
  return {
    domain: {
      name: 'HyperliquidSignTransaction', version: '1', chainId: HL_SIGNATURE_CHAIN_ID,
      verifyingContract: '0x0000000000000000000000000000000000000000' as const,
    },
    types: {
      'HyperliquidTransaction:SpotSend': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'destination', type: 'string' },
        { name: 'token', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'time', type: 'uint64' },
      ],
    },
    primaryType: 'HyperliquidTransaction:SpotSend' as const,
    message: { hyperliquidChain: 'Mainnet', destination: t.destination.toLowerCase(), token: t.token, amount: t.amount, time: BigInt(t.time) },
  };
}

/** The /exchange request for a signed spot transfer. */
export function spotSendRequest(t: SpotSend, sig: { r: string; s: string; v: number }) {
  return {
    action: {
      type: 'spotSend', signatureChainId: `0x${HL_SIGNATURE_CHAIN_ID.toString(16)}`, hyperliquidChain: 'Mainnet',
      destination: t.destination.toLowerCase(), token: t.token, amount: t.amount, time: t.time,
    },
    nonce: t.time,
    signature: sig,
  };
}

export type ExchangeOutcome = { kind: 'ok' } | { kind: 'refused'; error: string } | { kind: 'unknown' };

/** Hyperliquid's answer to /exchange. It refuses with HTTP 200 and status "err"; any other answer that is not
 *  "ok" (a gateway's 5xx or 429, with or without JSON) says nothing about whether the transfer went through. */
export function exchangeOutcome(httpOk: boolean, json: unknown): ExchangeOutcome {
  const r = json as { status?: unknown; response?: unknown } | null;
  if (!httpOk || !r || typeof r !== 'object') return { kind: 'unknown' };
  if (r.status === 'ok') return { kind: 'ok' };
  if (r.status === 'err') return { kind: 'refused', error: (typeof r.response === 'string' ? r.response : JSON.stringify(r.response ?? null)).slice(0, 200) };
  return { kind: 'unknown' };
}
