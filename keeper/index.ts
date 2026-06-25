#!/usr/bin/env node
// ============================================================================
// scripts/auto-usdc-vault-keeper.ts
//
// Weekly keeper for the iAEROAutoUSDCVault. Discovers what reward tokens the
// vault was owed for the latest completed epoch, fetches 0x quotes for each
// (filtering spam / unswappable), builds a PullStep[] swap plan, and calls
// `vault.harvest()` to claim + swap into USDC + bucket per-epoch.
//
// Uses a vendored copy of the swap pipeline at `./swap-pipeline.ts` (canonical
// source lives at iaero-frontend/src/lib/swap-pipeline.ts). The vendored copy
// is byte-identical and CI enforces drift via .github/workflows/keeper-sync.yml.
// Whenever the canonical file changes, copy it across before committing.
//
// Usage:
//   npx tsx protocol/scripts/auto-usdc-vault-keeper.ts             # broadcast
//   DRY_RUN=1 npx tsx protocol/scripts/auto-usdc-vault-keeper.ts   # simulate only
//
// Required env:
//   PRIVATE_KEY       — keeper EOA private key (currently the deployer)
//   RPC_URL           — Base mainnet RPC (uses public fallback if not set)
//   ZERO_EX_API_KEY   — 0x v2 API key (https://0x.org/docs)
//                       (legacy alias ZERO_X_API_KEY also accepted)
//
// Optional env:
//   TARGET_EPOCH      — override target epoch (default: latest completed)
//   FINALIZE          — '1' to set finalize=true on the harvest (default '1')
//   MIN_USDC_PCT      — global slippage floor as % of summed quoted output (default 95)
//   DRY_RUN           — '1' to skip broadcast (default '0')
//
// Environments:
//   - Locally: loads .env from protocol/ and repo root (silently no-op if missing)
//   - Railway: relies on process.env injected by the platform (no .env files needed)
// ============================================================================

import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
import fs   from 'node:fs';

import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  parseAbi,
  formatUnits,
  formatEther,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// Shared swap pipeline — single source of truth for quote/plan building.
import {
  SWAPPER_ADDRESS,
  REGISTRY_ADDRESS,
  USDC_ADDR,
  REGISTRY_ABI,
  SWAPPER_ABI,
  RouterKind,
  AUTO_DESELECT_IMPACT_PERCENT,
  calculateSlippage,
  buildSwapStepFromQuote,
  createDirectQuoteFetcher,
  fetchSpamBlocklist,
  isSpamToken,
  getQuoteWithImpact,
  type SwapStep,
  type TokenForSwap,
} from './swap-pipeline';

// ---------------------------------------------------------------------------
// Config & env
// ---------------------------------------------------------------------------

// Load .env files if present (local dev). On Railway / other PaaS, env vars
// are injected directly into process.env so file loading is a silent no-op.
// Search order: keeper/.env (preferred — gitignored, scoped to keeper) then
// the repo root .env as a fallback. `quiet: true` suppresses dotenv's banner.
for (const candidate of [
  path.resolve(__dirname, '.env'),
  path.resolve(__dirname, '..', '.env'),
]) {
  if (fs.existsSync(candidate)) {
    dotenvConfig({ path: candidate, quiet: true });
  }
}

const VAULT_ADDR      = '0xFE5c929677D97723dc822C86c93c7e2D1B59c774' as Address;
const IAERO_ADDR      = '0x81034Fb34009115F215f5d5F564AAc9FfA46a1Dc' as Address;
const EPOCH_DIST_ADDR = '0x781A80fA817b5a146C440F03EF8643f4aca6588A' as Address;
const WEEK            = 7n * 24n * 60n * 60n;

const RPC_URL = process.env.RPC_URL || 'https://mainnet.base.org';
const PRIVATE_KEY = (process.env.PRIVATE_KEY || '') as `0x${string}` | '';
// Accept either name; ZERO_EX_API_KEY matches the frontend (.env), ZERO_X_API_KEY
// is the legacy fallback.
const ZERO_X_API_KEY = process.env.ZERO_EX_API_KEY || process.env.ZERO_X_API_KEY || '';
const DRY_RUN = process.env.DRY_RUN === '1';
const FINALIZE = process.env.FINALIZE !== '0';   // default true
const MIN_USDC_PCT = BigInt(process.env.MIN_USDC_PCT || '95');
// Hard cap on execution slippage for the Tier-3 cleanup sweep. A sweep must
// deliver >= (100 - this)% of its quote or the harvest reverts and the token
// stays in the vault (recoverable). The impact gate (AUTO_DESELECT, 10%) already
// bounds forced slippage to ~20%; setting this to 1000 (10%) tightens it to
// match the impact ceiling so leftover tokens can't be sold below 90% of quote.
// Does not affect the main batch, which is already bounded by MIN_USDC_PCT.
const MAX_SWEEP_SLIPPAGE_BPS = Number(process.env.MAX_SWEEP_SLIPPAGE_BPS || '1000'); // 10%
// How long to wait for a broadcast's receipt before treating the tx as STUCK.
// A reverted tx still mines (returns a receipt, consumes its nonce — no gap); a
// tx that never mines is the only nonce-gap risk. On timeout we ABORT the run
// rather than send later txs (finalize/sweeps) behind the stuck nonce — the next
// run re-reads the pending nonce and self-heals.
const RECEIPT_TIMEOUT_MS = Number(process.env.RECEIPT_TIMEOUT_MS || '120000'); // 2 min
// Rehearsal-only knob: forces high per-step slippage (~50%+) so swaps execute
// against stale fork state. Production should NEVER set this — base+impact
// scaling at 30-500 bps is the right floor for live execution.
const FORCE_HIGH_SLIPPAGE = process.env.FORCE_HIGH_SLIPPAGE === '1';
// Set SKIP_INDIVIDUAL_RETRY=1 to disable the per-token retry pass (default: enabled).
// Disabling saves gas on harvests that have many unswappable tokens but loses the
// "ensure every token gets a swap attempt" guarantee.
const SKIP_INDIVIDUAL_RETRY = process.env.SKIP_INDIVIDUAL_RETRY === '1';
// Max number of sweep passes (each pass: scan vault, retry every remaining token).
// First pass runs as part of the main flow; subsequent passes only fire if tokens
// still sit in the vault. Set to 1 to disable additional sweeps.
const MAX_SWEEPS = Number(process.env.MAX_SWEEPS || '3');
// Max swap steps per harvest() tx. Matches the frontend's chunk size and stays
// well under the upstream RewardSwapper's MAX_STEPS=32 hard cap. Avoids gas-
// exhaustion when many tokens accrue in a single epoch.
const EXECUTION_BATCH_SIZE = Number(process.env.EXECUTION_BATCH_SIZE || '10');
// Logging verbosity. `verbose` adds per-phase timings + full env dump.
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const VERBOSE = LOG_LEVEL === 'verbose' || LOG_LEVEL === 'debug';
// Set by Railway's "Pre-Deploy Command" (`WARMUP_RUN=1 npm start`). This is the
// deploy GATE: it runs full discovery → quote → isolate to validate the new
// image, then exits 0 (deploy promoted, real harvest left to the scheduled
// cron) or non-zero (deploy aborted). It deliberately does NOT broadcast — a
// pre-deploy gate must never move funds or consume an epoch.
const WARMUP_RUN = process.env.WARMUP_RUN === '1';
// Force a sweep-only run: skip claiming this epoch's rewards entirely and just
// convert whatever reward tokens currently sit in the vault to USDC (bucketed to
// the target epoch). Safe + idempotent — it never claims or finalizes a fresh
// epoch's entitlement — so it's the right thing to run on deploy/startup to drain
// any stranded residue. Combine with TARGET_EPOCH to bucket the USDC to a
// specific still-open epoch (e.g. recovering a past stranded harvest).
const SWEEP_ON_START = process.env.SWEEP_ON_START === '1';

// Track total elapsed for the end-of-run summary.
const RUN_START_MS = Date.now();
const elapsedSec = () => ((Date.now() - RUN_START_MS) / 1000).toFixed(1) + 's';

/** Returns a closure that logs the elapsed phase time when called. */
function startPhase(name: string): () => void {
  if (!VERBOSE) return () => {};
  const t0 = Date.now();
  return () => log('timing', `phase=${name} took=${((Date.now() - t0) / 1000).toFixed(2)}s`);
}

// ---------------------------------------------------------------------------
// ABIs (only what this script needs)
// ---------------------------------------------------------------------------

const EPOCH_DIST_ABI = parseAbi([
  'function previewClaim(address user, address token, uint256 epoch) view returns (uint256)',
  'function currentEpoch() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function receiptToken() view returns (address)',
]);

const VAULT_ABI = parseAbi([
  'function totalShares() view returns (uint256)',
  'function epochFinalized(uint256) view returns (bool)',
  'function usdcForEpoch(uint256) view returns (uint256)',
  'function supplyCheckpointsLength() view returns (uint256)',
  'function totalSupplyAtEpochStart(uint256 epoch) view returns (uint256)',
  // Skip the full PullStep tuple — we'll encode manually via SWAPPER_ABI's struct
]);

const ERC20_BASIC_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

