// Run: npm run test:rift
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as orderState from '../../src/lib/rift/order-state.ts';

const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../src/lib/rift/notice.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
{ exports, require: n => { if (n === './order-state') return orderState; throw new Error(`unexpected import ${n}`); } });
const { orderNotice } = exports;

const T0 = 1_790_930_000_000;
const EXPIRED_AT = T0 + 7 * 864e5;
const order = (over = {}) => ({
  id: '01a0fb7d-591d-76f3-81c0-c6cc086fa85f', quoteId: '01a0fb7d-244e-7411-9358-5bf1e939153a', createdAt: T0,
  sourceChain: 'ethereum', token: { symbol: 'USDC', decimals: 6, asset: 'ethereum.0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' },
  fromAmount: '10', fromAmountRaw: '10000000', estimatedOut: '16.5', route: [], depositAddress: '0x1111111111111111111111111111111111111111',
  depositDeadline: new Date(EXPIRED_AT).toISOString(), toAddress: '0x2222222222222222222222222222222222222222',
  status: 'expired', statusTimes: { expired: EXPIRED_AT }, ...over,
});

test('round 6: the expiry notice for a payment in doubt says what its card says, not "Nothing was taken"', () => {
  const now = EXPIRED_AT + 60_000;
  const doubt = orderNotice(order({ payUnknown: true, payAttemptAt: T0 + 1000 }), now);
  assert.match(doubt, /most likely nothing was taken/);
  assert.doesNotMatch(doubt, /before a payment arrived/);
  assert.equal(orderNotice(order(), now), 'An order expired before a payment arrived. Nothing was taken.', 'an order never paid');
  assert.match(orderNotice(order({ depositSentAt: T0 + 1000, depositTxHash: `0x${'ab'.repeat(32)}` }), now), /a payment was sent/);
});

test('notices for the other statuses worth one', () => {
  assert.equal(orderNotice(order({ status: 'delivered', amountOut: '61.9555' }), T0), `${(61.9555).toLocaleString(undefined, { maximumFractionDigits: 4 })} iAERO arrived in your wallet.`);
  assert.equal(orderNotice(order({ status: 'refunded' }), T0), 'Rift refunded your USDC.');
  assert.match(orderNotice(order({ status: 'frozen' }), T0), /on hold/);
  assert.match(orderNotice(order({ status: 'underfunded' }), T0), /less than an order needs/);
  assert.equal(orderNotice(order({ status: 'funded' }), T0), '');
});
