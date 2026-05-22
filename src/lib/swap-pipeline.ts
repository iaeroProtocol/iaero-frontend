// ============================================================================
// src/lib/swap-pipeline.ts
//
// Shared swap pipeline primitives, extracted from
// `src/components/protocol/RewardsSection.tsx` so the on-chain auto-USDC vault
// keeper can reuse the exact same quoting / plan-building / slippage logic
// that the frontend uses today.
//
// Scope (intentionally narrow — MVP):
//   - Constants & ABIs needed to call the deployed RewardSwapper
//   - Types for SwapStep / TokenForSwap / SwapQuote
//   - Pure helpers: calculateSlippage, makeSwapArgs, buildSwapStepFromQuote
//   - Network: fetch0xQuote with an injected fetcher (browser vs. Node)
//   - Spam blocklist (cached) and isSpamToken
//   - parseSwapError (error → user-friendly reason)
//
// Explicitly OUT of scope for this MVP (keep in RewardsSection.tsx):
//   - simulateSwapsIndividually
//   - isolateProblemTokens
//   - executeProblemTokensIndividually
//   - retryBatchWithBoost
//   - ensureApprovals
//   - All React state / progress / toast wiring
//
// Browser usage: pass `browserQuoteFetcher` (hits /api/0x/quote).
// Node/keeper usage: pass `createDirectQuoteFetcher(apiKey)` (hits api.0x.org).
// ============================================================================

import { encodeAbiParameters, parseAbi } from 'viem';
import type { Address } from 'viem';

// ----------------------------------------------------------------------------
// Addresses (Base mainnet)
// ----------------------------------------------------------------------------

/** Deployed RewardSwapper — single source of truth for `taker` and approvals. */
export const SWAPPER_ADDRESS = '0x25f11f947309df89bf4d36da5d9a9fb5f1e186c1' as Address;

/** RewardTokenRegistry — append-only set of tokens the protocol has seen. */
export const REGISTRY_ADDRESS = '0xd3e32B22Da6Bf601A5917ECd344a7Ec46BCA072c' as Address;

export const USDC_ADDR    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
export const USDC_DECIMALS = 6;

export const AERO_ADDR  = '0x940181a94A35A4569E4529A3CDfB74e38FD98631' as Address;
export const IAERO_ADDR = '0x81034Fb34009115F215f5d5F564AAc9FfA46a1Dc' as Address;

// ----------------------------------------------------------------------------
// Swap pipeline tuning
// ----------------------------------------------------------------------------

export const QUOTE_BATCH_SIZE  = 10;
export const QUOTE_BATCH_DELAY = 500;  // ms between quote batches
export const EXECUTION_BATCH_SIZE = 10;

/** Slippage floor / cap (bps). Matches RewardsSection.tsx::calculateSlippage. */
export const SLIPPAGE_MIN_BPS = 30;
export const SLIPPAGE_MAX_BPS = 500;

/** Boosted slippage used in retry / individual-fallback paths. */
export const SLIPPAGE_BOOSTED_BPS = 1000;

/** Matches the Solidity enum in RewardSwapper.sol. */
export const RouterKind = {
  AERODROME: 0,
  UNIV3:     1,
  AGGREGATOR: 2,
} as const;
export type RouterKindValue = (typeof RouterKind)[keyof typeof RouterKind];

/** Auto-deselect quotes worse than this price impact (frontend default). */
export const AUTO_DESELECT_IMPACT_PERCENT = 10;

// ----------------------------------------------------------------------------
// ABIs
// ----------------------------------------------------------------------------