// Full harvest ABI lifted from the deployed vault — kept here so we don't drag
// the contract artifact across project boundaries.
const HARVEST_ABI = [
  {
    name: 'harvest',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'tokensToClaim', type: 'address[]' },
      {
        name: 'swapPlan',
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
      { name: 'minUSDC',  type: 'uint256' },
      { name: 'finalize', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(stage: string, msg: string, extra?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const tail = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[${ts}] [${stage}] ${msg}${tail}`);
}

/**
 * Sentinel thrown by die(). It carries the failure stage/message up to
 * main().catch, which is the single place that fires the failure webhook and
 * exits non-zero. Throwing (rather than process.exit) keeps die()'s `never`
 * return type — so call-site narrowing (e.g. PRIVATE_KEY) still works — while
 * letting one async handler own alerting + shutdown.
 */
class FatalExit extends Error {
  constructor(public stage: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
    this.name = 'FatalExit';
  }
}

function die(stage: string, msg: string, extra?: Record<string, unknown>): never {
  log(stage, `FATAL: ${msg}`, extra);
  throw new FatalExit(stage, msg, extra);
}

// ---------------------------------------------------------------------------
// Token discovery
// ---------------------------------------------------------------------------

interface ClaimableToken {
  address: Address;
  symbol: string;
  decimals: number;
  claimable: bigint;
}

async function discoverClaimableTokens(
  client: PublicClient,
  targetEpoch: bigint,
): Promise<ClaimableToken[]> {
  log('discover', 'Loading reward token registry...');
  const allTokens = (await client.readContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: 'allTokens',
  })) as readonly Address[];
  log('discover', `Registry returned ${allTokens.length} tokens`);

  log('discover', 'Fetching spam blocklist...');
  const blocklist = await fetchSpamBlocklist();
  const preFiltered = allTokens.filter(t => !blocklist.addresses.has(t.toLowerCase()));
  log('discover', `Address-filtered ${allTokens.length} → ${preFiltered.length}`);

  // previewClaim for each token against the vault, in parallel.
  log('discover', 'Querying previewClaim for each token...');
  const previews = await Promise.all(
    preFiltered.map(async (token) => {
      try {
        const amt = (await client.readContract({
          address: EPOCH_DIST_ADDR,
          abi: EPOCH_DIST_ABI,
          functionName: 'previewClaim',
          args: [VAULT_ADDR, token, targetEpoch],
        })) as bigint;
        return { token, amt };
      } catch {
        return { token, amt: 0n };
      }
    }),
  );
  const nonZero = previews.filter(p => p.amt > 0n);
  log('discover', `${nonZero.length} tokens with non-zero entitlement for epoch ${targetEpoch}`);

  if (nonZero.length === 0) return [];

  // Enrich with symbol + decimals; symbol-filter spam.
  const enriched = await Promise.all(
    nonZero.map(async ({ token, amt }) => {
      let symbol = '???';
      let decimals = 18;
      try {
        const [sym, dec] = await Promise.all([
          client.readContract({ address: token, abi: ERC20_BASIC_ABI, functionName: 'symbol' }) as Promise<string>,
          client.readContract({ address: token, abi: ERC20_BASIC_ABI, functionName: 'decimals' }) as Promise<number>,
        ]);
        symbol = sym;
        decimals = Number(dec);
      } catch {
        // keep defaults
      }
      return { address: token, symbol, decimals, claimable: amt };
    }),
  );

  const symbolFiltered = enriched.filter(t => {
    if (isSpamToken(t.address, t.symbol, blocklist)) {
      log('discover', `Symbol-filtered out: ${t.symbol} (${t.address})`);
      return false;
    }
    return true;
  });

  log('discover', `Final candidate set: ${symbolFiltered.length} tokens`);
  for (const t of symbolFiltered) {
    log('discover', `  ${t.symbol} → ${formatUnits(t.claimable, t.decimals)} (${t.address})`);
  }
  return symbolFiltered;
}

// ---------------------------------------------------------------------------
// Vault residue scan — find reward tokens physically sitting in the vault.
//
// Discovery (above) is entitlement-based (`previewClaim`): it only finds tokens
// the vault is still OWED for a given epoch. It cannot see tokens that were
// already CLAIMED into the vault but never swapped (e.g. stranded by a harvest
// whose swap step was dropped). Those just sit as ERC20 balances. This scan is
// balance-based, so the keeper can sweep *everything* in the vault to USDC each
// run — regardless of which epoch the tokens originated from — and leftovers
// never accumulate.
//
// USDC (the output asset) and iAERO (vault principal) are always excluded. The
// distributor's stiAERO receipt token must NEVER be swapped either: the vault
// HOLDS stiAERO (minted on stake, burned on withdraw), so swapping it away would
// brick withdrawals. It isn't a reward-registry token today, but we exclude it
// explicitly and dynamically (via receiptToken()) so a registry mishap can never
// let the sweep touch it.
async function buildSweepUniverse(
  client: PublicClient,
): Promise<{ tokens: Address[]; blocklist: Awaited<ReturnType<typeof fetchSpamBlocklist>> }> {
  const allTokens = (await client.readContract({
    address: REGISTRY_ADDRESS, abi: REGISTRY_ABI, functionName: 'allTokens',
  })) as readonly Address[];
  const blocklist = await fetchSpamBlocklist();

  const excluded = new Set([USDC_ADDR.toLowerCase(), IAERO_ADDR.toLowerCase()]);
  try {
    const receipt = (await client.readContract({
      address: EPOCH_DIST_ADDR, abi: EPOCH_DIST_ABI, functionName: 'receiptToken',
    })) as Address;
    if (receipt && receipt !== '0x0000000000000000000000000000000000000000') {
      excluded.add(receipt.toLowerCase());
    }
  } catch {
    log('discover', 'WARN: could not read receiptToken(); stiAERO not dynamically excluded from sweep');
  }

  const tokens = allTokens.filter(
    t => !excluded.has(t.toLowerCase()) && !blocklist.addresses.has(t.toLowerCase()),
  );
  return { tokens, blocklist };
}

/** Return every universe token the vault currently holds a non-zero balance of. */
async function scanVaultBalances(
  client: PublicClient,
  universe: Address[],
  blocklist: Awaited<ReturnType<typeof fetchSpamBlocklist>>,
  knownMeta: Map<string, ClaimableToken>,
): Promise<Array<{ tok: ClaimableToken; bal: bigint }>> {
  const balances = await Promise.all(
    universe.map(async (t) => {
      try {
        const bal = (await client.readContract({
          address: t, abi: ERC20_BASIC_ABI, functionName: 'balanceOf', args: [VAULT_ADDR],
        })) as bigint;
        return { t, bal };
      } catch {
        return { t, bal: 0n };
      }
    }),
  );

  const out: Array<{ tok: ClaimableToken; bal: bigint }> = [];
  for (const { t, bal } of balances) {
    if (bal === 0n) continue;
    let meta = knownMeta.get(t.toLowerCase());
    if (!meta) {
      let symbol = '???';
      let decimals = 18;
      try {
        const [sym, dec] = await Promise.all([
          client.readContract({ address: t, abi: ERC20_BASIC_ABI, functionName: 'symbol' }) as Promise<string>,
          client.readContract({ address: t, abi: ERC20_BASIC_ABI, functionName: 'decimals' }) as Promise<number>,
        ]);
        symbol = sym;
        decimals = Number(dec);
      } catch {
        // keep defaults
      }
      meta = { address: t, symbol, decimals, claimable: bal };
    }
    if (isSpamToken(t, meta.symbol, blocklist)) continue;
    // claimable carries the live balance so individualRetry quotes the full amount.
    out.push({ tok: { ...meta, claimable: bal }, bal });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan building (uses shared swap-pipeline)
// ---------------------------------------------------------------------------

interface BuiltPlan {
  steps: SwapStep[];
  tokensInPlan: Address[];
  totalQuotedUSDC: bigint;
  skippedTokens: Array<{ token: ClaimableToken; reason: string }>;
}

/** Build a swap plan by quoting each claimable token via 0x. */
async function buildSwapPlanFor(
  claimable: ClaimableToken[],
  opts: { forceHighSlippage: boolean; label: string },
): Promise<BuiltPlan> {
  log('quote', `Building swap plan via 0x [${opts.label}]...`);

  if (!ZERO_X_API_KEY) {
    die('quote', 'ZERO_X_API_KEY not set — cannot fetch 0x quotes');
  }
  const quoteFetcher = createDirectQuoteFetcher(ZERO_X_API_KEY);

  const steps: SwapStep[] = [];
  const tokensInPlan: Address[] = [];
  let totalQuotedUSDC = 0n;
  const skipped: Array<{ token: ClaimableToken; reason: string }> = [];

  for (const tok of claimable) {
    // USDC-as-reward: no swap needed, but still in tokensToClaim.
    if (tok.address.toLowerCase() === USDC_ADDR.toLowerCase()) {
      log('quote', `${tok.symbol}: claim only (USDC, no swap)`);
      continue;
    }

    const tokenForSwap: TokenForSwap = {
      address: tok.address,
      symbol: tok.symbol,
      decimals: tok.decimals,
      walletBN: tok.claimable,
      fullBalanceBN: tok.claimable,
    };

    const result = await getQuoteWithImpact({
      chainId: 8453,
      token: tokenForSwap,
      outToken: USDC_ADDR,
      outputPrice: 1,
      outputDecimals: 6,
      taker: SWAPPER_ADDRESS,
      fetcher: quoteFetcher,
    });

    if (!result.success) {
      log('quote', `${tok.symbol}: skipped — ${result.error}`);
      skipped.push({ token: tok, reason: result.error });
      continue;
    }

    if (result.lossPercent > AUTO_DESELECT_IMPACT_PERCENT) {
      log('quote', `${tok.symbol}: skipped — impact ${result.lossPercent.toFixed(2)}% > ${AUTO_DESELECT_IMPACT_PERCENT}%`);
      skipped.push({ token: tok, reason: `impact ${result.lossPercent.toFixed(2)}%` });
      continue;
    }

    const slippageBps = calculateSlippage(
      result.lossPercent,
      opts.forceHighSlippage || FORCE_HIGH_SLIPPAGE,
    );
    const step = buildSwapStepFromQuote({
      token:  tokenForSwap,
      outToken: USDC_ADDR,
      quote:  result.quote,
      slippageBps,
    });
    // Sell EXACTLY the quoted (entitlement) amount, not the vault's full balance.
    // useAll:true was unsafe: the swapper pulls balanceOf(vault) FIRST, then checks
    // quotedIn ∈ ±5% of the pulled amount. If same-token residue from a prior epoch
    // sits in the vault, balanceOf = entitlement + residue > quotedIn(entitlement),
    // the window fails, and the already-pulled tokens are STRANDED IN THE SWAPPER
    // (allowPartial swallows the skip). With useAll:false the swapper pulls exactly
    // amountIn = quotedIn = entitlement → window always holds; any residue stays in
    // the vault for the Tier-3 sweep, which quotes the live balance and handles it.
    step.useAll = false;

    steps.push(step);
    tokensInPlan.push(tok.address);
    totalQuotedUSDC += result.quote.buyAmount;
    log('quote', `${tok.symbol}: ${formatUnits(tok.claimable, tok.decimals)} → ${formatUnits(result.quote.buyAmount, 6)} USDC ` +
                 `(impact ${result.lossPercent.toFixed(2)}%, slippage ${slippageBps} bps)`);
  }

  log('quote', `Plan [${opts.label}]: ${steps.length} swap steps, ${formatUnits(totalQuotedUSDC, 6)} USDC quoted`);
  if (skipped.length > 0) log('quote', `Skipped: ${skipped.length} tokens`);

  return { steps, tokensInPlan, totalQuotedUSDC, skippedTokens: skipped };
}

/**
 * Re-fetch fresh 0x quotes for an existing set of steps, preserving the
 * pre-computed slippageBps. Returns a new plan with updated `data` / `quotedOut`.
 * Used right before broadcast so the swap calldata reflects current pool state.
 */
async function refreshQuotes(
  steps: SwapStep[],
  claimableByAddr: Map<string, ClaimableToken>,
): Promise<BuiltPlan> {
  log('refresh', `Refreshing ${steps.length} quotes immediately pre-broadcast...`);
  const quoteFetcher = createDirectQuoteFetcher(ZERO_X_API_KEY);

  const refreshed: SwapStep[] = [];
  const tokensInPlan: Address[] = [];
  let totalQuotedUSDC = 0n;

  for (const step of steps) {
    const tok = claimableByAddr.get(step.tokenIn.toLowerCase());
    if (!tok) {
      log('refresh', `WARN: unknown tokenIn ${step.tokenIn}; passing through stale step`);
      refreshed.push(step);
      tokensInPlan.push(step.tokenIn);
      totalQuotedUSDC += step.quotedOut;
      continue;
    }
    try {
      const quote = await quoteFetcher({
        chainId: 8453,
        sellToken: step.tokenIn,
        buyToken: USDC_ADDR,
        sellAmount: step.amountIn,
        taker: SWAPPER_ADDRESS,
      });
      if (!quote?.transaction?.data) throw new Error('no fresh quote data');
      const fresh: SwapStep = {
        ...step,
        quotedOut: BigInt(quote.buyAmount),
        data: encodeAbiParameters(
          [{ type: 'address' }, { type: 'bytes' }],
          [quote.transaction.to, quote.transaction.data],
        ) as `0x${string}`,
      };
      refreshed.push(fresh);
      tokensInPlan.push(step.tokenIn);
      totalQuotedUSDC += fresh.quotedOut;
      log('refresh', `  ${tok.symbol}: ${formatUnits(fresh.quotedOut, 6)} USDC (was ${formatUnits(step.quotedOut, 6)})`);
    } catch (e: any) {
      // If refresh fails, keep the old quote — better than dropping the step.
      log('refresh', `  ${tok.symbol}: refresh failed (${e.message || e}); keeping stale`);
      refreshed.push(step);
      tokensInPlan.push(step.tokenIn);
      totalQuotedUSDC += step.quotedOut;
    }
  }
  return { steps: refreshed, tokensInPlan, totalQuotedUSDC, skippedTokens: [] };
}

interface HarvestArgs {
  epoch:    bigint;
  tokens:   Address[];
  minUSDC:  bigint;
  finalize: boolean;
}

/** Simulate the vault.harvest() call. Returns null on success, error string on failure. */
async function simulateHarvest(
  client: PublicClient,
  account: Address,
  args: HarvestArgs,
  steps: SwapStep[],
): Promise<string | null> {
  try {
    await client.simulateContract({
      address: VAULT_ADDR,
      abi: HARVEST_ABI,
      functionName: 'harvest',
      args: [args.epoch, args.tokens, steps, args.minUSDC, args.finalize] as any,
      account,
    });
    return null;
  } catch (e: any) {
    return e.shortMessage || e.message || String(e);
  }
}

// Optional Slack/Discord-compatible incoming webhook. When set, every non-zero
// exit (failed harvest, failed deploy gate, unhandled crash) posts a message
// here so a human is paged instead of the failure sitting silently in the logs.
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';

/**
 * Best-effort failure alert. Never throws and never blocks shutdown for more
 * than ~5s; no-op when ALERT_WEBHOOK_URL is unset. Posts both `text` (Slack)
 * and `content` (Discord) keys — each provider ignores the other's field.
 */
async function sendAlert(title: string, body: string): Promise<void> {
  if (!ALERT_WEBHOOK_URL) return;
  const where = process.env.RAILWAY_SERVICE_NAME
    ? `${process.env.RAILWAY_SERVICE_NAME}/${process.env.RAILWAY_ENVIRONMENT_NAME ?? '?'}`
    : 'local';
  const text =
    `🚨 Auto-USDC keeper — ${title}\n${body}\n` +
    `vault=${VAULT_ADDR} epoch=${process.env.TARGET_EPOCH ?? 'latest'} host=${where}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      await fetch(ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, content: text }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
    log('alert', 'failure webhook sent');
  } catch (e: any) {
    log('alert', `WARN: could not send alert webhook: ${e?.message || e}`);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Block until the RPC has advanced to at least `target`. Load-balanced RPCs
 * (Alchemy, public fallbacks) serve reads from multiple nodes that lag the tip
 * by a block or two, so a `balanceOf`/`usdcForEpoch` read issued immediately
 * after a tx confirms can return PRE-tx state. That read-after-write race is
 * what made the Tier-3 sweep scan see a falsely "clean" vault right after the
 * claim landed and skip every retry, stranding the just-claimed tokens.
 * Polling the height first makes the subsequent `latest` reads consistent.
 */
async function waitForChainCatchUp(client: PublicClient, target: bigint, stage: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      if ((await client.getBlockNumber()) >= target) return;
    } catch { /* transient RPC blip — retry */ }
    await sleep(500);
  }
  log(stage, `WARN: RPC did not reach block ${target} after retries; post-tx reads may be stale`);
}

/**
 * Local nonce manager. viem's `writeContract` auto-fetches the nonce via
 * `eth_getTransactionCount('pending')` on EVERY send. Against a load-balanced
 * RPC that lags the tip (the same lag `waitForChainCatchUp` works around), that
 * read can return a STALE, too-low nonce in the moment right after a tx
 * confirmed — the next node hasn't seen the prior tx yet. The provider then
 * rejects the next send with -32602 "Missing or invalid parameters" or
 * "nonce too low". That is exactly what failed `finalize` (leaving an epoch
 * open) and several sweep txs in production: awaiting each receipt does NOT
 * help, because the implicit nonce read hits a different, laggy node.
 *
 * We fetch the nonce ONCE and track it locally, incrementing per accepted send,
 * so the laggy pending-count is never consulted mid-run. On a send error we
 * resync from chain but never move backwards (max of local vs chain), which
 * also recovers from a genuine "nonce too low" where the chain is ahead.
 *
 * Safe because the keeper sends strictly sequentially (chunks, then each sweep,
 * then finalize) — there is no concurrent submission to race this counter.
 */
class NonceManager {
  private next: number | null = null;
  constructor(
    private readonly client: PublicClient,
    private readonly address: Address,
  ) {}

  async init(): Promise<number> {
    this.next = await this.client.getTransactionCount({ address: this.address, blockTag: 'pending' });
    return this.next;
  }

  /** The nonce to attach to the next send. */
  peek(): number {
    if (this.next === null) throw new Error('NonceManager.init() not called');
    return this.next;
  }

  /** Advance after a tx was accepted into the mempool (a hash was returned). */
  consume(): void {
    if (this.next === null) throw new Error('NonceManager.init() not called');
    this.next += 1;
  }

  /** Re-sync from chain after a send error, never moving backwards. */
  async resync(): Promise<void> {
    const chain = await this.client.getTransactionCount({ address: this.address, blockTag: 'pending' });
    this.next = Math.max(this.next ?? chain, chain);
  }
}

/**
 * If the full plan reverts in simulation, drop steps one at a time until a
 * sub-plan passes. Same pattern as frontend's isolateProblemTokens but tested
 * via the whole vault.harvest call so we catch global-floor (minUSDC) issues
 * AND any contract-side validation failures.
 */
async function isolateExecutablePlan(
  client: PublicClient,
  account: Address,
  args: HarvestArgs,
  candidatePlan: SwapStep[],
): Promise<{ plan: SwapStep[]; dropped: SwapStep[]; lastError?: string }> {
  // The contract enforces `minUSDC` as a SINGLE aggregate floor over the whole
  // swapPlan. Each candidate subset must therefore be simulated against a floor
  // recomputed from *that subset's own* quotes — never the full plan's floor.
  //
  // Reusing the full-plan floor (the previous behaviour, where `args.minUSDC`
  // was passed unchanged to every trial sim) guarantees that every proper
  // subset under-delivers vs. the floor and reverts "total slippage". Isolation
  // then walks all the way down to the empty 0-step plan — the only subset whose
  // floor (0) it can ever satisfy — claiming all reward tokens but swapping
  // none. That is exactly what stranded ~$4.46 of rewards and left 20 tokens
  // sitting in the vault for epoch 1779926400.
  const floorFor = (steps: SwapStep[]): bigint =>
    (steps.reduce((s, st) => s + st.quotedOut, 0n) * MIN_USDC_PCT) / 100n;
  const simSubset = (steps: SwapStep[]) =>
    simulateHarvest(client, account, { ...args, minUSDC: floorFor(steps) }, steps);

  let err = await simSubset(candidatePlan);
  if (!err) return { plan: candidatePlan, dropped: [] };

  log('isolate', `Whole-plan sim failed: ${err.substring(0, 120)}`);
  log('isolate', `Isolating problem steps from ${candidatePlan.length} candidates...`);

  let remaining = [...candidatePlan];
  const dropped: SwapStep[] = [];
  let lastErr = err;

  // Iterative: at each outer pass, try removing each step in turn. If any
  // single removal makes sim pass, accept that subset. If no single removal
  // helps, drop the head and retry (handles the case where multiple steps
  // are individually problematic but the batch can survive a partial subset).
  // Worst case O(N²) sims for N steps. Mirrors frontend isolateProblemTokens.
  while (remaining.length > 0) {
    for (let i = 0; i < remaining.length; i++) {
      const trial = remaining.filter((_, j) => j !== i);
      const trialErr = await simSubset(trial);
      if (!trialErr) {
        log('isolate', `  drop ${remaining[i].tokenIn} → ${trial.length}-step plan passes`);
        dropped.push(remaining[i]);
        return { plan: trial, dropped };
      }
    }
    // No single removal helps — drop the head and retry the outer loop.
    log('isolate', `  no single removal fixes ${remaining.length}-step plan; dropping head and retrying`);
    dropped.push(remaining[0]);
    remaining = remaining.slice(1);
    const trialErr = await simSubset(remaining);
    if (!trialErr) return { plan: remaining, dropped };
    lastErr = trialErr;
  }
  return { plan: [], dropped, lastError: lastErr };
}

// ---------------------------------------------------------------------------
// Individual retry — per-token boosted-slippage swap for tokens left in the
// vault after the main batch broadcast. Each retry is its own harvest() call
// with empty tokensToClaim (the claim already happened in the main broadcast)
// and a single-step swap plan. minUSDC is set to the step's own boosted-slippage
// floor (quotedOut × (1 − slippageBps)) — NEVER 0. Because the vault calls the
// swapper with allowPartial:true, a minUSDC of 0 would let a swap pull the token
// out of the vault, deliver ~0 USDC (unbounded slippage), and strand it in the
// swapper. A real floor reverts that swap so the token stays in the vault — the
// documented behaviour (docs/AUTO_VAULT.md: "anything genuinely unswappable
// stays in the vault until an admin can resolve it manually").
// ---------------------------------------------------------------------------

interface IndividualRetryResult {
  symbol: string;
  address: Address;
  attempted: bigint;
  /** True only if tx confirmed AND USDC was actually delivered to the vault. */
  success: boolean;
  /** True if the tx confirmed on-chain (regardless of USDC delivered). */
  txConfirmed: boolean;
  txHash?: Hex;
  usdcOut?: bigint;
  error?: string;
}

async function individualRetry(
  publicClient: PublicClient,
  walletClient: WalletClient,
  account: ReturnType<typeof privateKeyToAccount>,
  token: ClaimableToken,
  vaultBalance: bigint,
  targetEpoch: bigint,
  quoteFetcher: ReturnType<typeof createDirectQuoteFetcher>,
  nonceManager: NonceManager,
): Promise<IndividualRetryResult> {
  const out: IndividualRetryResult = {
    symbol: token.symbol,
    address: token.address,
    attempted: vaultBalance,
    success: false,
    txConfirmed: false,
  };

  // Re-quote with FORCE high slippage so we accept worse routes than the main
  // batch's tight 30-bps floor.
  const tokenForSwap: TokenForSwap = {
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals,
    walletBN: vaultBalance,
    fullBalanceBN: vaultBalance,
  };
  const result = await getQuoteWithImpact({
    chainId: 8453,
    token: tokenForSwap,
    outToken: USDC_ADDR,
    outputPrice: 1,
    outputDecimals: 6,
    taker: SWAPPER_ADDRESS,
    fetcher: quoteFetcher,
  });
  if (!result.success) {
    return { ...out, error: `quote: ${result.error}` };
  }
  if (result.lossPercent > AUTO_DESELECT_IMPACT_PERCENT) {
    return { ...out, error: `impact ${result.lossPercent.toFixed(2)}% > ${AUTO_DESELECT_IMPACT_PERCENT}%` };
  }

  // Force high slippage so worse routes execute, but CAP it so the cleanup sweep
  // can never accept a near-zero fill (bounds value loss to MAX_SWEEP_SLIPPAGE_BPS).
  const slippageBps = Math.min(calculateSlippage(result.lossPercent, true), MAX_SWEEP_SLIPPAGE_BPS);
  const step = buildSwapStepFromQuote({
    token: tokenForSwap,
    outToken: USDC_ADDR,
    quote: result.quote,
    slippageBps,
  });
  step.useAll = true;

  // Per-step USDC floor = the step's own (boosted-slippage) expectation. The vault
  // always calls the swapper with allowPartial:true, so minTotalOut (this minUSDC)
  // is the ONLY thing stopping a swap that pulls the token but delivers ~0 USDC
  // from leaving it STRANDED in the swapper (where the vault sweep can't reach it).
  // With a real floor, such a swap reverts the whole harvest → the token transfer
  // rolls back → the token stays in the VAULT, recoverable on the next sweep,
  // never lost to the swapper. Using minUSDC=0 here is what stranded tokens before.
  const minOut = (step.quotedOut * BigInt(10000 - slippageBps)) / 10000n;
  if (minOut === 0n) {
    // Quote floors to nothing (illiquid dust). Don't attempt — that would pull the
    // token into the swapper with no protection. Leave it safely in the vault.
    return { ...out, error: `skipped: quoted floor rounds to 0 (illiquid); left in vault` };
  }

  // Simulate single-step harvest (no claim — tokens already in vault from main broadcast)
  const simErr = await simulateHarvest(
    publicClient,
    account.address,
    { epoch: targetEpoch, tokens: [], minUSDC: minOut, finalize: false },
    [step],
  );
  if (simErr) {
    return { ...out, error: `sim: ${simErr.substring(0, 200)}` };
  }

  // Capture USDC delta around the broadcast so we can report what was harvested.
  const usdcBefore = (await publicClient.readContract({
    address: USDC_ADDR, abi: ERC20_BASIC_ABI, functionName: 'balanceOf', args: [VAULT_ADDR],
  })) as bigint;

  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({
      address: VAULT_ADDR,
      abi: HARVEST_ABI,
      functionName: 'harvest',
      // viem's strict overload resolution can't infer ABI types through our
      // intermediate variables; the runtime path is exercised by the fork tests.
      args: [targetEpoch, [], [step], minOut, false] as any,
      account,
      chain: base,
      nonce: nonceManager.peek(),
    });
    nonceManager.consume();
  } catch (e: any) {
    await nonceManager.resync();
    return { ...out, error: `tx: ${(e.shortMessage || e.message || String(e)).substring(0, 200)}` };
  }

  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: RECEIPT_TIMEOUT_MS });
  } catch (e: any) {
    // The receipt never arrived → the sweep tx is stuck/unmined. Its nonce is
    // consumed locally but not on-chain, so every later tx (more sweeps, finalize)
    // would queue behind it. Abort the run; the next run self-heals.
    die('sweep', `${token.symbol} tx ${txHash} not mined in ${Math.round(RECEIPT_TIMEOUT_MS / 1000)}s (stuck?); aborting to avoid nonce-gap pileup`,
        { txHash, err: e.shortMessage || e.message });
  }
  try {
    if (receipt!.status !== 'success') {
      return { ...out, txHash, error: `reverted (block ${receipt!.blockNumber})` };
    }
    const usdcAfter = (await publicClient.readContract({
      address: USDC_ADDR, abi: ERC20_BASIC_ABI, functionName: 'balanceOf', args: [VAULT_ADDR],
    })) as bigint;
    const usdcOut = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0n;
    // With minUSDC = minOut (> 0), the swapper reverts any swap that would
    // deliver under the floor, so a CONFIRMED tx means USDC ≥ minOut was
    // delivered and the token is converted — it can no longer confirm-with-0
    // and strand in the swapper. The 0 branch is kept only as a defensive guard.
    return {
      ...out,
      txConfirmed: true,
      success: usdcOut > 0n,
      txHash,
      usdcOut,
      error: usdcOut === 0n ? 'tx confirmed but 0 USDC delivered (unexpected with floor)' : undefined,
    };
  } catch (e: any) {
    return { ...out, txHash, error: `receipt: ${e.shortMessage || e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Output persistence
// ---------------------------------------------------------------------------

function persistRun(payload: Record<string, unknown>) {
  // Note: on Railway this is ephemeral (gone on redeploy). The Railway log
  // stream is the durable audit trail; this is for local-run inspection.
  const outDir = path.resolve(__dirname, 'outputs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(outDir, `auto-usdc-vault-${ts}.json`);
  fs.writeFileSync(filename, JSON.stringify(payload, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v, 2));
  log('persist', `Wrote ${filename}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // ─────────────────────────────────────────────────────────────────────
  // Startup banner — comprehensive snapshot to make Railway logs easy to
  // diagnose. Every run begins with this block so when you scroll back to
  // a past run you have the full env context.
  // ─────────────────────────────────────────────────────────────────────
  if (WARMUP_RUN) {
    log('init', '┌─────────────────────────────────────────────────────────────┐');
    log('init', '│ WARM-UP RUN (Railway Pre-Deploy)                            │');
    log('init', '│ Gates the new deployment: if this run exits non-zero,       │');
    log('init', '│ Railway aborts the deploy and the old image stays live.     │');
    log('init', '│ Otherwise the new image is promoted and waits for the cron. │');
    log('init', '└─────────────────────────────────────────────────────────────┘');
    const rid = process.env.RAILWAY_DEPLOYMENT_ID;
    const sha = process.env.RAILWAY_GIT_COMMIT_SHA;
    const svc = process.env.RAILWAY_SERVICE_NAME;
    const env = process.env.RAILWAY_ENVIRONMENT_NAME;
    if (rid) log('init', `Railway deploy:  ${rid}`);
    if (sha) log('init', `Git commit SHA:  ${sha.slice(0, 12)}`);
    if (svc) log('init', `Service:         ${svc}`);
    if (env) log('init', `Environment:     ${env}`);
  }
  log('init', '═══════════════════════════════════════════════════════════════');
  log('init', `Auto-USDC vault keeper — vault=${VAULT_ADDR}` + (WARMUP_RUN ? ' (warm-up)' : ''));
  log('init', `node=${process.version} pid=${process.pid} cwd=${process.cwd()}`);
  log('init', `Config: DRY_RUN=${DRY_RUN} FINALIZE=${FINALIZE} MIN_USDC_PCT=${MIN_USDC_PCT} ` +
              `MAX_SWEEPS=${MAX_SWEEPS} EXECUTION_BATCH_SIZE=${EXECUTION_BATCH_SIZE} ` +
              `SKIP_INDIVIDUAL_RETRY=${SKIP_INDIVIDUAL_RETRY} LOG_LEVEL=${LOG_LEVEL}`);
  // Show only protocol + host of the RPC URL so we can debug which provider
  // is in use without leaking the API key embedded in the path. Works for any
  // RPC (Alchemy, QuickNode, Ankr, BlockPi, public — anything URL-parseable).
  const safeRpcUrl = (() => {
    try {
      const u = new URL(RPC_URL);
      const hasPath = u.pathname && u.pathname !== '/' && u.pathname !== '';
      return hasPath ? `${u.protocol}//${u.host}/[path-redacted]` : `${u.protocol}//${u.host}`;
    } catch { return '[invalid-url]'; }
  })();
  log('init', `Env presence: PRIVATE_KEY=${PRIVATE_KEY ? 'set' : 'MISSING'} ` +
              `ZERO_EX_API_KEY=${ZERO_X_API_KEY ? 'set' : 'MISSING'} ` +
              `RPC_URL=${safeRpcUrl}`);
  if (FORCE_HIGH_SLIPPAGE) {
    log('init', '⚠️  FORCE_HIGH_SLIPPAGE=1 — production should NOT have this set!');
  }

  if (!PRIVATE_KEY) die('init', 'PRIVATE_KEY env var is required');

  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  log('init', `Keeper EOA: ${account.address}`);

  // 60s timeout — anvil forks can be slow on first reads while populating state.
  const transport = http(RPC_URL, { timeout: 60_000, retryCount: 3 });
  const publicClient = createPublicClient({ chain: base, transport }) as PublicClient;
  const walletClient = createWalletClient({ account, chain: base, transport }) as WalletClient;

  // RPC health probe — print block + gas price so we know connectivity works
  // before doing any heavy reads. Failure here halts the run cleanly.
  try {
    const [latestBlock, gasPriceWei, ethBalance] = await Promise.all([
      publicClient.getBlockNumber(),
      publicClient.getGasPrice(),
      publicClient.getBalance({ address: account.address }),
    ]);
    log('init', `Chain: base block=${latestBlock} gasPrice=${formatUnits(gasPriceWei, 9)} gwei`);
    log('init', `Keeper ETH balance: ${formatEther(ethBalance)} ETH`);
    if (ethBalance < 1_000_000_000_000_000n) {  // 0.001 ETH
      log('init', '⚠️  Keeper ETH balance is low; top up the EOA to avoid failed broadcasts');
    }
  } catch (e: any) {
    die('init', `RPC health check failed: ${e.shortMessage || e.message || e}`);
  }

  // Local nonce tracking — never trust the laggy RPC pending-count mid-run.
  const nonceManager = new NonceManager(publicClient, account.address);
  try {
    await nonceManager.init();
    log('init', `Starting nonce: ${nonceManager.peek()}`);
  } catch (e: any) {
    die('init', `Could not fetch starting nonce: ${e.shortMessage || e.message || e}`);
  }
  log('init', '═══════════════════════════════════════════════════════════════');

  // -- Determine target epoch --
  const endDiscover = startPhase('determine-epoch');
  const currentEpoch = (await publicClient.readContract({
    address: EPOCH_DIST_ADDR, abi: EPOCH_DIST_ABI, functionName: 'currentEpoch',
  })) as bigint;
  const overrideEpoch = process.env.TARGET_EPOCH ? BigInt(process.env.TARGET_EPOCH) : null;
  const targetEpoch = overrideEpoch ?? (currentEpoch - WEEK);
  log('init', `currentEpoch=${currentEpoch}, targetEpoch=${targetEpoch}`);

  endDiscover();
  if (targetEpoch >= currentEpoch) die('init', 'targetEpoch must be < currentEpoch');

  // -- Pre-flight checks against the vault --
  const finalized = (await publicClient.readContract({
    address: VAULT_ADDR, abi: VAULT_ABI, functionName: 'epochFinalized', args: [targetEpoch],
  })) as boolean;
  if (finalized) {
    log('init', 'Epoch already finalized; nothing to do');
    process.exit(0);
  }
  const supplyAtEpochStart = (await publicClient.readContract({
    address: VAULT_ADDR, abi: VAULT_ABI, functionName: 'totalSupplyAtEpochStart', args: [targetEpoch],
  })) as bigint;
  if (supplyAtEpochStart === 0n) {
    log('init', `No vault stakers at epoch ${targetEpoch}; nothing to harvest`);
    process.exit(0);
  }
  log('init', `Vault supply at epoch start: ${formatUnits(supplyAtEpochStart, 18)} iAERO`);

  // -- Discover claimable tokens (entitlement for this epoch) --
  const claimable = await discoverClaimableTokens(publicClient, targetEpoch);
  const claimableByAddr = new Map<string, ClaimableToken>(
    claimable.map(c => [c.address.toLowerCase(), c]),
  );

  // -- Scan the vault for reward tokens already sitting in it --
  // These include anything stranded by a prior epoch's claim-but-no-swap. We
  // sweep them to USDC every run (see Tier 3 below), regardless of origin epoch,
  // so residue never piles up. Built once; balances re-read each sweep pass.
  const sweepUniverse = await buildSweepUniverse(publicClient);
  const vaultResident = await scanVaultBalances(
    publicClient, sweepUniverse.tokens, sweepUniverse.blocklist, claimableByAddr,
  );
  if (vaultResident.length > 0) {
    log('discover',
      `Vault holds ${vaultResident.length} reward token(s) to sweep` +
      (claimable.length === 0 ? ' (stranded from a prior epoch)' : ' (incl. any prior-epoch residue)'));
  }

  if (claimable.length === 0 && vaultResident.length === 0) {
    log('main', 'Nothing claimable and vault is clean — nothing to do');
    process.exit(0);
  }

  // sweepOnly: skip the claim/main-swap broadcast and go straight to the Tier-3
  // sweep, converting whatever is already in the vault. Triggered either because
  // there's nothing new to claim, or because SWEEP_ON_START forces a drain run
  // (e.g. on deploy, to recover stranded residue without touching fresh epochs).
  const sweepOnly = SWEEP_ON_START || claimable.length === 0;
  if (sweepOnly) {
    const why = SWEEP_ON_START
      ? `SWEEP_ON_START set — draining vault to USDC (bucketing to epoch ${targetEpoch})`
      : `nothing newly claimable for epoch ${targetEpoch}`;
    log('main', `Sweep-only run: ${why}; ${vaultResident.length} vault token(s) to convert`);
  }

  // Tokens to claim = all claimable (claimed raw, then swapped/swept). Empty in
  // sweep-only mode — we only convert balances already in the vault.
  const tokensToClaim = sweepOnly ? [] : claimable.map(c => c.address);

  // Claim-path plan building / isolation only runs for a normal (non-sweep) run.
  let plan: BuiltPlan = { steps: [], tokensInPlan: [], totalQuotedUSDC: 0n, skippedTokens: [] };
  let workingSteps: SwapStep[] = [];
  let droppedSteps: SwapStep[] = [];
  let lastError: string | undefined;
  let attemptedRetry = false;

  if (!sweepOnly) {
    // ---------------- Attempt 1: normal slippage ----------------
    plan = await buildSwapPlanFor(claimable, { forceHighSlippage: false, label: 'normal' });
    let minUSDC = (plan.totalQuotedUSDC * MIN_USDC_PCT) / 100n;
    let baseArgs: HarvestArgs = { epoch: targetEpoch, tokens: tokensToClaim, minUSDC, finalize: FINALIZE };

    log('main', `minUSDC floor: ${formatUnits(minUSDC, 6)} (${MIN_USDC_PCT}% of ${formatUnits(plan.totalQuotedUSDC, 6)})`);

    // Isolate: if the whole plan would revert, drop steps until it passes.
    log('simulate', 'Simulating harvest + isolating any problem steps...');
    const isolated = await isolateExecutablePlan(publicClient, account.address, baseArgs, plan.steps);
    workingSteps = isolated.plan;
    droppedSteps = isolated.dropped;
    lastError = isolated.lastError;

    // ---------------- Attempt 2: boosted retry if isolation gave us nothing ----------------
    if (workingSteps.length === 0 && !DRY_RUN) {
      const reason = lastError
        ? `last sim error: ${lastError.substring(0, 100)}`
        : 'isolation reduced plan to 0 swap steps (all swaps would revert under current floor)';
      log('main', `Normal-slippage plan yields no swaps (${reason}); retrying with boosted slippage...`);
      attemptedRetry = true;
      plan = await buildSwapPlanFor(claimable, { forceHighSlippage: true, label: 'boosted' });
      minUSDC = (plan.totalQuotedUSDC * MIN_USDC_PCT) / 100n;
      baseArgs = { epoch: targetEpoch, tokens: tokensToClaim, minUSDC, finalize: FINALIZE };
      log('main', `minUSDC floor (boosted): ${formatUnits(minUSDC, 6)}`);

      const retried = await isolateExecutablePlan(publicClient, account.address, baseArgs, plan.steps);
      workingSteps = retried.plan;
      droppedSteps = retried.dropped;
      lastError = retried.lastError;
    }

    if (workingSteps.length === 0 && tokensToClaim.length === 0) {
      die('main', 'Nothing executable and no tokens to claim — giving up');
    }
    if (workingSteps.length === 0) {
      log('main', `No swaps will execute; harvest will only claim raw tokens. Last sim error: ${lastError?.substring(0, 200)}`);
    } else if (droppedSteps.length > 0) {
      log('main', `Final plan: ${workingSteps.length} steps (dropped ${droppedSteps.length} via isolation)`);
    } else {
      log('main', `Final plan: ${workingSteps.length} steps (all passed isolation)`);
    }
  }

  const finalPlan = plan;
  const minUSDC = (finalPlan.totalQuotedUSDC * MIN_USDC_PCT) / 100n;  // reporting only

  // ---------------- WARM-UP (pre-deploy gate) exit ----------------
  // A warm-up run is Railway's pre-deploy gate. Its ONLY job is to validate the
  // new image end-to-end and decide (via exit code) whether the deploy is
  // promoted — then "wait for the cron" to do the real harvest. It must NEVER
  // broadcast: a deploy gate that moves real funds is what claimed-but-didn't-
  // swap epoch 1779926400 and stranded its rewards. We've already discovered,
  // quoted, and isolated above; now exit 0 if a viable plan exists (or there
  // were simply no swappable rewards), or non-zero to ABORT the deploy when
  // swappable rewards exist but no executable swap plan could be built.
  if (WARMUP_RUN) {
    const swappableExisted = finalPlan.totalQuotedUSDC > 0n;
    const planViable = workingSteps.length > 0 || !swappableExisted;
    log('broadcast', 'WARM-UP (pre-deploy gate) — validation only, NOT broadcasting');
    log('broadcast', `  swappable rewards quoted: ${formatUnits(finalPlan.totalQuotedUSDC, 6)} USDC`);
    log('broadcast', `  executable swap steps:    ${workingSteps.length} (dropped ${droppedSteps.length} via isolation)`);
    persistRun({
      kind:     'auto-usdc-vault-keeper',
      mode:     'warmup',
      ts:       Date.now(),
      epoch:    targetEpoch,
      keeper:   account.address,
      claimable,
      attemptedRetry,
      finalSteps: workingSteps.length,
      droppedSteps: droppedSteps.length,
      plan: {
        stepCount:       workingSteps.length,
        totalQuotedUSDC: finalPlan.totalQuotedUSDC,
        skippedTokens:   finalPlan.skippedTokens.map(s => ({ symbol: s.token.symbol, addr: s.token.address, reason: s.reason })),
      },
      planViable,
      finalize: FINALIZE,
    });
    if (!planViable) {
      die('warmup',
        `Pre-deploy gate FAILED: ${formatUnits(finalPlan.totalQuotedUSDC, 6)} USDC of swappable rewards ` +
        `but isolation produced 0 executable swaps — deploy aborted, old image stays live`);
    }
    log('main', 'Warm-up gate PASSED — image promoted; the real harvest runs on the scheduled cron.');
    process.exit(0);
  }

  // ---------------- DRY_RUN exit ----------------
  // (The pre-broadcast refresh that used to live here is now done per-chunk
  // inside the main broadcast loop, so quotes are always <5s old at tx time.)
  if (DRY_RUN) {
    log('broadcast', 'DRY_RUN=1 — skipping send');
    persistRun({
      kind:     'auto-usdc-vault-keeper',
      mode:     'dry-run',
      ts:       Date.now(),
      epoch:    targetEpoch,
      keeper:   account.address,
      claimable,
      attemptedRetry,
      finalSteps: workingSteps.length,
      droppedSteps: droppedSteps.length,
      plan: {
        stepCount:       workingSteps.length,
        totalQuotedUSDC: finalPlan.totalQuotedUSDC,
        skippedTokens:   finalPlan.skippedTokens.map(s => ({ symbol: s.token.symbol, addr: s.token.address, reason: s.reason })),
      },
      minUSDC,
      finalize: FINALIZE,
    });
    process.exit(0);
  }

  const ethBalance = await publicClient.getBalance({ address: account.address });
  log('broadcast', `Keeper ETH balance: ${formatEther(ethBalance)} ETH`);

  // ---------------- Main broadcast — CLAIM FIRST, THEN SWAP ----------------
  // The claim and the swaps are DECOUPLED on purpose. Bundling them (the old
  // "chunk 1 claims + swaps under a 95% floor" design) meant a single token's
  // swap slipping below the aggregate floor reverted the whole tx — claim and
  // all — and the keeper then die()d, never reaching the per-token sweep. That
  // is exactly what stranded epoch 1781740800.
  //
  //   Phase 1: a dedicated claim-only harvest (no swap plan, no slippage floor).
  //            Banks the directly-claimed USDC + pulls every raw reward token
  //            into the vault. Cannot revert on slippage. Only a claim that
  //            banks NOTHING is fatal.
  //   Phase 2: swap-only chunks. Every failure is NON-fatal — whatever a batch
  //            can't convert is left in the vault for the Tier-3 per-token sweep
  //            (boosted slippage), which is now always reached.
  // finalize=false everywhere here; the flag is flipped by the separate finalize
  // tx at the very end (after the Tier-3 sweep). sweepOnly skips straight to it.

  interface ChunkRecord { chunk: number; txHash?: Hex; gasUsed?: bigint; success: boolean; error?: string; usdcAfter: bigint }
  const chunkResults: ChunkRecord[] = [];
  let lastTxHash: Hex | undefined;
  let lastReceiptBlock: bigint | undefined;
  let totalGasUsed = 0n;

  // Snapshot the epoch's USDC bucket BEFORE we do anything. On a re-run of an
  // unfinalized epoch the bucket already holds prior-run USDC, so the end-of-run
  // health gate must measure THIS run's contribution as a delta, not the absolute.
  const bucketedAtStart = (await publicClient.readContract({
    address: VAULT_ADDR, abi: VAULT_ABI, functionName: 'usdcForEpoch', args: [targetEpoch],
  })) as bigint;

  // ---- Phase 1: CLAIM (dedicated tx, no swaps, no slippage floor) ----
  // `claimBanked` => at least one batch landed (so we have something to work with).
  // `allClaimBatchesLanded` => EVERY batch landed; it gates finalize, because
  // finalizing while a batch's entitlement is still unclaimed would strand it
  // behind the vault's AlreadyFinalized guard (admin-unfinalize-only recovery).
  let claimBanked = false;
  let allClaimBatchesLanded = true;
  if (!sweepOnly && tokensToClaim.length > 0) {
    const CLAIM_BATCH = 40; // stay under the vault's 50-token cap
    for (let i = 0; i < tokensToClaim.length; i += CLAIM_BATCH) {
      const batch = tokensToClaim.slice(i, i + CLAIM_BATCH);
      log('claim', `Claiming ${batch.length} token(s) — no swaps, no floor (banks USDC + pulls raw tokens)`);
      let landed = false;
      for (let attempt = 1; attempt <= 2 && !landed; attempt++) {
        // Split send from receipt-wait so the two failure modes get the right
        // nonce treatment (mirrors the Phase-2 chunk loop and Tier-3 sweep):
        //   • send throws        → nonce NOT consumed on-chain → resync + retry (no gap)
        //   • receipt-wait throws→ send DID consume the nonce, tx stuck → die() (a
        //                          retry would queue behind it on a nonce gap)
        //   • reverted receipt   → nonce consumed on-chain (no gap) → retry, NO resync
        let h: Hex;
        try {
          h = await walletClient.writeContract({
            address: VAULT_ADDR, abi: HARVEST_ABI, functionName: 'harvest',
            args: [targetEpoch, batch, [], 0n, false] as any,
            account, chain: base, nonce: nonceManager.peek(),
          });
          nonceManager.consume();
          log('claim', `  tx: ${h}`);
        } catch (e: any) {
          await nonceManager.resync();
          const msg = (e.shortMessage || e.message || String(e)).substring(0, 200);
          log('claim', `  ✗ claim send attempt ${attempt} failed: ${msg}${attempt < 2 ? ' — retrying' : ''}`);
          if (attempt < 2) { await sleep(2000); continue; }
          chunkResults.push({ chunk: chunkResults.length + 1, success: false, error: msg, usdcAfter: 0n });
          continue;
        }
        let rcpt;
        try {
          rcpt = await publicClient.waitForTransactionReceipt({ hash: h, timeout: RECEIPT_TIMEOUT_MS });
        } catch (e: any) {
          die('claim', `claim tx ${h} not mined in ${Math.round(RECEIPT_TIMEOUT_MS / 1000)}s (stuck?); aborting to avoid nonce-gap pileup`,
              { txHash: h, err: e.shortMessage || e.message });
        }
        if (rcpt.status === 'success') {
          landed = true; claimBanked = true;
          lastTxHash = h; lastReceiptBlock = rcpt.blockNumber; totalGasUsed += rcpt.gasUsed;
          chunkResults.push({ chunk: chunkResults.length + 1, txHash: h, gasUsed: rcpt.gasUsed, success: true, usdcAfter: 0n });
          log('claim', `  ✓ claimed in block ${rcpt.blockNumber}, gas=${rcpt.gasUsed}`);
        } else {
          log('claim', `  ✗ claim tx reverted (block ${rcpt.blockNumber})${attempt < 2 ? ' — retrying' : ''}`);
          if (attempt >= 2) chunkResults.push({ chunk: chunkResults.length + 1, txHash: h, success: false, error: `reverted (block ${rcpt.blockNumber})`, usdcAfter: 0n });
        }
      }
      if (!landed) allClaimBatchesLanded = false;
    }
    if (!claimBanked) {
      // Nothing banked at all — the only genuinely fatal broadcast condition
      // (almost always RPC/funds, never slippage now). Surface for investigation.
      die('claim', 'All claim attempts failed — nothing claimed; aborting for investigation');
    }
    if (!allClaimBatchesLanded) {
      // Some (not all) batches landed. We keep going to swap/sweep what we DID
      // claim, but finalize is suppressed below so the un-claimed batch can be
      // picked up by a re-run instead of being locked out by AlreadyFinalized.
      log('claim', 'WARN: a claim batch failed — epoch will be left OPEN (finalize suppressed) so a re-run can claim the rest');
    }
    // Let laggy RPC nodes catch up so the swap chunks see the freshly-claimed balances.
    if (lastReceiptBlock) await waitForChainCatchUp(publicClient, lastReceiptBlock, 'claim');
  } else if (sweepOnly) {
    log('claim', 'Sweep-only run — skipping claim; converting existing vault balances');
  }

  // ---- Phase 2: SWAP in chunks (swap-only; every failure is NON-fatal) ----
  const numChunks = sweepOnly ? 0 : Math.ceil(workingSteps.length / EXECUTION_BATCH_SIZE);
  if (sweepOnly) {
    log('broadcast', 'Sweep-only run — proceeding to vault sweep');
  } else if (numChunks > 0) {
    log('broadcast', `Swapping in ${numChunks} chunk(s) of up to ${EXECUTION_BATCH_SIZE} step(s) — batch failures fall through to the per-token sweep`);
  } else {
    log('broadcast', 'No executable swap steps — proceeding straight to the per-token sweep');
  }

  for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
    const chunkStart = chunkIdx * EXECUTION_BATCH_SIZE;
    const chunkEnd   = Math.min(chunkStart + EXECUTION_BATCH_SIZE, workingSteps.length);
    // Claim was done up front in Phase 1, so every chunk here is swap-only.
    const chunkTokensToClaim: Address[] = [];

    log('chunk', `═════ Swap chunk ${chunkIdx + 1}/${numChunks} ═════`);

    // --- JIT refresh THIS chunk's quotes ---
    let chunkSteps = workingSteps.slice(chunkStart, chunkEnd);
    if (chunkSteps.length > 0) {
      const refreshed = await refreshQuotes(chunkSteps, claimableByAddr);
      chunkSteps = refreshed.steps;
    }

    // Compute per-chunk minUSDC based on this chunk's refreshed quotes only.
    const chunkQuotedSum = chunkSteps.reduce((s, st) => s + st.quotedOut, 0n);
    const chunkMinUSDC = (chunkQuotedSum * MIN_USDC_PCT) / 100n;
    const chunkArgs: HarvestArgs = {
      epoch:    targetEpoch,
      tokens:   chunkTokensToClaim,
      minUSDC:  chunkMinUSDC,
      finalize: false,
    };
    log('chunk', `  steps=${chunkSteps.length} claims=${chunkTokensToClaim.length} ` +
                  `quoted=${formatUnits(chunkQuotedSum, 6)} USDC floor=${formatUnits(chunkMinUSDC, 6)} USDC`);

    // --- Per-chunk sim + re-isolate if needed ---
    if (chunkSteps.length > 0) {
      const simErr = await simulateHarvest(publicClient, account.address, chunkArgs, chunkSteps);
      if (simErr) {
        log('chunk', `  sim failed; re-isolating within chunk... (${simErr.substring(0, 100)})`);
        const reIso = await isolateExecutablePlan(publicClient, account.address, chunkArgs, chunkSteps);
        chunkSteps = reIso.plan;
        droppedSteps = [...droppedSteps, ...reIso.dropped];
        // Recompute floor against the now-smaller chunk
        const newSum = chunkSteps.reduce((s, st) => s + st.quotedOut, 0n);
        chunkArgs.minUSDC = (newSum * MIN_USDC_PCT) / 100n;
        log('chunk', `  after isolation: ${chunkSteps.length} step(s), new floor=${formatUnits(chunkArgs.minUSDC, 6)} USDC`);
      }
    }

    // Isolation dropped every step in this chunk — nothing to broadcast. The
    // dropped tokens stay in the vault and are picked up by the Tier-3 sweep.
    if (chunkSteps.length === 0) {
      log('chunk', `  no executable steps — deferring these tokens to the per-token sweep`);
      chunkResults.push({ chunk: chunkIdx + 1, success: true, usdcAfter: 0n });
      continue;
    }

    // --- Broadcast this chunk ---
    let chunkTxHash: Hex;
    try {
      chunkTxHash = await walletClient.writeContract({
        address: VAULT_ADDR,
        abi: HARVEST_ABI,
        functionName: 'harvest',
        args: [targetEpoch, chunkTokensToClaim, chunkSteps, chunkArgs.minUSDC, false] as any,
        account,
        chain: base,
        nonce: nonceManager.peek(),
      });
      nonceManager.consume();
    } catch (e: any) {
      await nonceManager.resync();
      const msg = (e.shortMessage || e.message || String(e)).substring(0, 200);
      log('chunk', `  ✗ swap chunk failed: ${msg}`);
      chunkResults.push({ chunk: chunkIdx + 1, success: false, error: msg, usdcAfter: 0n });
      // Non-fatal: the claim already banked separately, so these tokens are safe
      // in the vault. The Tier-3 per-token sweep retries each one individually
      // with boosted slippage. Never crash the run on a swap failure.
      continue;
    }
    log('chunk', `  tx: ${chunkTxHash}`);

    let chunkReceipt;
    try {
      chunkReceipt = await publicClient.waitForTransactionReceipt({ hash: chunkTxHash, timeout: RECEIPT_TIMEOUT_MS });
    } catch (e: any) {
      // A THROWN receipt wait (vs a returned reverted receipt) means the tx is
      // stuck/unmined — its nonce is consumed locally but not on-chain. Continuing
      // would build finalize + later sweeps on a nonce gap behind it, so abort the
      // run; the next run re-reads the pending nonce and self-heals.
      const msg = (e.shortMessage || e.message || String(e)).substring(0, 200);
      log('chunk', `  ⚠ receipt unobtainable: ${msg}`);
      chunkResults.push({ chunk: chunkIdx + 1, txHash: chunkTxHash, success: false, error: `receipt: ${msg}`, usdcAfter: 0n });
      die('broadcast', `Chunk ${chunkIdx + 1} tx ${chunkTxHash} not mined (stuck?); aborting to avoid nonce-gap`, { txHash: chunkTxHash, msg });
    }
    if (chunkReceipt!.status !== 'success') {
      // Reverted txs still mine and consume their nonce — no gap, safe to continue.
      // Non-fatal: tokens stay in the vault for the Tier-3 per-token sweep.
      log('chunk', `  ✗ swap chunk reverted (block ${chunkReceipt!.blockNumber})`);
      chunkResults.push({ chunk: chunkIdx + 1, txHash: chunkTxHash, success: false, error: `reverted (block ${chunkReceipt!.blockNumber})`, usdcAfter: 0n });
      continue;
    }
    lastTxHash = chunkTxHash;
    lastReceiptBlock = chunkReceipt!.blockNumber;
    totalGasUsed += chunkReceipt!.gasUsed;
    log('chunk', `  ✓ confirmed in block ${chunkReceipt!.blockNumber}, gas=${chunkReceipt!.gasUsed}`);
    try {
      const usdcAfter = (await publicClient.readContract({
        address: VAULT_ADDR, abi: VAULT_ABI, functionName: 'usdcForEpoch', args: [targetEpoch],
      })) as bigint;
      chunkResults.push({ chunk: chunkIdx + 1, txHash: chunkTxHash, gasUsed: chunkReceipt!.gasUsed, success: true, usdcAfter });
    } catch {
      // Post-success read blip — the chunk DID mine (nonce consumed on-chain, no
      // gap). Record success without the usdcAfter figure rather than aborting.
      chunkResults.push({ chunk: chunkIdx + 1, txHash: chunkTxHash, gasUsed: chunkReceipt!.gasUsed, success: true, usdcAfter: 0n });
    }
  }

  // Backwards-compat reporting fields (kept so the persistRun shape matches earlier runs)
  const txHash = lastTxHash ?? ('0x' as Hex);
  const receipt = { blockNumber: lastReceiptBlock ?? 0n, gasUsed: totalGasUsed };

  // Ensure the RPC has caught up to the claim/swap tx before we read balances,
  // otherwise the post-main `usdcForEpoch` read and the Tier-3 sweep's vault
  // scan can observe stale pre-claim state and wrongly conclude there's nothing
  // to sweep (see waitForChainCatchUp).
  if (lastReceiptBlock) await waitForChainCatchUp(publicClient, lastReceiptBlock, 'sweep');

  let bucketed = (await publicClient.readContract({
    address: VAULT_ADDR, abi: VAULT_ABI, functionName: 'usdcForEpoch', args: [targetEpoch],
  })) as bigint;
  log('main', `usdcForEpoch[${targetEpoch}] after main: ${formatUnits(bucketed, 6)} USDC`);

  // ---------------- Tier 3: sweep EVERY reward token in the vault, up to MAX_SWEEPS passes ----------------
  // Scans the vault's full reward-token balance (not just this epoch's claimable
  // set), so tokens stranded by any prior epoch get converted too. Each token is
  // a single-step boosted-slippage swap as its own harvest() call. Each pass
  // re-scans the vault + re-fetches fresh 0x quotes, so transient failures (rate
  // limits, brief liquidity moves) get retried. USDC/iAERO are excluded by the
  // sweep universe; the swept USDC buckets to the current targetEpoch.
  const individualResults: Array<IndividualRetryResult & { pass: number }> = [];
  if (!SKIP_INDIVIDUAL_RETRY) {
    const quoteFetcher = createDirectQuoteFetcher(ZERO_X_API_KEY);
    let totalPasses = 0;

    for (let pass = 1; pass <= MAX_SWEEPS; pass++) {
      totalPasses = pass;
      // Re-scan the whole vault — picks up this epoch's un-swapped claims AND
      // any residue stranded by earlier epochs.
      const candidates = await scanVaultBalances(
        publicClient, sweepUniverse.tokens, sweepUniverse.blocklist, claimableByAddr,
      );

      if (candidates.length === 0) {
        log('sweep', `pass ${pass}/${MAX_SWEEPS}: vault is clean, no more sweeps needed`);
        break;
      }

      log('sweep', `pass ${pass}/${MAX_SWEEPS}: ${candidates.length} token(s) still in vault — individual retries`);
      let anyDeliveredUSDC = false;
      for (const { tok, bal } of candidates) {
        log('sweep', `  attempting ${tok.symbol} (${formatUnits(bal, tok.decimals)})...`);
        const r = await individualRetry(
          publicClient, walletClient, account, tok, bal, targetEpoch, quoteFetcher, nonceManager,
        );
        individualResults.push({ ...r, pass });
        if (r.success) {
          anyDeliveredUSDC = true;
          log('sweep', `    ✓ ${tok.symbol}: ${formatUnits(r.usdcOut || 0n, 6)} USDC (tx ${r.txHash})`);
        } else if (r.txConfirmed) {
          log('sweep', `    ⚠ ${tok.symbol}: tx confirmed but 0 USDC delivered — token now in swapper (tx ${r.txHash})`);
        } else {
          log('sweep', `    ✗ ${tok.symbol}: ${r.error?.substring(0, 160)}`);
        }
      }

      // Stop early if a pass made no progress: either no USDC was delivered
      // AND no transient errors (txConfirmed: false) were retried. After
      // pass 2, if we have neither delivered USDC nor recovered from a
      // prior transient error, further passes won't help.
      if (!anyDeliveredUSDC && pass >= 2) {
        log('sweep', `pass ${pass}: no USDC delivered; remaining tokens are deterministically un-swappable, stopping early`);
        break;
      }
    }

    if (totalPasses > 1) log('sweep', `completed ${totalPasses} sweep pass(es)`);

    // Refresh bucketed total
    bucketed = (await publicClient.readContract({
      address: VAULT_ADDR, abi: VAULT_ABI, functionName: 'usdcForEpoch', args: [targetEpoch],
    })) as bigint;
    log('main', `usdcForEpoch[${targetEpoch}] after all sweeps: ${formatUnits(bucketed, 6)} USDC`);
  }

  // ---------------- Finalize ----------------
  // Single empty-plan harvest call just to flip the finalized flag.
  //
  // Guard: never finalize an epoch that still has UNCLAIMED entitlement. Two ways
  // that can happen: (a) a SWEEP_ON_START drain run deliberately skips claiming,
  // and (b) a multi-batch claim where some batch failed (allClaimBatchesLanded
  // is false). Finalizing in either case would lock the un-claimed entitlement
  // out behind the vault's AlreadyFinalized guard (admin-unfinalize-only
  // recovery). Only finalize for a normal harvest whose claim FULLY landed, or a
  // sweep where there was genuinely nothing left to claim.
  const claimIncomplete = !sweepOnly && !allClaimBatchesLanded;
  const shouldFinalize = FINALIZE && (!sweepOnly || claimable.length === 0) && !claimIncomplete;
  let finalizeTxHash: Hex | undefined;
  if (shouldFinalize) {
    log('finalize', 'Finalizing epoch...');
    try {
      finalizeTxHash = await walletClient.writeContract({
        address: VAULT_ADDR,
        abi: HARVEST_ABI,
        functionName: 'harvest',
        args: [targetEpoch, [], [], 0n, true] as any,
        account,
        chain: base,
        nonce: nonceManager.peek(),
      });
      nonceManager.consume();
      const finReceipt = await publicClient.waitForTransactionReceipt({ hash: finalizeTxHash, timeout: RECEIPT_TIMEOUT_MS });
      if (finReceipt.status !== 'success') {
        log('finalize', `WARN: finalize tx reverted (${finalizeTxHash}); epoch left open`);
      } else {
        log('finalize', `Finalized: ${finalizeTxHash}`);
      }
    } catch (e: any) {
      await nonceManager.resync();
      log('finalize', `WARN: finalize call failed (${e.shortMessage || e.message}); epoch left open`);
    }
  } else if (!FINALIZE) {
    log('finalize', 'FINALIZE=0 — epoch left open');
  } else if (claimIncomplete) {
    log('finalize', `A claim batch failed — leaving epoch ${targetEpoch} OPEN (finalize suppressed) so its un-claimed entitlement isn't stranded behind AlreadyFinalized; re-run to finish`);
    await sendAlert('claim incomplete — epoch left open',
      `epoch ${targetEpoch}: at least one claim batch failed; finalize skipped so a re-run can claim the rest`);
  } else {
    log('finalize', `SWEEP_ON_START drain with ${claimable.length} token(s) still claimable — leaving epoch ${targetEpoch} open for its normal harvest`);
  }

  // ---------------- Postflight: residual tokens still in vault or swapper ----------------
  const stuckInSwapper: Array<{ address: Address; balance: bigint }> = [];
  const stuckInVault: Array<{ address: Address; balance: bigint }> = [];
  for (const tok of claimable) {
    if (tok.address.toLowerCase() === USDC_ADDR.toLowerCase()) continue;
    try {
      const inSwapper = (await publicClient.readContract({
        address: tok.address, abi: ERC20_BASIC_ABI, functionName: 'balanceOf', args: [SWAPPER_ADDRESS],
      })) as bigint;
      if (inSwapper > 0n) stuckInSwapper.push({ address: tok.address, balance: inSwapper });

      const inVault = (await publicClient.readContract({
        address: tok.address, abi: ERC20_BASIC_ABI, functionName: 'balanceOf', args: [VAULT_ADDR],
      })) as bigint;
      if (inVault > 0n) stuckInVault.push({ address: tok.address, balance: inVault });
    } catch {}
  }
  if (stuckInSwapper.length > 0) {
    log('postflight', `Stuck in swapper (may include other callers'):`);
    for (const s of stuckInSwapper) log('postflight', `  ${s.address}: ${s.balance}`);
  }
  if (stuckInVault.length > 0) {
    log('postflight', `Still in vault (admin rescue candidates):`);
    for (const s of stuckInVault) log('postflight', `  ${s.address}: ${s.balance}`);
  }

  persistRun({
    kind:     'auto-usdc-vault-keeper',
    mode:     'broadcast',
    ts:       Date.now(),
    epoch:    targetEpoch,
    keeper:   account.address,
    txHash,                        // last chunk's tx hash (backwards-compat field)
    finalizeTxHash,
    blockNumber: receipt.blockNumber,
    gasUsed:  receipt.gasUsed,     // sum across all chunks
    usdcBucketed: bucketed,
    attemptedRetry,
    claimable,
    plan: {
      stepCount:       workingSteps.length,
      droppedSteps:    droppedSteps.length,
      totalQuotedUSDC: finalPlan.totalQuotedUSDC,
      skippedTokens:   finalPlan.skippedTokens.map(s => ({ symbol: s.token.symbol, addr: s.token.address, reason: s.reason })),
      droppedAddrs:    droppedSteps.map(s => s.tokenIn),
    },
    chunks: chunkResults,          // NEW: per-chunk tx hashes + gas + USDC progression
    individualRetries: individualResults,
    stuckInSwapper,
    stuckInVault,
    minUSDC,
    finalize: FINALIZE,
  });

  // ─────────────────────────────────────────────────────────────────────
  // End-of-run summary — single block at the bottom of every log so the
  // most recent run's outcome is at-a-glance in Railway's log tail.
  // ─────────────────────────────────────────────────────────────────────
  const successfulChunks = chunkResults.filter(c => c.success).length;
  const usdcDeliveringRetries = individualResults.filter(r => r.success).length;
  const txConfirmedRetries    = individualResults.filter(r => r.txConfirmed).length;
  log('summary', '═══════════════════════════════════════════════════════════════');
  log('summary', `Run complete in ${elapsedSec()} — epoch ${targetEpoch}` + (WARMUP_RUN ? ' [warm-up]' : ''));
  log('summary', `  USDC bucketed:       ${formatUnits(bucketed, 6)} USDC`);
  log('summary', `  Total gas used:      ${receipt.gasUsed} (${chunkResults.length} chunk(s)${finalizeTxHash ? ' + finalize' : ''})`);
  log('summary', `  Chunks:              ${successfulChunks}/${chunkResults.length} succeeded`);
  log('summary', `  Sweep retries:       ${individualResults.length} attempted, ${usdcDeliveringRetries} delivered USDC, ${txConfirmedRetries - usdcDeliveringRetries} confirmed-but-0-USDC`);
  log('summary', `  Stuck in swapper:    ${stuckInSwapper.length} token(s)`);
  log('summary', `  Stuck in vault:      ${stuckInVault.length} token(s) (admin can rescue if non-USDC)`);
  if (finalizeTxHash) log('summary', `  Finalize tx:         ${finalizeTxHash}`);
  log('summary', '═══════════════════════════════════════════════════════════════');

  // Health gate: if this epoch had swappable rewards but we converted NONE of
  // them to USDC, the harvest effectively failed even though the claim tx
  // succeeded. Exit non-zero so Railway marks the run failed (failed-run
  // webhook / alert) instead of reporting a silent "success" with a near-empty
  // bucket — the exact failure mode that went unnoticed for epoch 1779926400.
  // Measure THIS run's contribution as a delta over the pre-run bucket (a re-run
  // of an unfinalized epoch starts with prior-run USDC already bucketed, which
  // would otherwise mask a run that converted nothing). directUsdcClaim is this
  // run's USDC entitlement (0 on a re-run where USDC was already claimed), so
  // subtracting it isolates swap-derived USDC banked by THIS run.
  const directUsdcClaim = claimable.find(c => c.address.toLowerCase() === USDC_ADDR.toLowerCase())?.claimable ?? 0n;
  const bucketedThisRun = bucketed > bucketedAtStart ? bucketed - bucketedAtStart : 0n;
  const swapDerivedUsdc = bucketedThisRun > directUsdcClaim ? bucketedThisRun - directUsdcClaim : 0n;
  if (finalPlan.totalQuotedUSDC > 0n && swapDerivedUsdc === 0n) {
    // Degraded, NOT fatal. The claim succeeded (USDC banked, raw tokens safe in
    // the vault), so we do NOT crash the service — the leftover tokens are picked
    // up by the next run's Tier-3 sweep. Alert a human, but exit 0.
    log('summary',
      `WARN: converted NONE of ${formatUnits(finalPlan.totalQuotedUSDC, 6)} USDC swappable rewards ` +
      `(this-run bucketed Δ ${formatUnits(bucketedThisRun, 6)}, direct USDC claim ${formatUnits(directUsdcClaim, 6)}); ` +
      `leftover tokens remain in the vault for the next sweep`);
    await sendAlert('degraded harvest (no swaps converted)',
      `epoch ${targetEpoch}: claim OK but 0 of ${formatUnits(finalPlan.totalQuotedUSDC, 6)} USDC swappable ` +
      `rewards converted this run; leftover tokens safe in vault, will retry next run`);
  }

  log('main', 'Done.');
}

main().catch(async (err) => {
  if (err instanceof FatalExit) {
    // Expected, already-logged failure raised via die().
    console.error(`[fatal] ${err.stage}: ${err.message}`);
    await sendAlert(`run failed (${err.stage})`, err.message);
  } else {
    console.error('[fatal]', err);
    await sendAlert('run crashed (unhandled error)',
      String(err?.stack || err?.message || err).substring(0, 500));
  }
  console.error(`[fatal] Run aborted after ${elapsedSec()}`);
  process.exit(1);
});
