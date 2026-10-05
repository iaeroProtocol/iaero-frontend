import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as hypercore from '../../src/lib/rift/hypercore.ts';
import * as evidence from '../../src/lib/rift/evidence.ts';

const source = readFileSync(new URL('../../src/lib/rift/payment-io.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

test('a Hyperliquid answer whose body stalls ends as "unknown" at the timeout instead of hanging', async () => {
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, require: n => ({ viem: { erc20Abi: [] }, './hypercore': hypercore, './evidence': evidence })[n],
    // Headers arrive, the body never does (until the request is aborted).
    fetch: async (_url, init) => ({
      ok: true, status: 200,
      text: () => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    }),
    AbortController, setTimeout: fn => setTimeout(fn, 20), clearTimeout, JSON,
  });
  const action = { destination: '0x3333333333333333333333333333333333333333', token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054', amount: '1', time: 1, r: '0x1', s: '0x2', v: 27 };
  assert.deepEqual({ ...(await exports.postHyperTransfer(action)) }, { kind: 'unknown' });
  await assert.rejects(exports.hyperDepositEvidence({ toAddress: '0x2', depositAddress: '0x3', fromAmount: '1', createdAt: 0 }, 'USDC'));
});

test('the HyperCore payment check does not depend on this computer\u2019s clock', async () => {
  // Round 2, Low: the ledger was read from createdAt - 60 s; with a clock 90 s fast, a transfer that went through
  // was never found, and "Check payment" said nothing had arrived.
  const exports = {};
  const createdAt = 1_800_000_000_000; // this computer's clock, 90 s fast
  const transferAt = createdAt - 90_000 + 5_000; // Hyperliquid's clock
  let startTime;
  vm.runInNewContext(compiled, {
    exports, require: n => ({ viem: { erc20Abi: [] }, './hypercore': hypercore, './evidence': evidence })[n],
    fetch: async (_url, init) => {
      startTime = JSON.parse(init.body).startTime;
      const entry = { time: transferAt, hash: '0xab', delta: { type: 'send', user: '0x2', destination: '0x3', token: 'USDC', amount: '1' } };
      return { ok: true, status: 200, text: async () => JSON.stringify(startTime <= transferAt ? [entry] : []) };
    },
    AbortController, setTimeout, clearTimeout, JSON,
  });
  const r = await exports.hyperDepositEvidence({ toAddress: '0x2', depositAddress: '0x3', fromAmount: '1', createdAt }, 'USDC');
  assert.equal(r.evidence, 'arrived');
});
