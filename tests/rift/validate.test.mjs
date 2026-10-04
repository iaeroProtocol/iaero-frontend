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
  // A ticker alone cannot prove which contract Rift would deliver.
  assert.throws(() => parseQuote({ ...quote(), to: 'base.iAERO' }, { destination: DEST, fromChain: 'ethereum', fromAmount: '0.1' }), /does not deliver iAERO/);
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
    [{ refund_address: '0x3333333333333333333333333333333333333333' }, /does not refund to the address you gave/],
    [{ refund_address: null }, /does not refund to the address you gave/, 'a refund address that was sent must come back'],
    [{ status: 'teleported' }, /unknown Rift order status/],
    [{ deposit_deadline: 'soon' }, /deposit deadline/],
    [{ deposit_address: 'base.0x5adfc66c5e7158cbfb3b0129a8433c5da6f6382c' }, /deposit address is on a different chain/],
    [{ deposit_address: 'ethereum.extra.0x5adfc66c5e7158cbfb3b0129a8433c5da6f6382c' }, /invalid chain prefix/],
    [{ to_address: `arbitrum.${USER}` }, /delivery address is on a different chain/],
    [{ refund_address: `base.${USER}` }, /refund address is on a different chain/],
    [{ id: 'x' }, /UUID/],
  ];
  for (const [patch, re] of refused) assert.throws(() => parseOrder(order(patch), expectOrder), re, JSON.stringify(patch));
  // A quote presented twice returns the first order: a new order must still be waiting for its deposit.
  assert.throws(() => parseOrder(order({ status: 'funded' }), { ...expectOrder, fresh: true }), /already under way/);
  assert.ok(parseOrder(order(), { ...expectOrder, fresh: true }));
  // Bitcoin refund addresses: bech32 compares case-insensitively.
  const btc = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  assert.ok(parseOrder(order({
    from: 'bitcoin.btc', deposit_address: `bitcoin.${btc}`, refund_address: `bitcoin.${btc}`,
  }), { ...expectOrder, fromChain: 'bitcoin', refundAddress: btc.toUpperCase() }));
});

test("Rift's token in a quote or order is the one asked for, by name or by address", async () => {
  const { sameSourceAsset } = await import('../../src/lib/rift/validate.ts');
  const { RIFT_TOKEN_NAMES } = await import('../../src/lib/rift/rift-tokens.ts');
  const USDT0 = 'arbitrum.0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
  // A live quote for USDT0 asked by address came back as "arbitrum.usdt0" (2026-10-02).
  assert.equal(sameSourceAsset('arbitrum.usdt0', USDT0, RIFT_TOKEN_NAMES), true);
  assert.equal(sameSourceAsset('arbitrum.USDC', USDT0, RIFT_TOKEN_NAMES), false, 'another listed token');
  assert.equal(sameSourceAsset(USDT0.toUpperCase().replace('ARBITRUM', 'arbitrum'), USDT0, RIFT_TOKEN_NAMES), true);
  assert.equal(sameSourceAsset('arbitrum.0x0000000000000000000000000000000000000001', USDT0, RIFT_TOKEN_NAMES), false);
  assert.equal(sameSourceAsset('base.usdt0', USDT0, RIFT_TOKEN_NAMES), false, 'another chain');
  assert.equal(sameSourceAsset('arbitrum.eth', USDT0, RIFT_TOKEN_NAMES), false, 'the native coin');
  assert.equal(sameSourceAsset('arbitrum.weth', 'arbitrum.eth', RIFT_TOKEN_NAMES), false, 'WETH is not ETH');
  assert.equal(sameSourceAsset('hyperliquid.HYPE', 'hyperliquid.hype', RIFT_TOKEN_NAMES), true);
  assert.equal(sameSourceAsset('arbitrum.newtoken', USDT0, RIFT_TOKEN_NAMES), false, 'an unknown name cannot authenticate a contract');
  const expect = { destination: DEST, fromChain: 'arbitrum', fromAmount: '25', source: { fromAsset: USDT0, names: RIFT_TOKEN_NAMES } };
  const q = { ...quote(), from: 'arbitrum.usdt0', from_amount: '25' };
  assert.ok(parseQuote(q, expect));
  assert.throws(() => parseQuote({ ...q, from: 'arbitrum.usdc' }, expect), /different token/);
  const o = order({ from: 'arbitrum.usdc', from_amount: '25' });
  assert.throws(() => parseOrder(o, { ...expectOrder, fromChain: 'arbitrum', fromAmount: '25', source: expect.source }), /different token/);
});

test('status polls must be for the same order; an unknown status is reported, not fatal', () => {
  assert.deepEqual(parseOrderUpdate(order({ status: 'delivered', amount_out: '461.1' }), ORDER_ID), { status: 'delivered', rawStatus: 'delivered', amountOut: '461.1' });
  assert.deepEqual(parseOrderUpdate(order({ status: 'settling' }), ORDER_ID), { status: null, rawStatus: 'settling', amountOut: null });
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
