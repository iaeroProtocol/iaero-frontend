// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costLevel, costVsMarketPct, deliveredVsQuotedPct, formatPct, priceDropPct } from '../../src/lib/rift/cost.ts';

test('cost against market prices, from a real quote', () => {
  // $500 in, 830 iAERO out at $0.5976: $496.01 of iAERO, so 0.8%.
  const pct = costVsMarketPct(500, 830 * 0.5976);
  assert.ok(pct > 0.7 && pct < 0.9, String(pct));
  assert.equal(costLevel(pct), 'low');
  assert.equal(costLevel(1.5), 'medium');
  assert.equal(costLevel(3), 'high');
  assert.ok(costVsMarketPct(100, 101) < 0, 'better than the reference price comes out negative');
  assert.equal(costVsMarketPct(0, 10), null, 'no input price: unknown, not zero');
  assert.equal(costVsMarketPct(10, 0), null, 'no iAERO price: unknown');
  assert.equal(costVsMarketPct(NaN, 10), null);
});

test('price moves between looking and clicking', () => {
  assert.ok(Math.abs(priceDropPct("100", "99") - 1) < 1e-9);
  assert.ok(Math.abs(priceDropPct('843.58', '835') - 1.017) < 0.01);
  assert.ok(priceDropPct('100', '101') < 0, 'an improvement is never a stop');
  assert.equal(priceDropPct('0', '5'), 0);
});

test('delivered against quoted', () => {
  assert.ok(Math.abs(deliveredVsQuotedPct('461.1', '461.25') - -0.0325) < 0.001);
  assert.ok(deliveredVsQuotedPct('462', '461') > 0);
  assert.equal(deliveredVsQuotedPct(null, '461'), null);
  assert.equal(deliveredVsQuotedPct('461', '0'), null);
  assert.equal(formatPct(0.83), '0.8%');
  assert.equal(formatPct(-2.04), '2.0%');
  assert.equal(formatPct(12.6), '13%');
  assert.equal(formatPct(0.04), '<0.1%');
});

test('market prices: DeFiLlama ids and parsing', async () => {
  const { llamaIdOf, parseLlamaPrices } = await import('../../src/lib/rift/cost.ts');
  assert.equal(llamaIdOf('bitcoin.btc'), 'coingecko:bitcoin');
  assert.equal(llamaIdOf('arbitrum.eth'), 'coingecko:ethereum');
  assert.equal(llamaIdOf('base.0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'), 'base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  assert.equal(llamaIdOf('hyperliquid.usdc'), null);
  const now = 1790922940_000;
  const json = { coins: {
    'base:0x81034fb34009115f215f5d5f564aac9ffa46a1dc': { price: 0.5975797707224795, timestamp: 1790922110, confidence: 0.99 },
    'coingecko:bitcoin': { price: 85947.03, timestamp: 1790922940, confidence: 0.99 },
    'base:0xstale': { price: 1, timestamp: 1790922940 - 1801, confidence: 0.99 },
    'base:0xunsure': { price: 1, timestamp: 1790922940, confidence: 0.5 },
    'base:0xzero': { price: 0, timestamp: 1790922940 },
  } };
  assert.deepEqual(parseLlamaPrices(json, now), {
    'base:0x81034fb34009115f215f5d5f564aac9ffa46a1dc': 0.5975797707224795,
    'coingecko:bitcoin': 85947.03,
  });
  assert.deepEqual(parseLlamaPrices(null, now), {});
});

test('iAERO market price from its Aerodrome pools, and cost wording', async () => {
  const { clAeroPerIaero, v2AeroPerIaero, costText } = await import('../../src/lib/rift/cost.ts');
  // Live reads, 2026-10-02 07:05 UTC: Slipstream pool slot0 and the classic pool's reserves.
  assert.ok(Math.abs(clAeroPerIaero(68366852591258221366807171016n) - 0.744615) < 1e-6);
  assert.ok(Math.abs(v2AeroPerIaero(35750224959386513595392n, 26721494850357903054290n) - 0.74745) < 1e-5);
  assert.equal(v2AeroPerIaero(0n, 5n), 0);
  assert.equal(costText(0.88), '0.9%');
  assert.equal(costText(0.04), '<0.1%');
  assert.equal(costText(0), 'about 0%');
  assert.equal(costText(-0.3), 'about 0%', 'never "better than market"');
});

test("Rift's gas desk: once per chain, Ethereum scaled by gas price", async () => {
  const { gasDeskChains, gasDeskUsd } = await import('../../src/lib/rift/cost.ts');
  // The RESOLV order's route (2026-10-02): two steps on Ethereum, one on Base.
  const route = [
    { venue: 'nordstern', execution: { mode: 'evm_gas_desk', chain: 1 } },
    { venue: 'across', execution: { mode: 'evm_gas_desk', chain: 1 } },
    { venue: 'nordstern', execution: { mode: 'evm_gas_desk', chain: 8453 } },
  ];
  assert.deepEqual(gasDeskChains(route), [1, 8453]);
  assert.deepEqual(gasDeskChains([{ venue: 'unit', execution: { mode: 'bitcoin' } }, { venue: 'x' }]), []);
  // 0.1 gwei, ETH $2,727: about $0.44 on Ethereum plus $0.10 on Base. Charged on the two Ethereum
  // orders: $0.36 and $0.64 in total.
  const usd = gasDeskUsd([1, 8453], 100_000_000n, 2727);
  assert.ok(usd > 0.5 && usd < 0.6, String(usd));
  assert.ok(gasDeskUsd([1], 10_000_000_000n, 2727) > 40, '10 gwei would make it about $44');
  assert.equal(gasDeskUsd([1, 8453], undefined, 2727), null);
  assert.equal(gasDeskUsd([42161, 8453], undefined, undefined), 0.2, 'Layer 2 only needs no Ethereum gas price');
});
