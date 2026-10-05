// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAY_WINDOW_MS, canMoveTo, canPay, capOrders, isAbandoned, isFinalStatus, isTerminalStatus, payState, payWindowOpen, phaseInput,
  BTC_MISSING_AFTER, btcConfirmed, btcSightingChanged, canHide, isOutOfDate, missingButExpired, nextBtcRecord, paidButExpired, pendingByLeastRecentPoll, sanitizeOrder,
} from '../../src/lib/rift/order-state.ts';

const T0 = 1_790_930_000_000;
const HASH = `0x${'ab'.repeat(32)}`;
const order = (over = {}) => ({
  id: '01a0fb7d-591d-76f3-81c0-c6cc086fa85f', quoteId: '01a0fb7d-244e-7411-9358-5bf1e939153a', createdAt: T0,
  sourceChain: 'ethereum', token: { symbol: 'USDC', decimals: 6, asset: 'ethereum.0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  fromAmount: '10', fromAmountRaw: '10000000', estimatedOut: '16.5', route: [{ venue: 'across', from: 'a', to: 'b' }],
  depositAddress: '0x1111111111111111111111111111111111111111', depositDeadline: new Date(T0 + 7 * 864e5).toISOString(),
  toAddress: '0x2222222222222222222222222222222222222222', status: 'awaiting_deposit', statusTimes: {}, ...over,
});

test('payment state: requested, unknown, sent, failed', () => {
  assert.equal(payState(order(), T0), 'none');
  assert.equal(payState(order({ payRequestedAt: T0 }), T0 + 30_000), 'requesting');
  assert.equal(payState(order({ payRequestedAt: T0 }), T0 + 5 * 60_000), 'unknown', 'a prompt whose marker went stale');
  assert.equal(payState(order({ payUnknown: true }), T0), 'unknown');
  assert.equal(payState(order({ depositSentAt: T0, depositTxHash: HASH }), T0), 'sent');
  assert.equal(payState(order({ depositSentAt: T0 }), T0), 'sent', 'HyperCore: no hash');
  assert.equal(payState(order({ depositSentAt: T0, depositFailed: true, depositFailReason: 'reverted' }), T0), 'failed');
  assert.equal(payState(order({ payAttemptAt: T0, payRequestedAt: undefined }), T0 + 30_000), 'unknown', 'old cleared EVM attempts are not proof of no broadcast');
  assert.equal(payState(order({ payAttemptAt: T0, depositFailed: true, depositFailReason: 'lost' }), T0 + 30_000), 'unknown');
  assert.equal(payState(order({ payAttemptAt: T0, depositFailed: true, depositFailReason: 'cancelled' }), T0 + 30_000), 'failed');
  assert.equal(payState(order({ depositSentAt: T0, depositTxHash: HASH, payUnknown: true }), T0), 'unknown', 'a hash that never showed up');
});

test('an order is paid only inside its window, once', () => {
  assert.equal(canPay(order(), 'evm', T0 + 60_000), true);
  assert.equal(canPay(order(), 'evm', T0 + PAY_WINDOW_MS + 1), false, 'an old order is re-priced, not paid');
  assert.equal(canPay(order({ payRequestedAt: T0 }), 'evm', T0 + 1000), false, 'a prompt is open');
  assert.equal(canPay(order({ payUnknown: true }), 'evm', T0 + 1000), false, 'check first');
  assert.equal(canPay(order({ payAttemptAt: T0 }), 'evm', T0 + 1000), false, 'a cleared legacy EVM marker is still inconclusive');
  assert.equal(canPay(order({ depositFailed: true, depositFailReason: 'lost' }), 'evm', T0 + 1000), false, 'legacy lost has no definitive evidence');
  assert.equal(canPay(order({ depositSentAt: T0, depositTxHash: HASH }), 'evm', T0 + 1000), false, 'already paid');
  assert.equal(canPay(order({ depositFailed: true, depositFailReason: 'reverted' }), 'evm', T0 + 1000), true);
  assert.equal(canPay(order({ status: 'funded' }), 'evm', T0 + 1000), false);
  assert.equal(canPay(order(), 'bitcoin', T0 + 1000), false, 'BTC is sent by the user');
  assert.equal(payWindowOpen(order({ sourceChain: 'bitcoin' }), 'bitcoin', T0 + 50 * 60_000), true);
  assert.equal(payWindowOpen(order({ depositDeadline: new Date(T0 + 5 * 60_000).toISOString() }), 'evm', T0), false, 'too close to the deadline');
});

test('abandoned: unpaid past the window, nothing in doubt', () => {
  const late = T0 + PAY_WINDOW_MS + 1;
  assert.equal(isAbandoned(order(), late), true);
  assert.equal(isAbandoned(order(), T0 + 1000), false, 'still payable');
  assert.equal(isAbandoned(order({ payUnknown: true }), late), false, 'a payment may be on its way');
  assert.equal(isAbandoned(order({ depositSentAt: T0, depositTxHash: HASH }), late), false);
  assert.equal(isAbandoned(order({ depositFailed: true, depositFailReason: 'reverted' }), late), true);
  assert.equal(isAbandoned(order({ sourceChain: 'bitcoin', btc: { txid: 'ab'.repeat(32) } }), T0 + 2 * 3600_000), false);
  assert.equal(isAbandoned(order({ status: 'expired' }), late), false);
});

test('statuses only move forward; frozen can still settle', () => {
  assert.equal(canMoveTo('awaiting_deposit', 'funded'), true);
  assert.equal(canMoveTo('funded', 'awaiting_deposit'), false, 'a late answer cannot re-open payment');
  assert.equal(canMoveTo('executing', 'funded'), false);
  assert.equal(canMoveTo('executing', 'delivered'), true);
  assert.equal(canMoveTo('delivered', 'refunded'), false, 'final');
  assert.equal(canMoveTo('frozen', 'refunded'), true);
  assert.equal(canMoveTo('frozen', 'delivered'), true);
  assert.equal(canMoveTo('frozen', 'executing'), true, 'released');
  assert.equal(canMoveTo('frozen', 'awaiting_deposit'), false);
  assert.equal(canMoveTo('awaiting_deposit', 'underfunded'), true);
  assert.equal(canMoveTo('underfunded', 'refunded'), true);
  assert.equal(isTerminalStatus('frozen'), true);
  assert.equal(isFinalStatus('frozen'), false, 'still polled');
});

test('the same phase inputs everywhere (HyperCore has no hash)', () => {
  const p = phaseInput(order({ sourceChain: 'hyperliquid', depositSentAt: T0, depositConfirmedAt: T0 }), 'hypercore');
  assert.equal(p.depositSentAt, T0);
  assert.equal(phaseInput(order({ depositSentAt: T0, depositFailed: true }), 'evm').depositSentAt, undefined);
  assert.equal(phaseInput(order({ depositSentAt: T0, payUnknown: true }), 'evm').depositSentAt, undefined, 'unknown pays first');
});

test('saved records are checked; bad ones are dropped, not rendered', () => {
  assert.ok(sanitizeOrder(order()));
  assert.equal(sanitizeOrder(order({ sourceChain: 'solana' })), null, 'a chain this version does not know');
  assert.equal(sanitizeOrder(order({ token: undefined })), null);
  assert.equal(sanitizeOrder(order({ route: [{ venue: 'x' }] })), null);
  assert.equal(sanitizeOrder(order({ status: 'teleported' })), null);
  assert.equal(sanitizeOrder(order({ fromAmountRaw: '1e6' })), null);
  assert.equal(sanitizeOrder(order({ fromAmountRaw: '1000000000' })), null, 'the displayed amount must equal the raw wallet transfer');
  assert.equal(sanitizeOrder(order({ estimatedOut: '9'.repeat(400) })), null, 'an overflowing estimate is not renderable');
  assert.equal(sanitizeOrder(order({ token: { ...order().token, asset: 'arbitrum.eth' } })), null, 'source asset must match its chain and contract');
  assert.equal(sanitizeOrder(order({ depositAddress: '0x333333333333333333333333333333333333333' })), null, 'a restored order cannot pay a malformed address');
  assert.equal(sanitizeOrder(order({ depositDeadline: 'later' })), null);
  assert.equal(sanitizeOrder(order({ fromAmount: '0.001x' })), null, 'the amount is used in BigInt maths while rendering');
  assert.ok(sanitizeOrder(order({
    sourceChain: 'bitcoin', token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' },
    fromAmount: '0.01', fromAmountRaw: '1000000', depositAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  })), 'a saved Bitcoin order is still tracked');
  assert.deepEqual(sanitizeOrder(order({ statusTimes: undefined })).statusTimes, {});
  assert.equal(sanitizeOrder(null), null);
});

test('damaged optional fields are dropped, the order kept', () => {
  const o = sanitizeOrder(order({
    btc: { txid: 'ab'.repeat(32), totalSats: '0.001', confirmations: 'x', firstSeenAt: T0 },
    depositTxHash: '0x12', depositReceivedRaw: '-1', baseFromBlock: '1e9', payRequestedAt: 'soon', payAttemptId: 'bad', amountOut: 'lots',
    statusTimes: { funded: 'later', awaiting_deposit: T0, teleported: T0 }, pastTxHashes: [HASH, 'nope'],
    hlAction: { destination: '0x1', token: 'USDC:0x6d', amount: '5', time: T0 },
  }));
  assert.ok(o);
  assert.deepEqual(o.btc, { txid: 'ab'.repeat(32), firstSeenAt: T0 }, 'BigInt(totalSats) would throw while rendering');
  assert.equal(o.depositTxHash, undefined);
  assert.equal(o.depositReceivedRaw, undefined);
  assert.equal(o.baseFromBlock, undefined);
  assert.equal(o.payRequestedAt, undefined);
  assert.equal(o.payAttemptId, undefined);
  assert.equal(o.amountOut, undefined);
  assert.deepEqual(o.statusTimes, { awaiting_deposit: T0 });
  assert.deepEqual(o.pastTxHashes, [HASH]);
  assert.equal(o.hlAction, undefined, 'unsigned');
});

test('orders skipped by the poll budget move to the front on the next round', () => {
  const all = Array.from({ length: 12 }, (_, i) => order({ id: String(i), lastPolledAt: T0 }));
  const first = pendingByLeastRecentPoll(all, {});
  assert.deepEqual(first.map(o => o.id), all.map(o => o.id));
  const stamps = Object.fromEntries(first.slice(0, 8).map(o => [o.id, T0 + 60_000]));
  const next = pendingByLeastRecentPoll(all, stamps);
  assert.deepEqual(next.slice(0, 4).map(o => o.id), ['8', '9', '10', '11']);
  assert.deepEqual(pendingByLeastRecentPoll([...all, order({ id: 'done', status: 'delivered' })], stamps).map(o => o.id), next.map(o => o.id));
});

test('capping never drops an order in flight or one needing support; abandoned ones go first', () => {
  const list = [
    order({ id: 'a', createdAt: T0 + 5, status: 'delivered' }),
    order({ id: 'b', createdAt: T0 + 4, status: 'executing' }),
    order({ id: 'c', createdAt: T0 + 3, status: 'frozen' }),
    order({ id: 'd', createdAt: T0 + 2, status: 'expired' }),
    order({ id: 'e', createdAt: T0 + 1, status: 'awaiting_deposit' }),
  ];
  assert.deepEqual(capOrders(list, 4, T0 + 1000).map(o => o.id), ['a', 'b', 'c', 'e']);
  assert.deepEqual(capOrders(list, 2, T0 + 1000).map(o => o.id), ['b', 'c', 'e'], 'over the cap rather than losing one in flight');
  assert.deepEqual(capOrders(list, 3, T0 + PAY_WINDOW_MS + 10).map(o => o.id), ['a', 'b', 'c'], 'e was never paid and its window closed');
});

test('an order in doubt can be hidden only after its window; hidden, it is out of date but never removable', () => {
  const late = T0 + PAY_WINDOW_MS + 1;
  const unknown = order({ payUnknown: true });
  assert.equal(canHide(unknown, T0 + 1000), false, 'still inside its window');
  assert.equal(canHide(unknown, late), true);
  assert.equal(canHide(order({ payRequestedAt: late - 1000 }), late), false, 'a wallet prompt is open');
  assert.equal(canHide(order({ sourceChain: 'bitcoin', payUnknown: true }), late), false);
  assert.equal(isOutOfDate(unknown, late), false, 'not out of date until hidden');
  const hidden = order({ payUnknown: true, hiddenAt: late });
  assert.equal(isOutOfDate(hidden, late), true);
  assert.equal(isAbandoned(hidden, late), false, 'its payment may still arrive: never removed by Dismiss, Clear or the cap');
  assert.equal(capOrders([hidden, ...Array.from({ length: 3 }, (_, i) => order({ id: String(i), status: 'delivered' }))], 1, late).some(o => o === hidden), true);
  assert.equal(isOutOfDate(order({ payUnknown: true, hiddenAt: late, status: 'funded' }), late), false, 'a payment turned up');
  assert.equal(sanitizeOrder(order({ hiddenAt: 'yes', hlPostedAt: 'no' })).hiddenAt, undefined);
});

test('a Bitcoin payment seen once survives empty answers, and is marked missing only after several', () => {
  const seen = { payments: [{ txid: 'ab'.repeat(32), confirmations: 0 }], totalSats: 1_000_000n };
  const empty = { payments: [], totalSats: 0n };
  let btc = nextBtcRecord(undefined, seen, T0);
  assert.equal(btc.firstSeenAt, T0);
  assert.equal(nextBtcRecord(undefined, empty, T0), undefined, 'nothing seen, nothing recorded');
  for (let i = 1; i < BTC_MISSING_AFTER; i++) {
    btc = nextBtcRecord(btc, empty, T0 + i);
    assert.equal(btc.txid, 'ab'.repeat(32));
    assert.equal(btc.missing, undefined, `${i} empty answer(s) are not enough`);
  }
  btc = nextBtcRecord(btc, empty, T0 + 10);
  assert.equal(btc.missing, true);
  assert.equal(btc.txid, 'ab'.repeat(32), 'still known: the order is never treated as unpaid');
  const o = order({ sourceChain: 'bitcoin', btc, token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' } });
  assert.equal(phaseInput(o, 'bitcoin').btcSeenAt, undefined, 'the QR code returns');
  assert.equal(isAbandoned(o, T0 + 2 * 3600_000), false, 'not removable while the payment may still confirm');
  assert.equal(nextBtcRecord(btc, empty, T0 + 11), btc, 'nothing more is recorded once missing');
  const back = nextBtcRecord(btc, seen, T0 + 20);
  assert.equal(back.missing, undefined);
  assert.equal(back.firstSeenAt, T0, 'first seen keeps its time');
  // An older version could leave only `{ missing: true }`: still a payment seen, never "nothing was sent".
  const legacy = order({ sourceChain: 'bitcoin', btc: { missing: true }, token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' } });
  assert.equal(isAbandoned(legacy, T0 + 2 * 3600_000), false);
});

test('an expired order this browser saw paid needs Rift\u2019s support, so it is never cleared', () => {
  const late = T0 + 8 * 864e5;
  const paid = order({ status: 'expired', depositSentAt: T0, depositTxHash: HASH });
  assert.equal(paidButExpired(paid, late), true);
  assert.equal(paidButExpired(order({ status: 'expired' }), late), false);
  assert.equal(paidButExpired(order({ status: 'expired', depositSentAt: T0, depositFailed: true, depositFailReason: 'reverted' }), late), false);
  // A Bitcoin payment seen and then gone (dropped or replaced) is not one Rift was paid: the order can be cleared.
  assert.equal(paidButExpired(order({ status: 'expired', sourceChain: 'bitcoin', btc: { txid: 'ab'.repeat(32) } }), late), true);
  assert.equal(paidButExpired(order({ status: 'expired', sourceChain: 'bitcoin', btc: { txid: 'ab'.repeat(32), missing: true } }), late), false);
  const others = Array.from({ length: 3 }, (_, i) => order({ id: String(i), status: 'delivered' }));
  assert.ok(capOrders([paid, ...others], 1, late).includes(paid));
});

test('while storage refuses writes, a Bitcoin look records what was seen, not its counters', () => {
  const seen = c => ({ payments: [{ txid: 'ab'.repeat(32), confirmations: c }], totalSats: 1_000_000n });
  const empty = { payments: [], totalSats: 0n };
  const first = nextBtcRecord(undefined, seen(0), T0);
  assert.equal(btcSightingChanged(undefined, first), true, 'first seen');
  assert.equal(btcSightingChanged(first, nextBtcRecord(first, seen(0), T0 + 1)), false);
  const one = nextBtcRecord(first, seen(1), T0 + 2);
  assert.equal(btcSightingChanged(first, one), true, 'first confirmation');
  assert.equal(btcSightingChanged(one, nextBtcRecord(one, seen(2), T0 + 3)), false, 'more confirmations: a counter');
  assert.equal(btcSightingChanged(one, nextBtcRecord(one, empty, T0 + 4, 1)), false, 'one empty answer: a counter');
  assert.equal(btcSightingChanged({ ...one, emptyChecks: 2 }, nextBtcRecord({ ...one, emptyChecks: 2 }, seen(1), T0 + 4)), true,
    'seen again after empty answers: recorded, so the stored count can\u2019t outlive it');
  // The page's own count stands in for the stored one, which a sighting it could not record left too high
  // (an unconfirmed payment: a confirmed one is never missing).
  const high = { ...first, emptyChecks: 2 };
  assert.equal(nextBtcRecord(high, empty, T0 + 5, 1).missing, undefined);
  const gone = nextBtcRecord(high, empty, T0 + 6, BTC_MISSING_AFTER);
  assert.equal(gone.missing, true);
  assert.equal(btcSightingChanged(high, gone), true, 'missing is recorded');
});

test('an expired order whose Bitcoin payment went missing can be cleared, but is never dropped automatically', () => {
  const late = T0 + 8 * 864e5;
  const o = order({ status: 'expired', sourceChain: 'bitcoin', token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' }, btc: { txid: 'ab'.repeat(32), missing: true } });
  assert.equal(missingButExpired(o), true);
  assert.equal(paidButExpired(o, late), false);
  const others = Array.from({ length: 3 }, (_, i) => order({ id: String(i), status: 'delivered' }));
  assert.ok(capOrders([o, ...others], 1, late).includes(o));
});

test('a confirmed Bitcoin payment is never "missing", whatever the API answers', () => {
  // Another audit, High 3: three empty answers put a six-confirmation payment's QR code back on screen.
  const seen = (...c) => ({ payments: c.map((n, i) => ({ txid: String(i).repeat(64), confirmations: n })), totalSats: 1_000_000n });
  const empty = { payments: [], totalSats: 0n };
  let btc = nextBtcRecord(undefined, seen(6), T0);
  assert.equal(btc.confirmed, true);
  for (let i = 1; i <= 5; i++) btc = nextBtcRecord(btc, empty, T0 + i, i);
  assert.equal(btc.missing, undefined);
  assert.equal(btc.emptyChecks, undefined, 'not even counted');
  btc = nextBtcRecord(btc, seen(6, 0), T0 + 10); // then a second, unconfirmed payment
  assert.equal(btc.confirmations, 0);
  assert.equal(btcConfirmed(btc), true, 'still confirmed');
  assert.equal(nextBtcRecord(btc, empty, T0 + 11, 3), btc);
  // An older version could mark one missing: it reads back as seen.
  const legacy = sanitizeOrder(order({
    sourceChain: 'bitcoin', token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' }, fromAmount: '0.001', fromAmountRaw: '100000',
    depositAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
    btc: { txid: 'ab'.repeat(32), confirmations: 6, firstSeenAt: T0, missing: true, emptyChecks: 3 },
  }));
  assert.equal(legacy.btc.missing, undefined);
  assert.equal(legacy.btc.emptyChecks, undefined);
  assert.equal(phaseInput(legacy, 'bitcoin').btcSeenAt, T0, 'no QR code');
});