/** RewardSwapper.executePlanFromCaller(plan, recipient). */
export const SWAPPER_ABI = [
  {
    name: 'executePlanFromCaller',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'plan',
        type: 'tuple[]',
        components: [
          { name: 'kind',           type: 'uint8' },
          { name: 'tokenIn',        type: 'address' },
          { name: 'outToken',       type: 'address' },
          { name: 'useAll',         type: 'bool' },
          { name: 'amountIn',       type: 'uint256' },
          { name: 'quotedIn',       type: 'uint256' },
          { name: 'quotedOut',      type: 'uint256' },
          { name: 'slippageBps',    type: 'uint16' },
          { name: 'data',           type: 'bytes' },
          { name: 'viaPermit2',     type: 'bool' },
          { name: 'permitSig',      type: 'bytes' },
          { name: 'permitAmount',   type: 'uint256' },
          { name: 'permitDeadline', type: 'uint256' },
          { name: 'permitNonce',    type: 'uint256' },
        ],
      },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

export const ERC20_FULL_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

export const REGISTRY_ABI = parseAbi([
  'function allTokens() view returns (address[])',
]);

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/** Matches RewardSwapper.PullStep exactly — fed straight into `executePlanFromCaller`. */
export interface SwapStep {
  kind: RouterKindValue;
  tokenIn:  Address;
  outToken: Address;
  useAll:   boolean;
  amountIn: bigint;
  quotedIn: bigint;
  quotedOut: bigint;
  slippageBps: number;
  data: `0x${string}`;
  viaPermit2: boolean;
  permitSig: `0x${string}`;
  permitAmount:   bigint;
  permitDeadline: bigint;
  permitNonce:    bigint;
}

export interface TokenForSwap {
  address: Address;
  symbol: string;
  decimals: number;
  /** Amount to sell (may be custom; defaults to fullBalanceBN). */
  walletBN: bigint;
  /** Original wallet balance — used to decide `useAll`. */
  fullBalanceBN: bigint;
  valueUsd?: number;
}

export interface SwapQuote {
  token: TokenForSwap;
  buyAmount: bigint;
  buyAmountFormatted: string;
  transactionTo: Address;
  transactionData: `0x${string}`;
  priceImpact: number;
}

export interface QuotePreviewItem {
  token: TokenForSwap;
  /** Input value at market rate (from reference quote). */
  inputValueUsd:  number;
  /** Output value from full-amount quote. */
  quotedOutputUsd: number;
  /** Price impact percent (positive means loss). */
  lossPercent: number;
  lossUsd:     number;
  quote:       SwapQuote;
  selected:    boolean;
  forceHighSlippage?: boolean;
}

export interface FailedQuoteItem {
  token: TokenForSwap;
  error: string;
}

export type QuoteBatchResult =
  | { success: true;  token: TokenForSwap; inputValueUsd: number; quotedOutputUsd: number; lossPercent: number; lossUsd: number; quote: SwapQuote }
  | { success: false; token: TokenForSwap; error: string };

// ----------------------------------------------------------------------------
// Quote fetcher abstraction
// ----------------------------------------------------------------------------

export interface QuoteRequest {
  chainId:    number;
  sellToken:  string;
  buyToken:   string;
  sellAmount: bigint;
  taker:      string;
}

/**
 * Raw response shape from 0x v2 `swap/allowance-holder/quote`.
 * Only the fields we read are typed — extra fields are passed through.
 */
export interface ZeroExQuoteResponse {
  buyAmount:  string;
  sellAmount?: string;
  transaction?: {
    to:    Address;
    data:  `0x${string}`;
    value?: string;
    gas?:  string;
  };
  // ...passthrough for everything else 0x returns
  [k: string]: unknown;
}

export type QuoteFetcher = (req: QuoteRequest) => Promise<ZeroExQuoteResponse>;

/**
 * Browser fetcher — hits the Next.js API route which proxies to 0x with the
 * server-side key. Path matches `src/app/api/0x/quote/route.ts`.
 */
export const browserQuoteFetcher: QuoteFetcher = async (req) => {
  const params = new URLSearchParams({
    chainId:    String(req.chainId),
    sellToken:  req.sellToken,
    buyToken:   req.buyToken,
    sellAmount: req.sellAmount.toString(),
    taker:      req.taker,
  });
  const res = await fetch(`/api/0x/quote?${params}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = (err as any).error || (err as any).reason || (err as any).message || 'Quote failed';
    throw new Error(msg);
  }
  return res.json();
};

/**
 * Direct-to-0x fetcher for the keeper (Node, no Next.js route in front of it).
 * Pass your 0x API key. Same upstream URL/headers as the API route.
 */
export function createDirectQuoteFetcher(apiKey: string): QuoteFetcher {
  if (!apiKey) throw new Error('createDirectQuoteFetcher: empty apiKey');
  return async (req) => {
    const params = new URLSearchParams({
      chainId:    String(req.chainId),
      sellToken:  req.sellToken,
      buyToken:   req.buyToken,
      sellAmount: req.sellAmount.toString(),
      taker:      req.taker,
    });
    const res = await fetch(
      `https://api.0x.org/swap/allowance-holder/quote?${params}`,
      { headers: { '0x-api-key': apiKey, '0x-version': 'v2' } },
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = (err as any).reason || (err as any).message || `0x ${res.status}`;
      throw new Error(msg);
    }
    return res.json();
  };
}

