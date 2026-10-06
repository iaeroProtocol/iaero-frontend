// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterGasOut, cardCostCheck, clickQuoteMove, costLevel, costVsMarketPct, costWorseThanAccepted, deliveredVsQuotedPct, formatPct, gasDeskUsd, gasSharePct, gasSwallows, nextShown, parseLlamaQuotes, priceDropPct, seenBaseline, tickCovers } from '../../src/lib/rift/cost.ts';

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
  const cur = { out: '100', chains: [42161, 8453] };
  const shown = { key: 'k', since: now - 20_000, prev: { out: '99', chains: [42161, 8453] } };
  assert.equal(seenBaseline(shown, 'k', cur, now).out, '100', 'read for 20 s');
  assert.equal(seenBaseline({ ...shown, since: now - 1000 }, 'k', cur, now).out, '99', 'changed a second ago: the one before');
  assert.equal(seenBaseline({ ...shown, since: now + 5 * 60_000 }, 'k', cur, now).out, '100', 'the clock put back: the higher, not the older');
  assert.equal(seenBaseline({ ...shown, prev: { out: '101', chains: [42161, 8453] }, since: now + 5 * 60_000 }, 'k', cur, now).out, '101');
  assert.equal(seenBaseline(shown, 'other', cur, now).out, '100', 'another token or amount');
  assert.equal(seenBaseline(null, 'k', cur, now).out, '100');
});

test('round 14: the route "seen" at Buy: a step on Ethereum that appeared within 3 s, or "in the future", wasn\'t seen', () => {
  const now = 1_790_930_000_000;
  const viaEth = { out: '100', chains: [42161, 1, 8453] };
  const l2 = { out: '100', chains: [42161, 8453] };
  assert.deepEqual(seenBaseline({ key: 'k', since: now - 1000, prev: l2 }, 'k', viaEth, now).chains, [42161, 8453], 'changed a second ago');
  assert.deepEqual(seenBaseline({ key: 'k', since: now - 20_000, prev: l2 }, 'k', viaEth, now).chains, [42161, 1, 8453], 'read for 20 s');
  assert.deepEqual(seenBaseline({ key: 'k', since: now + 60_000, prev: l2 }, 'k', viaEth, now).chains, [42161, 8453], 'from the future: only both routes\' chains');
  assert.deepEqual(seenBaseline({ key: 'k', since: now + 60_000, prev: viaEth }, 'k', l2, now).chains, [42161, 8453]);
});

