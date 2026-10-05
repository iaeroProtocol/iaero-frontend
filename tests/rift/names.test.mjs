// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalToAsset, guessNames, learnedNames, namesToLearn, rememberNames, unknownNames } from '../../src/lib/rift/names.ts';

const IAERO = 'base.0x81034fb34009115f215f5d5f564aac9ffa46a1dc';
const USDT0 = 'arbitrum.0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
// What Rift answered for USDT0 -> iAERO with format "raw" (2026-10-05).
const RAW = { from: 'evm:42161.0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', to: 'evm:8453.0x81034fb34009115f215f5d5f564aac9ffa46a1dc' };

test('raw ids map to <chain>.<address>; anything else does not', () => {
  assert.equal(canonicalToAsset(RAW.from), USDT0);
  assert.equal(canonicalToAsset('evm:8453.0x81034FB34009115F215F5D5F564AAC9FFA46A1DC'), IAERO);
  assert.equal(canonicalToAsset('evm:10.0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'), null, 'a chain this app does not use');
  assert.equal(canonicalToAsset('arbitrum.usdt0'), null);
  assert.equal(canonicalToAsset(undefined), null);
});

test('only names that are neither addresses, native coins nor already known need resolving', () => {
  const known = { 'arbitrum.usdt0': USDT0.slice(9) };
  assert.deepEqual(unknownNames({ from: 'arbitrum.usdt0', to: IAERO }, known), []);
  assert.deepEqual(unknownNames({ from: 'arbitrum.eth', to: 'base.iaero' }, known), ['base.iaero']);
  assert.deepEqual(unknownNames({ from: 'arbitrum.newtoken', to: 'base.iAERO' }, {}), ['arbitrum.newtoken', 'base.iaero']);
  assert.deepEqual(unknownNames({ from: 'hyperliquid.usdc', to: IAERO }, {}), [], 'HyperCore and Bitcoin come back as asked');
  assert.deepEqual(unknownNames(null, {}), []);
});

test('a name is learned only for exactly the asset asked for, on its own chain', () => {
  assert.deepEqual(namesToLearn({ from: 'arbitrum.usdt0', to: 'base.iaero' }, RAW, { from: USDT0, to: IAERO }),
    { 'arbitrum.usdt0': USDT0.slice(9), 'base.iaero': IAERO.slice(5) });
  assert.deepEqual(namesToLearn({ from: 'arbitrum.eth', to: 'base.iaero' }, { from: 'evm:42161.native', to: RAW.to }, { from: 'arbitrum.eth', to: IAERO }),
    { 'base.iaero': IAERO.slice(5) }, 'a native source needs no name; the destination is still learned');
  assert.equal(namesToLearn({ from: 'arbitrum.usdt0', to: IAERO }, { ...RAW, from: 'evm:42161.0x1111111111111111111111111111111111111111' },
    { from: USDT0, to: IAERO }), null, 'the raw answer is for another token');
  assert.equal(namesToLearn({ from: USDT0, to: 'base.iaero' }, { ...RAW, to: 'evm:8453.0x2222222222222222222222222222222222222222' },
    { from: USDT0, to: IAERO }), null, 'the raw answer delivers something else');
  assert.equal(namesToLearn({ from: USDT0, to: 'base.iaero' }, { ...RAW, from: 'evm:42161.0x1111111111111111111111111111111111111111' },
    { from: USDT0, to: IAERO }), null, 'a canonical formatted source does not excuse a different raw source');
  assert.equal(namesToLearn({ from: 'arbitrum.eth', to: 'base.iaero' }, { from: 'evm:1.native', to: RAW.to },
    { from: 'arbitrum.eth', to: IAERO }), null, 'a native source must be on the requested chain');
  assert.equal(namesToLearn({ from: 'bitcoin.btc', to: 'base.iaero' }, { from: 'bitcoin.other', to: RAW.to },
    { from: 'bitcoin.btc', to: IAERO }), null, 'an unknown raw source cannot establish the destination name');
  assert.equal(namesToLearn({ from: 'ethereum.usdt0', to: IAERO }, RAW, { from: USDT0, to: IAERO }), null, 'a name on another chain');
});

