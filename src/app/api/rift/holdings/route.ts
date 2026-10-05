// src/app/api/rift/holdings/route.ts
//
// The wallet's balances on Ethereum, Arbitrum and Base, and its HyperCore spot balances on Hyperliquid,
// valued in USD and sorted largest first, for the "Get iAERO" token picker.
// - Blockscout's paginated /tokens list says which tokens the wallet holds and prices most of them. The scan
//   stops at its own caps (blockscout-pages.ts): such a list is kept like a whole one, 10 minutes per wallet
//   and chain, and used up to an hour old when Blockscout fails. A list cut short by a failed page is kept
//   90 s, and completed from an older list when there is one. The balances themselves are read on-chain, in
//   one multicall covering those tokens, the major tokens Rift routes and ETH, because Blockscout's numbers
//   can be stale.
// - Hyperliquid's API gives the HyperCore balances; one DeFiLlama call prices the rest, major tokens first,
//   keeping only recent, confident prices (as the page's own cost check does).
// - A source that fails is reported in `warnings` and the others are still returned. If no RPC answers for a
//   chain, Blockscout's own numbers are used and flagged. If DeFiLlama is down, ETH is priced from Blockscout,
//   and major tokens without a price are listed unvalued rather than dropped. A deliberate limit (a token
//   list longer than the scan reads) is reported in `notes`, not as a failure.
// - Each request has one time budget, under the page's 45 s timeout; every source call gets what is left.
// - Answers are cached per wallet (Cloudflare's cache, where available) for 90 s, longer than the page's
//   60 s refresh, or 20 s when a source failed (`warnings`, not `notes`); `?fresh=1` (the Refresh button)
//   skips it, at most every 20 s.
// - Each Worker instance limits callers to 30 requests a minute (IPv6 per /64). Balance reads use public RPCs
//   only, so anonymous callers cannot spend a private RPC key's quota.
// - `hyperliquidUsdc` is the USDC that can pay Hyperliquid's 1 USDC new-address fee, whatever token is sent.

import { type NextRequest, NextResponse } from 'next/server';
import { createPublicClient, erc20Abi, fallback, http, type Address } from 'viem';
import { arbitrum, base, mainnet } from 'viem/chains';
import { CURATED_TOKENS, RIFT_DESTINATION } from '@/lib/rift/config';
import { RIFT_LISTED } from '@/lib/rift/rift-tokens';
import { EVM_ADDRESS_RE, badRequest } from '@/lib/rift/server';
import { parseLlamaPrices } from '@/lib/rift/cost';
import {
  HOLDING_CHAINS, MAX_UNPRICED_CANDIDATES, applyLlamaPrices, blockscoutCandidates, candidatesToHoldings, mergeTokenRows, nativeHolding,
  parseNative, parseTokenBalances, rankHoldings, rawToNumber, splitRead, validDecimals, wholeReadFailed, type EvmHoldingChain, type Holding,
  type TokenCandidate,
} from '@/lib/rift/holdings';
import { HL_API, HYPERCORE_TOKENS, hyperCoreHoldings, parseSpotBalances, usdcForFee } from '@/lib/rift/hypercore';
import { collectTokenPages, type TokenPages } from '@/lib/rift/blockscout-pages';
import { RateLimiter, rateKey, touch } from '@/lib/rift/rate-limit';
import { rpcUrls } from '@/lib/public-rpcs';

export const runtime = 'edge';

const SOURCE_TIMEOUT_MS = 8_000;
const RPC_TIMEOUT_MS = 4_000;
/** The whole request, under the page's 45 s timeout (HOLDINGS_TIMEOUT_MS in GetIaeroSection.tsx). */
const REQUEST_BUDGET_MS = 25_000;
/** Kept back from the balance reads for the price lookup that follows them. */
const PRICE_RESERVE_MS = 6_000;
const CACHE_SECONDS = 90;
const WARNED_CACHE_SECONDS = 20;
const PARTIAL_LIST_CACHE_SECONDS = 90;
const LIST_FRESH_MS = 10 * 60_000;
const LIST_MAX_AGE_MS = 60 * 60_000;
const LIST_FETCH_BUDGET_MS = 12_000;
const FRESH_EVERY_MS = 20_000;
const PER_IP_PER_MINUTE = 30;
const MAX_TRACKED = 5_000;
const MAX_LLAMA_LOOKUPS = 80;
const MAX_CHAIN_CANDIDATES = 120;
/** A refused multicall is read again in halves only with at least this much time left. */
const RETRY_MIN_MS = 2_000;
/** Reads to find the calls that break a refused multicall: enough to narrow one among the most a chain reads
 *  (1 + 120 balances + 120 decimals) down to itself. */