test('round 14: Buy at the click holds what arrives after Rift\'s gas charge to the tolerance, and shows a new Ethereum step first', () => {
  const px = { ethUsd: 2500, iaeroUsd: 1 };
  const gwei = 1_000_000_000n;
  const l2 = { out: '100', chains: [42161, 8453] };
  const viaEth = { out: '100', chains: [42161, 1, 8453] };
  // The charge on each chain: $0.10 on a Layer 2; on Ethereum 1.6M gas at the gas price.
  assert.equal(afterGasOut('100', [42161, 8453], undefined, px), 99.8);
  assert.equal(afterGasOut('100', [42161, 1, 8453], 8n * gwei, px), 100 - 0.2 - 32);
  assert.equal(afterGasOut('100', [42161, 1, 8453], undefined, px), null, 'Ethereum without a gas price');
  assert.equal(afterGasOut('100', [42161, 8453], undefined, { ethUsd: 2500 }), null, 'a charge without iAERO\'s price');
  assert.equal(afterGasOut('100', [], undefined, {}), 100, 'no charge needs no price');
  // The auditor's cases: Rift's amount unchanged, the route now via Ethereum: shown, whether or not it can be valued.
  for (const [gas, prices] of [[undefined, px], [8n * gwei, px], [undefined, { ethUsd: 2500 }], [8n * gwei, {}]]) {
    const m = clickQuoteMove(l2, viaEth, 1, gas, prices);
    assert.equal(m.moved, true);
    assert.equal(m.routeChanged, true);
  }
  // Valued: the drop in what arrives (99.8 -> 67.8) is the move's size.
  assert.ok(Math.abs(clickQuoteMove(l2, viaEth, 1, 8n * gwei, px).dropPct - (1 - 67.8 / 99.8) * 100) < 1e-9);
  // The same route, Rift's amount 0.9% lower: within a 1% limit, but with a 50% gas share what arrives falls 1.8%.
  const eth50 = { out: '100', chains: [1] }; // $50 at 12.5 gwei
  const m = clickQuoteMove(eth50, { out: '99.1', chains: [1] }, 1, 12_500_000_000n, px);
  assert.equal(m.moved, true);
  assert.equal(m.routeChanged, false);
  assert.ok(m.dropPct > 1.7 && m.dropPct < 1.9);
  // Nothing changed, a small drop, or a route that drops its Ethereum step: bought.
  assert.equal(clickQuoteMove(l2, l2, 1, undefined, px).moved, false);
  assert.equal(clickQuoteMove(l2, { out: '99.5', chains: [42161, 8453] }, 1, undefined, px).moved, false);
  assert.equal(clickQuoteMove(viaEth, l2, 1, undefined, px).moved, false);
  assert.equal(clickQuoteMove(viaEth, viaEth, 1, undefined, px).moved, false, 'seen with its step: Rift\'s amount alone');
  // Round 15: Rift's amount 2% lower but its Ethereum step gone: more arrives, so nothing to ask (it was "2% less").
  assert.equal(clickQuoteMove(viaEth, { out: '98', chains: [42161, 8453] }, 1, 8n * gwei, px).moved, false);
  assert.equal(clickQuoteMove(viaEth, { out: '98', chains: [42161, 8453] }, 1, undefined, px).moved, true, 'unvalued: Rift\'s amount');
  // Unvalued: Rift's own amount is still held to the limit.
  assert.equal(clickQuoteMove(l2, { out: '98', chains: [42161, 8453] }, 1, undefined, {}).moved, true);
});

test('round 14: a card\'s cost rule without a USD value compares the gas charge\'s share now with the share accepted at Buy', () => {
  // Unpriced token at Buy; Buy showed the after-charge amount (94.6 of a 100 quote: a 5.4% share) and the user ticked.
  const base = { quoteOut: 100, usdIn: null, iaeroUsd: 0.6, thenExpectedOut: 94.6, thenQuoteOut: 100 };
  assert.equal(cardCostCheck({ ...base, afterOut: 94.6 }).refuse, false, 'nothing changed: paid, not refused');
  assert.equal(cardCostCheck({ ...base, afterOut: 94.3 }).refuse, false, 'within half a point');
  assert.equal(cardCostCheck({ ...base, afterOut: 90 }).refuse, true, 'gas up: 10% now, 5.4% then');
  // Saved without an expected amount (Buy couldn't value the charge): a high share needs a new order.
  const blind = { quoteOut: 34, usdIn: null, iaeroUsd: 0.6, thenQuoteOut: 34 };
  const c = cardCostCheck({ ...blind, afterOut: 25 });
  assert.equal(c.refuse, true);
  assert.equal(c.share, true);
  assert.equal(cardCostCheck({ ...blind, afterOut: 33.5 }).refuse, false, 'a small share');
  // With a USD value: the cost against market prices, as before.
  assert.equal(cardCostCheck({ afterOut: 30, quoteOut: 34, usdIn: 20, iaeroUsd: 0.6, thenUsdIn: 20, thenIaeroUsd: 0.6, thenExpectedOut: 33, thenQuoteOut: 34 }).refuse, true);
  assert.equal(cardCostCheck({ afterOut: 33, quoteOut: 34, usdIn: 20, iaeroUsd: 0.6, thenUsdIn: 20, thenIaeroUsd: 0.6, thenExpectedOut: 33, thenQuoteOut: 34 }).refuse, false);
  // A USD value that gives no cost (not a positive number) still leaves the share rule, not no rule.
  const odd = cardCostCheck({ ...blind, usdIn: Number.NaN, afterOut: 25 });
  assert.equal(odd.share, true);
  assert.equal(odd.refuse, true);
});

