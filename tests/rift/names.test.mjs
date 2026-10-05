// Run: npm run test:rift (Node strips the TypeScript types).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalToAsset, namesToLearn, unknownNames } from '../../src/lib/rift/names.ts';

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
  assert.equal(namesToLearn({ from: 'ethereum.usdt0', to: IAERO }, RAW, { from: USDT0, to: IAERO }), null, 'a name on another chain');
});
