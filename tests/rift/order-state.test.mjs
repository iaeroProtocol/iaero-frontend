// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAY_WINDOW_MS, canMoveTo, canPay, capOrders, isAbandoned, isFinalStatus, isTerminalStatus, payState, payWindowOpen, phaseInput,
  sanitizeOrder,
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
  assert.equal(payState(order({ depositSentAt: T0, depositFailed: true }), T0), 'failed');
  assert.equal(payState(order({ depositSentAt: T0, depositTxHash: HASH, payUnknown: true }), T0), 'unknown', 'a hash that never showed up');
});

test('an order is paid only inside its window, once', () => {
  assert.equal(canPay(order(), 'evm', T0 + 60_000), true);
  assert.equal(canPay(order(), 'evm', T0 + PAY_WINDOW_MS + 1), false, 'an old order is re-priced, not paid');
  assert.equal(canPay(order({ payRequestedAt: T0 }), 'evm', T0 + 1000), false, 'a prompt is open');
  assert.equal(canPay(order({ payUnknown: true }), 'evm', T0 + 1000), false, 'check first');
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
  assert.equal(isAbandoned(order({ depositFailed: true }), late), true);
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
  assert.equal(sanitizeOrder(order({ fromAmount: '0.001x' })), null, 'the amount is used in BigInt maths while rendering');
  assert.deepEqual(sanitizeOrder(order({ statusTimes: undefined })).statusTimes, {});
  assert.equal(sanitizeOrder(null), null);
});

test('damaged optional fields are dropped, the order kept', () => {
  const o = sanitizeOrder(order({
    sourceChain: 'bitcoin', btc: { txid: 'ab'.repeat(32), totalSats: '0.001', confirmations: 'x', firstSeenAt: T0 },
    depositTxHash: '0x12', depositReceivedRaw: '-1', baseFromBlock: '1e9', payRequestedAt: 'soon', amountOut: 'lots',
    statusTimes: { funded: 'later', awaiting_deposit: T0, teleported: T0 }, pastTxHashes: [HASH, 'nope'],
    hlAction: { destination: '0x1', token: 'USDC:0x6d', amount: '5', time: T0 },
  }));
  assert.ok(o);
  assert.deepEqual(o.btc, { txid: 'ab'.repeat(32), firstSeenAt: T0 }, 'BigInt(totalSats) would throw while rendering');
  assert.equal(o.depositTxHash, undefined);
  assert.equal(o.depositReceivedRaw, undefined);
  assert.equal(o.baseFromBlock, undefined);
  assert.equal(o.payRequestedAt, undefined);
  assert.equal(o.amountOut, undefined);
  assert.deepEqual(o.statusTimes, { awaiting_deposit: T0 });
  assert.deepEqual(o.pastTxHashes, [HASH]);
  assert.equal(o.hlAction, undefined, 'unsigned');
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