test('round 15: Buy at the click holds what was shown after the gas charge, so a gas price that rose within 3 s counts', () => {
  // Quotes auditor, Low 1: both quotes were valued at the click's gas price, so a gas refresh landing just before the
  // click (the figure the user read was the one before it) moved what arrives without a question.
  const px = { ethUsd: 2500, iaeroUsd: 1 };
  const gwei = 1_000_000_000n;
  const shownAt = (g) => afterGasOut('100', [1], g, px); // Rift's 100 iAERO, a route on Ethereum
  const before = { out: '100', chains: [1], after: shownAt(gwei / 4n) }; // read at 0.25 gwei: 99.0
  const m = clickQuoteMove(before, { out: '100', chains: [1] }, 1, 6n * gwei / 10n, px); // bought at 0.6 gwei: 97.6
  assert.equal(m.moved, true);
  assert.ok(Math.abs(m.dropPct - (1 - 97.6 / 99) * 100) < 1e-9);
  assert.equal(clickQuoteMove({ out: '100', chains: [1] }, { out: '100', chains: [1] }, 1, 6n * gwei / 10n, px).moved, false,
    'what the page did before: both valued now');
  // The seen figure follows the 3 s rule like the rest of the quote, and from "the future" the higher one counts.
  const now = 1_790_930_000_000;
  const shown = { key: 'k', since: now - 1000, prev: { out: '100', chains: [1], after: 99 } };
  assert.equal(seenBaseline(shown, 'k', { out: '100', chains: [1], after: 97.6 }, now).after, 99);
  assert.equal(seenBaseline({ ...shown, since: now - 20_000 }, 'k', { out: '100', chains: [1], after: 97.6 }, now).after, 97.6);
  assert.equal(seenBaseline({ ...shown, since: now + 60_000 }, 'k', { out: '100', chains: [1], after: 97.6 }, now).after, 99);
  assert.equal(seenBaseline({ ...shown, since: now + 60_000, prev: { out: '100', chains: [1], after: null } }, 'k', { out: '100', chains: [1], after: null }, now).after, null);
  // A figure that couldn't be shown is valued now, as before.
  assert.equal(clickQuoteMove({ out: '100', chains: [1], after: null }, { out: '100', chains: [1] }, 1, 6n * gwei / 10n, px).moved, false);
});

test('round 15: a cost tick covers only the route charges it was given with', () => {
  // Payments auditor, Low: an "unknown cost" tick given for a Layer 2 route went on covering the route the 30 s refresh
  // brought with an Ethereum step (Rift's charge there 82% of the order, valued on screen), with no new question.
  const unknown = { kind: 'unknown' };
  const l2 = { chains: [42161, 8453], share: 2 };
  const tick = { key: 'k', kind: 'unknown', pct: NaN, ...l2 };
  assert.equal(tickCovers(tick, 'k', unknown, l2), true, 'as ticked');
  assert.equal(tickCovers(tick, 'k', unknown, { chains: [42161, 1, 8453], share: 82 }), false, 'a step on Ethereum added');
  assert.equal(tickCovers(tick, 'k', unknown, { chains: [42161, 1, 8453], share: null }), false, '...even unvalued');
  assert.equal(tickCovers(tick, 'k', unknown, { chains: [42161, 8453], share: 2.4 }), true, 'within half a point');
  assert.equal(tickCovers(tick, 'k', unknown, { chains: [42161, 8453], share: 3 }), false, 'the charge\'s share grew');
  assert.equal(tickCovers({ ...tick, share: null }, 'k', unknown, l2), false, 'ticked unvalued, valued now: asked again');
  // Round 16: valued when ticked, unvalued now (a gas price unread for minutes): ticked again; unvalued both times: covered.
  assert.equal(tickCovers(tick, 'k', unknown, { chains: [42161, 8453], share: null }), false, 'valued then, not now');
  assert.equal(tickCovers({ ...tick, share: null }, 'k', unknown, { chains: [42161, 8453], share: null }), true, 'unvalued both times');
  const eth = { chains: [1, 8453], share: 20 };
  assert.equal(tickCovers({ ...tick, ...eth }, 'k', unknown, { chains: [42161, 8453], share: 2 }), true, 'a step dropped: cheaper');
  // As before: the token and amount, the kind of check, and a known cost's size.
  assert.equal(tickCovers(tick, 'other', unknown, l2), false);
  assert.equal(tickCovers(tick, 'k', { kind: 'disagree', pct: -5 }, l2), false);
  const high = { kind: 'ok', pct: 6, level: 'high' };
  const okTick = { key: 'k', kind: 'ok', pct: 6, ...l2 };
  assert.equal(tickCovers(okTick, 'k', { ...high, pct: 6.4 }, l2), true);
  assert.equal(tickCovers(okTick, 'k', { ...high, pct: 6.6 }, l2), false);
  assert.equal(tickCovers(null, 'k', unknown, l2), false);
  // The share: the charge against Rift's quote.
  assert.equal(gasSharePct('10', 1.8), 82);
  assert.equal(gasSharePct('10', null), null);
  assert.equal(gasSharePct('0', 1), null);
});

