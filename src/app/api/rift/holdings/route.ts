// src/app/api/rift/holdings/route.ts
//
// The wallet's balances on Ethereum, Arbitrum and Base, and its HyperCore spot balances on Hyperliquid,
// valued in USD and sorted largest first, for the "Get iAERO" token picker.
// - Blockscout's /tokens page (sorted by USD value, about 25 KB) says which tokens the wallet holds and prices
//   most of them. The balances themselves are read on-chain, in one multicall per chain covering those
//   tokens, the major tokens Rift routes and ETH, because Blockscout's numbers can be stale.
// - Hyperliquid's API gives the HyperCore balances; one DeFiLlama call prices the rest, major tokens first.
// - A source that fails is reported in `warnings` and the others are still returned. If no RPC answers for a
//   chain, Blockscout's own numbers are used and flagged.
// - Answers are cached for 30 s per wallet (Cloudflare's cache, where available); `?fresh=1` skips it.
// - `hyperliquidUsdc` is the USDC that can pay Hyperliquid's 1 USDC new-address fee, whatever token is sent.

import { type NextRequest, NextResponse } from 'next/server';
import { createPublicClient, erc20Abi, fallback, http, type Address } from 'viem';
import { arbitrum, base, mainnet } from 'viem/chains';
import { CURATED_TOKENS, RIFT_DESTINATION } from '@/lib/rift/config';
import { EVM_ADDRESS_RE, badRequest } from '@/lib/rift/server';
import { rpcUrls } from '@/lib/public-rpcs';
import {
  HOLDING_CHAINS, applyLlamaPrices, blockscoutCandidates, candidatesToHoldings, nativeHolding, parseTokenBalances,
  rankHoldings, rawToNumber, type EvmHoldingChain, type Holding, type TokenCandidate,
} from '@/lib/rift/holdings';
import { HL_API, HYPERCORE_TOKENS, hyperCoreHoldings, parseSpotBalances, usdcForFee } from '@/lib/rift/hypercore';

export const runtime = 'edge';

const SOURCE_TIMEOUT_MS = 8_000;
const RPC_TIMEOUT_MS = 4_000;
const CACHE_SECONDS = 30;
const MAX_LLAMA_LOOKUPS = 80;
const VIEM_CHAINS = { 1: mainnet, 42161: arbitrum, 8453: base } as const;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
const GET_ETH_BALANCE = [{
  type: 'function', name: 'getEthBalance', stateMutability: 'view',
  inputs: [{ name: 'addr', type: 'address' }], outputs: [{ name: 'balance', type: 'uint256' }],
}] as const;

type Warnings = string[];

/** JSON from a GET (or a POST with `body`), with a timeout. No fetch `cache` option: Workers with an older
 *  compatibility date reject it. */
async function getJson(url: string, body?: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
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

/** The major tokens Rift routes on a chain, read even when Blockscout does not list them. */
const curatedFor = (chain: EvmHoldingChain): TokenCandidate[] =>
  CURATED_TOKENS.filter(t => t.chain === chain && t.address).map(t => ({
    address: t.address!.toLowerCase() as `0x${string}`, symbol: t.symbol, name: t.name, decimals: t.decimals, priceUsd: 0,
  }));
const MAJOR = new Set(CURATED_TOKENS.map(t => t.asset.toLowerCase()));

const DECIMALS = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] }] as const;

/** ETH and token balances in one multicall, plus decimals() for tokens outside our list (an amount typed by
 *  the user is converted with them, so they come from the chain, not the indexer). No retries (the fallback
 *  list is the retry), short timeouts. null when the read as a whole failed, which is when every call failed
 *  (a token's own revert fails only its call). */
async function readBalances(chainId: 1 | 42161 | 8453, owner: Address, tokens: TokenCandidate[]) {
  const client = createPublicClient({
    chain: VIEM_CHAINS[chainId],
    transport: fallback(rpcUrls(chainId, { server: true }).map(url => http(url, { timeout: RPC_TIMEOUT_MS, retryCount: 0 })), { retryCount: 0 }),
  });
  const unlisted = tokens.filter(t => !MAJOR.has(`${chainKey(chainId)}.${t.address}`));
  const contracts = [
    { address: MULTICALL3, abi: GET_ETH_BALANCE, functionName: 'getEthBalance', args: [owner] },
    ...tokens.map(t => ({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })),
    ...unlisted.map(t => ({ address: t.address, abi: DECIMALS, functionName: 'decimals', args: [] })),
  ] as unknown as Parameters<typeof client.multicall>[0]['contracts'];
  const results = await client.multicall({ contracts, allowFailure: true, batchSize: 0 });
  if (results.every(r => r.status === 'failure')) return null;
  const eth = results[0];
  const balanceResults = results.slice(1, 1 + tokens.length);
  const decimals = new Map(unlisted.map((t, i) => {
    const r = results[1 + tokens.length + i];
    return [t.address, r.status === 'success' ? Number(r.result) : null] as const;
  }));
  return {
    native: eth.status === 'success' ? (eth.result as bigint) : null,
    // A token whose decimals the chain does not confirm is left out rather than mis-sized.
    tokens: tokens.map(t => (decimals.has(t.address) ? { ...t, decimals: decimals.get(t.address) ?? -1 } : t)),
    balances: balanceResults.map((r, i) => {
      const d = decimals.get(tokens[i].address);
      return r.status === 'success' && d !== null ? (r.result as bigint) : null;
    }),
  };
}

