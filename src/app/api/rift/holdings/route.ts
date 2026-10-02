// src/app/api/rift/holdings/route.ts
//
// The wallet's balances on Ethereum, Arbitrum and Base, and its HyperCore spot balances on Hyperliquid,
// valued in USD and sorted largest first, for the "Get iAERO" token picker. Blockscout says which tokens the
// wallet has held and prices most of them; the EVM balances themselves are read on-chain (one multicall per
// chain, also covering the major tokens Blockscout may not list), since Blockscout's can be stale. Hyperliquid's
// API gives the HyperCore balances, DeFiLlama the remaining prices. A source that fails to answer
// is reported in `warnings`; the others are still returned. `hyperliquidUsdc` is the spendable HyperCore
// USDC, which must cover Hyperliquid's 1 USDC fee whatever token is sent.

import { type NextRequest, NextResponse } from 'next/server';
import { createPublicClient, erc20Abi, fallback, http } from 'viem';
import { arbitrum, base, mainnet } from 'viem/chains';
import { CURATED_TOKENS, RIFT_DESTINATION } from '@/lib/rift/config';
import { EVM_ADDRESS_RE, badRequest } from '@/lib/rift/server';
import { rpcUrls } from '@/lib/public-rpcs';
import {
  HOLDING_CHAINS, applyLlamaPrices, blockscoutCandidates, candidatesToHoldings, mergeCandidates, nativeHolding, parseNative,
  parseTokenBalances, rankHoldings, rawToNumber, type EvmHoldingChain, type Holding, type TokenCandidate,
} from '@/lib/rift/holdings';
import { HL_API, HYPERCORE_TOKENS, hyperCoreHoldings, parseSpotBalances } from '@/lib/rift/hypercore';

export const runtime = 'edge';

const TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 10_000;
const MAX_LLAMA_LOOKUPS = 80;
const VIEM_CHAINS = { 1: mainnet, 42161: arbitrum, 8453: base } as const;

/** The major tokens Rift routes on each chain, read even when Blockscout does not list them. */
const curatedFor = (chain: EvmHoldingChain): TokenCandidate[] =>
  CURATED_TOKENS.filter(t => t.chain === chain && t.address).map(t => ({
    address: t.address!.toLowerCase() as `0x${string}`, symbol: t.symbol, name: t.name, decimals: t.decimals, priceUsd: 0,
  }));

/** Balances of `candidates` (one multicall) and of native ETH, read on-chain. */
async function readOnchain(chainId: 1 | 42161 | 8453, address: `0x${string}`, candidates: TokenCandidate[]) {
  const client = createPublicClient({
    chain: VIEM_CHAINS[chainId],
    transport: fallback(rpcUrls(chainId).map(url => http(url, { timeout: RPC_TIMEOUT_MS }))),
  });
  const [results, native] = await Promise.all([
    candidates.length
      ? client.multicall({
        contracts: candidates.map(c => ({ address: c.address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [address] as const })),
        allowFailure: true, batchSize: 0,
      })
      : Promise.resolve([]),
    client.getBalance({ address }),
  ]);
  return { balances: results.map(r => (r.status === 'success' ? (r.result as bigint) : null)), native };
}

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
  const perChain = await Promise.all(HOLDING_CHAINS.map(async ({ chain, chainId, blockscout }) => {
    const [tokens, info] = await Promise.allSettled([
      getJson(`${blockscout}/api/v2/addresses/${address}/token-balances`),
      getJson(`${blockscout}/api/v2/addresses/${address}`),
    ]);
    if (tokens.status !== 'fulfilled') warnings.push(`${chain}: token list unavailable, major tokens only`);
    const candidates = mergeCandidates(
      tokens.status === 'fulfilled' ? blockscoutCandidates(tokens.value, [RIFT_DESTINATION]) : [],
      curatedFor(chain),
    );
    const ethPrice = info.status === 'fulfilled' ? Number((info.value as { exchange_rate?: string | null } | null)?.exchange_rate ?? 0) || 0 : 0;
    try {
      const { balances, native } = await readOnchain(chainId, address as `0x${string}`, candidates);
      const out = candidatesToHoldings(chain, candidates, balances);
      const n = nativeHolding(chain, native, ethPrice);
      if (n) out.push(n);
      return out;
    } catch {
      // No RPC answered: Blockscout's own numbers, flagged because they can be stale.
      warnings.push(`${chain}: balances could not be checked on-chain and may be out of date`);
      const out: Holding[] = [];
      if (tokens.status === 'fulfilled') out.push(...parseTokenBalances(chain, tokens.value, [RIFT_DESTINATION]));
      if (info.status === 'fulfilled') { const n = parseNative(chain, info.value); if (n) out.push(n); }
      return out;
    }
  }));
  const hyperResult = await hyper;
  let holdings = [...perChain.flat(), ...hyperResult.holdings];

  // Price what Blockscout could not (including ETH if its price was missing), in one DeFiLlama call.
  const llamaChain = (c: string) => HOLDING_CHAINS.find(x => x.chain === c)?.llama ?? c;
  // Major tokens first: a wallet full of airdropped spam must not use up the lookups before its cbBTC does.
  const major = new Set(CURATED_TOKENS.map(t => t.asset));
  const unpricedAll = holdings.filter(h => !(h.priceUsd > 0) && h.address);
  const unpriced = [...unpricedAll.filter(h => major.has(h.asset)), ...unpricedAll.filter(h => !major.has(h.asset))].slice(0, MAX_LLAMA_LOOKUPS);
  const ethUnpriced = holdings.some(h => !(h.priceUsd > 0) && !h.address && h.chain !== 'hyperliquid');
  if (unpriced.length || ethUnpriced) {
    try {
      const ids = [...unpriced.map(h => `${llamaChain(h.chain)}:${h.address}`), ...(ethUnpriced ? ['coingecko:ethereum'] : [])].join(',');
      const json = await getJson(`https://coins.llama.fi/prices/current/${ids}`);
      holdings = applyLlamaPrices(holdings, json, llamaChain);
      const eth = (json as { coins?: Record<string, { price?: number }> } | null)?.coins?.['coingecko:ethereum']?.price;
      if (ethUnpriced && typeof eth === 'number' && eth > 0) {
        holdings = holdings.map(h => (!h.address && h.chain !== 'hyperliquid' && !(h.priceUsd > 0)
          ? { ...h, priceUsd: eth, valueUsd: eth * rawToNumber(h.balanceRaw, h.decimals) } : h));
      }
    } catch {
      warnings.push('some token prices unavailable');
    }
  }

  return NextResponse.json(
    { holdings: rankHoldings(holdings), warnings, hyperliquidUsdc: hyperResult.hyperliquidUsdc },
    { headers: { 'cache-control': 'no-store' } },
  );
}
