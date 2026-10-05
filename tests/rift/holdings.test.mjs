// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLlamaPrices, candidatesToHoldings, parseNative, parseTokenBalances, probeAmount, rankHoldings, rawToNumber, validDecimals, wholeReadFailed,
} from '../../src/lib/rift/holdings.ts';

const IAERO = 'base.0x81034fb34009115f215f5d5f564aac9ffa46a1dc';
const tok = (address, symbol, decimals, value, rate, extra = {}) => ({
  value, token: { address_hash: address, symbol, name: symbol, decimals: String(decimals), exchange_rate: rate, icon_url: null, type: 'ERC-20', reputation: 'ok', ...extra },
});

test('Blockscout balances become holdings; NFTs, scams, zero balances and iAERO itself are dropped', () => {
  const rows = [
    tok('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC', 6, '250000000', '1.0'),
    tok('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'USDC-DUPLICATE', 6, '250000000', '1.0'),
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
  assert.equal(parseTokenBalances('base', [tok('0x6666666666666666666666666666666666666666', 'OVERFLOW', 18, '1000000000000000000', '1e999')])[0].priceUsd, 0);
  assert.deepEqual(parseTokenBalances('base', { not: 'an array' }), []);
});

test('native ETH, DeFiLlama fallback prices and ranking by USD value', () => {
  const eth = parseNative('arbitrum', { coin_balance: '500000000000000000', exchange_rate: '3000' });
  assert.deepEqual([eth.asset, eth.symbol, eth.valueUsd], ['arbitrum.eth', 'ETH', 1500]);
  assert.equal(parseNative('base', { coin_balance: '0', exchange_rate: '3000' }), null);
  assert.equal(parseNative('base', { coin_balance: '1', exchange_rate: '1e999' }).priceUsd, 0);

  const tokens = parseTokenBalances('ethereum', [
    tok('0x4444444444444444444444444444444444444444', 'NOPRICE', 18, '7000000000000000000', null),
    tok('0x5555555555555555555555555555555555555555', 'DUST', 18, '1000000000000000', '0.5'),
  ]);
  const priced = applyLlamaPrices(tokens, { 'ethereum:0x4444444444444444444444444444444444444444': 2 }, c => c);
  assert.equal(priced[0].valueUsd, 14);
  const ranked = rankHoldings([...priced, eth]);
  assert.deepEqual(ranked.map(h => h.symbol), ['ETH', 'NOPRICE'], 'largest first; dust under $1 dropped');
  const missing = { ...eth, chain: 'base', asset: 'base.eth', priceUsd: 0, valueUsd: 0, priceMissing: true };
  assert.deepEqual(rankHoldings([missing, ...priced]).map(h => h.symbol), ['NOPRICE', 'ETH'], 'a holding without a price stays listed, last');
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

test('on-chain balances replace stale Blockscout ones; curated tokens fill its gaps', async () => {
  const { blockscoutCandidates, mergeCandidates, candidatesToHoldings, nativeHolding } = await import('../../src/lib/rift/holdings.ts');
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
  // 0x010B…9831 on Base, 2026-10-02: Blockscout said 1,402.605006 USDC (on-chain: 0) and had no cbBTC row.
  const rows = [
    tok(USDC, 'USDC', 6, '1402605006', '0.999876'),
    tok(USDC.toUpperCase().replace('0X', '0x'), 'USDC-DUPLICATE', 6, '1402605006', '0.999876'),
    tok('0x5cda0e1ca4ce2af96315f7f8963c85399c172204', 'WTCOIN', 18, '0', '193.31'),
    tok('0x1111111111111111111111111111111111111111', 'SPAM', 18, '6000000000000000000000000', null),
    tok('0x2222222222222222222222222222222222222222', 'ZERO', 18, '0', null),
    tok('0x2222222222222222222222222222222222222222', 'NOW-HELD', 18, '1000000000000000000', null),
    tok(IAERO.slice(5), 'iAERO', 18, '10000000000000000', '0.59'),
  ];
  const listed = blockscoutCandidates(rows, [IAERO]);
  assert.deepEqual(listed.map(c => c.symbol), ['USDC', 'WTCOIN', 'SPAM', 'NOW-HELD'], 'duplicates are checked once, including a balance that appeared during pagination');
  const curated = [{ address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, priceUsd: 0 }, { address: CBBTC, symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', decimals: 8, priceUsd: 0 }];
  const all = mergeCandidates(listed, curated);
  assert.deepEqual(all.map(c => c.symbol), ['USDC', 'WTCOIN', 'SPAM', 'NOW-HELD', 'cbBTC']);
  const held = candidatesToHoldings('base', all, [0n, 460076320000000000n, null, 0n, 4981205n]);
  assert.deepEqual(held.map(h => [h.symbol, h.balanceRaw]), [['WTCOIN', '460076320000000000'], ['cbBTC', '4981205']]);
  assert.equal(held[1].asset, `base.${CBBTC}`);
  assert.equal(held[1].priceUsd, 0, 'priced later, from DeFiLlama');
  assert.equal(nativeHolding('base', 0n, 2700), null);
  assert.equal(nativeHolding('base', 10n ** 18n, 2700).valueUsd, 2700);
  let truncated = false;
  const longTail = Array.from({ length: 61 }, (_, i) => tok(`0x${(i + 1).toString(16).padStart(40, '0')}`, `T${i}`, 18, '1000000000000000000', null));
  assert.equal(blockscoutCandidates(longTail, [], () => { truncated = true; }).length, 60);
  assert.equal(truncated, true, 'an incomplete token scan must be disclosed');
});

test('a list cut short by a failed page keeps its fresh rows and takes the rest from an older list', async () => {
  const { mergeTokenRows, tokenRowAddress } = await import('../../src/lib/rift/holdings.ts');
  const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), C = '0x' + 'c'.repeat(40);
  assert.equal(tokenRowAddress(tok(A.toUpperCase().replace('0X', '0x'), 'A', 18, '1', '1')), A);
  assert.equal(tokenRowAddress({ token: { address: B } }), B, 'older rows name it `address`');
  assert.equal(tokenRowAddress(null), '');
  const fresh = [tok(A, 'A-NOW', 18, '5', '2'), tok(C, 'C-NEW', 18, '1', '1')];
  const older = [tok(A, 'A-THEN', 18, '9', '2'), tok(B, 'B', 18, '3', '1'), { token: null }];
  const merged = mergeTokenRows(fresh, older);
  assert.deepEqual(merged.map(r => r.token.symbol), ['A-NOW', 'C-NEW', 'B'], 'fresh rows win; older rows fill the gap; rows without an address are dropped');
  assert.deepEqual(mergeTokenRows([], older).map(r => r.token.symbol), ['A-THEN', 'B']);
});

test('a decimals() no real token answers is never used in arithmetic', () => {
  assert.equal(rawToNumber('123', 1e9), 0, 'would otherwise throw RangeError: Invalid string length');
  assert.equal(rawToNumber('123', 1e8), 0, 'would otherwise allocate a 100 MB string');
  assert.equal(rawToNumber('123', -1), 0);
  assert.equal(rawToNumber('123', 2.5), 0);
  assert.equal(rawToNumber('1500000', 6), 1.5);
  for (const d of [0, 6, 18, 36]) assert.equal(validDecimals(d), true, String(d));
  for (const d of [-1, 37, 255, 1e9, 2.5, NaN, '18', undefined]) assert.equal(validDecimals(d), false, String(d));
  const started = Date.now();
  const out = candidatesToHoldings('base', [{ address: `0x${'11'.repeat(20)}`, symbol: 'BAD', name: 'Bad', decimals: 1e9, priceUsd: 1 }], [10n ** 30n]);
  assert.equal(out[0].valueUsd, 0, 'valued at nothing, not thrown');
  assert.ok(Date.now() - started < 200);
});

test('a multicall refused as a whole is told apart from single calls failing', () => {
  const ok = { status: 'success' }, fail = { status: 'failure' };
  assert.equal(wholeReadFailed([fail, fail, fail, ok], 3), true, 'only the balance reads count, not the decimals reads after them');
  assert.equal(wholeReadFailed([fail, ok, fail], 3), false);
});