const chainKey = (chainId: 1 | 42161 | 8453): EvmHoldingChain => (chainId === 1 ? 'ethereum' : chainId === 42161 ? 'arbitrum' : 'base');

async function chainHoldings(chain: EvmHoldingChain, chainId: 1 | 42161 | 8453, blockscout: string, owner: Address, warnings: Warnings): Promise<Holding[]> {
  let list: unknown = null;
  try {
    list = await getJson(`${blockscout}/api/v2/addresses/${owner}/tokens?type=ERC-20`);
  } catch {
    warnings.push(`${chain}: token list unavailable, major tokens only`);
  }
  const listed = list ? blockscoutCandidates(list, [RIFT_DESTINATION]) : [];
  const listedPrice = new Map(listed.map(c => [c.address, c]));
  // Major tokens keep Blockscout's price and icon when it lists them.
  const candidates = [
    ...curatedFor(chain).map(c => ({ ...c, priceUsd: listedPrice.get(c.address)?.priceUsd ?? 0, icon: listedPrice.get(c.address)?.icon })),
    ...listed.filter(c => !MAJOR.has(`${chain}.${c.address}`)),
  ];
  let read: Awaited<ReturnType<typeof readBalances>> = null;
  try { read = await readBalances(chainId, owner, candidates); } catch { read = null; }
  if (!read) {
    warnings.push(`${chain}: balances could not be checked on-chain and may be out of date`);
    const items = (list as { items?: unknown[] } | null)?.items;
    return items ? parseTokenBalances(chain, items, [RIFT_DESTINATION]) : [];
  }
  const out = candidatesToHoldings(chain, read.tokens, read.balances);
  if (read.native !== null) { const n = nativeHolding(chain, read.native, 0); if (n) out.push(n); }
  return out;
}

/** Unpriced tokens to look up, major tokens first, then taking turns across chains (Base first), so one
 *  chain's long tail cannot use up every lookup. */
function lookupOrder(holdings: Holding[]): Holding[] {
  const unpriced = holdings.filter(h => !(h.priceUsd > 0) && h.address);
  const major = unpriced.filter(h => MAJOR.has(h.asset));
  const byChain: Holding[][] = (['base', 'arbitrum', 'ethereum'] as const).map(c => unpriced.filter(h => h.chain === c && !MAJOR.has(h.asset)));
  const rest: Holding[] = [];
  for (let i = 0; byChain.some(l => i < l.length); i++) for (const l of byChain) if (i < l.length) rest.push(l[i]);
  return [...major, ...rest].slice(0, MAX_LLAMA_LOOKUPS);
}

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address') ?? '';
  if (!EVM_ADDRESS_RE.test(address)) return badRequest('invalid address');
  const owner = address.toLowerCase() as Address;

  const cache = typeof caches !== 'undefined' ? (caches as unknown as { default?: Cache }).default : undefined;
  const cacheKey = new Request(`https://iaero-cache.invalid/rift-holdings/${owner}`);
  if (cache && request.nextUrl.searchParams.get('fresh') !== '1') {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) return new NextResponse(hit.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-cache': 'hit' } });
  }

  const warnings: Warnings = [];
  const [evm, hyperJson] = await Promise.all([
    Promise.all(HOLDING_CHAINS.map(c => chainHoldings(c.chain, c.chainId, c.blockscout, owner, warnings))),
    getJson(`${HL_API}/info`, { type: 'spotClearinghouseState', user: owner }).catch(() => { warnings.push('hyperliquid: balances unavailable'); return null; }),
  ]);
  let holdings = evm.flat();
  const hyperBalances = hyperJson ? parseSpotBalances(hyperJson) : [];

  // One DeFiLlama call: HyperCore tokens, ETH and the unpriced tokens.
  const llamaChain = (c: string) => HOLDING_CHAINS.find(x => x.chain === c)?.llama ?? c;
  const lookups = lookupOrder(holdings);
  const ids = [
    ...(hyperBalances.length ? HYPERCORE_TOKENS.map(t => t.llamaId) : []),
    ...(holdings.some(h => !h.address) ? ['coingecko:ethereum'] : []),
    ...lookups.map(h => `${llamaChain(h.chain)}:${h.address}`),
  ];
  let prices: unknown = null;
  if (ids.length) {
    try { prices = await getJson(`https://coins.llama.fi/prices/current/${[...new Set(ids)].join(',')}`); } catch { warnings.push('prices: some token prices unavailable'); }
  }
  if (prices) {
    holdings = applyLlamaPrices(holdings, prices, llamaChain);
    const eth = (prices as { coins?: Record<string, { price?: number }> }).coins?.['coingecko:ethereum']?.price;
    if (typeof eth === 'number' && eth > 0) {
      holdings = holdings.map(h => (!h.address ? { ...h, priceUsd: eth, valueUsd: eth * rawToNumber(h.balanceRaw, h.decimals) } : h));
    }
  }
  holdings = [...holdings, ...hyperCoreHoldings(hyperBalances, prices)];

  const body = JSON.stringify({
    holdings: rankHoldings(holdings), warnings,
    hyperliquidUsdc: hyperJson ? String(usdcForFee(hyperJson)) : undefined,
  });
  if (cache && !warnings.length) {
    await cache.put(cacheKey, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${CACHE_SECONDS}` } })).catch(() => {});
  }
  return new NextResponse(body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
