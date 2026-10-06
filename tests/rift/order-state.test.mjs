// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAY_WINDOW_MS, canMoveTo, canPay, capOrders, isAbandoned, isFinalStatus, isTerminalStatus, payState, payWindowOpen, phaseInput,
  BTC_MISSING_AFTER, BTC_GRACE_MS, btcCheckpoint, btcConfirmed, btcLookPatch, btcNeedsLook, btcPositive, btcUnchecked, btcUnpaid, canRetryUnknown, BTC_EMPTY_SPAN_MS, BTC_LOOK_FRESH_MS, btcLookEveryMs, doubtButExpired,
  PRE_SEND_COOLDOWN_MS, btcLookChange, nonceUsed, paymentFacts, pastDeadline, windowCloseChange,
  clearable, canHide, isOutOfDate, missingButExpired, nextBtcRecord, paidButExpired, pendingByLeastRecentPoll, sanitizeOrder,
  BTC_EMPTY_GAP_MS, shownOutOfDate, btcLookSoon, btcWatchEveryMs, BTC_WATCH_LOOK_MS, btcStillPayable,
} from '../../src/lib/rift/order-state.ts';

const T0 = 1_790_930_000_000;
/** btcLookPatch for a look asked at `at`, answered and applied at `appliedAt` (the clock then; `at` by default). The
 *  clock is never behind times already stored by this page, so a look older than the record is applied later. */
const lookNow = (prev, seen, at, checkpoint, failing = false, appliedAt = at) => {
  const real = Date.now;
  Date.now = () => appliedAt;
  try { return btcLookPatch(prev, seen, { at, answeredAt: appliedAt, failing, checkpoint }); } finally { Date.now = real; }
};
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
    btc = nextBtcRecord(btc, empty, T0 + i * 60_000);
    assert.equal(btc.txid, 'ab'.repeat(32));
    assert.equal(btc.missing, undefined, `${i} empty answer(s) are not enough`);
  }
  btc = nextBtcRecord(btc, empty, T0 + BTC_MISSING_AFTER * 60_000);
  assert.equal(btc.missing, true);
  assert.equal(btc.txid, 'ab'.repeat(32), 'still known: the order is never treated as unpaid');
  const o = order({ sourceChain: 'bitcoin', btc, token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' } });
  assert.equal(phaseInput(o, 'bitcoin').btcSeenAt, undefined, 'the QR code returns');
  assert.equal(isAbandoned(o, T0 + 2 * 3600_000), false, 'not removable while the payment may still confirm');
  assert.equal(nextBtcRecord(btc, empty, T0 + 9 * 60_000), btc, 'nothing more is recorded once missing');
  const back = nextBtcRecord(btc, seen, T0 + 10 * 60_000);
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
  assert.equal(btcPositive(undefined, first), true, 'first seen');
  assert.equal(btcPositive(first, nextBtcRecord(first, seen(0), T0 + 1)), false);
  const one = nextBtcRecord(first, seen(1), T0 + 2);
  assert.equal(btcPositive(first, one), true, 'first confirmation');
  assert.equal(btcPositive(one, nextBtcRecord(one, seen(2), T0 + 3)), false, 'more confirmations: a counter');
  assert.equal(btcPositive(first, nextBtcRecord(first, empty, T0 + 4)), false, 'one empty answer: a counter');
  assert.equal(btcPositive({ ...one, emptyChecks: 2 }, nextBtcRecord({ ...one, emptyChecks: 2 }, seen(1), T0 + 4)), true,
    'seen again after empty answers: recorded, so the stored count can\u2019t outlive it');
  // While storage refuses writes, "missing" is never recorded: another tab may be seeing the payment.
  const at = T0 + BTC_EMPTY_SPAN_MS + 1, cp = T0 + 10 * 3600_000;
  const high = { ...first, emptyChecks: BTC_MISSING_AFTER - 1, emptySince: T0, emptyLastAt: at - 20_000 };
  assert.deepEqual(lookNow(high, empty, at, cp, true), {}, 'not while failing');
  assert.equal(lookNow(high, empty, at, cp).btc.missing, true, 'recorded once storage works');
  assert.equal(lookNow(first, seen(1), at, cp, true).btc.confirmed, true, 'a payment seen is recorded while failing');
});

