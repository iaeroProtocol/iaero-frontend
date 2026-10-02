// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLlamaPrices, parseNative, parseTokenBalances, probeAmount, rankHoldings, rawToNumber } from '../../src/lib/rift/holdings.ts';

const IAERO = 'base.0x81034fb34009115f215f5d5f564aac9ffa46a1dc';
const tok = (address, symbol, decimals, value, rate, extra = {}) => ({
  value, token: { address_hash: address, symbol, name: symbol, decimals: String(decimals), exchange_rate: rate, icon_url: null, type: 'ERC-20', reputation: 'ok', ...extra },
});

test('Blockscout balances become holdings; NFTs, scams, zero balances and iAERO itself are dropped', () => {
  const rows = [
    tok('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 6, '250000000', '1.0'),
    tok('0x940181a94A35A4569E4529A3CDfB74e38FD98631', 'AERO', 18, '1000000000000000000000', '0.8'),
    tok('0x81034Fb34009115F215f5d5F564AAc9FfA46a1Dc', 'iAERO', 18, '5000000000000000000', '0.6'),
    tok('0x1111111111111111111111111111111111111111', 'SCAM', 18, '1000000000000000000000000', '1000', { reputation: 'scam' }),
    tok('0x2222222222222222222222222222222222222222', 'NFT', 0, '3', null, { type: 'ERC-721' }),
    tok('0x3333333333333333333333333333333333333333', 'ZERO', 18, '0', '1'),
    tok('0x4444444444444444444444444444444444444444', 'NOPRICE', 18, '7000000000000000000', null),
  ];
  const hs = parseTokenBalances('base', rows, [IAERO]);
  assert.deepEqual(hs.map(h => h.symbol), ['USDC', 'AERO', 'NOPRICE']);
  const usdc = hs[0];
  assert.equal(usdc.asset, 'base.0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  assert.equal(usdc.decimals, 6);
  assert.equal(usdc.valueUsd, 250);
  assert.equal(hs[2].priceUsd, 0, 'unpriced until DeFiLlama answers');
  assert.deepEqual(parseTokenBalances('base', { not: 'an array' }), []);
});

test('native ETH, DeFiLlama fallback prices and ranking by USD value', () => {
  const eth = parseNative('arbitrum', { coin_balance: '500000000000000000', exchange_rate: '3000' });
  assert.deepEqual([eth.asset, eth.symbol, eth.valueUsd], ['arbitrum.eth', 'ETH', 1500]);
  assert.equal(parseNative('base', { coin_balance: '0', exchange_rate: '3000' }), null);

  const tokens = parseTokenBalances('ethereum', [
    tok('0x4444444444444444444444444444444444444444', 'NOPRICE', 18, '7000000000000000000', null),
    tok('0x5555555555555555555555555555555555555555', 'DUST', 18, '1000000000000000', '0.5'),
  ]);
  const priced = applyLlamaPrices(tokens, { coins: { 'ethereum:0x4444444444444444444444444444444444444444': { price: 2 } } }, c => c);
  assert.equal(priced[0].valueUsd, 14);
  const ranked = rankHoldings([...priced, eth]);
  assert.deepEqual(ranked.map(h => h.symbol), ['ETH', 'NOPRICE'], 'largest first; dust under $1 dropped');
});

test('route checks use the balance, capped near $100', () => {
  assert.equal(rawToNumber('1500000', 6), 1.5);
  assert.equal(rawToNumber('5', 0), 5);
  assert.equal(probeAmount({ balanceRaw: '25000000', decimals: 6, priceUsd: 1 }), '25', 'small balance: all of it');
  assert.equal(probeAmount({ balanceRaw: '5000000000', decimals: 6, priceUsd: 1 }), '100', '$5,000 of USDC is checked as $100');
  assert.equal(probeAmount({ balanceRaw: '2000000000000000000', decimals: 18, priceUsd: 2500 }), '0.04');
  assert.equal(probeAmount({ balanceRaw: '7', decimals: 0, priceUsd: 0 }), '7');
  assert.match(probeAmount({ balanceRaw: '1000000000000000000000000', decimals: 24, priceUsd: 0 }), /^1(\.0+)?$|^1$/);
  assert.ok(probeAmount({ balanceRaw: '123456789012345678901234567', decimals: 24, priceUsd: 0 }).split('.')[1].length <= 18, 'never more than 18 decimals');
});
