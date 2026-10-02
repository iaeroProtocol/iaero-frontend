// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProgress, estimateRoute, formatClock, formatDuration, formatRange, phaseOf } from '../../src/lib/rift/timing.ts';

const DEST = 'base.0x81034fb34009115f215f5d5f564aac9ffa46a1dc';
const KNOWN = { [DEST]: 'iAERO', 'ethereum.eth': 'ETH' };
const ethRoute = [
  { venue: 'across', from: 'ethereum.eth', to: 'base.eth' },
  { venue: 'kyberswap', from: 'base.eth', to: DEST },
];
const btcRoute = [
  { venue: 'unit', from: 'bitcoin.btc', to: 'hyperliquid.btc' },
  { venue: 'hyperliquid_spot', from: 'hyperliquid.btc', to: 'hyperliquid.usdc' },
  { venue: 'cctp_hyperliquid_fast', from: 'hyperliquid.usdc', to: 'base.usdc' },
  { venue: 'velora', from: 'base.usdc', to: DEST },
];

test('a route becomes payment + one step per hop + delivery, with readable labels', () => {
  const est = estimateRoute('ethereum', ethRoute, KNOWN);
  assert.deepEqual(est.steps.map(s => s.kind), ['deposit', 'bridge', 'swap', 'deliver']);
  assert.equal(est.steps[0].label, 'Your payment confirms on Ethereum');
  assert.equal(est.steps[1].label, 'Move ETH from Ethereum to Base');
  assert.equal(est.steps[1].detail, 'via Across');
  assert.equal(est.steps[2].label, 'Swap ETH for iAERO on Base');
  assert.equal(est.typicalSec, est.steps.reduce((n, s) => n + s.typicalSec, 0));
  assert.ok(est.typicalSec < 5 * 60, 'an Ethereum route usually takes a few minutes');
  const btc = estimateRoute('bitcoin', btcRoute, KNOWN);
  assert.ok(btc.typicalSec > 40 * 60 && btc.typicalSec < 2 * 3600, 'Bitcoin is dominated by confirmations');
  assert.equal(btc.steps[1].label, 'Move BTC from Bitcoin to Hyperliquid');
  assert.equal(btc.steps[2].label, 'Swap BTC for USDC on Hyperliquid');
  // An unknown venue still gets an estimate.
  assert.ok(estimateRoute('arbitrum', [{ venue: 'newbridge', from: 'arbitrum.usdc', to: DEST }], KNOWN).steps[1].typicalSec > 0);
});

test('durations read naturally', () => {
  assert.equal(formatDuration(42), '40 sec');
  assert.equal(formatDuration(3), '5 sec');
  assert.equal(formatDuration(150), '3 min');
  assert.equal(formatDuration(3600 + 15 * 60), '1 h 15 min');
  assert.equal(formatRange(120, 360), '2–6 min');
  assert.equal(formatRange(45, 240), '45 sec – 4 min');
  assert.equal(formatRange(40 * 60, 2 * 3600 + 15 * 60), '40 min – 2 h 15 min');
  assert.equal(formatClock(65), '1:05');
  assert.equal(formatClock(3723), '1:02:03');
});

test('progress follows the payment, then the route by the clock, and flags slowness', () => {
  const est = estimateRoute('ethereum', ethRoute, KNOWN);
  const t0 = 1_000_000;
  const base = { sourceKind: 'evm', createdAt: t0, estimate: est };
  assert.equal(computeProgress({ ...base, status: 'awaiting_deposit', now: t0 }).phase, 'pay');

  const sent = computeProgress({ ...base, status: 'awaiting_deposit', depositSentAt: t0, now: t0 + 20_000 });
  assert.equal(sent.phase, 'confirming');
  assert.equal(sent.activeIndex, 0);
  assert.ok(sent.remainingSec > 0 && sent.expectedDoneAt > t0);
  assert.equal(sent.slow, false);
  assert.equal(computeProgress({ ...base, status: 'awaiting_deposit', depositSentAt: t0, now: t0 + 10 * 60_000 }).slow, true);

  const confirmed = computeProgress({ ...base, status: 'awaiting_deposit', depositSentAt: t0, depositConfirmedAt: t0 + 15_000, now: t0 + 30_000 });
  assert.equal(confirmed.phase, 'detecting');

  const funded = t0 + 60_000;
  const early = computeProgress({ ...base, status: 'executing', depositSentAt: t0, fundedAt: funded, now: funded + 10_000 });
  assert.equal(early.phase, 'executing');
  assert.equal(early.activeIndex, 1, 'bridging first');
  const later = computeProgress({ ...base, status: 'executing', depositSentAt: t0, fundedAt: funded, now: funded + (est.steps[1].typicalSec + 5) * 1000 });
  assert.equal(later.activeIndex, 2, 'then swapping');
  assert.ok(later.fraction > early.fraction && later.fraction < 1);
  const overdue = computeProgress({ ...base, status: 'executing', depositSentAt: t0, fundedAt: funded, now: funded + 3600_000 });
  assert.equal(overdue.activeIndex, 2, 'stays on the last hop until Rift reports delivery');
  assert.equal(overdue.slow, true);

  const done = computeProgress({ ...base, status: 'delivered', depositSentAt: t0, fundedAt: funded, finishedAt: funded + 90_000, now: funded + 900_000 });
  assert.deepEqual([done.phase, done.fraction, done.activeIndex, done.remainingSec], ['delivered', 1, est.steps.length, 0]);
  assert.equal(done.elapsedSec, 150, 'measured from the payment to delivery');
  assert.equal(computeProgress({ ...base, status: 'refunded', now: t0 }).phase, 'refunded');
});

test('bitcoin orders wait for the payment to be seen, then confirm', () => {
  assert.equal(phaseOf({ status: 'awaiting_deposit', sourceKind: 'bitcoin' }), 'pay');
  assert.equal(phaseOf({ status: 'awaiting_deposit', sourceKind: 'bitcoin', btcSeenAt: 1 }), 'confirming');
  assert.equal(phaseOf({ status: 'funded', sourceKind: 'bitcoin', btcSeenAt: 1 }), 'executing');
  assert.equal(phaseOf({ status: 'underfunded', sourceKind: 'evm' }), 'underfunded');
});
