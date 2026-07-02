// Unit tests for the keeper swap-pipeline changes (Changes 2 & 3).
// Run:  node --experimental-strip-types --test test/swap-pipeline.test.mts   (from iaero_frontend/keeper)
//
// Covers:
//   - SLIPPAGE_MIN_BPS raised to 150 and calculateSlippage's normal/boosted math
//   - both 0x fetchers forwarding `slippageBps` into the query string (and omitting it when unset)
//   - getQuoteWithImpact passing slippageBps to the MAIN quote but NOT the reference quote
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  calculateSlippage,
  SLIPPAGE_MIN_BPS,
  SLIPPAGE_MAX_BPS,
  createDirectQuoteFetcher,
  browserQuoteFetcher,
  getQuoteWithImpact,
  USDC_ADDR,
} from '../swap-pipeline.ts';
import { SWEEP_SLIPPAGE_LADDER_BPS, sweepSlippageForPass } from '../sweep-ladder.ts';

// ---------------------------------------------------------------------------
// calculateSlippage / floor (Changes 2 + 3)
// ---------------------------------------------------------------------------
test('SLIPPAGE_MIN_BPS is raised to 150 (keeper floor)', () => {
  assert.equal(SLIPPAGE_MIN_BPS, 150);
});

test('calculateSlippage normal-mode floor is 150 at zero impact', () => {
  assert.equal(calculateSlippage(0, false), 150);
});

test('calculateSlippage boosted-mode floor is 1000 at zero impact', () => {
  assert.equal(calculateSlippage(0, true), 1000);
});

test('calculateSlippage normal mode adds 1.5x impact above the floor', () => {
  // impact 2% -> priceImpactBps 200 -> 150 + ceil(200*1.5)=150+300 = 450
  assert.equal(calculateSlippage(2, false), 450);
  // impact 0.2% -> priceImpactBps 20 -> 150 + ceil(20*1.5)=150+30 = 180
  assert.equal(calculateSlippage(0.2, false), 180);
});

test('calculateSlippage normal mode caps at SLIPPAGE_MAX_BPS (500)', () => {
  assert.equal(calculateSlippage(5, false), SLIPPAGE_MAX_BPS);
  assert.equal(calculateSlippage(50, false), SLIPPAGE_MAX_BPS);
  assert.equal(SLIPPAGE_MAX_BPS, 500);
});

// ---------------------------------------------------------------------------
// Fetchers forward slippageBps into the 0x request (Change 2)
// ---------------------------------------------------------------------------
function withMockedFetch(run: (getUrl: () => string) => Promise<void>) {
  const orig = globalThis.fetch;
  let lastUrl = '';
  // @ts-ignore - test double
  globalThis.fetch = async (url: any) => {
    lastUrl = String(url);
    return { ok: true, json: async () => ({ buyAmount: '1000000', transaction: { data: '0x00' } }) } as any;
  };
  return run(() => lastUrl).finally(() => { globalThis.fetch = orig; });
}

const REQ = (slippageBps?: number) => ({
  chainId: 8453,
  sellToken: '0x1111111111111111111111111111111111111111',
  buyToken: USDC_ADDR,
  sellAmount: 1000000000000000000n,
  taker: '0x2222222222222222222222222222222222222222',
  ...(slippageBps != null ? { slippageBps } : {}),
});

test('createDirectQuoteFetcher includes slippageBps when set', async () => {
  await withMockedFetch(async (getUrl) => {
    const fetcher = createDirectQuoteFetcher('test-key');
    await fetcher(REQ(300));
    assert.match(getUrl(), /slippageBps=300/);
  });
});

test('createDirectQuoteFetcher omits slippageBps when unset', async () => {
  await withMockedFetch(async (getUrl) => {
    const fetcher = createDirectQuoteFetcher('test-key');
    await fetcher(REQ());
    assert.doesNotMatch(getUrl(), /slippageBps/);
  });
});

test('browserQuoteFetcher includes slippageBps when set', async () => {
  await withMockedFetch(async (getUrl) => {
    await browserQuoteFetcher(REQ(800));
    assert.match(getUrl(), /slippageBps=800/);
  });
});

// ---------------------------------------------------------------------------
// getQuoteWithImpact: slippage on the MAIN quote only, not the reference (Change 2)
// ---------------------------------------------------------------------------
test('getQuoteWithImpact passes slippageBps to main quote but not the reference quote', async () => {
  const calls: Array<number | undefined> = [];
  const recordingFetcher = async (req: any) => {
    calls.push(req.slippageBps);
    return { buyAmount: '1000000', transaction: { data: '0x00' } } as any;
  };
  const result = await getQuoteWithImpact({
    chainId: 8453,
    token: {
      address: '0x1111111111111111111111111111111111111111',
      symbol: 'X',
      decimals: 18,
      walletBN: 1000000000000000000n,
      fullBalanceBN: 1000000000000000000n,
      valueUsd: 1,
    } as any,
    outToken: USDC_ADDR,
    outputPrice: 1,
    outputDecimals: 6,
    fetcher: recordingFetcher as any,
    slippageBps: 300,
  });
  assert.equal(result.success, true, 'quote should succeed');
  assert.equal(calls.length, 2, 'expected a main quote and a reference quote');
  assert.equal(calls[0], 300, 'main quote must carry slippageBps');
  assert.equal(calls[1], undefined, 'reference (price-probe) quote must NOT carry slippageBps');
});

// ---------------------------------------------------------------------------
// Tier-3 sweep escalation ladder (Change 5)
// ---------------------------------------------------------------------------
test('sweep ladder is the requested 1/3/5/8/10% escalation', () => {
  assert.deepEqual(SWEEP_SLIPPAGE_LADDER_BPS, [100, 300, 500, 800, 1000]);
});

test('sweepSlippageForPass escalates per pass and clamps to the top rung', () => {
  assert.equal(sweepSlippageForPass(1), 100);
  assert.equal(sweepSlippageForPass(2), 300);
  assert.equal(sweepSlippageForPass(3), 500);
  assert.equal(sweepSlippageForPass(4), 800);
  assert.equal(sweepSlippageForPass(5), 1000);
  // pass beyond the ladder length (e.g. MAX_SWEEPS overridden up) clamps to top rung
  assert.equal(sweepSlippageForPass(6), 1000);
  assert.equal(sweepSlippageForPass(99), 1000);
  // defensive: never index below 0
  assert.equal(sweepSlippageForPass(0), 100);
});

test('every ladder rung stays within the 10% sweep ceiling', () => {
  for (const bps of SWEEP_SLIPPAGE_LADDER_BPS) assert.ok(bps <= 1000, `${bps} <= 1000`);
});
