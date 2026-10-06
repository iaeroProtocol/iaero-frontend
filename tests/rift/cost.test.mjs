// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costLevel, costVsMarketPct, costWorseThanAccepted, deliveredVsQuotedPct, formatPct, gasDeskUsd, gasSwallows, parseLlamaQuotes, priceDropPct, seenBaseline } from '../../src/lib/rift/cost.ts';

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
  assert.equal(llamaIdOf('ink.kbtc'), null);
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

test('prices are checked for age when used, not only when fetched', async () => {
  const { freshPrice, parseLlamaQuotes, PRICE_MAX_AGE_SEC } = await import('../../src/lib/rift/cost.ts');
  const t = 1_790_922_940;
  const quotes = parseLlamaQuotes({ coins: { 'coingecko:ethereum': { price: 2700, timestamp: t, confidence: 0.99 } } }, t * 1000);
  assert.deepEqual(quotes, { 'coingecko:ethereum': { price: 2700, ts: t } });
  assert.equal(freshPrice(quotes['coingecko:ethereum'], t * 1000 + 60_000), 2700);
  // A failed refresh keeps the old answer: twenty minutes later it is still there, an hour later it no longer counts.
  assert.equal(freshPrice(quotes['coingecko:ethereum'], (t + PRICE_MAX_AGE_SEC + 1) * 1000), undefined);
  assert.equal(freshPrice(undefined, t * 1000), undefined);
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

test('HyperCore assets price by CoinGecko id', async () => {
  const { llamaIdOf } = await import('../../src/lib/rift/cost.ts');
  assert.equal(llamaIdOf('hyperliquid.hype'), 'coingecko:hyperliquid');
  assert.equal(llamaIdOf('hyperliquid.btc'), 'coingecko:bitcoin');
  assert.equal(llamaIdOf('hyperliquid.usdc'), 'coingecko:usd-coin');
  assert.equal(llamaIdOf('hyperliquid.purr'), null);
});

test('cost check: zero output, unknown and disagreeing prices all need a tick', async () => {
  const { assessCost, costNeedsTick } = await import('../../src/lib/rift/cost.ts');
  assert.deepEqual(assessCost(100, 99.5), { kind: 'ok', pct: 0.5000000000000004, level: 'low' });
  assert.equal(costNeedsTick(assessCost(100, 99.5)), false);
  assert.equal(costNeedsTick(assessCost(100, 96)), true, 'high');
  assert.deepEqual(assessCost(40, 0), { kind: 'ok', pct: 100, level: 'high' }, 'the gas charge ate the whole order');
  assert.deepEqual(assessCost(40, -3), { kind: 'ok', pct: 100, level: 'high' });
  assert.equal(assessCost(null, 10).kind, 'unknown');
  assert.equal(assessCost(10, null).kind, 'unknown');
  assert.equal(costNeedsTick(assessCost(null, 10)), true, 'no price to warn with');
  assert.equal(assessCost(100, 125).kind, 'disagree', 'a 25% "gain" means a price is wrong');
  assert.equal(costNeedsTick(assessCost(100, 125)), true);
  assert.equal(assessCost(100, 101).kind, 'ok', 'within noise');
});

test('round 8: an order the gas charge would take whole is refused from what is known, without iAERO\'s price', () => {
  const ETH = [1, 8453]; // a route that runs on Ethereum (and Base)
  const gwei = n => BigInt(Math.round(n * 1e9));
  // Paid in ETH or WETH: against the amount itself (1.6M gas at 2 gwei is 0.0032 ETH).
  assert.equal(gasSwallows({ chains: ETH, gasWei: gwei(2), payWei: 500_000_000_000_000n }), true);
  assert.equal(gasSwallows({ chains: ETH, gasWei: gwei(2), payWei: 10_000_000_000_000_000n }), false);
  assert.equal(gasSwallows({ chains: [8453], gasWei: gwei(2), payWei: 1_000n }), false, 'no Ethereum step');
  // Another token: the charge in USD against the payment's value. $20 of USDC at 5 gwei and ETH at $4,000: $32.
  assert.equal(gasSwallows({ chains: ETH, gasWei: gwei(5), ethUsd: 4000, payUsd: 20 }), true);
  assert.equal(gasSwallows({ chains: ETH, gasWei: gwei(5), ethUsd: 4000, payUsd: 50 }), false);
  // Gas price unknown: at least the floor (0.5 gwei, $3.20 here).
  assert.equal(gasSwallows({ chains: ETH, ethUsd: 4000, payUsd: 2 }), true);
  assert.equal(gasSwallows({ chains: ETH, ethUsd: 4000, payUsd: 5 }), false);
  // No ETH price, or no price for the payment: nothing to compare (the cost check asks for the tick instead).
  assert.equal(gasSwallows({ chains: ETH, gasWei: gwei(5), payUsd: 20 }), false);
  assert.equal(gasSwallows({ chains: ETH, gasWei: gwei(5), ethUsd: 4000, payUsd: null }), false);
  // Layer 2 steps only: about $0.10 each.
  assert.equal(gasSwallows({ chains: [42161, 8453], payUsd: 0.15 }), true);
  assert.equal(gasSwallows({ chains: [42161, 8453], payUsd: 5 }), false);
});

test('round 9: with this computer\'s clock running slow, a price hours old is still too old', () => {
  const real = Date.now();
  const slow = real - 2 * 3600_000; // the clock two hours behind
  const answer = { coins: {
    'coingecko:ethereum': { price: 4000, timestamp: Math.floor(real / 1000) - 60, confidence: 0.99 },
    'base:0xstale': { price: 1, timestamp: Math.floor(real / 1000) - 2 * 3600, confidence: 0.99 },
  } };
  const q = parseLlamaQuotes(answer, slow, 'coingecko:ethereum');
  assert.ok(q['coingecko:ethereum'], 'a fresh price is kept');
  assert.equal(q['base:0xstale'], undefined, 'two hours older than ETH\'s price in the same answer: left out');
  // A correct clock gives the same answer.
  assert.equal(parseLlamaQuotes(answer, real, 'coingecko:ethereum')['base:0xstale'], undefined);
});

test('round 9: a gas price of zero counts as unknown (the floor applies)', () => {
  assert.equal(gasSwallows({ chains: [1, 8453], gasWei: 0n, ethUsd: 4000, payUsd: 2 }), true);
  assert.equal(gasSwallows({ chains: [1, 8453], gasWei: 0n, payWei: 500_000_000_000_000n }), true);
});

test('round 10: one odd entry dated ahead doesn\'t age the other prices out; the server keeps its own clock', () => {
  const now = Date.now();
  const sec = Math.floor(now / 1000);
  const answer = { coins: {
    'coingecko:ethereum': { price: 4000, timestamp: sec - 60, confidence: 0.99 },
    'base:0xusdc': { price: 1, timestamp: sec - 120, confidence: 0.99 },
    'base:0xjunk': { price: 0.01, timestamp: sec + 2 * 3600, confidence: 0.2 }, // an airdropped token, oddly dated
  } };
  assert.ok(parseLlamaQuotes(answer, now, 'coingecko:ethereum')['base:0xusdc'], 'the page');
  assert.ok(parseLlamaQuotes(answer, now)['base:0xusdc'], 'the holdings route');
});

test('round 10: ETH and WETH are compared with the Layer 2 charges too', () => {
  // An Arbitrum-to-Base route: $0.20 of Layer 2 charges, about 0.00005 ETH at $4,000.
  assert.equal(gasSwallows({ chains: [42161, 8453], ethUsd: 4000, payWei: 10_000_000_000_000n }), true, '0.00001 ETH');
  assert.equal(gasSwallows({ chains: [42161, 8453], ethUsd: 4000, payWei: 1_000_000_000_000_000n }), false, '0.001 ETH');
});

test('round 10: a card\'s Pay asks for a new order when the cost is now high and worse than when it was made', () => {
  assert.equal(costWorseThanAccepted(3.5, 2.6), true, 'moderate then, high now');
  assert.equal(costWorseThanAccepted(3.5, 3.2), false, 'high then too, and within half a point: the tick at Buy covers it');
  assert.equal(costWorseThanAccepted(2.9, 1), false, 'not high');
  assert.equal(costWorseThanAccepted(4, null), true, 'unknown then');
});

test('round 11: a nonsense ETH price (from a broken source) counts as none, and never throws', () => {
  // 1e-300 made the Layer 2 conversion BigInt(Infinity), which threw while the page rendered.
  assert.doesNotThrow(() => gasSwallows({ chains: [42161, 8453], ethUsd: 1e-300, payWei: 10n ** 15n }));
  assert.equal(gasDeskUsd([1, 8453], 10n ** 9n, 1e-300), null, 'the Ethereum charge can\'t be valued');
  assert.equal(gasDeskUsd([1, 8453], 10n ** 9n, 1e12), null);
  assert.ok(gasDeskUsd([1, 8453], 10n ** 9n, 4000) > 0);
  const sec = Math.floor(Date.now() / 1000);
  assert.deepEqual(Object.keys(parseLlamaQuotes({ coins: { a: { price: 1e12, timestamp: sec }, b: { price: 2, timestamp: sec } } }, Date.now())), ['b'],
    'a price of a billion or more is none');
});

test('round 13: the quote "seen" at Buy: one that changed within 3 s isn\'t what was read; a change "in the future" takes the higher', () => {
  const now = 1_790_930_000_000;
  const shown = { key: 'k', since: now - 20_000, prevOut: '99' };
  assert.equal(seenBaseline(shown, 'k', '100', now), '100', 'read for 20 s');
  assert.equal(seenBaseline({ ...shown, since: now - 1000 }, 'k', '100', now), '99', 'changed a second ago: the one before');
  assert.equal(seenBaseline({ ...shown, since: now + 5 * 60_000 }, 'k', '100', now), '100', 'the clock put back: the higher, not the older');
  assert.equal(seenBaseline({ ...shown, prevOut: '101', since: now + 5 * 60_000 }, 'k', '100', now), '101');
  assert.equal(seenBaseline(shown, 'other', '100', now), '100', 'another token or amount');
  assert.equal(seenBaseline(null, 'k', '100', now), '100');
});
