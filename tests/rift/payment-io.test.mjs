import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as evidence from '../../src/lib/rift/evidence.ts';

const source = readFileSync(new URL('../../src/lib/rift/payment-io.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
vm.runInNewContext(compiled, {
  exports,
  require: name => {
    if (name === 'viem') return { erc20Abi: [] };
    if (name === './hypercore') return {};
    if (name === './evidence') return evidence;
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

test('round 6: a mined token payment is judged by its Transfer to the deposit address, or else by what the address holds', async () => {
  const TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const word = v => `0x${v.toString(16).padStart(64, '0')}`;
  const pad = a => `0x${a.slice(2).padStart(64, '0')}`;
  const log = (to, value, { indexed = false } = {}) => ({
    address: TOKEN, topics: [TOPIC, pad(OWNER), pad(to), ...(indexed ? [word(value)] : [])], data: indexed ? '0x' : word(value),
  });
  const order = { depositAddress: DEPOSIT, token: { address: TOKEN }, fromAmountRaw: '100' };
  const chain = ({ balance = 0n, nonce = 0 } = {}) => {
    const reads = [];
    return { reads, getBlockNumber: async () => 1000n, readContract: async a => { reads.push(a.blockNumber); return balance; },
      getTransactionCount: async () => nonce, getCode: async () => '0x' };
  };
  const mined = async (client, logs, status = 'success') => ({ ...(await exports.minedPayment(client, order, { status, logs, blockNumber: 990n })) });
  // The whole amount, part of it (a fee on transfer), a token that indexes the amount, a Transfer elsewhere alongside.
  assert.deepEqual(await mined(chain(), [log(DEPOSIT, 100n)]), { kind: 'paid', received: undefined });
  assert.deepEqual(await mined(chain(), [log(DEPOSIT, 98n)]), { kind: 'paid', received: '98' });
  assert.deepEqual(await mined(chain(), [log(DEPOSIT, 100n, { indexed: true })]), { kind: 'paid', received: undefined }, 'no BigInt("0x") throw');
  assert.deepEqual(await mined(chain(), [log(OWNER, 100n), log(DEPOSIT, 100n)]), { kind: 'paid', received: undefined });
  assert.deepEqual(await mined(chain(), [], 'reverted'), { kind: 'failed' });
  // No Transfer to the deposit address: nothing there once mined is a failed payment (a token that returns false)...
  const empty = chain();
  assert.deepEqual(await mined(empty, [log(OWNER, 100n)]), { kind: 'failed' });
  assert.deepEqual([...empty.reads], [999n], 'read at a block that includes the transaction');
  // ...the whole amount there (a token with a non-standard event) or a sweep is a payment; part of it is in doubt.
  assert.deepEqual(await mined(chain({ balance: 100n }), []), { kind: 'paid' });
  assert.deepEqual(await mined(chain({ nonce: 1 }), []), { kind: 'paid' });
  assert.deepEqual(await mined(chain({ balance: 40n }), []), { kind: 'doubt' });
});
