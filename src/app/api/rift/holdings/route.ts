// src/app/api/rift/holdings/route.ts
//
// The wallet's balances on Ethereum, Arbitrum and Base, and its HyperCore spot balances on Hyperliquid,
// valued in USD and sorted largest first, for the "Get iAERO" token picker. Sources: Blockscout (balances,
// most USD rates), Hyperliquid's API (HyperCore) and DeFiLlama (the rest). A source that fails to answer
// is reported in `warnings`; the others are still returned. `hyperliquidUsdc` is the spendable HyperCore
// USDC, which must cover Hyperliquid's 1 USDC fee whatever token is sent.

import { type NextRequest, NextResponse } from 'next/server';
import { RIFT_DESTINATION } from '@/lib/rift/config';
import { EVM_ADDRESS_RE, badRequest } from '@/lib/rift/server';
import {
  HOLDING_CHAINS, applyLlamaPrices, parseNative, parseTokenBalances, rankHoldings, type Holding,
} from '@/lib/rift/holdings';
import { HL_API, HYPERCORE_TOKENS, hyperCoreHoldings, parseSpotBalances } from '@/lib/rift/hypercore';

export const runtime = 'edge';

const TIMEOUT_MS = 15_000;
const MAX_LLAMA_LOOKUPS = 60;

async function getJson(url: string, body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal, cache: 'no-store',
      ...(body === undefined
        ? { headers: { accept: 'application/json' } }
        : { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address') ?? '';
  if (!EVM_ADDRESS_RE.test(address)) return badRequest('invalid address');

  const warnings: string[] = [];
  // HyperCore spot balances, priced by CoinGecko id, alongside the EVM chains.
  const hyper = (async () => {
    try {
      const balances = parseSpotBalances(await getJson(`${HL_API}/info`, { type: 'spotClearinghouseState', user: address }));
      const usdc = balances.find(b => b.token.symbol === 'USDC');
      const hyperliquidUsdc = usdc ? (Number(usdc.availableRaw) / 10 ** usdc.token.decimals).toString() : '0';
      if (!balances.length) return { holdings: [] as Holding[], hyperliquidUsdc };
      const ids = HYPERCORE_TOKENS.map(t => t.llamaId).join(',');
      let prices: unknown = null;
      try { prices = await getJson(`https://coins.llama.fi/prices/current/${ids}`); } catch { warnings.push('hyperliquid: prices unavailable'); }
      return { holdings: hyperCoreHoldings(balances, prices), hyperliquidUsdc };
    } catch {
      warnings.push('hyperliquid: balances unavailable');
      return { holdings: [] as Holding[], hyperliquidUsdc: undefined };
    }
  })();
  const perChain = await Promise.all(HOLDING_CHAINS.map(async ({ chain, blockscout }) => {
    const [tokens, native] = await Promise.allSettled([
      getJson(`${blockscout}/api/v2/addresses/${address}/token-balances`),
      getJson(`${blockscout}/api/v2/addresses/${address}`),
    ]);
    const out: Holding[] = [];
    if (tokens.status === 'fulfilled') out.push(...parseTokenBalances(chain, tokens.value, [RIFT_DESTINATION]));
    else warnings.push(`${chain}: token balances unavailable`);
    if (native.status === 'fulfilled') { const n = parseNative(chain, native.value); if (n) out.push(n); }
    else if (tokens.status === 'fulfilled') warnings.push(`${chain}: ETH balance unavailable`);
    return out;
  }));
  const hyperResult = await hyper;
  let holdings = [...perChain.flat(), ...hyperResult.holdings];

  // Price what Blockscout could not, in one DeFiLlama call.
  const llamaChain = (c: string) => HOLDING_CHAINS.find(x => x.chain === c)?.llama ?? c;
  const unpriced = holdings.filter(h => !(h.priceUsd > 0) && h.address).slice(0, MAX_LLAMA_LOOKUPS);
  if (unpriced.length) {
    try {
      const ids = unpriced.map(h => `${llamaChain(h.chain)}:${h.address}`).join(',');
      holdings = applyLlamaPrices(holdings, await getJson(`https://coins.llama.fi/prices/current/${ids}`), llamaChain);
    } catch {
      warnings.push('some token prices unavailable');
    }
  }

  return NextResponse.json(
    { holdings: rankHoldings(holdings), warnings, hyperliquidUsdc: hyperResult.hyperliquidUsdc },
    { headers: { 'cache-control': 'no-store' } },
  );
}