/** Thin wrapper that picks the default fetcher when one isn't supplied. */
export async function fetch0xQuote(
  req: QuoteRequest,
  fetcher: QuoteFetcher = browserQuoteFetcher,
): Promise<ZeroExQuoteResponse> {
  return fetcher(req);
}

// ----------------------------------------------------------------------------
// Pure helpers
// ----------------------------------------------------------------------------

/**
 * Slippage in bps as a function of measured price impact percent.
 * Matches RewardsSection.tsx::calculateSlippage exactly.
 *
 * Normal mode:  max(30, 30 + ceil(impactBps * 1.5)) capped at 500 bps (5%).
 * Forced mode:  max(500, impactBps + 1000) capped at 9900 bps (99%).
 */
export function calculateSlippage(
  priceImpactPercent: number,
  forceHighSlippage = false,
): number {
  const priceImpactBps = Math.ceil(priceImpactPercent * 100);
  if (forceHighSlippage) {
    return Math.min(9900, Math.max(500, priceImpactBps + 1000));
  }
  return Math.min(
    SLIPPAGE_MAX_BPS,
    Math.max(SLIPPAGE_MIN_BPS, SLIPPAGE_MIN_BPS + Math.ceil(priceImpactBps * 1.5)),
  );
}

/**
 * Build the `(plan, recipient)` args tuple for executePlanFromCaller.
 * Kept as a separate helper so the on-chain ABI shape lives in one place.
 */
export function makeSwapArgs(steps: SwapStep[], recipient: Address) {
  const validated = steps.map(s => ({
    kind: s.kind,
    tokenIn: s.tokenIn,
    outToken: s.outToken,
    useAll: s.useAll,
    amountIn: s.amountIn,
    quotedIn: s.quotedIn,
    quotedOut: s.quotedOut,
    slippageBps: s.slippageBps,
    data: s.data,
    viaPermit2: s.viaPermit2,
    permitSig: s.permitSig,
    permitAmount: s.permitAmount,
    permitDeadline: s.permitDeadline,
    permitNonce: s.permitNonce,
  }));
  return [validated, recipient] as const;
}

/**
 * Encode the AGGREGATOR `data` field: `abi.encode(address routerTo, bytes routerCalldata)`.
 * The RewardSwapper unpacks this and forwards to the named router with the calldata.
 */
export function encodeAggregatorData(
  routerTo: Address,
  routerCalldata: `0x${string}`,
): `0x${string}` {
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes' }],
    [routerTo, routerCalldata],
  ) as `0x${string}`;
}

/**
 * Turn a 0x quote into a fully-formed SwapStep ready for executePlanFromCaller.
 * `useAll` is set when amount equals full balance — saves a re-read of balance
 * on chain and lets the swapper sweep precisely whatever is in the caller.
 */
export function buildSwapStepFromQuote(args: {
  token: TokenForSwap;
  outToken: Address;
  quote: SwapQuote;
  slippageBps: number;
}): SwapStep {
  const { token, outToken, quote, slippageBps } = args;
  const isFullSweep = token.walletBN >= token.fullBalanceBN;
  return {
    kind: RouterKind.AGGREGATOR,
    tokenIn: token.address,
    outToken,
    useAll: isFullSweep,
    amountIn:  token.walletBN,
    quotedIn:  token.walletBN,
    quotedOut: quote.buyAmount,
    slippageBps,
    data: encodeAggregatorData(quote.transactionTo, quote.transactionData),
    viaPermit2: false,
    permitSig:  '0x',
    permitAmount:   0n,
    permitDeadline: 0n,
    permitNonce:    0n,
  };
}

