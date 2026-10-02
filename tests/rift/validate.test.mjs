// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decimalToRaw, normalizeDecimal, parseOrder, parseOrderUpdate, parseQuote, stripChainPrefix,
} from '../../src/lib/rift/validate.ts';

const DEST = 'base.0x81034fb34009115f215f5d5f564aac9ffa46a1dc';
const USER = '0x1111111111111111111111111111111111111111';
const QUOTE_ID = '01a0fb0a-3f25-76e1-bc30-53287987baba';
const ORDER_ID = '01a0e938-96a9-7d92-a5cb-bab585c2fc47';

// A real ETH -> iAERO quote returned by Rift on 2026-10-02.
const quote = () => ({
  id: QUOTE_ID, from: 'ethereum.eth', to: DEST, from_amount: '0.1', estimated_amount_out: '461.246560430192773043',
  route: [
    { venue: 'across', execution: { mode: 'evm', chain: 1 }, from: 'ethereum.eth', to: 'base.eth', step_amount_in: '0.1', step_amount_out: '0.0999' },
    { venue: 'kyberswap', execution: { mode: 'evm', chain: 8453 }, from: 'base.eth', to: DEST, step_amount_in: '0.0999', step_amount_out: '461.2' },
  ],
  delivery: { amount_in: '461.2498', execution_cost: '0.0032', amount_out: '461.2465' },
  expires_at: '2026-10-02T05:25:47.877988Z', format: 'formatted',
});
const order = (patch = {}) => ({
  id: ORDER_ID, quote_id: QUOTE_ID, from: 'ethereum.eth', to: DEST, from_amount: '0.1',
  deposit_address: '0x5adfc66c5e7158cbfb3b0129a8433c5da6f6382c', deposit_deadline: '2026-10-09T18:13:14.984542Z',
  to_address: USER, refund_address: USER, status: 'awaiting_deposit', amount_out: null, created_at: '2026-10-02T05:16:00Z',
  ...patch,
});
const expectOrder = { destination: DEST, quoteId: QUOTE_ID, toAddress: USER, fromChain: 'ethereum', fromAmount: '0.1', refundAddress: USER };

test('decimal amounts convert exactly, and too many decimals are refused', () => {
  assert.equal(normalizeDecimal('0.50'), '0.5');
  assert.equal(normalizeDecimal('001.20'), '1.2');
  assert.equal(normalizeDecimal('25'), '25');
  assert.equal(decimalToRaw('0.1', 18), 100000000000000000n);
  assert.equal(decimalToRaw('1.234567', 6), 1234567n);
  assert.equal(decimalToRaw('0.000000000000000001', 18), 1n);
  assert.equal(decimalToRaw('0.01', 8), 1000000n);
  assert.throws(() => decimalToRaw('1.2345678', 6), /more than 6 decimals/);
  assert.throws(() => normalizeDecimal('1e5'));
  assert.throws(() => normalizeDecimal('-1'));
});

test('a real quote passes; a quote for another destination, chain or amount is refused', () => {
  const q = parseQuote(quote(), { destination: DEST, fromChain: 'ethereum', fromAmount: '0.1' });
  assert.equal(q.route.length, 2);
  assert.equal(q.estimated_amount_out, '461.246560430192773043');
  assert.throws(() => parseQuote({ ...quote(), to: 'base.aero' }, { destination: DEST, fromChain: 'ethereum', fromAmount: '0.1' }), /does not deliver iAERO/);
  assert.throws(() => parseQuote(quote(), { destination: DEST, fromChain: 'arbitrum', fromAmount: '0.1' }), /different source chain/);
  assert.throws(() => parseQuote(quote(), { destination: DEST, fromChain: 'ethereum', fromAmount: '0.2' }), /different amount/);
  assert.throws(() => parseQuote({ ...quote(), route: [] }, { destination: DEST, fromChain: 'ethereum', fromAmount: '0.1' }), /no route/);
  assert.throws(() => parseQuote({ ...quote(), id: 'nope' }, { destination: DEST, fromChain: 'ethereum', fromAmount: '0.1' }), /UUID/);
  // Rift may echo a token by ticker even when it was requested by address: only the chain is compared.
  assert.ok(parseQuote({ ...quote(), from: 'ethereum.usdc' }, { destination: DEST, fromChain: 'ethereum', fromAmount: '0.10' }));
});

test('an order is accepted only if it delivers iAERO to this wallet, for this quote and amount', () => {
  const o = parseOrder(order(), expectOrder);
  assert.equal(o.deposit_address, '0x5adfc66c5e7158cbfb3b0129a8433c5da6f6382c');
  // Addresses may come back chain-prefixed.
  assert.equal(parseOrder(order({ to_address: `base.${USER}`, deposit_address: 'ethereum.0x5adfc66c5e7158cbfb3b0129a8433c5da6f6382c' }), expectOrder).to_address, USER);
  const refused = [
    [{ to_address: '0x2222222222222222222222222222222222222222' }, /different wallet/],
    [{ to: 'base.usdc' }, /does not deliver iAERO/],
    [{ quote_id: '01a0fb0a-3f25-76e1-bc30-000000000000' }, /different quote/],
    [{ from_amount: '1' }, /different amount/],
    [{ from: 'arbitrum.eth' }, /different source chain/],
    [{ refund_address: '0x3333333333333333333333333333333333333333' }, /refunds to a different address/],
    [{ status: 'teleported' }, /unknown Rift order status/],
    [{ deposit_deadline: 'soon' }, /deposit deadline/],
    [{ id: 'x' }, /UUID/],
  ];
  for (const [patch, re] of refused) assert.throws(() => parseOrder(order(patch), expectOrder), re, JSON.stringify(patch));
});

test('status polls must be for the same order and a known status', () => {
  assert.deepEqual(parseOrderUpdate(order({ status: 'delivered', amount_out: '461.1' }), ORDER_ID), { status: 'delivered', amountOut: '461.1' });
  assert.throws(() => parseOrderUpdate(order(), '01a0e938-96a9-7d92-a5cb-000000000000'), /different order/);
  assert.equal(stripChainPrefix('bitcoin.bc1qxyz'), 'bc1qxyz');
  assert.equal(stripChainPrefix('0xabc'), '0xabc');
});

test('contract wallets, and EIP-7702 delegated EOAs that are not', async () => {
  const { isContractCode } = await import('../../src/lib/rift/validate.ts');
  assert.equal(isContractCode(undefined), false);
  assert.equal(isContractCode('0x'), false);
  // vitalik.eth on Ethereum and Base, 2026-10-02: a 7702 delegation, still an EOA.
  assert.equal(isContractCode('0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d'), false);
  assert.equal(isContractCode('0x608060405234801561001057600080fd5b50'), true, 'real bytecode');
  assert.equal(isContractCode('0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d00'), true, 'not exactly a designator');
});