test('round 16: a view replaced within 3 s of appearing was never read: a burst of changes keeps the one read before it', () => {
  // Quotes auditor, Medium (round-15 regression): the refresh bringing a route with an Ethereum step makes the page read
  // Ethereum's gas price, which lands a moment later and changes what arrives; the unread Ethereum view became the one
  // "seen", so a click a second later bought it without the route-change question.
  const px = { ethUsd: 2500, iaeroUsd: 1 };
  const gas = 300_000_000n; // 0.3 gwei
  const T = 1_790_930_000_000;
  const l2 = { out: '100', chains: [8453], after: 99.9 };
  let s = nextShown(null, 'k', l2, T);
  s = nextShown(s, 'k', { out: '100', chains: [8453, 1], after: null }, T + 30_000); // the refresh: Ethereum, unvalued
  s = nextShown(s, 'k', { out: '100', chains: [8453, 1], after: afterGasOut('100', [8453, 1], gas, px) }, T + 30_500); // its gas
  const seen = seenBaseline(s, 'k', s.view, T + 31_500);
  assert.deepEqual(seen, l2, 'the view read before the burst');
  const m = clickQuoteMove(seen, { out: '100', chains: [8453, 1] }, 1, gas, px);
  assert.equal(m.moved, true);
  assert.equal(m.routeChanged, true);
  // The general case: a quote 3% lower 2 s before the click, then a price refresh 1 s before it.
  let g = nextShown(null, 'k', { out: '100', chains: [8453], after: 99.9 }, T);
  g = nextShown(g, 'k', { out: '97', chains: [8453], after: 96.9 }, T + 60_000);
  g = nextShown(g, 'k', { out: '97', chains: [8453], after: 96.8 }, T + 61_000);
  assert.equal(seenBaseline(g, 'k', g.view, T + 62_000).out, '100');
  assert.equal(clickQuoteMove(seenBaseline(g, 'k', g.view, T + 62_000), { out: '97', chains: [8453] }, 1, undefined, px).moved, true);
  // A view on screen for 3 s or more was read: it becomes the one before the next change.
  let r = nextShown(null, 'k', { out: '100', chains: [8453], after: 99.9 }, T);
  r = nextShown(r, 'k', { out: '99', chains: [8453], after: 98.9 }, T + 30_000);
  r = nextShown(r, 'k', { out: '98', chains: [8453], after: 97.9 }, T + 34_000);
  assert.equal(r.prev.out, '99');
  // The same view again changes nothing; another key starts afresh; the first view replaced quickly is still the one before.
  assert.equal(nextShown(r, 'k', { out: '98', chains: [8453], after: 97.9 }, T + 35_000), r);
  assert.equal(nextShown(r, 'other', l2, T + 35_000).prev, undefined);
  const f = nextShown(nextShown(null, 'k', l2, T), 'k', { out: '90', chains: [8453], after: 89.9 }, T + 1000);
  assert.equal(f.prev.out, '100');
  // A view stored "in the future" (the clock since put back) can't be placed: the better of the two stays before.
  let c = nextShown(null, 'k', { out: '100', chains: [8453], after: 99.9 }, T);
  c = nextShown(c, 'k', { out: '102', chains: [8453, 1], after: 98 }, T + 3_600_000); // written with the clock an hour ahead
  c = nextShown(c, 'k', { out: '95', chains: [8453], after: 94.9 }, T + 60_000);
  assert.deepEqual(c.prev, { out: '102', chains: [8453], after: 99.9 });
});
