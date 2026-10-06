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
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const lookups = m => m.calls.filter(c => c.format === 'raw').length;

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
      './client': { fetchQuote: async (body, _s, kind) => { calls.push({ ...body, kind }); return { from_amount: body.from_amount, ...raw }; }, riftBudget: kind => (calls.push({ budget: kind }), budget) },
      './rift-tokens': { RIFT_TOKEN_NAMES: { 'arbitrum.usdt0': USDT0.slice(9), 'base.usdc': USDC_BASE } },
      './names': names, './validate': validate,
    })[n] ?? (() => { throw new Error(`unexpected import ${n}`); })(),
  });
  return { ...exports, calls, names };
}
const expect = { destination: DEST, fromChain: 'arbitrum', fromAmount: '20', fromAsset: USDT0 };

test('a name Rift gives iAERO is learned from one raw quote, then needs no lookup', async () => {
  const m = load();
  const q = await m.checkQuote(formatted(), expect, { rawAmount: 20_000_000n, kind: 'user' });
  assert.equal(q.to, 'base.iaero');
  const lookups = m.calls.filter(c => c.format === 'raw');
  assert.equal(lookups.length, 1);
  assert.equal(lookups[0].from_amount, '20000000', 'raw amounts are base units');
  assert.equal(lookups[0].quote_mode, 'optimal', 'the same mode as the quote it resolves (route checks pass fast)');
  await m.checkQuote(formatted(), expect, { rawAmount: 20_000_000n, kind: 'user' });
  assert.equal(m.calls.filter(c => c.format === 'raw').length, 1, 'remembered');
  assert.deepEqual(Object.keys(m.names.learnedNames()), ['base.iaero'], 'only the unknown name is learned');
});

test('a route check resolves a name within the poll limit, not the probe spacing', async () => {
  const m = load();
  await m.checkQuote(formatted(), expect, { rawAmount: 1_000_000n, kind: 'probe' });
  assert.deepEqual(m.calls.filter(c => c.budget).map(c => c.budget), ['poll']);
  const busy = load({ budget: false });
  await assert.rejects(busy.checkQuote(formatted(), expect, { rawAmount: 1_000_000n, kind: 'probe' }),
    e => e instanceof busy.NameLookupPending && /does not deliver iAERO/.test(e.message), 'no room: asked again later');
  assert.equal(busy.calls.filter(c => c.format === 'raw').length, 0, 'no room: no lookup');
});

test('nothing is learned from a raw answer for another token or destination', async () => {
  for (const raw of [{ ...RAW, from: 'evm:42161.0x1111111111111111111111111111111111111111' }, { ...RAW, to: 'evm:8453.0x2222222222222222222222222222222222222222' }]) {
    const m = load({ raw });
    await assert.rejects(m.checkQuote(formatted(), expect, { rawAmount: 20_000_000n, kind: 'user' }), /does not deliver iAERO|different token/);
  }
  const m = load({ raw: { ...RAW, from: 'evm:42161.0x1111111111111111111111111111111111111111' } });
  await assert.rejects(m.checkQuote(formatted({ from: USDT0 }), expect, { rawAmount: 20_000_000n, kind: 'user' }), /does not deliver iAERO/);
  const wrongAmount = load({ raw: { ...RAW, from_amount: '1' } });
  await assert.rejects(wrongAmount.checkQuote(formatted(), expect, { rawAmount: 20_000_000n, kind: 'user' }), /does not deliver iAERO/);
});

test('a listed name is never re-pointed: an answer naming another token is refused without a lookup', async () => {
  // Review 6, High 2: Rift's formatted answer names USDC on Base while a raw quote says iAERO.
  const m = load();
  await assert.rejects(m.checkQuote(formatted({ to: 'base.usdc' }), expect, { rawAmount: 20_000_000n, kind: 'user' }), /does not deliver iAERO/);
  // The source side: asked for another token, Rift names USDT0.
  const other = 'arbitrum.0x1111111111111111111111111111111111111111';
  await assert.rejects(m.checkQuote(formatted({ to: DEST }), { ...expect, fromAsset: other }, { rawAmount: 20_000_000n, kind: 'user' }), /different token/);
  assert.equal(lookups(m), 0);
  assert.deepEqual(m.names.learnedNames(), {}, 'nothing learned');
  m.names.rememberNames({ 'base.usdc': DEST.slice(5) }); // even a learned entry cannot override the list
  await assert.rejects(m.checkQuote(formatted({ to: 'base.usdc' }), expect, { rawAmount: 20_000_000n, kind: 'user' }), /does not deliver iAERO/);
});

test('a learned name is not re-pointed while in date; after a week it is looked up again', async () => {
  const OTHER = '0x2222222222222222222222222222222222222222';
  const m = load();
  m.names.rememberNames({ 'base.iaero': OTHER });
  await assert.rejects(m.checkQuote(formatted(), expect, { rawAmount: 20_000_000n, kind: 'user' }), /does not deliver iAERO/);
  assert.equal(lookups(m), 0, 'known for another contract: refused, no lookup');
  const later = load();
  later.names.rememberNames({ 'base.iaero': OTHER }, Date.now() - 8 * 86_400_000);
  const q = await later.checkQuote(formatted(), expect, { rawAmount: 20_000_000n, kind: 'user' });
  assert.equal(q.to, 'base.iaero');
  assert.equal(lookups(later), 1);
  assert.equal(later.names.learnedNames()['base.iaero'], DEST.slice(5));
});

test('an answer that fails whatever its unknown names stand for is refused without a lookup, and is not pending', async () => {
  const m = load();
  // An unknown source name on another chain than the token asked for.
  await assert.rejects(m.checkQuote(formatted({ from: 'base.newtok' }), expect, { rawAmount: 20_000_000n, kind: 'user' }), /does not deliver iAERO|different token/);
  // An unknown source name, but a destination known to be another token.
  await assert.rejects(m.checkQuote(formatted({ from: 'arbitrum.newtok', to: 'base.usdc' }), expect, { rawAmount: 20_000_000n, kind: 'user' }), /does not deliver iAERO/);
  assert.equal(lookups(m), 0);
  const busy = load({ budget: false });
  await assert.rejects(busy.checkQuote(formatted({ from: 'base.newtok' }), expect, { rawAmount: 1_000_000n, kind: 'probe' }),
    e => !(e instanceof busy.NameLookupPending), 'a route check caches it as no route');
});
