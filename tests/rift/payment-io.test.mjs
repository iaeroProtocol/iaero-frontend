import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../src/lib/rift/payment-io.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInNewContext(compiled, {
  exports,
  require: name => {
    if (name === 'viem') return { erc20Abi: [] };
    if (name === './hypercore') return {};
    if (name === './evidence') return {};
    throw new Error(`unexpected import ${name}`);
  },
  crypto: { getRandomValues: bytes => bytes.fill(1) },
  AbortController, setTimeout, clearTimeout,
});

const TOKEN = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';
const DEPOSIT = '0x3333333333333333333333333333333333333333';
const result = (before, after) => ({ results: [
  { status: 'success', result: before }, { status: 'success', result: true }, { status: 'success', result: after },
] });

test('the final token check simulates to the actual Rift deposit address', async () => {
  let calls;
  const client = { simulateCalls: async input => { calls = input.calls; return result(7n, 107n); } };
  assert.equal(await exports.transferDeliversInFull(client, TOKEN, OWNER, 100n, DEPOSIT), true);
  assert.deepEqual(Array.from(calls, c => c.args?.[0]), [DEPOSIT, DEPOSIT, DEPOSIT]);
});

test('a short transfer or unsupported simulation cannot approve payment', async () => {
  assert.equal(await exports.transferDeliversInFull({ simulateCalls: async () => result(0n, 99n) }, TOKEN, OWNER, 100n, DEPOSIT), false);
  assert.equal(await exports.transferDeliversInFull({ simulateCalls: async () => { throw new Error('unsupported'); } }, TOKEN, OWNER, 100n, DEPOSIT), null);
});

test('a transfer that would fail is told apart from one that cannot be checked', async () => {
  const failing = { results: [{ status: 'success', result: 0n }, { status: 'failure', error: new Error('reverted') }, { status: 'success', result: 0n }] };
  assert.equal(await exports.transferDeliversInFull({ simulateCalls: async () => failing }, TOKEN, OWNER, 100n, DEPOSIT), 'reverts');
  const returnsFalse = { results: [{ status: 'success', result: 0n }, { status: 'success', result: false }, { status: 'success', result: 0n }] };
  assert.equal(await exports.transferDeliversInFull({ simulateCalls: async () => returnsFalse }, TOKEN, OWNER, 100n, DEPOSIT), 'reverts');
});