const MAX_SPLIT_READS = 16;
/** Kept back from those reads for Blockscout's numbers, used when the chain can't be read after all. */
const FALLBACK_RESERVE_MS = 3_000;
const VIEM_CHAINS = { 1: mainnet, 42161: arbitrum, 8453: base } as const;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;
const GET_ETH_BALANCE = [{
  type: 'function', name: 'getEthBalance', stateMutability: 'view',
  inputs: [{ name: 'addr', type: 'address' }], outputs: [{ name: 'balance', type: 'uint256' }],
}] as const;

/** `warnings`: a source failed (the answer may be incomplete). `notes`: a deliberate limit was reached. */
interface Report { warnings: string[]; notes: string[] }

/** JSON from a GET (or a POST with `body`), with a timeout that never runs past `until`. No fetch `cache`
 *  option: Workers with an older compatibility date reject it. */
async function getJson(url: string, { body, until = Infinity, timeout = SOURCE_TIMEOUT_MS }: { body?: unknown; until?: number; timeout?: number } = {}): Promise<unknown> {
  const ms = Math.min(timeout, until - Date.now());
  if (!(ms > 0)) throw new Error('out of time');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
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

/** `p`, or a rejection once `until` passes (for calls that take no abort signal). */
function beforeDeadline<T>(p: Promise<T>, until: number): Promise<T> {
  // A late failure of the abandoned call must not surface as an unhandled rejection (viem errors carry the URL).
  p.catch(() => {});
  const left = until - Date.now();
  if (!(left > 0)) return Promise.reject(new Error('out of time'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('out of time')), left); });
  return Promise.race([p, expired]).finally(() => clearTimeout(timer));
}

// --- Cloudflare's cache (absent in `next dev`) ---

const edgeCache = (): Cache | undefined => (typeof caches !== 'undefined' ? (caches as unknown as { default?: Cache }).default : undefined);
const cacheKey = (kind: string, id: string) => new Request(`https://iaero-cache.invalid/${kind}/${id}`);

