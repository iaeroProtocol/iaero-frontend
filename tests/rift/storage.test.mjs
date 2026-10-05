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
const HASH = `0x${'ab'.repeat(32)}`;
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

function harness(saved, { locksAvailable = true, lockRejects = false } = {}) {
  const data = new Map([[key, JSON.stringify(Array.isArray(saved) ? saved : [saved])]]);
  let storageBlocked = false;
  const localStorage = {
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => { if (storageBlocked) throw new Error('quota'); data.set(k, v); },
    removeItem: k => { data.delete(k); },
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
  return {
    tab, read: () => JSON.parse(data.get(key))[0], all: () => JSON.parse(data.get(key)),
    block: () => { storageBlocked = true; }, unblock: () => { storageBlocked = false; },
  };
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

test('a rejected Web Lock writes nothing, and storage is not reported as failing', async () => {
  const h = harness(order(), { lockRejects: true });
  const tab = h.tab();
  assert.equal(await tab.patchOrder(h.read().id, { payRequestedAt: Date.now() }), 'failed');
  assert.equal(h.read().payRequestedAt, undefined);
  assert.equal(tab.storageFailing(), false, 'nothing was written, so later writes start from storage as usual');
  await assert.rejects(tab.claimPayment(h.read().id, owner), /coordinate this payment/);
  assert.equal(h.read().payRequestedAt, undefined);
});

test('a tab whose save failed never undoes another tab\u2019s payment record', async () => {
  const x = order(), y = order();
  const h = harness([x, y]);
  const a = h.tab(), b = h.tab();
  h.block();
  assert.equal(await a.patchOrder(y.id, { notify: true }), 'failed', 'storage full in tab A');
  assert.equal(a.storageFailing(), true);
  h.unblock();
  const claimed = await b.claimPayment(x.id, owner, { payNonce: 1 });
  assert.ok(claimed);
  assert.equal(await b.patchPaymentAttempt(x.id, claimed.payAttemptId, { depositTxHash: HASH, depositSentAt: Date.now(), payRequestedAt: undefined }), 'saved');
  // Tab A's next write (a status poll for the other order) starts from storage, not from its own older copy.
  assert.equal(await a.patchOrder(y.id, { lastPolledAt: Date.now() }), 'saved');
  const stored = h.all().find(o => o.id === x.id);
  assert.equal(stored.payAttemptId, claimed.payAttemptId);
  assert.equal(stored.depositTxHash, HASH);
  assert.equal(orderState.payState(stored, Date.now()), 'sent');
});

test('a wallet result for a superseded or removed attempt is reported, not applied', async () => {
  const x = order();
  const h = harness([x]);
  const a = h.tab(), b = h.tab();
  const claimed = await a.claimPayment(x.id, owner);
  assert.equal(await a.patchPaymentAttempt(x.id, claimed.payAttemptId, { payNonce: 7 }), 'saved');
  await b.patchOrder(x.id, { payAttemptId: randomUUID() });
  assert.equal(await a.patchPaymentAttempt(x.id, claimed.payAttemptId, { depositTxHash: HASH }), 'superseded');
  assert.equal(h.read().depositTxHash, undefined);
  await b.removeOrders([x.id]);
  assert.equal(await a.patchPaymentAttempt(x.id, claimed.payAttemptId, { depositTxHash: HASH }), 'missing');
});

test('a signed HyperCore transfer is posted only by the attempt that saved it', async () => {
  const x = order();
  const h = harness([x]);
  const a = h.tab();
  const claimed = await a.claimPayment(x.id, owner);
  const action = { destination: x.depositAddress, token: 'USDC:0x6d', amount: '1', time: 1000, r: '0x1', s: '0x2', v: 27 };
  assert.equal(await a.patchPaymentAttempt(x.id, claimed.payAttemptId, { hlAction: action }), 'saved');
  assert.equal(await a.beginHyperPost(x.id, randomUUID(), action), null, 'another attempt');
  assert.equal(await a.beginHyperPost(x.id, claimed.payAttemptId, { ...action, r: '0x9' }), null, 'another signature');
  assert.equal(h.read().hlPostedAt, undefined);
  assert.equal((await a.beginHyperPost(x.id, claimed.payAttemptId, action))?.postedBefore, false);
  assert.ok(h.read().hlPostedAt > 0);
  assert.equal((await a.beginHyperPost(x.id, claimed.payAttemptId, action))?.postedBefore, true, 'a refusal of it now is not read as nothing sent');
});

test('payments are refused up front without Web Locks or working storage; unreadable records are listed', () => {
  assert.equal(harness(order()).tab().paymentStorageProblem(), null);
  assert.match(harness(order(), { locksAvailable: false }).tab().paymentStorageProblem(), /Web Locks/);
  const blocked = harness(order());
  blocked.block();
  assert.match(blocked.tab().paymentStorageProblem(), /storage is full or blocked/);
  const foreignId = randomUUID();
  const mixed = harness([order(), { id: foreignId, from: 'a newer version' }]).tab();
  mixed.loadOrders();
  assert.deepEqual([...mixed.unreadableOrderIds()], [foreignId]);
});

test('a claim is compare-and-set: another tab\u2019s saved transfer is never replaced by a second signature', async () => {
  const x = order();
  const h = harness([x]);
  const a = h.tab();
  const posted = { destination: x.depositAddress, token: 'USDC:0x6d', amount: '1', time: 1000, r: '0x1', s: '0x2', v: 27 };
  const saw = undefined; // this tab looked before another tab saved `posted`
  await a.patchOrder(x.id, { hlAction: posted, hlPostedAt: 1000 });
  const holds = seen => s => s.hlAction?.time === seen?.time && s.hlAction?.r === seen?.r;
  assert.equal(await a.claimPayment(x.id, owner, { hlAction: undefined, hlPostedAt: undefined }, holds(saw)), null);
  assert.equal(h.read().hlAction?.r, '0x1', 'the saved transfer is kept');
  assert.ok(await a.claimPayment(x.id, owner, { hlAction: posted }, holds(posted)), 'retrying the same transfer is allowed');
});

test('changes a full storage refused are kept on this page and applied on top of other tabs\u2019 records', async () => {
  const x = order(), y = order();
  const h = harness([x, y]);
  const a = h.tab(), b = h.tab();
  h.block();
  assert.equal(await a.patchOrder(y.id, { notify: true }), 'failed');
  h.unblock();
  await b.patchOrder(x.id, { notify: true });
  const view = a.loadOrders();
  assert.equal(view.find(o => o.id === y.id).notify, true, 'this page still shows its unsaved change');
  assert.equal(view.find(o => o.id === x.id).notify, true, '...and the other tab\u2019s');
  h.block();
  await a.applyStatusUpdate(y.id, { status: 'awaiting_deposit', rawStatus: 'awaiting_deposit', amountOut: null });
  assert.equal(a.loadOrders().find(o => o.id === y.id).notify, true, 'not lost at the next unrelated write');
  h.unblock();
  assert.equal(await a.patchOrder(x.id, { lastPolledAt: 1 }), 'saved');
  assert.equal(h.all().find(o => o.id === y.id).notify, true, 'saved once storage takes writes again');
  assert.equal(a.storageFailing(), false);
});
