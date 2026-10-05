import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as validate from '../../src/lib/rift/validate.ts';
import * as errors from '../../src/lib/rift/errors.ts';

const cjs = f => ts.transpileModule(readFileSync(new URL(`../../src/lib/rift/${f}`, import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const OUTAGE = 'execution costs could not be priced, so no route was evaluated in full';

/** client.ts against a stub Rift: route checks for `token` get the "could not be priced" answer; the control quote
 *  (USDC on Base) prices normally. */
function load() {
  const store = new Map();
  const calls = [];
  const exports = {};
  vm.runInNewContext(cjs('client.ts'), {
    exports, window: { localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } },
    require: n => ({
      './config': { RIFT_DESTINATION: 'base.0x81034fb34009115f215f5d5f564aac9ffa46a1dc', RIFT_INTEGRATOR_ID: 'iaero' },
      './errors': errors, './validate': validate, './bitcoin': { isBtcAddress: () => false },
    })[n] ?? (() => { throw new Error(`unexpected import ${n}`); })(),
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.from);
      const control = body.from === 'base.0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
      return { ok: control, status: control ? 200 : 422, text: async () => JSON.stringify(control ? {} : { error: OUTAGE }) };
    },
    AbortController, setTimeout, clearTimeout, Date, JSON, Number, Math,
  });
  return { ...exports, calls };
}

test('right after a route check that could not be priced, the control quote still runs and says which', async () => {
  const c = load();
  await assert.rejects(c.fetchQuote({ from: 'arbitrum.0x1111111111111111111111111111111111111111', from_amount: '1' }, undefined, 'probe'));
  assert.equal(c.riftBudget('probe'), false, 'route checks are spaced 15 s apart');
  assert.equal(await c.riftPricing('background'), true, 'Rift prices other routes: this token has none');
  assert.equal(c.calls.length, 2);
});