async function cacheGet(key: Request): Promise<Response | undefined> {
  return edgeCache()?.match(key).catch(() => undefined);
}
async function cachePut(key: Request, body: string, seconds: number, extra: Record<string, string> = {}) {
  await edgeCache()?.put(key, new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${seconds}`, ...extra } })).catch(() => {});
}

// --- Per-instance limits: a loop over addresses would otherwise hammer Blockscout and the public RPCs. ---

const limiter = new RateLimiter(PER_IP_PER_MINUTE, 60_000, MAX_TRACKED);
const lastFresh = new Map<string, number>();

/** Whether a `fresh=1` for this wallet may skip the caches now. */
function freshAllowed(owner: string, now: number): boolean {
  const last = lastFresh.get(owner) ?? 0;
  if (now - last < FRESH_EVERY_MS) return false;
  touch(lastFresh, owner, now, MAX_TRACKED);
  return true;
}

/** The major tokens Rift routes on a chain, read even when Blockscout does not list them. */
const curatedFor = (chain: EvmHoldingChain): TokenCandidate[] =>
  CURATED_TOKENS.filter(t => t.chain === chain && t.address).map(t => ({
    address: t.address!.toLowerCase() as `0x${string}`, symbol: t.symbol, name: t.name, decimals: t.decimals, priceUsd: 0,
  }));
const MAJOR = new Set(CURATED_TOKENS.map(t => t.asset.toLowerCase()));

const DECIMALS = [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] }] as const;

type CallResult = { status: 'success'; result: unknown } | { status: 'failure'; error?: unknown };
const notRead = (): CallResult => ({ status: 'failure', error: new Error('not read') });

/** ETH and token balances in one multicall, plus decimals() for tokens outside our list (an amount typed by
 *  the user is converted with them, so they come from the chain, not the indexer, and only an integer from 0
 *  to 36 is taken). Short timeouts, nothing past `until`; the fallback list is the retry. A multicall refused
 *  as a whole while the chain still answers a plain balance read broke on something in it (one token answering
 *  with megabytes of data can do that): the rest is read again in halves (splitRead), so such a token fails
 *  alone, leaving time for Blockscout's numbers if that fails too. null when nothing was read (a token's own
 *  revert fails only its call). Errors are never logged: they may carry provider URLs. */
async function readBalances(chainId: 1 | 42161 | 8453, owner: Address, tokens: TokenCandidate[], until: number) {
  const timeout = Math.max(1, Math.min(RPC_TIMEOUT_MS, until - Date.now()));
  const client = createPublicClient({
    chain: VIEM_CHAINS[chainId],
    transport: fallback(rpcUrls(chainId, { server: true }).map(url => http(url, { timeout, retryCount: 0 })), { retryCount: 0 }),
  });
  const unlisted = tokens.filter(t => !MAJOR.has(`${chainKey(chainId)}.${t.address}`));
  const contracts = [
    { address: MULTICALL3, abi: GET_ETH_BALANCE, functionName: 'getEthBalance', args: [owner] },
    ...tokens.map(t => ({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })),
    ...unlisted.map(t => ({ address: t.address, abi: DECIMALS, functionName: 'decimals', args: [] })),
  ] as unknown as Parameters<typeof client.multicall>[0]['contracts'];
  // One aggregate call per read (batchSize 0: viem would otherwise split by calldata size, not by call).
  const read = (part: readonly unknown[], by: number) =>
    beforeDeadline(client.multicall({ contracts: part as typeof contracts, allowFailure: true, batchSize: 0 }), by) as Promise<CallResult[]>;
  let results = await read(contracts, until);
  if (wholeReadFailed(results, 1 + tokens.length)) {
    const by = until - FALLBACK_RESERVE_MS;
    const mayRead = () => by - Date.now() > RETRY_MIN_MS;
    const eth = mayRead() ? await beforeDeadline(client.getBalance({ address: owner }), by).catch(() => null) : null;
    if (eth !== null) {
      const rest = await splitRead(contracts.slice(1), part => read(part, by), notRead, { maxReads: MAX_SPLIT_READS, mayRead });
      if (!wholeReadFailed(rest, tokens.length)) results = [{ status: 'success', result: eth }, ...rest];
    }
  }
  const balanceReads = results.slice(0, 1 + tokens.length);
  if (wholeReadFailed(results, 1 + tokens.length)) return null;
  const eth = results[0];
  const balanceResults = results.slice(1, 1 + tokens.length);
  const decimals = new Map(unlisted.map((t, i) => {
    const r = results[1 + tokens.length + i];
    // Untrusted: a decimals() no real token answers counts as a failed read.
    const d = r.status === 'success' ? Number(r.result) : NaN;
    return [t.address, validDecimals(d) ? d : null] as const;
  }));
  return {
    incomplete: balanceReads.some(r => r.status === 'failure') || [...decimals.values()].some(d => d === null),
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

/** As good as the scan makes it: every page read, or stopped at the scan's own cap. */
const settled = (list: TokenPages) => list.complete || list.truncated;

/** Blockscout's token list for a wallet. A settled list is kept 10 minutes and used up to an hour old when
 *  Blockscout fails; a list cut short by a failed page is kept 90 s, or completed from a list under an hour
 *  old. Either fallback comes back marked incomplete, so the answer says so instead of passing as current. */
async function tokenList(chain: EvmHoldingChain, blockscout: string, owner: Address, fresh: boolean, until: number): Promise<TokenPages | null> {
  const key = cacheKey('rift-token-list-v3', `${chain}/${owner}`);
  const hit = await cacheGet(key);
  const cached = hit ? await hit.json().catch(() => null) as { at?: number; list?: TokenPages } | null : null;
  const age = cached?.at ? Date.now() - cached.at : Infinity;
  const older = cached?.list && Array.isArray(cached.list.items) && age < LIST_MAX_AGE_MS ? cached.list : null;
  if (!fresh && older && age < (settled(older) ? LIST_FRESH_MS : PARTIAL_LIST_CACHE_SECONDS * 1000)) return older;
  let list: TokenPages;
  try {
    // One budget for all pages: a big wallet's first page alone can take 10 s on a cold Blockscout.
    const listUntil = Math.min(Date.now() + LIST_FETCH_BUDGET_MS, until);
    list = await collectTokenPages(`${blockscout}/api/v2/addresses/${owner}/tokens?type=ERC-20`, url => getJson(url, { until: listUntil, timeout: LIST_FETCH_BUDGET_MS }));
  } catch {
    return older ? { items: older.items, complete: false, truncated: false } : null;
  }
  if (settled(list)) {
    await cachePut(key, JSON.stringify({ at: Date.now(), list }), LIST_MAX_AGE_MS / 1000);
    return list;
  }
  // Not cached: the older list stays as it is, to complete the next partial read too, until it expires.
  if (older) return { items: mergeTokenRows(list.items, older.items), complete: false, truncated: false };
  await cachePut(key, JSON.stringify({ at: Date.now(), list }), PARTIAL_LIST_CACHE_SECONDS);
  return list;
}

async function chainHoldings(chain: EvmHoldingChain, chainId: 1 | 42161 | 8453, blockscout: string, owner: Address, fresh: boolean, report: Report, until: number): Promise<Holding[]> {
  const list = await tokenList(chain, blockscout, owner, fresh, until);
  if (list && !settled(list)) report.warnings.push(`${chain}: token list incomplete; some tokens may be missing`);
  if (list?.truncated) report.notes.push(`${chain}: token list scan stopped at ${list.items.length} tokens`);
  const listed = list ? blockscoutCandidates(list.items, [RIFT_DESTINATION], () => {
    report.notes.push(`${chain}: only the first ${MAX_UNPRICED_CANDIDATES} unpriced tokens checked on-chain`);
  }) : [];
  const listedPrice = new Map(listed.map(c => [c.address, c]));
  // Major tokens keep Blockscout's price and icon when it lists them.
  const allCandidates = [
    ...curatedFor(chain).map(c => ({ ...c, priceUsd: listedPrice.get(c.address)?.priceUsd ?? 0, icon: listedPrice.get(c.address)?.icon })),
    ...listed.filter(c => !MAJOR.has(`${chain}.${c.address}`)),
  ];
  if (allCandidates.length > MAX_CHAIN_CANDIDATES) report.notes.push(`${chain}: only the first ${MAX_CHAIN_CANDIDATES} tokens checked on-chain`);
  const candidates = allCandidates.slice(0, MAX_CHAIN_CANDIDATES);
  let read: Awaited<ReturnType<typeof readBalances>> = null;
  try { read = await readBalances(chainId, owner, candidates, until); } catch { read = null; }
  if (!read) {
    // No RPC answered: Blockscout's own numbers (ETH from its address page), flagged.
    const items = list?.items;
    let native: Holding | null = null;
    try { native = parseNative(chain, await getJson(`${blockscout}/api/v2/addresses/${owner}`, { until })); } catch { /* none */ }
    const out = [...(items ? parseTokenBalances(chain, items, [RIFT_DESTINATION]) : []), ...(native ? [native] : [])];
    report.warnings.push(!items && !native ? `${chain}: balances unavailable` : `${chain}: balances could not be checked on-chain and may be out of date`);
    return out;
  }
  if (!list) report.warnings.push(`${chain}: token list unavailable, major tokens only`);
  if (read.incomplete) report.warnings.push(`${chain}: some balances could not be checked on-chain`);
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

/** ETH's price from Blockscout, for when DeFiLlama has none. */
async function blockscoutEthUsd(until: number): Promise<number | undefined> {
  try {
    const stats = await getJson('https://base.blockscout.com/api/v2/stats', { until }) as { coin_price?: unknown };
    const p = Number(stats?.coin_price);
    return p > 0 ? p : undefined;
  } catch {
    return undefined;
  }
}

export async function GET(request: NextRequest) {
  const address = request.nextUrl.searchParams.get('address') ?? '';
  if (!EVM_ADDRESS_RE.test(address)) return badRequest('invalid address');
  const owner = address.toLowerCase() as Address;
  const now = Date.now();
  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  if (limiter.over(rateKey(ip), now)) {
    return NextResponse.json({ error: 'Too many requests. Try again in a minute.' }, { status: 429, headers: { 'retry-after': '60', 'cache-control': 'no-store' } });
  }
  const fresh = request.nextUrl.searchParams.get('fresh') === '1' && freshAllowed(owner, now);

  const key = cacheKey('rift-holdings', owner);
  if (!fresh) {
    const hit = await cacheGet(key);
    if (hit) return new NextResponse(hit.body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-cache': 'hit' } });
  }

  const deadline = now + REQUEST_BUDGET_MS;
  const balancesUntil = deadline - PRICE_RESERVE_MS;
  const report: Report = { warnings: [], notes: [] };
  const [evm, hyperJson] = await Promise.all([
    // A chain that fails in an unexpected way is reported as unavailable; the other chains are still answered.
    Promise.all(HOLDING_CHAINS.map(c => chainHoldings(c.chain, c.chainId, c.blockscout, owner, fresh, report, balancesUntil)
      .catch((): Holding[] => { report.warnings.push(`${c.chain}: balances unavailable`); return []; }))),
    getJson(`${HL_API}/info`, { body: { type: 'spotClearinghouseState', user: owner }, until: balancesUntil })
      .catch(() => { report.warnings.push('hyperliquid: balances unavailable'); return null; }),
  ]);
  let holdings = evm.flat();
  let hyperBalances: ReturnType<typeof parseSpotBalances> = [];
  let hyperliquidUsdc: string | undefined;
  try {
    if (hyperJson) { hyperBalances = parseSpotBalances(hyperJson); hyperliquidUsdc = String(usdcForFee(hyperJson)); }
  } catch {
    hyperBalances = [];
    report.warnings.push('hyperliquid: balances unavailable');
  }

  // One DeFiLlama call: HyperCore tokens, ETH and the unpriced tokens. Blockscout's ETH price is asked at the
  // same time, and used only when DeFiLlama has none.
  const llamaChain = (c: string) => HOLDING_CHAINS.find(x => x.chain === c)?.llama ?? c;
  const lookups = lookupOrder(holdings);
  const holdsEth = holdings.some(h => !h.address);
  const ids = [
    ...(hyperBalances.length ? HYPERCORE_TOKENS.map(t => t.llamaId) : []),
    ...(holdsEth ? ['coingecko:ethereum'] : []),
    ...lookups.map(h => `${llamaChain(h.chain)}:${h.address}`),
  ];
  const [prices, blockscoutEth] = await Promise.all([
    ids.length
      ? getJson(`https://coins.llama.fi/prices/current/${[...new Set(ids)].join(',')}?searchWidth=4h`, { until: deadline })
        .then(json => parseLlamaPrices(json, Date.now()))
        .catch(() => { report.warnings.push('prices: some token prices unavailable'); return null; })
      : null,
    holdsEth ? blockscoutEthUsd(deadline) : undefined,
  ]);
  if (prices) holdings = applyLlamaPrices(holdings, prices, llamaChain);
  const ethUsd = prices?.['coingecko:ethereum'] || blockscoutEth;
  if (ethUsd) holdings = holdings.map(h => (!h.address ? { ...h, priceUsd: ethUsd, valueUsd: ethUsd * rawToNumber(h.balanceRaw, h.decimals) } : h));
  holdings = [...holdings, ...hyperCoreHoldings(hyperBalances, prices ?? {})];
  // Tokens known to be real (ETH, major tokens, Rift's list) stay listed without a value when no price is to be
  // had; the unknown, unpriced long tail (mostly airdropped spam) is not shown.
  holdings = holdings.map(h => (h.priceUsd > 0 || !(!h.address || MAJOR.has(h.asset) || RIFT_LISTED.has(h.asset)) ? h : { ...h, priceMissing: true }));

  const { warnings, notes } = report;
  const body = JSON.stringify({
    holdings: rankHoldings(holdings), warnings, notes,
    hyperliquidUsdc,
  });
  await cachePut(key, body, warnings.length ? WARNED_CACHE_SECONDS : CACHE_SECONDS);
  return new NextResponse(body, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
