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

/** Spendable spot balances (total minus what open orders hold) of the tokens Rift routes, in base units. */
export function parseSpotBalances(json: unknown): { token: HyperCoreToken; availableRaw: bigint }[] {
  const balances = (json as { balances?: unknown } | null)?.balances;
  if (!Array.isArray(balances)) return [];
  const out: { token: HyperCoreToken; availableRaw: bigint }[] = [];
  for (const b of balances as { coin?: unknown; token?: unknown; total?: unknown; hold?: unknown }[]) {
    const token = HYPERCORE_TOKENS.find(t => t.index === b?.token && t.symbol === b?.coin);
    if (!token) continue;
    const total = decimalToUnits(String(b.total ?? ''), token.decimals);
    const hold = decimalToUnits(String(b.hold ?? '0'), token.decimals) ?? 0n;
    if (total === null || total <= hold) continue;
    out.push({ token, availableRaw: total - hold });
  }
  return out;
}

/** HyperCore balances as picker holdings, priced from a DeFiLlama /prices/current response. */
export function hyperCoreHoldings(balances: { token: HyperCoreToken; availableRaw: bigint }[], llamaJson: unknown): Holding[] {
  const coins = (llamaJson as { coins?: Record<string, { price?: number }> } | null)?.coins ?? {};
  return balances.map(({ token, availableRaw }) => {
    const price = coins[token.llamaId]?.price;
    const priceUsd = typeof price === 'number' && price > 0 ? price : 0;
    return {
      chain: 'hyperliquid' as const, asset: token.asset, symbol: token.symbol, name: token.name, decimals: token.decimals,
      balanceRaw: availableRaw.toString(), priceUsd, valueUsd: priceUsd * unitsToNumber(availableRaw, token.decimals),
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

/** Hyperliquid's answer to /exchange: "ok", or the reason it refused. */
export function spotSendResult(json: unknown): { ok: true } | { ok: false; error: string } {
  const r = json as { status?: unknown; response?: unknown } | null;
  if (r?.status === 'ok') return { ok: true };
  const detail = typeof r?.response === 'string' ? r.response : JSON.stringify(r ?? null);
  return { ok: false, error: detail.slice(0, 200) };
}