test('Rift\u2019s real raw ids for native ETH and HyperCore sources let the destination name be learned', () => {
  // Raw ids exactly as Rift answered on 2026-10-05.
  for (const [from, rawFrom] of [['arbitrum.eth', 'evm:42161.eth'], ['base.eth', 'evm:8453.eth'], ['bitcoin.btc', 'bitcoin.btc'],
    ['hyperliquid.usdc', 'hyperliquid.spot:0'], ['hyperliquid.hype', 'hyperliquid.spot:150']]) {
    assert.deepEqual(namesToLearn({ from, to: 'base.iaero' }, { from: rawFrom, to: RAW.to }, { from, to: IAERO }), { 'base.iaero': IAERO.slice(5) }, from);
  }
  assert.equal(namesToLearn({ from: 'hyperliquid.usdc', to: 'base.iaero' }, { from: 'hyperliquid.spot:150', to: RAW.to },
    { from: 'hyperliquid.usdc', to: IAERO }), null, 'another HyperCore token');
  assert.equal(namesToLearn({ from: 'arbitrum.eth', to: 'base.iaero' }, { from: 'evm:8453.eth', to: RAW.to },
    { from: 'arbitrum.eth', to: IAERO }), null, 'the native coin of another chain');
});

test('only unknown names on the chain of the token asked for in their place are worth a lookup', () => {
  const known = { 'base.usdc': '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'arbitrum.usdt0': USDT0.slice(9) };
  assert.deepEqual(guessNames({ from: 'arbitrum.newtok', to: 'base.iaero' }, { from: USDT0, to: IAERO }, known),
    { 'arbitrum.newtok': USDT0.slice(9), 'base.iaero': IAERO.slice(5) });
  assert.deepEqual(guessNames({ from: 'arbitrum.usdt0', to: 'base.usdc' }, { from: USDT0, to: IAERO }, known), {}, 'a known name is never guessed');
  assert.deepEqual(guessNames({ from: 'base.newtok', to: IAERO }, { from: USDT0, to: IAERO }, known), {}, 'a name on another chain');
  assert.deepEqual(guessNames({ from: 'arbitrum.weth2', to: IAERO }, { from: 'arbitrum.eth', to: IAERO }, known), {}, 'a native coin has no name to learn');
  assert.deepEqual(guessNames({ from: 'base.newtok', to: 'base.newtok' }, { from: 'base.0x1111111111111111111111111111111111111111', to: IAERO }, {}),
    { 'base.newtok': '0x1111111111111111111111111111111111111111' }, 'one name cannot stand for both tokens');
});

test('a learned name is never re-pointed while in date, and is forgotten after a week', () => {
  const A = '0x1111111111111111111111111111111111111111', B = '0x2222222222222222222222222222222222222222';
  const t0 = 1_800_000_000_000, DAY = 86_400_000;
  rememberNames({ 'base.ttltok': A }, t0);
  assert.equal(learnedNames(t0 + DAY)['base.ttltok'], A);
  rememberNames({ 'base.ttltok': B }, t0 + DAY);
  assert.equal(learnedNames(t0 + 2 * DAY)['base.ttltok'], A, 'not re-pointed');
  assert.equal(learnedNames(t0 + 7 * DAY)['base.ttltok'], undefined, 'expired after a week');
  rememberNames({ 'base.ttltok': B }, t0 + 8 * DAY);
  assert.equal(learnedNames(t0 + 8 * DAY + 1)['base.ttltok'], B, 'learned again once expired');
  assert.equal(learnedNames(t0 - 1)['base.ttltok'], undefined, 'a time in the future (the clock moved back) is not trusted');
});