test('Bitcoin "nothing was sent" waits for a look at the address past its checkpoint', () => {
  // Round 2, Medium: an order with no payment recorded was Dismissable, and "Nothing was taken" was said, without
  // anything having looked at the address (only the open card looks; a last-minute payment takes a while to show).
  const btc = (over = {}) => order({ sourceChain: 'bitcoin', token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' }, ...over });
  const o = btc();
  const cutoff = T0 + 3600_000;
  assert.equal(btcCheckpoint(o), cutoff + BTC_GRACE_MS);
  assert.equal(isAbandoned(o, cutoff + 60_000), false, 'just past the window: not yet');
  assert.equal(isAbandoned(o, T0 + 5 * 3600_000), false, 'hours later, but nobody looked');
  const empty = { payments: [], totalSats: 0n };
  const cp = btcCheckpoint(o);
  assert.deepEqual(lookNow(o.btc, empty, cutoff + 60_000, cp), {}, 'a look before the checkpoint is not evidence');
  assert.deepEqual(lookNow(o.btc, empty, cp + 1, cp, true), {}, 'nor while storage fails');
  let rec = o.btc;
  for (const dt of [...Array.from({ length: BTC_MISSING_AFTER - 1 }, (_, i) => 1 + i * 20_000), BTC_EMPTY_SPAN_MS + 1]) rec = lookNow(rec, empty, cp + dt, cp).btc;
  const looked = btc({ btc: rec });
  assert.equal(isAbandoned(looked, cp + BTC_EMPTY_SPAN_MS + 2), true, 'a run of looks over two minutes');
  assert.deepEqual(lookNow(looked.btc, empty, cp + BTC_EMPTY_SPAN_MS + 9, cp), {}, 'recorded once');
  // Expired by Rift: cleared, and "Nothing was taken", only after a look since then.
  const expired = btc({ status: 'expired', statusTimes: { awaiting_deposit: T0, expired: T0 + 7 * 864e5 } });
  assert.equal(btcUnchecked(expired, T0 + 8 * 864e5), true);
  assert.equal(clearable(expired, T0 + 8 * 864e5), false);
  assert.equal(btcNeedsLook(expired, T0 + 8 * 864e5), true);
  const checked = btc({ ...expired, btc: { emptyAt: T0 + 7 * 864e5 + 1 } });
  assert.equal(clearable(checked, T0 + 8 * 864e5), true);
  assert.equal(btcNeedsLook(checked, T0 + 8 * 864e5), false);
  // An expired order whose unconfirmed payment was seen keeps being looked at; a confirmed one needs support only.
  assert.equal(btcNeedsLook(btc({ status: 'expired', btc: { txid: 'ab'.repeat(32), confirmations: 0 } })), true);
  assert.equal(btcNeedsLook(btc({ status: 'expired', btc: { txid: 'ab'.repeat(32), confirmations: 2, confirmed: true } })), false);
  assert.equal(btcNeedsLook(order()), false, 'not a Bitcoin order');
});

test('a HyperCore order in doubt may re-post its saved transfer, only while its window is open', () => {
  const action = { destination: '0x1', token: 'USDC:0x6d', amount: '10', time: 1, r: '0x1', s: '0x2', v: 27 };
  const hl = over => order({ sourceChain: 'hyperliquid', token: { symbol: 'USDC', decimals: 8, asset: 'hyperliquid.usdc' }, ...over });
  assert.equal(canRetryUnknown(hl({ hlAction: action, payUnknown: true }), T0 + 1000), true);
  assert.equal(canRetryUnknown(hl({ payUnknown: true }), T0 + 1000), true, 'nothing ever saved: signing anew is safe');
  assert.equal(canRetryUnknown(hl({ payUnknown: true, hlPostedAt: T0 }), T0 + 1000), false, 'posted, but the transfer is gone: never');
  assert.equal(canRetryUnknown(hl({ hlAction: action }), T0 + 1000), false, 'not in doubt');
  assert.equal(canRetryUnknown(hl({ hlAction: action, payUnknown: true }), T0 + 11 * 60_000), false, 'window closed');
  assert.equal(canRetryUnknown(order({ hlAction: action, payUnknown: true }), T0 + 1000), false, 'not HyperCore');
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

test('Bitcoin evidence needs a run of empty answers over minutes; a stale or lagging answer counts for nothing', () => {
  // Round 3, Medium: one empty answer past the checkpoint proved "nothing was sent"; and several tabs, or an old
  // answer applied late, could make "missing" come in seconds.
  const btc = (over = {}) => order({ sourceChain: 'bitcoin', token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' }, ...over });
  const empty = { payments: [], totalSats: 0n };
  const o = btc();
  const cp = btcCheckpoint(o);
  let rec = lookNow(undefined, empty, cp + 1, cp).btc;
  assert.equal(rec.emptyAt, undefined, 'one empty answer is not evidence');
  for (let i = 1; i <= BTC_MISSING_AFTER; i++) rec = lookNow(rec, empty, cp + i * 20_000, cp).btc;
  assert.equal(rec.emptyAt, undefined, 'several in under two minutes are not either');
  rec = lookNow(rec, empty, cp + BTC_EMPTY_SPAN_MS + 1, cp).btc;
  assert.equal(typeof rec.emptyAt, 'number', 'a run over two minutes is');
  // A payment recorded earlier that the address no longer lists, but mempool.space still knows: a lagging index.
  const paid = { txid: 'ab'.repeat(32), confirmations: 0, firstSeenAt: cp, emptyChecks: 2, emptySince: cp };
  assert.deepEqual(lookNow(paid, 'known', cp + 60_000, cp).btc, { txid: 'ab'.repeat(32), confirmations: 0, firstSeenAt: cp, lastSeenAt: cp + 60_000 });
  assert.deepEqual(lookNow({ txid: 'ab'.repeat(32) }, 'known', cp, cp), {}, 'nothing to undo');
  // An empty answer applied later than BTC_LOOK_FRESH_MS (a refused change, replayed) keeps only what it saw.
  const real = Date.now;
  Date.now = () => cp + 10 * 60_000;
  try {
    assert.deepEqual(btcLookPatch(paid, empty, { at: cp + 10 * 60_000 - BTC_LOOK_FRESH_MS - 1, failing: false, checkpoint: cp }), {});
    assert.equal(btcLookPatch(undefined, { payments: [{ txid: 'ab'.repeat(32), confirmations: 0 }], totalSats: 1n }, { at: cp - 3600_000, failing: false, checkpoint: cp }).btc.txid,
      'ab'.repeat(32), 'a payment it saw is kept whenever it is applied');
  } finally {
    Date.now = real;
  }
  // An empty answer older than the run it would extend counts for nothing.
  assert.deepEqual(lookNow({ ...paid, emptySince: cp + 5 * 60_000 }, empty, cp + 4 * 60_000, cp, false, cp + 5 * 60_000 + 1000), {});
  // Unpaid Bitcoin orders are never dropped by the cap; an expired one whose payment went missing is not bulk-cleared.
  const unpaid = btc({ createdAt: T0 - 864e5, btc: { emptyAt: T0 } });
  const others = Array.from({ length: 3 }, (_, i) => order({ id: String(i), status: 'delivered' }));
  assert.equal(btcUnpaid(unpaid), true);
  assert.ok(capOrders([unpaid, ...others], 1, T0 + 864e5).includes(unpaid));
  assert.equal(clearable(btc({ status: 'expired', btc: { txid: 'ab'.repeat(32), missing: true } }), T0 + 8 * 864e5), false);
});

test('an empty answer older than the latest sighting recorded counts for nothing; unchanged sightings write nothing', () => {
  // Round 5, Low: a replayed empty answer, older than another tab's saved sighting, started a new run.
  const seen = { payments: [{ txid: 'ab'.repeat(32), confirmations: 0 }], totalSats: 1_000_000n };
  const empty = { payments: [], totalSats: 0n };
  const cp = T0 + 10 * 3600_000;
  const rec = lookNow(undefined, seen, T0 + 100_000, cp).btc;
  assert.equal(rec.lastSeenAt, T0 + 100_000, 'a recorded sighting carries its time');
  assert.deepEqual(lookNow(rec, seen, T0 + 120_000, cp), {}, 'the same sighting again: nothing to write');
  assert.deepEqual(lookNow(rec, empty, T0 + 90_000, cp, false, T0 + 101_000), {}, 'older than the sighting: ignored');
  assert.equal(lookNow(rec, empty, T0 + 130_000, cp).btc.emptyChecks, 1, 'newer: counted');
});

test('looks back off when mempool.space fails, and don\u2019t race while storage can\u2019t finish a run', () => {
  const btc = (over = {}) => order({ sourceChain: 'bitcoin', token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' }, ...over });
  const o = btc();
  const deciding = btcCheckpoint(o) + 1;
  assert.equal(btcLookEveryMs(o, deciding), 20_000);
  assert.equal(btcLookEveryMs(o, deciding, { errors: 3 }), 160_000);
  assert.equal(btcLookEveryMs(o, deciding, { errors: 30 }), 10 * 60_000, 'capped');
  assert.equal(btcLookEveryMs(o, deciding, { failing: true }), 10 * 60_000, 'the run can\u2019t complete while writes fail');
  assert.equal(btcLookEveryMs(o, T0 + 60_000, { failing: true }), 20_000, 'while it can be paid, a payment must still be seen');
});

test('an EVM payment in doubt that Rift expired is neither "sent" nor "nothing taken", and stays until removed', () => {
  // Round 5 (from the Bitcoin audit): after a39afb9 such an order read "Nothing was taken" and could be bulk-cleared.
  const late = T0 + 8 * 864e5;
  const o = order({ status: 'expired', payUnknown: true, depositTxHash: HASH, depositSentAt: T0 });
  assert.equal(doubtButExpired(o, late), true);
  assert.equal(paidButExpired(o, late), false);
  assert.equal(clearable(o, late), false);
  const others = Array.from({ length: 3 }, (_, i) => order({ id: String(i), status: 'delivered' }));
  assert.ok(capOrders([o, ...others], 1, late).includes(o));
});

test('Pay waits a minute after "nothing was sent", and never while Rift reports a status this page doesn\u2019t know', () => {
  // Round 5, Lows and wallet behaviour: a private relay shows a payment only once mined; an unknown status may mean paid.
  const failed = order({ depositFailed: true, depositFailReason: 'pre_send', preSendAt: T0 + 1000, payAttemptAt: T0 });
  assert.equal(canPay(failed, 'evm', T0 + 2000), false, 'just failed');
  assert.equal(canPay(failed, 'evm', T0 + 1000 + PRE_SEND_COOLDOWN_MS + 1), true, 'a minute later');
  assert.equal(canPay(order({ rawStatus: 'rebalancing' }), 'evm', T0 + 1000), false);
  assert.equal(isAbandoned(order({ rawStatus: 'rebalancing' }), T0 + 3600_000), false, 'never "nothing was sent" then');
  const action = { destination: '0x1', token: 'USDC:0x6d', amount: '10', time: 1, r: '0x1', s: '0x2', v: 27 };
  assert.equal(canRetryUnknown(order({ sourceChain: 'hyperliquid', token: { symbol: 'USDC', decimals: 8, asset: 'hyperliquid.usdc' }, hlAction: action, payUnknown: true, rawStatus: 'x' }), T0 + 1000), false);
});

// --- Round 6 ---

const btcOrd = (over = {}) => order({ sourceChain: 'bitcoin', token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' }, ...over });
const EMPTY = { payments: [], totalSats: 0n };
/** `fn` run with the clock at `t`. */
const clockAt = (t, fn) => { const real = Date.now; Date.now = () => t; try { return fn(); } finally { Date.now = real; } };

test('round 6: a look is judged against the order as stored when applied (Rift expired it while the look ran)', () => {
  const cp = T0 + 60 * 60_000 + BTC_GRACE_MS;
  // A run of empty looks past the old checkpoint, still going when Rift expired the order.
  const expiredAt = T0 + 7 * 864e5;
  const t = expiredAt + 30_000;
  const waiting = btcOrd({ btc: { emptyChecks: BTC_MISSING_AFTER - 1, emptySince: cp + 60_000, emptyLastAt: t - 20_000 } });
  const expired = { ...waiting, status: 'expired', statusTimes: { expired: expiredAt } };
  // Judged with the checkpoint of the order as it was when the look began, one answer after the expiry proved it.
  const stale = clockAt(t, () => btcLookPatch(expired.btc, EMPTY, { at: t, failing: false, checkpoint: btcCheckpoint(waiting) }));
  assert.equal(stale.btc.emptyAt, t, 'what the call sites did before');
  // Against the stored order's checkpoint, it starts a new run.
  const r = clockAt(t, () => btcLookChange(expired, EMPTY, { at: t, failing: false }));
  assert.deepEqual({ ...r.btc }, { emptyChecks: 1, emptySince: t, emptyLastAt: t });
  assert.equal(btcUnchecked({ ...expired, ...r }), true, 'one answer proves nothing');
});

test('round 6: a payment seen for an expired order is followed for two weeks; an unchecked address until checked', () => {
  const expiredAt = T0 + 7 * 864e5;
  const seen = btcOrd({ status: 'expired', statusTimes: { expired: expiredAt },
    btc: { txid: 'ab'.repeat(32), confirmations: 0, firstSeenAt: T0, totalSats: '100000', payments: 1, missing: true } });
  assert.equal(btcNeedsLook(seen, expiredAt + 13 * 864e5), true);
  assert.equal(btcNeedsLook(seen, expiredAt + 15 * 864e5), false, 'by then it has confirmed or left every mempool');
  assert.equal(btcNeedsLook({ ...seen, btc: { ...seen.btc, missing: undefined } }, expiredAt + 15 * 864e5), false);
  assert.equal(btcNeedsLook(btcOrd({ status: 'expired', statusTimes: { expired: expiredAt } }), expiredAt + 30 * 864e5), true,
    'never "nothing was taken" without a look');
  assert.equal(btcNeedsLook(btcOrd(), T0 + 20 * 864e5), true, 'an open order is watched...');
  assert.equal(btcNeedsLook(btcOrd(), T0 + 22 * 864e5), false, '...until two weeks past Rift\'s deposit deadline (Rift no longer answers for it)');
});

test('round 6: an explicit removal is judged on the payment, not on a look\'s own bookkeeping', () => {
  const o = btcOrd({ status: 'expired', statusTimes: { expired: T0 }, btc: { emptyChecks: 1, emptySince: T0 + 1000 } });
  assert.equal(paymentFacts(o), paymentFacts({ ...o, btc: { emptyChecks: 2, emptySince: T0 + 1000 } }), 'a look ran meanwhile');
  assert.notEqual(paymentFacts(o), paymentFacts({ ...o, btc: { txid: 'ab'.repeat(32), confirmations: 0, firstSeenAt: T0, totalSats: '1', payments: 1 } }));
  const seen = { txid: 'ab'.repeat(32), confirmations: 0, firstSeenAt: T0, totalSats: '1', payments: 1 };
  assert.notEqual(paymentFacts({ ...o, btc: seen }), paymentFacts({ ...o, btc: { ...seen, confirmations: 1, confirmed: true } }), 'it confirmed');
  assert.notEqual(paymentFacts(o), paymentFacts({ ...o, status: 'delivered' }));
  assert.notEqual(paymentFacts(order()), paymentFacts(order({ payUnknown: true })));
  assert.notEqual(paymentFacts(order()), paymentFacts(order({ rawStatus: 'held' })));
  assert.equal(paymentFacts(order({ payUnknown: false })), paymentFacts(order()), 'false and unset are the same');
});

test('round 6: the kept pre-send nonce moves past a transaction of this order that used it, and only that one', () => {
  assert.deepEqual(nonceUsed(order({ preSendNonce: 7 }), 7), { preSendNonce: 8 });
  assert.deepEqual(nonceUsed(order({ preSendNonce: 7 }), 6), {});
  assert.deepEqual(nonceUsed(order({ preSendNonce: 7 }), undefined), {});
  assert.deepEqual(nonceUsed(order(), 7), {});
});

// --- Round 7 ---

test('round 7: an answer older than the latest sighting recorded never sets that record back', () => {
  const cp = T0 + 60 * 60_000 + BTC_GRACE_MS;
  const t0 = T0 + 30 * 60_000;
  const A = 'ab'.repeat(32), B = 'cd'.repeat(32);
  // Tab B's look, taken at t0 + 3 s, saw a second payment and recorded it.
  const newer = { txid: A, confirmations: 0, firstSeenAt: T0, totalSats: '200000', payments: 2, lastSeenAt: t0 + 3000 };
  // Tab A's look, taken at t0, lands after it: one payment. It must not replace the record.
  assert.deepEqual(lookNow(newer, { payments: [{ txid: A, confirmations: 0 }], totalSats: 100000n }, t0, cp, false, t0 + 4000), {});
  // An empty answer taken at t0 + 1.5 s counts for nothing either.
  assert.deepEqual(lookNow(newer, EMPTY, t0 + 1500, cp, false, t0 + 4000), {});
  // A newer answer still records what it adds.
  const later = lookNow(newer, { payments: [{ txid: A, confirmations: 1 }, { txid: B, confirmations: 1 }], totalSats: 200000n }, t0 + 6000, cp);
  assert.equal(later.btc.confirmed, true);
  assert.equal(later.btc.lastSeenAt, t0 + 6000);
});

// --- Round 8 ---

test('round 8: a look is timed and ordered by when it was asked, and judged fresh by when it was answered', () => {
  const cp = T0 + 60 * 60_000 + BTC_GRACE_MS;
  const t = cp + 4 * 60_000;
  // A slow answer (asked at t, back 12 s later) applied as it arrives is fresh: its empty answer completes the run.
  const run = { emptyChecks: BTC_MISSING_AFTER - 1, emptySince: cp + 60_000, emptyLastAt: t - 20_000 };
  const r = clockAt(t + 12_000, () => btcLookPatch(run, EMPTY, { at: t, answeredAt: t + 12_000, failing: false, checkpoint: cp }));
  assert.equal(r.btc?.emptyChecks, BTC_MISSING_AFTER);
  assert.equal(r.btc?.emptyAt, t, 'proven as of when it was asked');
  // An answer asked before a newer sighting was recorded is older, however late it arrives: it can't set it back
  // (a fee bump's txid replaced by the old one, a payment count going down).
  const A = 'ab'.repeat(32), B = 'cd'.repeat(32);
  const newer = { txid: B, confirmations: 0, firstSeenAt: T0, totalSats: '100000', payments: 1, lastSeenAt: t + 3000 };
  assert.deepEqual(clockAt(t + 12_000, () => btcLookPatch(newer, { payments: [{ txid: A, confirmations: 0 }], totalSats: 100000n },
    { at: t, answeredAt: t + 12_000, failing: false, checkpoint: cp })), {});
});

// --- Round 9 ---

test('round 9: a sighting or run stored while the clock ran ahead does not stop looks counting', () => {
  const cp = T0 + 60 * 60_000 + BTC_GRACE_MS;
  const now = cp + 3600_000;
  const A = 'ab'.repeat(32);
  // Saved three hours "ahead": a sighting, and a run of empty answers that started then.
  const ahead = { txid: A, confirmations: 0, firstSeenAt: T0, totalSats: '100000', payments: 1, lastSeenAt: now + 3 * 3600_000 };
  const r = lookNow(ahead, EMPTY, now, cp);
  assert.equal(r.btc?.emptyChecks, 1, 'an empty answer counts again');
  assert.equal(r.btc?.emptySince, now);
  const run = { ...ahead, lastSeenAt: now - 600_000, emptyChecks: 2, emptySince: now + 3 * 3600_000 };
  const r2 = lookNow(run, EMPTY, now, cp);
  assert.equal(r2.btc?.emptyChecks, 1, 'a run "from the future" starts again from now');
  assert.equal(r2.btc?.emptySince, now);
});

test('round 9: an unfinished order a week past Rift\'s deposit deadline can be removed (Rift no longer answers for it)', () => {
  const o = order(); // deadline: T0 + 7 days
  assert.equal(pastDeadline(o, T0 + 10 * 864e5), false);
  assert.equal(pastDeadline(o, T0 + 15 * 864e5), true);
  assert.equal(pastDeadline(order({ status: 'delivered' }), T0 + 30 * 864e5), false, 'a finished order is cleared as usual');
  assert.equal(pastDeadline(order({ depositDeadline: 'soon' }), T0 + 30 * 864e5), false, 'no readable deadline: never');
});

// --- Round 10 ---

test('round 10: an expiry or a proof stored from the future (the clock ran ahead) neither holds a check up nor proves it', () => {
  const now = T0 + 8 * 864e5;
  // "Expired" recorded five hours ahead; Rift's own deadline (T0 + 7 days) is the checkpoint instead.
  const expired = btcOrd({ status: 'expired', statusTimes: { expired: now + 5 * 3600_000 }, btc: { emptyAt: now - 3600_000 } });
  assert.equal(btcCheckpoint(expired, now), T0 + 7 * 864e5);
  assert.equal(btcUnchecked(expired, now), false, 'a run of looks after the deadline counts');
  // A proof of "nothing was sent" made by a clock three hours ahead, during the pay window: not a proof.
  const open = btcOrd({ btc: { emptyChecks: 3, emptySince: T0 + 3 * 3600_000, emptyAt: T0 + 3 * 3600_000 + BTC_EMPTY_SPAN_MS } });
  const justPast = T0 + 61 * 60_000;
  assert.equal(btcUnchecked(open, justPast), true);
  assert.equal(isAbandoned(open, justPast), false, 'no Dismiss, no "wasn\'t paid": the grace for a last-minute payment stands');
  // A look at the order drops it and starts a run of its own.
  const cp = btcCheckpoint(open, justPast);
  const r = lookNow(open.btc, EMPTY, cp + 1000, cp);
  assert.equal(r.btc?.emptyAt, undefined);
  assert.equal(r.btc?.emptyChecks, 1);
});

test('round 10: a payment recorded without its time still counts as seen (no QR code)', () => {
  assert.equal(phaseInput(btcOrd({ btc: { txid: 'ab'.repeat(32), confirmations: 0 } }), 'bitcoin').btcSeenAt, T0);
  assert.equal(phaseInput(btcOrd({ btc: { txid: 'ab'.repeat(32), missing: true } }), 'bitcoin').btcSeenAt, undefined, 'missing: paying again shows');
});

test('round 10: a prompt or a cooldown stamped by a clock that ran ahead doesn\'t hold the order up', () => {
  const now = T0 + 5 * 60_000;
  // Stamped three hours "ahead": the prompt can't be known to be open (unknown, checkable), not "requesting" for hours.
  assert.equal(payState(order({ payRequestedAt: now + 3 * 3600_000 }), now), 'unknown');
  assert.equal(payState(order({ payRequestedAt: now - 30_000 }), now), 'requesting');
  // A cooldown from the future doesn't block Pay for hours.
  assert.equal(canPay(order({ depositFailed: true, depositFailReason: 'pre_send', preSendAt: now + 3 * 3600_000 }), 'evm', now), true);
  assert.equal(canPay(order({ depositFailed: true, depositFailReason: 'pre_send', preSendAt: now - 10_000 }), 'evm', now), false);
});

// --- Round 11 ---

test('round 12: the pay window is measured on this clock, whatever its offset; a creation time from the future closes it', () => {
  // Made now, whether the clock is right or fast: a full window on this clock (round 11 took Rift's time, so a fast
  // clock started the window already used up).
  const o = order({ createdAt: T0 });
  assert.equal(payWindowOpen(o, 'evm', T0 + 9 * 60_000), true);
  assert.equal(payWindowOpen(o, 'evm', T0 + 11 * 60_000), false);
  // Made while the clock ran two hours ahead, the clock since put back: closed, not open for hours.
  assert.equal(payWindowOpen(order({ createdAt: T0 + 2 * 3600_000 }), 'evm', T0 + 60_000), false);
  assert.equal(payWindowOpen(btcOrd({ createdAt: T0 + 2 * 3600_000 }), 'bitcoin', T0 + 60_000), false, 'no Bitcoin QR code at an old price');
  assert.equal(btcLookEveryMs(btcOrd({ createdAt: T0 + 2 * 3600_000 }), T0 + 60_000), 10 * 60_000, 'nor looks every 20 s for hours');
});

test('round 11: an expired order with no expiry time recorded is checked from Rift\'s deadline, not its creation', () => {
  const o = btcOrd({ status: 'expired', statusTimes: {} }); // deadline: T0 + 7 days
  assert.equal(btcCheckpoint(o, T0 + 8 * 864e5), T0 + 7 * 864e5);
  // A run of looks from before the deadline proves nothing.
  assert.equal(btcUnchecked({ ...o, btc: { emptyAt: T0 + 3 * 864e5 } }, T0 + 8 * 864e5), true);
});

test('round 12: a pay window seen closed stays closed (a clock put back can\'t reopen it)', () => {
  const o = order({ createdAt: T0 });
  // Seen closed eleven minutes on; the clock is then put back by an hour.
  const closed = { ...o, ...windowCloseChange(o, T0 + 11 * 60_000) };
  assert.equal(closed.windowClosedAt, T0 + 11 * 60_000);
  assert.equal(payWindowOpen(closed, 'evm', T0 + 5 * 60_000), false);
  assert.deepEqual(windowCloseChange(closed, T0 + 12 * 60_000), {}, 'recorded once');
  assert.deepEqual(windowCloseChange(o, T0 + 5 * 60_000), {}, 'nothing while it is open');
  assert.equal(payWindowOpen(btcOrd({ createdAt: T0, windowClosedAt: T0 + 61 * 60_000 }), 'bitcoin', T0 + 30 * 60_000), false, 'no QR code again');
});

// --- Round 14 ---

test('round 14: a run of empty answers is one stretch of looking: a gap restarts it, so old answers can\'t make up its span', () => {
  // Bitcoin auditor, Low 1: a payment seen at minute 10, one lagging empty answer at minute 20, nobody looking until
  // minute 45, then four empty answers in 60 s: "five answers over two minutes", with a lag of only a minute.
  const A = 'ab'.repeat(32);
  const cp = T0 + 60 * 60_000 + BTC_GRACE_MS;
  const min = m => T0 + m * 60_000;
  let b = { txid: A, confirmations: 0, firstSeenAt: min(10), totalSats: '100000', payments: 1, lastSeenAt: min(10) };
  const step = at => { const r = lookNow(b, EMPTY, at, cp); if (r.btc) b = r.btc; };
  step(min(20));
  for (const s of [0, 20, 40, 60]) step(min(45) + s * 1000);
  assert.equal(b.missing, undefined, 'the answer before the gap doesn\'t count');
  assert.equal(b.emptyChecks, 4);
  assert.equal(b.emptySince, min(45));
  step(min(45) + 80_000);
  step(min(45) + 100_000);
  assert.equal(b.missing, undefined, 'six answers, but over 100 s');
  step(min(45) + 120_000);
  assert.equal(b.missing, true, 'two minutes of looking, no gap');
  // A gap of more than BTC_EMPTY_GAP_MS between answers (mempool.space unreachable meanwhile) also starts a new run.
  b = { txid: A, confirmations: 0, firstSeenAt: min(10), totalSats: '100000', payments: 1, emptyChecks: 4, emptySince: min(40), emptyLastAt: min(41) };
  step(min(41) + BTC_EMPTY_GAP_MS + 1);
  assert.equal(b.emptyChecks, 1);
  // A run stored by an older version (no latest answer's time) starts anew; so does one whose latest answer is "from the future".
  b = { txid: A, confirmations: 0, firstSeenAt: min(10), totalSats: '100000', payments: 1, emptyChecks: 4, emptySince: min(40) };
  step(min(43));
  assert.equal(b.emptyChecks, 1);
  b = { txid: A, confirmations: 0, firstSeenAt: min(10), totalSats: '100000', payments: 1, emptyChecks: 4, emptySince: min(40), emptyLastAt: min(90) };
  step(min(43));
  assert.equal(b.emptyChecks, 1);
  assert.equal(b.emptyLastAt, min(43));
});

test('round 14: the unpaid proof needs a run with no gap too', () => {
  const o = btcOrd();
  const cp = btcCheckpoint(o);
  let b;
  const step = at => { const r = lookNow(b, EMPTY, at, cp); if (r.btc) b = r.btc; };
  step(cp + 60_000); // one answer, then nobody looks for an hour
  for (const s of [0, 20, 40, 60]) step(cp + 3600_000 + s * 1000);
  assert.equal(b.emptyAt, undefined, 'not proven by an answer from before the gap');
  assert.equal(btcUnchecked({ ...o, btc: b }, cp + 3600_000 + 60_000), true);
  for (const s of [80, 100, 120]) step(cp + 3600_000 + s * 1000);
  assert.equal(b.emptyAt, cp + 3600_000 + 120_000, 'proven after two minutes of looking');
  // The background watcher's looks, 5 minutes apart, never make a run on their own.
  b = undefined;
  for (let i = 0; i < 8; i++) step(cp + i * 5 * 60_000);
  assert.equal(b.emptyAt, undefined);
  assert.equal(b.emptyChecks, 1);
});

test('round 14: the orders list doesn\'t show a Bitcoin order past its pay window as waiting for a payment', () => {
  // Bitcoin auditor, Low 2: "Waiting for payment ~X iAERO" until a look proved the address unpaid, while its card says
  // the window has closed and not to send.
  const o = btcOrd();
  const past = T0 + 61 * 60_000;
  assert.equal(isOutOfDate(o, past), false, 'removal still waits for the look');
  assert.equal(shownOutOfDate(o, past), true);
  assert.equal(shownOutOfDate(o, T0 + 59 * 60_000), false, 'within the window');
  assert.equal(shownOutOfDate(btcOrd({ btc: { txid: 'ab'.repeat(32), firstSeenAt: T0 } }), past), false, 'a payment seen');
  assert.equal(shownOutOfDate(btcOrd({ btc: { missing: true } }), past), false, 'one seen, now not visible: its own badge');
  assert.equal(shownOutOfDate(btcOrd({ rawStatus: 'held_for_review' }), past), false, 'a status this page doesn\'t know');
  assert.equal(shownOutOfDate(btcOrd({ status: 'expired', statusTimes: { expired: past } }), past), false, 'expired: its own badge');
  // EVM orders: as before (an unpaid one past its window is out of date already; one in doubt is not).
  const unpaid = order({ createdAt: T0 });
  assert.equal(shownOutOfDate(unpaid, T0 + PAY_WINDOW_MS + 1000), isOutOfDate(unpaid, T0 + PAY_WINDOW_MS + 1000));
  const doubt = order({ createdAt: T0, payUnknown: true, payRequestedAt: T0 + 1000 });
  assert.equal(shownOutOfDate(doubt, T0 + PAY_WINDOW_MS + 1000), false);
});

test('round 14: the run\'s latest answer time survives sanitizing', () => {
  const o = btcOrd({ depositAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', fromAmount: '0.001', fromAmountRaw: '100000',
    btc: { txid: 'ab'.repeat(32), firstSeenAt: T0, emptyChecks: 2, emptySince: T0 + 60_000, emptyLastAt: T0 + 80_000 } });
  assert.ok(sanitizeOrder(o), 'a valid record');
  assert.equal(sanitizeOrder(o).btc.emptyLastAt, T0 + 80_000);
  assert.equal(sanitizeOrder({ ...o, btc: { ...o.btc, emptyLastAt: 'soon' } }).btc.emptyLastAt, undefined, 'not a number: dropped');
});

// --- Round 15 ---

/** A looker over simulated time: from `start`, looks at the address when `next` says, applying each answer to the record
 *  as stored; `answer(t)` is what mempool.space says at t. Returns the order when `done` holds, or at `until`. */
function lookOver(o, { start, until, answer, next, done }) {
  let t = start;
  while (t <= until) {
    const r = lookNow(o.btc, answer(t), t, btcCheckpoint(o, t));
    if (r.btc) o = { ...o, btc: r.btc };
    if (done(o, t)) return { o, t };
    t += next(o, t);
  }
  return { o, t: null };
}

test('round 15: a payment that vanishes long after it was seen is found missing, with the card open', () => {
  // Bitcoin auditor, Medium (round-14 regression): past 75 minutes the card looked every 10 minutes, so with runs
  // needing answers 2 minutes apart, "missing" was never decided; Rift's expiry then read as "a payment was sent".
  const A = 'ab'.repeat(32);
  const seen = { payments: [{ txid: A, confirmations: 0 }], totalSats: 100000n };
  const o = btcOrd({ btc: { txid: A, confirmations: 0, firstSeenAt: T0 + 50 * 60_000, totalSats: '100000', payments: 1, lastSeenAt: T0 + 50 * 60_000 } });
  const dropped = T0 + 100 * 60_000;
  const r = lookOver(o, {
    start: T0 + 51 * 60_000, until: T0 + 6 * 3600_000, answer: t => (t < dropped ? seen : EMPTY),
    next: (x, t) => btcLookEveryMs(x, t), done: x => !!x.btc?.missing,
  });
  assert.ok(r.t !== null && r.t - dropped < 15 * 60_000, `missing ${r.t === null ? 'never' : `${(r.t - dropped) / 60_000} min after the drop`}`);
  // An open run is looked at again soon; not once it is decided, nor for a confirmed payment, nor while storage fails.
  const run = { ...o, btc: { ...o.btc, emptyChecks: 1, emptySince: dropped, emptyLastAt: dropped } };
  const late = T0 + 2 * 3600_000;
  assert.equal(btcLookSoon(run, late), true);
  assert.equal(btcLookEveryMs(run, late), 20_000);
  assert.equal(btcLookEveryMs(o, late), 10 * 60_000, 'no run open: the slow pace');
  assert.equal(btcLookSoon({ ...run, btc: { ...run.btc, missing: true } }, late), false);
  assert.equal(btcLookSoon({ ...run, btc: { ...run.btc, confirmed: true } }, late), false);
  assert.equal(btcLookSoon(run, late, true), false, 'storage failing: empty answers wouldn\'t count');
});

test('round 15: the background watcher alone proves an unpaid order and finds a vanished payment', () => {
  // Bitcoin auditor, Low (round-14 regression): the watcher's looks, 5 minutes apart, never made a run, so an unpaid
  // order whose card wasn't opened was never proven unpaid (polled each minute for a week, looked at for ever after).
  const o = btcOrd();
  const cp = btcCheckpoint(o);
  // The watcher: a round each minute, a look when the order's spacing has passed since its last look.
  const sim = (answer, done) => {
    let x = o, last = -Infinity;
    for (let t = T0 + 60_000; t <= T0 + 6 * 3600_000; t += 60_000) {
      if (t - last < btcWatchEveryMs(x, t, false, 0)) continue;
      last = t;
      const p = lookNow(x.btc, answer(t), t, btcCheckpoint(x, t));
      if (p.btc) x = { ...x, btc: p.btc };
      if (done(x, t)) return { x, t };
    }
    return { x, t: null };
  };
  const unpaid = sim(() => EMPTY, (x, t) => !btcUnchecked(x, t));
  assert.ok(unpaid.t !== null && unpaid.t - cp < 6 * 60_000, `proven ${unpaid.t === null ? 'never' : `${(unpaid.t - cp) / 60_000} min after the checkpoint`}`);
  assert.equal(isAbandoned(unpaid.x, unpaid.t), true, 'then out of date: polled now and then, clearable');
  // Before the checkpoint, and with nothing deciding, the watcher's pace is unchanged.
  assert.equal(btcWatchEveryMs(o, T0 + 30 * 60_000, false, 0), BTC_WATCH_LOOK_MS);
  assert.equal(btcWatchEveryMs(o, cp + 1, false, 0), 20_000);
  assert.equal(btcWatchEveryMs(o, cp + 1, false, 2), 80_000, 'backs off after failed looks');
  assert.equal(btcWatchEveryMs(o, cp + 1, false, 9), BTC_WATCH_LOOK_MS, 'to its usual pace at most');
  // A payment seen, then gone long after: the watcher's looks find it missing too.
  const A = 'ab'.repeat(32);
  const seenAns = { payments: [{ txid: A, confirmations: 0 }], totalSats: 100000n };
  const dropped = T0 + 100 * 60_000;
  const missing = sim(t => (t < dropped ? seenAns : EMPTY), x => !!x.btc?.missing);
  assert.ok(missing.t !== null && missing.t - dropped < 12 * 60_000, `missing ${missing.t === null ? 'never' : `${(missing.t - dropped) / 60_000} min after the drop`}`);
});

// --- Round 16 ---

test('round 16: Buy asks before a second Bitcoin order while an earlier one may yet receive its payment', () => {
  // Bitcoin auditor, Low: the question stopped once the earlier order's window closed, though a payment sent in its
  // last minutes may still arrive (its card then offers a new order, its list badge says "Out of date").
  const o = btcOrd();
  const cp = btcCheckpoint(o);
  assert.equal(btcStillPayable(o, T0 + 30 * 60_000), 'open');
  assert.equal(btcStillPayable(o, T0 + 61 * 60_000), 'closed', 'window closed, nothing seen, nothing ruled out');
  assert.equal(btcStillPayable(o, T0 + 5 * 3600_000), 'closed', '...for as long as no look has ruled it out');
  assert.equal(btcStillPayable({ ...o, btc: { emptyChecks: 5, emptySince: cp + 1000, emptyLastAt: cp + 121_000, emptyAt: cp + 121_000 } }, cp + 200_000), null,
    'proven: nothing was sent');
  assert.equal(btcStillPayable({ ...o, btc: { txid: 'ab'.repeat(32), firstSeenAt: T0 } }, T0 + 61 * 60_000), null, 'its payment seen');
  assert.equal(btcStillPayable({ ...o, btc: { txid: 'ab'.repeat(32), firstSeenAt: T0, missing: true } }, T0 + 61 * 60_000), 'missing');
  assert.equal(btcStillPayable({ ...o, btc: { txid: 'ab'.repeat(32), firstSeenAt: T0, missing: true } }, T0 + 30 * 60_000), 'open');
  assert.equal(btcStillPayable({ ...o, status: 'expired' }, T0 + 61 * 60_000), null, 'expired: Rift takes no payment');
  assert.equal(btcStillPayable(order(), T0 + 1000), null, 'not a Bitcoin order');
});
