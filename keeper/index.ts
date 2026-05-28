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
// Set by Railway's "Pre-Deploy Command" (`WARMUP_RUN=1 npm start`). Triggers
// extra logging that distinguishes deploy-gating runs from scheduled cron runs.
// Behaviorally identical to a normal run — same skip/finalize/exit logic.
const WARMUP_RUN = process.env.WARMUP_RUN === '1';

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

function die(stage: string, msg: string, extra?: Record<string, unknown>): never {
  log(stage, `FATAL: ${msg}`, extra);
  process.exit(1);
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
    // useAll: vault holds full balance post-claim; if the quotedIn ±5% window
    // is breached the upstream swapper skips this step (allowPartial: true).
    step.useAll = true;

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
  let err = await simulateHarvest(client, account, args, candidatePlan);
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
      const trialErr = await simulateHarvest(client, account, args, trial);
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
    const trialErr = await simulateHarvest(client, account, args, remaining);
    if (!trialErr) return { plan: remaining, dropped };
    lastErr = trialErr;
  }
  return { plan: [], dropped, lastError: lastErr };
}

// ---------------------------------------------------------------------------
// Individual retry — per-token boosted-slippage swap for tokens left in the
// vault after the main batch broadcast. Each retry is its own harvest() call
// with empty tokensToClaim (the claim already happened in the main broadcast)
// and a single-step swap plan. minUSDC = 0 (boosted slippage is the floor,
// not the global percentage).
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

  const slippageBps = calculateSlippage(result.lossPercent, true);  // force high
  const step = buildSwapStepFromQuote({
    token: tokenForSwap,
    outToken: USDC_ADDR,
    quote: result.quote,
    slippageBps,
  });
  step.useAll = true;

  // Simulate single-step harvest (no claim — tokens already in vault from main broadcast)
  const simErr = await simulateHarvest(
    publicClient,
    account.address,
    { epoch: targetEpoch, tokens: [], minUSDC: 0n, finalize: false },
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
      args: [targetEpoch, [], [step], 0n, false] as any,
      account,
      chain: base,
    });
  } catch (e: any) {
    return { ...out, error: `tx: ${(e.shortMessage || e.message || String(e)).substring(0, 200)}` };
  }

  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      return { ...out, txHash, error: `reverted (block ${receipt.blockNumber})` };
    }
    const usdcAfter = (await publicClient.readContract({
      address: USDC_ADDR, abi: ERC20_BASIC_ABI, functionName: 'balanceOf', args: [VAULT_ADDR],
    })) as bigint;
    const usdcOut = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0n;
    // Real success requires USDC was actually delivered. A confirmed tx with
    // 0 USDC means the swap step failed inside the swapper (allowPartial)
    // and the input token is now stuck in the swapper.
    return {
      ...out,
      txConfirmed: true,
      success: usdcOut > 0n,
      txHash,
      usdcOut,
      error: usdcOut === 0n ? 'tx confirmed but 0 USDC delivered (token now stuck in swapper)' : undefined,
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

  // -- Discover claimable tokens --
  const claimable = await discoverClaimableTokens(publicClient, targetEpoch);
  if (claimable.length === 0) {
    log('main', 'Nothing claimable for this epoch');
    process.exit(0);
  }
  const claimableByAddr = new Map<string, ClaimableToken>(
    claimable.map(c => [c.address.toLowerCase(), c]),
  );

  // Tokens to claim = all claimable (including those we couldn't price-swap;
  // they get claimed raw and sit in the vault for admin to handle).
  const tokensToClaim = claimable.map(c => c.address);

  // ---------------- Attempt 1: normal slippage ----------------
  let plan = await buildSwapPlanFor(claimable, { forceHighSlippage: false, label: 'normal' });
  let minUSDC = (plan.totalQuotedUSDC * MIN_USDC_PCT) / 100n;
  let baseArgs: HarvestArgs = { epoch: targetEpoch, tokens: tokensToClaim, minUSDC, finalize: FINALIZE };

  log('main', `minUSDC floor: ${formatUnits(minUSDC, 6)} (${MIN_USDC_PCT}% of ${formatUnits(plan.totalQuotedUSDC, 6)})`);

  // Isolate: if the whole plan would revert, drop steps until it passes.
  log('simulate', 'Simulating harvest + isolating any problem steps...');
  let { plan: workingSteps, dropped: droppedSteps, lastError } =
    await isolateExecutablePlan(publicClient, account.address, baseArgs, plan.steps);

  let attemptedRetry = false;
  let finalPlan = plan;

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
    finalPlan = plan;
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

  // ---------------- Main broadcast — CHUNKED ----------------
  // Split workingSteps into chunks of at most EXECUTION_BATCH_SIZE. Chunk 1
  // claims ALL tokens (including those isolation dropped + USDC-as-reward);
  // chunks 2+ have empty tokensToClaim and just swap. Each chunk refreshes
  // its own quotes JIT and re-isolates within the chunk if sim fails.
  // Always finalize=false here; final flip happens via the separate finalize
  // tx at the very end (after Tier 3 sweep).
  const numChunks = Math.max(1, Math.ceil(workingSteps.length / EXECUTION_BATCH_SIZE));
  log('broadcast', `Splitting into ${numChunks} chunk(s) of up to ${EXECUTION_BATCH_SIZE} swap steps each`);

  interface ChunkRecord { chunk: number; txHash?: Hex; gasUsed?: bigint; success: boolean; error?: string; usdcAfter: bigint }
  const chunkResults: ChunkRecord[] = [];
  let firstChunkSuccess = false;
  let lastTxHash: Hex | undefined;
  let lastReceiptBlock: bigint | undefined;
  let totalGasUsed = 0n;

  for (let chunkIdx = 0; chunkIdx < numChunks; chunkIdx++) {
    const chunkStart = chunkIdx * EXECUTION_BATCH_SIZE;
    const chunkEnd   = Math.min(chunkStart + EXECUTION_BATCH_SIZE, workingSteps.length);
    const isFirstChunk = chunkIdx === 0;
    const chunkTokensToClaim = isFirstChunk ? tokensToClaim : [];

    log('chunk', `═════ Chunk ${chunkIdx + 1}/${numChunks} ═════`);

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

    // If this is not chunk 1 AND we have nothing to do, skip (no claims, no swaps).
    if (!isFirstChunk && chunkSteps.length === 0) {
      log('chunk', `  empty plan and no claims needed — skipping broadcast`);
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
      });
    } catch (e: any) {
      const msg = (e.shortMessage || e.message || String(e)).substring(0, 200);
      log('chunk', `  ✗ broadcast failed: ${msg}`);
      chunkResults.push({ chunk: chunkIdx + 1, success: false, error: msg, usdcAfter: 0n });
      if (isFirstChunk) {
        // First chunk owns the claim — failure here means nothing claimed; abort.
        die('broadcast', `Chunk 1 (claim chunk) failed; nothing was claimed`, { error: msg });
      }
      // For non-first chunks, log and continue — tokens are still in vault
      // for the Tier 3 sweep to retry individually.
      continue;
    }
    log('chunk', `  tx: ${chunkTxHash}`);

    try {
      const chunkReceipt = await publicClient.waitForTransactionReceipt({ hash: chunkTxHash });
      if (chunkReceipt.status !== 'success') {
        log('chunk', `  ✗ tx reverted (block ${chunkReceipt.blockNumber})`);
        chunkResults.push({ chunk: chunkIdx + 1, txHash: chunkTxHash, success: false, error: `reverted (block ${chunkReceipt.blockNumber})`, usdcAfter: 0n });
        if (isFirstChunk) die('broadcast', `Chunk 1 reverted; nothing was claimed`, { txHash: chunkTxHash });
        continue;
      }
      lastTxHash = chunkTxHash;
      lastReceiptBlock = chunkReceipt.blockNumber;
      totalGasUsed += chunkReceipt.gasUsed;
      log('chunk', `  ✓ confirmed in block ${chunkReceipt.blockNumber}, gas=${chunkReceipt.gasUsed}`);

      const usdcAfter = (await publicClient.readContract({
        address: VAULT_ADDR, abi: VAULT_ABI, functionName: 'usdcForEpoch', args: [targetEpoch],
      })) as bigint;
      chunkResults.push({ chunk: chunkIdx + 1, txHash: chunkTxHash, gasUsed: chunkReceipt.gasUsed, success: true, usdcAfter });
      if (isFirstChunk) firstChunkSuccess = true;
    } catch (e: any) {
      const msg = (e.shortMessage || e.message || String(e)).substring(0, 200);
      log('chunk', `  ⚠ receipt error: ${msg}`);
      chunkResults.push({ chunk: chunkIdx + 1, txHash: chunkTxHash, success: false, error: `receipt: ${msg}`, usdcAfter: 0n });
      if (isFirstChunk) die('broadcast', `Chunk 1 receipt error`, { txHash: chunkTxHash, msg });
    }
  }

  if (numChunks > 0 && !firstChunkSuccess && workingSteps.length === 0) {
    // Edge case: workingSteps was empty so numChunks was forced to 1. The
    // single chunk handles the claim. If that failed we already die()d above.
    // This path shouldn't normally reach but keep it defensive.
    log('broadcast', 'No chunks succeeded; continuing to Tier 3 sweep against whatever the vault has');
  }

  // Backwards-compat reporting fields (kept so the persistRun shape matches earlier runs)
  const txHash = lastTxHash ?? ('0x' as Hex);
  const receipt = { blockNumber: lastReceiptBlock ?? 0n, gasUsed: totalGasUsed };

  let bucketed = (await publicClient.readContract({
    address: VAULT_ADDR, abi: VAULT_ABI, functionName: 'usdcForEpoch', args: [targetEpoch],
  })) as bigint;
  log('main', `usdcForEpoch[${targetEpoch}] after main: ${formatUnits(bucketed, 6)} USDC`);

  // ---------------- Tier 3: per-token individual retries, up to MAX_SWEEPS passes ----------------
  // For every claimable token (except USDC) that still has balance in the
  // vault, attempt a single-step boosted-slippage swap as its own harvest()
  // call. Each pass re-scans the vault and re-fetches fresh 0x quotes, so
  // transient failures (rate limits, brief liquidity moves) get retried.
  const individualResults: Array<IndividualRetryResult & { pass: number }> = [];
  if (!SKIP_INDIVIDUAL_RETRY) {
    const quoteFetcher = createDirectQuoteFetcher(ZERO_X_API_KEY);
    let totalPasses = 0;

    for (let pass = 1; pass <= MAX_SWEEPS; pass++) {
      totalPasses = pass;
      // Find tokens still in vault — these are the retry candidates.
      const candidates: Array<{ tok: ClaimableToken; bal: bigint }> = [];
      for (const tok of claimable) {
        if (tok.address.toLowerCase() === USDC_ADDR.toLowerCase()) continue;
        const bal = (await publicClient.readContract({
          address: tok.address, abi: ERC20_BASIC_ABI, functionName: 'balanceOf', args: [VAULT_ADDR],
        })) as bigint;
        if (bal > 0n) candidates.push({ tok, bal });
      }

      if (candidates.length === 0) {
        log('sweep', `pass ${pass}/${MAX_SWEEPS}: vault is clean, no more sweeps needed`);
        break;
      }

      log('sweep', `pass ${pass}/${MAX_SWEEPS}: ${candidates.length} token(s) still in vault — individual retries`);
      let anyDeliveredUSDC = false;
      for (const { tok, bal } of candidates) {
        log('sweep', `  attempting ${tok.symbol} (${formatUnits(bal, tok.decimals)})...`);
        const r = await individualRetry(
          publicClient, walletClient, account, tok, bal, targetEpoch, quoteFetcher,
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
  let finalizeTxHash: Hex | undefined;
  if (FINALIZE) {
    log('finalize', 'Finalizing epoch...');
    try {
      finalizeTxHash = await walletClient.writeContract({
        address: VAULT_ADDR,
        abi: HARVEST_ABI,
        functionName: 'harvest',
        args: [targetEpoch, [], [], 0n, true] as any,
        account,
        chain: base,
      });
      const finReceipt = await publicClient.waitForTransactionReceipt({ hash: finalizeTxHash });
      if (finReceipt.status !== 'success') {
        log('finalize', `WARN: finalize tx reverted (${finalizeTxHash}); epoch left open`);
      } else {
        log('finalize', `Finalized: ${finalizeTxHash}`);
      }
    } catch (e: any) {
      log('finalize', `WARN: finalize call failed (${e.shortMessage || e.message}); epoch left open`);
    }
  } else {
    log('finalize', 'FINALIZE=0 — epoch left open');
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
  log('main', 'Done.');
}

main().catch((err) => {
  console.error('[fatal]', err);
  console.error(`[fatal] Run aborted after ${elapsedSec()}`);
  process.exit(1);
});
