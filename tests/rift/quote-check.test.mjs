import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as validate from '../../src/lib/rift/validate.ts';

const cjs = f => ts.transpileModule(readFileSync(new URL(`../../src/lib/rift/${f}`, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const DEST = 'base.0x81034fb34009115f215f5d5f564aac9ffa46a1dc';
const USDT0 = 'arbitrum.0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const formatted = (over = {}) => ({
  id: '01a10a8e-d95c-73f3-9ab7-71801cf89d01', from: 'arbitrum.usdt0', to: 'base.iaero', from_amount: '20', estimated_amount_out: '31.4',
  expires_at: '2026-10-05T05:44:56.348262Z', route: [{ venue: 'across', from: 'arbitrum.usdt0', to: 'base.usdc' }], ...over,
});
const RAW = { from: `evm:42161.${USDT0.slice(9)}`, to: `evm:8453.${DEST.slice(5)}` };

/** quote-check.ts with a stub Rift: `raw` is what a raw quote answers; `budget` whether background calls may go. */
function load({ raw = RAW, budget = true } = {}) {
  const store = new Map();
  const window = { localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };
  const names = {}; vm.runInNewContext(cjs('names.ts'), { exports: names, window, JSON, Object });
  const calls = [];
  const exports = {};
  vm.runInNewContext(cjs('quote-check.ts'), {
    exports, window,
    require: n => ({
      './client': { fetchQuote: async (body, _s, kind) => { calls.push({ ...body, kind }); return raw; }, riftBudget: kind => (calls.push({ budget: kind }), budget) },
      './rift-tokens': { RIFT_TOKEN_NAMES: { 'arbitrum.usdt0': USDT0.slice(9) } },
      './names': names, './validate': validate,
    })[n] ?? (() => { throw new Error(`unexpected import ${n}`); })(),
  });
  return { ...exports, calls };
}
const expect = { destination: DEST, fromChain: 'arbitrum', fromAmount: '20', fromAsset: USDT0 };

test('a name Rift gives iAERO is learned from one raw quote, then needs no lookup', async () => {
  const m = load();
  const q = await m.checkQuote(formatted(), expect, { rawAmount: 20_000_000n, kind: 'user' });
  assert.equal(q.to, 'base.iaero');
  const lookups = m.calls.filter(c => c.format === 'raw');
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].from_amount, '20000000', 'raw amounts are base units');
  await m.checkQuote(formatted(), expect, { rawAmount: 20_000_000n, kind: 'user' });
  assert.equal(m.calls.filter(c => c.format === 'raw').length, 1, 'remembered');
});

test('a route check resolves a name within the poll limit, not the probe spacing', async () => {
  const m = load();
  await m.checkQuote(formatted(), expect, { rawAmount: 1_000_000n, kind: 'probe' });
  assert.deepEqual(m.calls.filter(c => c.budget).map(c => c.budget), ['poll']);
  const busy = load({ budget: false });
  await assert.rejects(busy.checkQuote(formatted(), expect, { rawAmount: 1_000_000n, kind: 'probe' }), /does not deliver iAERO/);
  assert.equal(busy.calls.filter(c => c.format === 'raw').length, 0, 'no room: no lookup');
});

test('nothing is learned from a raw answer for another token or destination', async () => {
  for (const raw of [{ ...RAW, from: 'evm:42161.0x1111111111111111111111111111111111111111' }, { ...RAW, to: 'evm:8453.0x2222222222222222222222222222222222222222' }]) {
    const m = load({ raw });
    await assert.rejects(m.checkQuote(formatted(), expect, { rawAmount: 20_000_000n, kind: 'user' }), /does not deliver iAERO|different token/);
  }
});