/**
 * Parse a swap error message into a short user-friendly reason. Mirrors the
 * matching block in RewardsSection.tsx::simulateSwapsIndividually so the
 * keeper logs the same vocabulary the frontend already shows users.
 */
export function parseSwapError(err: unknown): { reason: string } {
  const raw = String((err as { message?: unknown } | undefined)?.message ?? err ?? '').toLowerCase();
  if (raw.includes('aggregator') && raw.includes('whitelist')) return { reason: 'Aggregator not whitelisted' };
  if (raw.includes('#1002') || raw.includes('agg swap fail'))   return { reason: 'Swap failed — token may have transfer tax or no liquidity' };
  if (raw.includes('slippage exceeded') || raw.includes('too little received')) return { reason: 'Slippage exceeded' };
  if (raw.includes('insufficient') && raw.includes('balance'))  return { reason: 'Insufficient balance' };
  if (raw.includes('allowance') || raw.includes('approve'))     return { reason: 'Insufficient allowance' };
  if (raw.includes('transfer') && raw.includes('fail'))         return { reason: 'Token transfer failed' };
  const m = raw.match(/reverted with the following reason:\s*([^\n]+)/i);
  if (m) return { reason: m[1].trim() };
  return { reason: raw.substring(0, 100) || 'Unknown error' };
}

// ----------------------------------------------------------------------------
// Spam blocklist
// ----------------------------------------------------------------------------

export interface SpamBlocklist {
  addresses: Set<string>;
  patterns:  string[];
}

export const DEFAULT_SPAM_BLOCKLIST_URL =
  'https://raw.githubusercontent.com/iaeroProtocol/ChainProcessingBot/main/data/spam_tokens_base.json';

const BLOCKLIST_CACHE_TTL_MS = 5 * 60 * 1000;
let _blocklistCache: { data: SpamBlocklist; lastFetch: number } | null = null;

/** Fetch + cache the protocol's spam token list. Resilient to outages. */
export async function fetchSpamBlocklist(
  url: string = DEFAULT_SPAM_BLOCKLIST_URL,
): Promise<SpamBlocklist> {
  if (_blocklistCache && Date.now() - _blocklistCache.lastFetch < BLOCKLIST_CACHE_TTL_MS) {
    return _blocklistCache.data;
  }
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { addresses: new Set(), patterns: [] };
    const data = await res.json();
    const blocklist: SpamBlocklist = {
      addresses: new Set<string>(
        (data.tokens || []).map((t: { address: string }) => t.address.toLowerCase()),
      ),
      patterns: data.symbolPatterns || [],
    };
    _blocklistCache = { data: blocklist, lastFetch: Date.now() };
    return blocklist;
  } catch {
    return { addresses: new Set(), patterns: [] };
  }
}

/** Symbol- and address-level spam screen. */
export function isSpamToken(
  address: string,
  symbol: string,
  blocklist: SpamBlocklist,
): boolean {
  if (blocklist.addresses.has(address.toLowerCase())) return true;
  const sym = (symbol || '').toLowerCase();
  for (const pat of blocklist.patterns) {
    try {
      if (new RegExp(pat, 'i').test(sym)) return true;
    } catch {
      // Bad pattern in the blocklist — fall back to substring match
      if (sym.includes(pat.toLowerCase())) return true;
    }
  }
  return false;
}

// ----------------------------------------------------------------------------
// Convenience: combined full + reference quote → impact-aware QuoteBatchResult
// ----------------------------------------------------------------------------

/**
 * Fetch the main (full-amount) quote and a small reference quote, and combine
 * them into a `QuoteBatchResult` with measured price impact. Mirrors the
 * per-token block inside buildQuotePreview in RewardsSection.tsx but as a
 * single reusable async unit.
 *
 * `outputPrice` is the USD price of the buy token (1 for USDC).
 * `outputDecimals` is the buy token's decimals (6 for USDC).
 * `referencePriceMapEntry` is an optional DefiLlama USD/token fallback used
 * when the reference quote itself fails — same fallback the frontend uses.
 */
