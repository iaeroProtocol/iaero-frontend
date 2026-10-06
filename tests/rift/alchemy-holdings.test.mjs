import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeRecoveredHoldings, parseAlchemyHoldings } from '../../src/lib/rift/holdings.ts';

const owner = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const token = '0x1111111111111111111111111111111111111111';
const knownToken = '0x2222222222222222222222222222222222222222';
const destination = 'base.0x81034fb34009115f215f5d5f564aac9ffa46a1dc';
const now = Date.parse('2026-10-06T17:00:00Z');
const row = (address = token, extra = {}) => ({
  address: owner, network: 'base-mainnet', tokenAddress: address, tokenBalance: '0x2faf080',
  tokenMetadata: { decimals: 6, symbol: 'TEST', name: 'Test token', logo: 'https://untrusted.example/icon.png' },
  tokenPrices: [{ currency: 'usd', value: '2', lastUpdatedAt: new Date(now - 60_000).toISOString() }],
  ...extra,
});

test('Alchemy fallback validates owner, chain, balance, decimals, price age and destination', () => {
  const known = new Set([`base.${knownToken}`]);
  const excluded = new Set([destination]);
  const rows = [
    row(), row(token, { tokenBalance: '0x1' }), // duplicate must not replace the first balance
    row(token, { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }),
    row(token, { network: 'arb-mainnet' }),
    row(destination.slice(5)),
    row('0x3333333333333333333333333333333333333333', { tokenMetadata: { decimals: 200, symbol: 'BAD' } }),
    row('0x4444444444444444444444444444444444444444', { tokenBalance: '0x' + 'f'.repeat(65) }),
    row('0x5555555555555555555555555555555555555555', { tokenBalance: '0x0' }),
    row('0x6666666666666666666666666666666666666666', { tokenPrices: [] }),
    row('0x7777777777777777777777777777777777777777', { tokenPrices: [{ currency: 'usd', value: '2', lastUpdatedAt: new Date(now - 31 * 60_000).toISOString() }] }),
    row('0x8888888888888888888888888888888888888888', { tokenPrices: [{ currency: 'usd', value: '2', lastUpdatedAt: new Date(now + 2 * 60_000).toISOString() }] }),
    row(knownToken, { tokenPrices: [] }),
  ];
  const out = parseAlchemyHoldings('base', owner, rows, known, excluded, now);
  assert.deepEqual(out.map(h => h.asset), [`base.${token}`, `base.${knownToken}`]);
  assert.deepEqual([out[0].balanceRaw, out[0].valueUsd, out[0].icon], ['50000000', 100, undefined]);
  assert.deepEqual([out[1].priceMissing, out[1].valueUsd], [true, 0]);
  assert.deepEqual(parseAlchemyHoldings('base', owner, { malformed: true }, known, excluded, now), []);
});

test('on-chain holdings win over recovered copies and the merged list is ranked', () => {
  const known = new Set();
  const excluded = new Set();
  const recovered = parseAlchemyHoldings('base', owner, [row()], known, excluded, now);
  const primary = { ...recovered[0], balanceRaw: '25000000', valueUsd: 50 };
  assert.deepEqual(mergeRecoveredHoldings([primary], recovered), [primary]);
  const direct = { ...recovered[0], balanceRaw: '75000000', valueUsd: 150 };
  assert.deepEqual(mergeRecoveredHoldings([], [direct, ...recovered]), [direct], 'a direct on-chain read wins over an Alchemy copy');
  const more = parseAlchemyHoldings('base', owner, [row(knownToken, { tokenBalance: '0x5f5e100' })], known, excluded, now);
  assert.deepEqual(mergeRecoveredHoldings([primary], more).map(h => h.asset), [`base.${knownToken}`, `base.${token}`]);
});
