import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import * as orderState from '../../src/lib/rift/order-state.ts';

const source = readFileSync(new URL('../../src/lib/rift/storage.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const owner = '0x2222222222222222222222222222222222222222';
const key = 'iaero.rift.orders.v1';
const order = () => {
  const now = Date.now();
  return {
    id: randomUUID(), quoteId: randomUUID(), createdAt: now - 1000, sourceChain: 'ethereum',
    token: { symbol: 'ETH', decimals: 18, asset: 'ethereum.eth' }, fromAmount: '1', fromAmountRaw: '1000000000000000000',
    estimatedOut: '10', route: [{ venue: 'across', from: 'ethereum.eth', to: 'base.eth' }],
    depositAddress: '0x1111111111111111111111111111111111111111', depositDeadline: new Date(now + 86400000).toISOString(),
    toAddress: owner, status: 'awaiting_deposit', statusTimes: {},
  };
};

function harness(savedOrder, { locksAvailable = true, lockRejects = false } = {}) {
  const data = new Map([[key, JSON.stringify([savedOrder])]]);
  let storageBlocked = false;
  const localStorage = {
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => { if (storageBlocked) throw new Error('quota'); data.set(k, v); },
  };
  let tail = Promise.resolve();
  const locks = !locksAvailable ? undefined : lockRejects ? { request: () => Promise.reject(new Error('lock unavailable')) } : { request: (_name, fn) => {
    const task = tail.then(fn);
    tail = task.then(() => {}, () => {});
    return task;
  } };
  const tab = () => {
    const exports = {};
    vm.runInNewContext(compiled, {
      exports, require: name => {
        if (name === 'react') return { useCallback() {}, useEffect() {}, useState() {} };
        if (name === './order-state') return orderState;
        if (name === './keys') return { ORDERS_KEY: key };
        throw new Error(`unexpected import ${name}`);
      },
      window: { localStorage, dispatchEvent() {} }, navigator: { locks }, Event: class {}, crypto: { randomUUID },
      Date, JSON, Promise, Set, Map,
    });
    return exports;
  };
  return { tab, read: () => JSON.parse(data.get(key))[0], block: () => { storageBlocked = true; }, unblock: () => { storageBlocked = false; } };
}

test('two tabs racing for one order open only one payment attempt', async () => {
  const h = harness(order());
  const a = h.tab(), b = h.tab();
  const [first, second] = await Promise.all([a.claimPayment(h.read().id, owner, { payNonce: 4 }), b.claimPayment(h.read().id, owner, { payNonce: 4 })]);
  assert.equal(Number(!!first) + Number(!!second), 1);
  const winner = first ? a : b;
  const claimed = first ?? second;
  assert.equal(h.read().payAttemptId, claimed.payAttemptId);
  assert.equal(h.read().payNonce, 4);
  await winner.patchPaymentAttempt(claimed.id, randomUUID(), { payUnknown: true });
  assert.equal(h.read().payUnknown, false, 'a stale wallet result cannot change a newer attempt');
  await winner.patchPaymentAttempt(claimed.id, claimed.payAttemptId, { payUnknown: true });
  assert.equal(h.read().payUnknown, true);
  assert.equal(await h.tab().claimPayment(claimed.id, owner), null, 'a refreshed tab cannot reopen the prompt');
});

test('a payment claim fails closed when the durable write or Web Lock is unavailable', async () => {
  const h = harness(order());
  h.block();
  const a = h.tab();
  await assert.rejects(a.claimPayment(h.read().id, owner), /Could not save the payment attempt/);
  assert.equal(h.read().payRequestedAt, undefined);
  h.unblock();
  await assert.rejects(a.claimPayment(h.read().id, owner), /not saving orders/, 'an in-memory copy is not used for a payment claim');
  assert.ok(await h.tab().claimPayment(h.read().id, owner), 'a fresh tab can claim after storage recovers');

  const unsupported = harness(order(), { locksAvailable: false });
  await assert.rejects(unsupported.tab().claimPayment(unsupported.read().id, owner), /Web Locks support/);
  assert.equal(unsupported.read().payRequestedAt, undefined);
});

test('a rejected Web Lock never falls back to an unlocked write', async () => {
  const h = harness(order(), { lockRejects: true });
  const tab = h.tab();
  await tab.patchOrder(h.read().id, { payRequestedAt: Date.now() });
  assert.equal(h.read().payRequestedAt, undefined);
  assert.equal(tab.storageFailing(), true);
  await assert.rejects(tab.claimPayment(h.read().id, owner), /coordinate this payment/);
  assert.equal(h.read().payRequestedAt, undefined);
});