export async function getQuoteWithImpact(args: {
  chainId: number;
  token: TokenForSwap;
  outToken: Address;
  outputPrice: number;
  outputDecimals: number;
  taker?: Address;
  fetcher?: QuoteFetcher;
  referencePriceMapEntry?: number;
}): Promise<QuoteBatchResult> {
  const {
    chainId, token, outToken, outputPrice, outputDecimals,
    taker = SWAPPER_ADDRESS,
    fetcher = browserQuoteFetcher,
    referencePriceMapEntry,
  } = args;

  try {
    const mainQuote = await fetcher({
      chainId, sellToken: token.address, buyToken: outToken,
      sellAmount: token.walletBN, taker,
    });
    if (!mainQuote?.transaction?.data) {
      return { success: false, token, error: 'No quote available' };
    }

    const buyAmount = BigInt(mainQuote.buyAmount);
    const quotedOutputUsd = formatNumberFromBigint(buyAmount, outputDecimals) * outputPrice;

    // --- reference quote (~$1 worth, capped at 1 whole token) ---
    let inputValueUsd: number;
    let priceImpact: number;
    try {
      const sellAmountWhole = formatNumberFromBigint(token.walletBN, token.decimals);
      const tokenPriceEstimate = (token.valueUsd || 0) / Math.max(sellAmountWhole, 1e-12);
      const refTokenAmount = Math.max(1, Math.ceil(1 / Math.max(tokenPriceEstimate, 1)));
      const refAmount = parseUnitsToBigint(refTokenAmount.toString(), token.decimals);

      const refQuote = await fetcher({
        chainId, sellToken: token.address, buyToken: outToken,
        sellAmount: refAmount, taker,
      });
      if (!refQuote?.buyAmount) throw new Error('No ref quote');

      const refBuy = formatNumberFromBigint(BigInt(refQuote.buyAmount), outputDecimals);
      const refSell = formatNumberFromBigint(refAmount, token.decimals);
      const marketPricePerToken = (refBuy / refSell) * outputPrice;

      inputValueUsd = sellAmountWhole * marketPricePerToken;
      priceImpact   = inputValueUsd > 0
        ? Math.max(0, ((inputValueUsd - quotedOutputUsd) / inputValueUsd) * 100)
        : 0;
    } catch {
      // Fallback: DefiLlama price (if provided) or output itself
      const llama = referencePriceMapEntry ?? 0;
      const sellAmountWhole = formatNumberFromBigint(token.walletBN, token.decimals);
      inputValueUsd = llama > 0 ? sellAmountWhole * llama : quotedOutputUsd;
      priceImpact = inputValueUsd > 0
        ? Math.max(0, ((inputValueUsd - quotedOutputUsd) / inputValueUsd) * 100)
        : 2;
    }

    return {
      success: true,
      token,
      inputValueUsd,
      quotedOutputUsd,
      lossPercent: priceImpact,
      lossUsd: Math.max(0, inputValueUsd - quotedOutputUsd),
      quote: {
        token,
        buyAmount,
        buyAmountFormatted: formatNumberFromBigint(buyAmount, outputDecimals).toString(),
        transactionTo:   mainQuote.transaction.to as Address,
        transactionData: mainQuote.transaction.data as `0x${string}`,
        priceImpact,
      },
    };
  } catch (e) {
    return { success: false, token, error: parseSwapError(e).reason };
  }
}

// ----------------------------------------------------------------------------
// Tiny numeric helpers (avoid pulling viem's formatUnits into the hot path)
// ----------------------------------------------------------------------------

function formatNumberFromBigint(value: bigint, decimals: number): number {
  // Safe for the value ranges we see (reward amounts, never beyond ~1e30).
  // For absolute precision the caller should use viem's formatUnits + parseFloat.
  const negative = value < 0n;
  const v = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac  = v % base;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 18);
  const n = Number(`${whole}.${fracStr}`);
  return negative ? -n : n;
}

function parseUnitsToBigint(value: string, decimals: number): bigint {
  const [w, f = ''] = value.split('.');
  const fracPadded = (f + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}
