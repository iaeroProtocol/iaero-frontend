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
