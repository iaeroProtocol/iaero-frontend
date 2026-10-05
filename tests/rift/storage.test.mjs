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
const BTC_DEPOSIT = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const btcOrder = (over = {}) => ({
  ...order(), sourceChain: 'bitcoin', token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' }, fromAmount: '0.001', fromAmountRaw: '100000',
  depositAddress: BTC_DEPOSIT, route: [{ venue: 'garden', from: 'bitcoin.btc', to: 'base.cbbtc' }], ...over,
});
/** Bitcoin looks as the order card takes them (OrderTracker.tsx 2b); `at`: when (now by default). */
const trackerLook = (t, id) => (d, at = Date.now()) => {
  const o = t.loadOrders().find(x => x.id === id);
  const look = { at, failing: t.storageFailing(), checkpoint: orderState.btcCheckpoint(o) };
  return t.patchOrder(id, prev => orderState.btcLookPatch(prev.btc, d, look));
};
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

function harness(saved, { locksAvailable = true, lockRejects = false, lockError = new Error('lock unavailable') } = {}) {
  const data = new Map([[key, JSON.stringify(Array.isArray(saved) ? saved : [saved])]]);
  const listeners = [];
  const timers = [];
  let storageBlocked = false;
  const refusedKeys = new Set();
  const localStorage = {
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => { if (storageBlocked || refusedKeys.has(k)) throw new Error('quota'); data.set(k, v); },
    removeItem: k => { data.delete(k); },
  };
  let tail = Promise.resolve();
  const locks = !locksAvailable ? undefined : lockRejects ? { request: () => Promise.reject(lockError) } : { request: (_name, fn) => {
    const task = tail.then(fn);
    tail = task.then(() => {}, () => {});
    return task;
  } };
  /** A tab; `own`: its storage can be blocked on its own (blockMe), as when only its larger write is refused. */
  const tab = ({ own = false } = {}) => {
    const exports = {};
    const me = { blocked: false };
    const store = !own ? localStorage : {
      getItem: localStorage.getItem, removeItem: localStorage.removeItem,
      setItem: (k, v) => { if (me.blocked) throw new Error('quota'); localStorage.setItem(k, v); },
    };
    vm.runInNewContext(compiled, {
      exports, require: name => {
        if (name === 'react') return { useCallback() {}, useEffect() {}, useState() {} };
        if (name === './order-state') return orderState;
        if (name === './keys') return { ORDERS_KEY: key };
        throw new Error(`unexpected import ${name}`);
      },
      window: { localStorage: store, dispatchEvent: () => { for (const listener of listeners) listener(); } },
      navigator: { locks }, Event: class {}, crypto: { randomUUID },
      setTimeout: fn => timers.push(fn), clearTimeout() {},
      Date, JSON, Promise, Set, Map,
    });
    return Object.assign(exports, { blockMe: () => { me.blocked = true; }, unblockMe: () => { me.blocked = false; } });
  };
  return {
    tab, read: () => JSON.parse(data.get(key))[0], all: () => JSON.parse(data.get(key)),
    onEvent: listener => listeners.push(listener),
    block: () => { storageBlocked = true; }, unblock: () => { storageBlocked = false; },
    timers, setRaw: v => data.set(key, v), get: k => data.get(k), refuseKey: k => refusedKeys.add(k),
    /** Fire the timers set so far (the page's 15 s retry), then let their writes finish. */
    runTimers: async () => { for (const fn of timers.splice(0)) fn(); await new Promise(r => setImmediate(r)); },
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
  await b.removeOrders([x.id], () => true);
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

test('orders and payments are refused up front without Web Locks or working storage; unreadable records are listed', () => {
  assert.equal(harness(order()).tab().orderStorageProblem(), null);
  assert.match(harness(order(), { locksAvailable: false }).tab().orderStorageProblem(), /Web Locks/);
  const blocked = harness(order());
  blocked.block();
  assert.match(blocked.tab().orderStorageProblem(), /storage is full or blocked/);
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

test('an order that could not be saved is not offered for a Bitcoin payment', async () => {
  const existing = order();
  const h = harness([existing]);
  const a = h.tab();
  const claimed = await a.claimPayment(existing.id, owner);
  const btc = {
    ...order(), sourceChain: 'bitcoin', token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' },
    fromAmount: '0.001', fromAmountRaw: '100000',
    depositAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  };
  h.block();
  assert.equal(await a.patchPaymentAttempt(existing.id, claimed.payAttemptId, { depositTxHash: HASH, depositSentAt: Date.now() }), 'failed');
  assert.equal(await a.upsertOrder(btc, { keepOnFailure: false }), 'failed');
  assert.equal(a.loadOrders().some(o => o.id === btc.id), false, 'the payment card cannot show an ephemeral deposit address');
  assert.equal(h.all().some(o => o.id === btc.id), false, 'nothing was saved');
  assert.equal(a.loadOrders().find(o => o.id === existing.id).depositTxHash, HASH, 'discarding the new order keeps an earlier unsaved payment');
  h.unblock();
  assert.equal(await a.upsertOrder(btc, { keepOnFailure: false }), 'saved');
  assert.equal(a.loadOrders().some(o => o.id === btc.id), true);
  assert.equal(h.all().find(o => o.id === existing.id).depositTxHash, HASH, 'the earlier payment is saved too');
});

test('a sent payment hash stays visible through more than fifty failed later writes', async () => {
  const x = order();
  const h = harness(x);
  const a = h.tab();
  const claimed = await a.claimPayment(x.id, owner);
  const seen = [];
  h.onEvent(() => seen.push(a.loadOrders()[0]?.depositTxHash));
  h.block();
  assert.equal(await a.patchPaymentAttempt(x.id, claimed.payAttemptId, { depositTxHash: HASH, depositSentAt: Date.now() }), 'failed');
  assert.equal(seen.at(-1), HASH, 'the change event exposes the unsaved hash to the order card');
  for (let i = 0; i < 51; i++) assert.equal(await a.patchOrder(x.id, { lastPolledAt: Date.now() + i }), 'failed');
  assert.equal(a.loadOrders()[0].depositTxHash, HASH, 'the open tab must retain its only record of the sent transaction');
  h.unblock();
  assert.equal(await a.patchOrder(x.id, { notify: true }), 'saved');
  assert.equal(h.read().depositTxHash, HASH, 'the hash is saved when storage recovers');
});

test('while storage refuses writes, polls that only stamp their time are not kept; payment changes all are', async () => {
  const x = order();
  const h = harness(x);
  const a = h.tab();
  const claimed = await a.claimPayment(x.id, owner);
  h.block();
  assert.equal(await a.patchPaymentAttempt(x.id, claimed.payAttemptId, { depositTxHash: HASH, depositSentAt: Date.now() }), 'failed');
  for (let i = 0; i < 200; i++) await a.applyStatusUpdate(x.id, { status: 'awaiting_deposit', rawStatus: 'awaiting_deposit', amountOut: null }, Date.now() + i * 40_000);
  assert.ok(a.unsavedChanges() <= 3, `bounded: ${a.unsavedChanges()}`);
  assert.equal(a.loadOrders()[0].depositTxHash, HASH, 'the payment change is still applied');
  // The page kept polling, so a status it first sees now was watched live, although no stamp was saved.
  await a.applyStatusUpdate(x.id, { status: 'funded', rawStatus: 'funded', amountOut: null }, Date.now() + 200 * 40_000);
  assert.equal(a.loadOrders()[0].statusLate?.funded, undefined, 'not "noticed late"');
  const fresh = h.tab();
  await fresh.applyStatusUpdate(x.id, { status: 'executing', rawStatus: 'executing', amountOut: null }, Date.now() + 400 * 40_000);
  assert.equal(fresh.loadOrders()[0].statusLate?.executing, true, 'a page that was not watching still says so');
  h.unblock();
  assert.equal(await a.patchOrder(x.id, { notify: true }), 'saved');
  assert.equal(h.read().depositTxHash, HASH);
  assert.equal(a.unsavedChanges(), 0);
});

test('a Bitcoin payment first seen while storage refuses writes survives later empty answers', async () => {
  // Review 6, High 1: a later observation is applied on top of the first sighting, never in place of it.
  const x = {
    ...order(), sourceChain: 'bitcoin', token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' }, fromAmount: '0.001', fromAmountRaw: '100000',
    depositAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', route: [{ venue: 'garden', from: 'bitcoin.btc', to: 'base.cbbtc' }],
  };
  const h = harness(x);
  const a = h.tab();
  const TXID = 'cd'.repeat(32);
  const seen = { payments: [{ txid: TXID, confirmations: 0 }], totalSats: 100_000n };
  const empty = { payments: [], totalSats: 0n };
  const observe = (d, at) => a.patchOrder(x.id, prev => {
    const btc = orderState.nextBtcRecord(prev.btc, d, at);
    return btc === prev.btc ? {} : { btc };
  });
  const t = Date.now();
  h.block();
  assert.equal(await observe(seen, t), 'failed');
  assert.equal(await observe(empty, t + 40_000), 'failed');
  assert.equal(a.loadOrders()[0].btc.txid, TXID);
  assert.equal(a.loadOrders()[0].btc.missing, undefined, 'one empty answer is not enough');
  for (let i = 2; i <= 6; i++) await observe(empty, t + i * 40_000);
  const btc = a.loadOrders()[0].btc;
  assert.equal(btc.txid, TXID, 'the payment is never forgotten');
  assert.equal(btc.missing, true);
  assert.ok(btc.emptyChecks >= orderState.BTC_MISSING_AFTER);
  assert.ok(a.unsavedChanges() <= 6, `bounded: ${a.unsavedChanges()}`);
  assert.equal(orderState.isAbandoned({ ...a.loadOrders()[0], createdAt: t - 2 * 3600_000 }, t + 3600_000), false);
  h.unblock();
  assert.equal(await a.patchOrder(x.id, { notify: true }), 'saved');
  assert.equal(h.read().btc.txid, TXID, 'saved once storage recovers');
  assert.equal(h.read().btc.missing, true);
});

test('once storage works again, the next write of any kind saves what the page carried', async () => {
  // Review 7, Medium: while storage fails, a poll that only stamps its time changes nothing, so nothing wrote, and
  // the refresh the banner asks for dropped the unsaved hash.
  const x = { ...order(), statusTimes: { awaiting_deposit: Date.now() - 1000 }, lastPolledAt: Date.now() - 1000 };
  const h = harness(x);
  const a = h.tab();
  const claimed = await a.claimPayment(x.id, owner);
  h.block();
  assert.equal(await a.patchPaymentAttempt(x.id, claimed.payAttemptId, { depositTxHash: HASH, depositSentAt: Date.now() }), 'failed');
  assert.equal(a.storageFailing(), true);
  h.unblock();
  assert.equal(await a.applyStatusUpdate(x.id, { status: 'awaiting_deposit', rawStatus: 'awaiting_deposit', amountOut: null }), 'unchanged');
  assert.equal(h.read().depositTxHash, HASH, 'saved by a poll that changed nothing');
  assert.equal(a.storageFailing(), false);
  assert.equal(a.unsavedChanges(), 0);
  assert.equal(h.tab().loadOrders()[0].depositTxHash, HASH, 'a refresh keeps it');
});

test('changes storage refused are tried again every 15 s, even with nothing else writing', async () => {
  const x = order();
  const h = harness(x);
  const a = h.tab();
  h.block();
  assert.equal(await a.patchOrder(x.id, { notify: true }), 'failed');
  assert.equal(h.timers.length, 1, 'one retry set');
  await h.runTimers();
  assert.equal(h.read().notify, undefined, 'still refused');
  assert.equal(h.timers.length, 1, 'set again');
  h.unblock();
  await h.runTimers();
  assert.equal(h.read().notify, true, 'saved once storage works');
  assert.equal(a.storageFailing(), false);
  assert.equal(h.timers.length, 0, 'nothing left to retry');
});

test('while storage refuses writes, Bitcoin looks record what was seen and not their counters', async () => {
  // Review 7, Low 2: confirmations and a flapping mempool.space answer used to add a change per look.
  const x = {
    ...order(), sourceChain: 'bitcoin', token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' }, fromAmount: '0.001', fromAmountRaw: '100000',
    depositAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', route: [{ venue: 'garden', from: 'bitcoin.btc', to: 'base.cbbtc' }],
  };
  const h = harness(x);
  const a = h.tab();
  const TXID = 'ef'.repeat(32);
  const seen = c => ({ payments: [{ txid: TXID, confirmations: c }], totalSats: 100_000n });
  const empty = { payments: [], totalSats: 0n };
  const look = trackerLook(a, x.id);
  h.block();
  await look(seen(0)); // first seen: a change
  await a.patchOrder(x.id, { notify: true }); // storage is now known to be failing
  for (let i = 0; i < 100; i++) await look(i % 2 ? empty : seen(0)); // an unconfirmed payment, flapping
  assert.ok(a.unsavedChanges() <= 3, `bounded: ${a.unsavedChanges()}`);
  assert.equal(a.loadOrders()[0].btc.txid, TXID);
  assert.equal(a.loadOrders()[0].btc.missing, undefined, 'a flapping answer is not "missing"');
  for (let i = 0; i < 5; i++) await look(empty);
  assert.equal(a.loadOrders()[0].btc.missing, undefined, 'never "missing" while storage refuses writes');
  h.unblock();
  await a.patchOrder(x.id, {});
  const now = Date.now();
  for (const dt of [0, 30_000, 60_000]) await look(empty, now + dt);
  assert.equal(h.read().btc.missing, undefined, 'three quick empty answers are not enough (several tabs, one lagging backend)');
  await look(empty, now + orderState.BTC_EMPTY_SPAN_MS + 1);
  assert.equal(h.read().btc.missing, true, 'empty answers in a row over two minutes, once storage works');
  assert.equal(h.read().btc.txid, TXID);
  // Confirmations climbing during an outage: the first confirmation is recorded, the count is not.
  const y = h.tab();
  const lookY = trackerLook(y, x.id);
  h.block();
  await y.patchOrder(x.id, { notify: false });
  for (let c = 0; c <= 30; c++) await lookY(seen(c));
  assert.ok(y.unsavedChanges() <= 3, `bounded: ${y.unsavedChanges()}`);
  assert.equal(y.loadOrders()[0].btc.confirmed, true);
});

test('a refused save that carried nothing is noticed as fixed by the next poll, or by the retry', async () => {
  // Review 8, Low 2: a refused payment claim or new-order save sets "not saving" without carrying a change.
  const x = { ...order(), statusTimes: { awaiting_deposit: Date.now() - 1000 }, lastPolledAt: Date.now() - 1000 };
  const h = harness(x);
  const a = h.tab();
  h.block();
  await assert.rejects(a.claimPayment(x.id, owner), /Could not save the payment attempt/);
  assert.equal(a.storageFailing(), true);
  h.unblock();
  assert.equal(await a.applyStatusUpdate(x.id, { status: 'awaiting_deposit', rawStatus: 'awaiting_deposit', amountOut: null }), 'unchanged');
  assert.equal(a.storageFailing(), false, 'a poll that changed nothing noticed it');
  assert.ok(await a.claimPayment(x.id, owner), 'the payment can be claimed again without a refresh');
  const h2 = harness(order());
  const b = h2.tab();
  h2.block();
  assert.equal(await b.upsertOrder(order(), { keepOnFailure: false }), 'failed');
  assert.equal(h2.timers.length, 1, 'a retry is set although nothing is carried');
  h2.unblock();
  await h2.runTimers();
  assert.equal(b.storageFailing(), false);
  assert.equal(b.orderStorageProblem(), null, 'a new order can be made again');
});

test('a Bitcoin payment seen again during an outage clears the empty count, so one late empty answer is not "missing"', async () => {
  // Review 8, Low 1: the stored count of 2 outlived a sighting the page could not record.
  const TXID = 'cd'.repeat(32);
  const x = {
    ...order(), sourceChain: 'bitcoin', token: { symbol: 'BTC', decimals: 8, asset: 'bitcoin.btc' }, fromAmount: '0.001', fromAmountRaw: '100000',
    depositAddress: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', route: [{ venue: 'garden', from: 'bitcoin.btc', to: 'base.cbbtc' }],
    statusTimes: { awaiting_deposit: Date.now() - 1000 }, lastPolledAt: Date.now() - 1000,
    btc: { txid: TXID, confirmations: 0, firstSeenAt: Date.now() - 600_000, totalSats: '100000', payments: 1, emptyChecks: 2 },
  };
  const h = harness(x);
  const a = h.tab();
  const look = trackerLook(a, x.id); // two empty answers in a row before the outage (emptyChecks: 2)
  h.block();
  await a.patchOrder(x.id, { notify: true }); // storage is now known to be failing
  await look({ payments: [{ txid: TXID, confirmations: 0 }], totalSats: 100_000n });
  assert.equal(a.loadOrders()[0].btc.emptyChecks, undefined, 'seen again: recorded');
  h.unblock();
  await a.applyStatusUpdate(x.id, { status: 'awaiting_deposit', rawStatus: 'awaiting_deposit', amountOut: null });
  assert.equal(a.storageFailing(), false);
  await look({ payments: [], totalSats: 0n });
  assert.equal(h.read().btc.emptyChecks, 1);
  assert.equal(h.read().btc.missing, undefined, 'one empty answer is not enough');
});

test('a "missing" change carried through an outage does not undo another tab\u2019s newer record of the payment', async () => {
  // Another audit, High 2: tab A's page-counted "missing", replayed after recovery, overwrote tab B's newer sighting.
  const TXID = 'ab'.repeat(32);
  const x = btcOrder({ btc: { txid: TXID, confirmations: 0, firstSeenAt: Date.now() - 600_000, totalSats: '100000', payments: 1 } });
  const h = harness(x);
  const a = h.tab({ own: true }), b = h.tab();
  const empty = { payments: [], totalSats: 0n };
  const lookA = trackerLook(a, x.id);
  a.blockMe();
  await a.patchOrder(x.id, { notify: true }); // tab A now knows its writes fail
  for (let i = 0; i < 4; i++) await lookA(empty);
  assert.equal(a.loadOrders()[0].btc.missing, undefined, 'tab A never decides "missing" while its writes fail');
  // Tab B, whose writes work, records a newer sighting: a second payment to the address.
  await trackerLook(b, x.id)({ payments: [{ txid: TXID, confirmations: 0 }, { txid: 'cd'.repeat(32), confirmations: 0 }], totalSats: 150_000n });
  assert.equal(h.read().btc.payments, 2);
  a.unblockMe();
  await a.patchOrder(x.id, {}); // tab A saves what it carried
  assert.equal(a.storageFailing(), false);
  assert.equal(h.read().btc.missing, undefined, 'B\u2019s newer record stands');
  assert.equal(h.read().btc.payments, 2);
});

test('a removal is checked again when applied, and never carried through an outage', async () => {
  // Round 2, High: a refused Dismiss, applied later by the 15 s retry, deleted an order that had been paid since.
  const x = btcOrder({ createdAt: Date.now() - 3 * 3600_000, btc: { emptyAt: Date.now() - 1000 } });
  const h = harness(x);
  const a = h.tab({ own: true }), b = h.tab();
  assert.equal(orderState.clearable(a.loadOrders()[0], Date.now()), true, 'abandoned: looked at well after its window');
  a.blockMe();
  assert.equal(await a.removeOrders([x.id], orderState.clearable), 'failed');
  assert.equal(a.unsavedChanges(), 0, 'not carried');
  assert.equal(a.loadOrders().length, 1, 'still shown');
  await trackerLook(b, x.id)({ payments: [{ txid: 'ab'.repeat(32), confirmations: 0 }], totalSats: 100_000n }); // B sees a payment
  a.unblockMe();
  await h.runTimers();
  await a.patchOrder(x.id, {});
  assert.equal(h.all().length, 1, 'the paid order is still there');
  assert.equal(await b.removeOrders([x.id], orderState.clearable), 'unchanged', 'and no longer removable');
  assert.equal(h.all().length, 1);
});

test('one damaged record never makes the others unreadable; a value that is not a list is kept aside', async () => {
  // Round 2, Low: a record whose token.address was an array made sanitizeOrder throw, and the next write wiped every order.
  const good = btcOrder();
  const bad = { ...order(), token: { symbol: 'X', decimals: 6, asset: 'base.0x1', address: ['0x1'] } };
  const h = harness([good, bad]);
  const t = h.tab();
  assert.deepEqual([...t.loadOrders()].map(o => o.id), [good.id]);
  assert.equal(await t.upsertOrder(order(), { keepOnFailure: false }), 'saved');
  assert.equal(h.all().length, 3, 'the good, the new, and the damaged record kept as it was');
  const odd = harness([]);
  odd.setRaw('{"not":"a list"}');
  const u = odd.tab();
  assert.equal(u.loadOrders().length, 0);
  assert.equal(odd.get('iaero.rift.orders.v1.unreadable'), '{"not":"a list"}', 'kept aside before anything is written');
});

test('a HyperCore transfer in doubt is re-posted only through a claim, and never after its window', async () => {
  // Round 2, Lows: "Pay again" cleared "unknown" before its claim; a signature could be posted after the window.
  const action = { destination: '0x1111111111111111111111111111111111111111', token: 'USDC:0x6d', amount: '1', time: 1000, r: '0x1', s: '0x2', v: 27 };
  const x = { ...order(), sourceChain: 'hyperliquid', token: { symbol: 'USDC', decimals: 8, asset: 'hyperliquid.usdc' }, fromAmountRaw: '100000000', hlAction: action, hlPostedAt: Date.now() - 60_000, payUnknown: true };
  const h = harness(x);
  const t = h.tab();
  assert.equal(orderState.payState(t.loadOrders()[0], Date.now()), 'unknown');
  assert.equal(await t.claimPayment(x.id, owner, { hlAction: action }), null, 'not an ordinary claim');
  const claimed = await t.claimPayment(x.id, owner, { hlAction: action }, o => o.hlAction?.r === action.r, { repost: true });
  assert.ok(claimed, 'a re-post claim');
  assert.equal(h.read().payUnknown, false);
  assert.ok(await t.beginHyperPost(x.id, claimed.payAttemptId, action));
  const late = harness({ ...x, createdAt: Date.now() - 11 * 60_000, payUnknown: false, payAttemptId: claimed.payAttemptId });
  assert.equal(await late.tab().beginHyperPost(x.id, claimed.payAttemptId, action), 'closed', 'not once the window has closed, and says so');
  assert.equal(late.read().hlPostedAt, x.hlPostedAt, 'nothing recorded as posted');
  // In doubt with no transfer ever saved (the page died at the prompt): a new signature, under a repost claim.
  const lost = harness({ ...x, hlAction: undefined, hlPostedAt: undefined });
  const lt = lost.tab();
  assert.equal(await lt.claimPayment(x.id, owner, { hlAction: undefined }), null, 'not an ordinary claim');
  assert.ok(await lt.claimPayment(x.id, owner, { hlAction: undefined }, o => !o.hlAction, { repost: true }), 'a repost claim may sign anew');
});

test('nothing is written while storage can\u2019t be read, even a value that can\u2019t be put aside', async () => {
  // Round 3, Low: a non-list value too big to copy aside was written over by the next save.
  const h = harness([]);
  h.setRaw('not json at all');
  h.refuseKey('iaero.rift.orders.v1.unreadable'); // too big to copy aside, while a small list still fits
  const full = h.tab();
  assert.equal(await full.upsertOrder(order(), { keepOnFailure: false }), 'failed');
  assert.equal(h.get('iaero.rift.orders.v1'), 'not json at all', 'never written over unseen');
  assert.equal(full.storageFailing(), true);
});

test('while storage can\u2019t be read, a change shows on the page and only real changes wait', async () => {
  // Round 4, Low: changes were carried without being shown (a Bitcoin payment seen kept the QR code up), and every
  // poll and retry piled up.
  const x = order();
  const h = harness(x);
  const t = h.tab();
  t.loadOrders(); // this page's view
  h.setRaw('garbled');
  h.refuseKey('iaero.rift.orders.v1.unreadable');
  assert.equal(await t.patchOrder(x.id, { notify: true }), 'failed');
  assert.equal(t.loadOrders()[0]?.notify, true, 'shown on this page');
  for (let i = 0; i < 20; i++) { await t.patchOrder(x.id, { notify: true }); await h.runTimers(); }
  assert.equal(t.unsavedChanges(), 1, 'no-ops and retries are not carried');
  assert.equal(h.get('iaero.rift.orders.v1'), 'garbled', 'and nothing is written over it');
});

test('Rift expiring an order settles nothing about a payment in doubt', async () => {
  // Round 4, Medium: "expired" cleared payUnknown, and a hash that never landed then read as "a payment was sent".
  const x = { ...order(), payUnknown: true, depositTxHash: HASH, depositSentAt: Date.now() - 600_000, statusTimes: { awaiting_deposit: Date.now() - 1000 } };
  const h = harness(x);
  const t = h.tab();
  await t.applyStatusUpdate(x.id, { status: 'expired', rawStatus: 'expired', amountOut: null });
  assert.equal(h.read().payUnknown, true, 'still in doubt');
  assert.equal(orderState.paidButExpired(h.read(), Date.now()), false, 'not "a payment was sent"');
  const funded = harness({ ...x });
  await funded.tab().applyStatusUpdate(x.id, { status: 'funded', rawStatus: 'funded', amountOut: null });
  assert.equal(funded.read().payUnknown, false, 'a deposit Rift saw settles it');
});

test('every HyperCore transfer signed for an order uses one nonce, fixed at its first claim', async () => {
  // Round 4, suspected: a refused first post let a new signature follow; with one nonce, at most one can execute.
  const x = { ...order(), sourceChain: 'hyperliquid', token: { symbol: 'USDC', decimals: 8, asset: 'hyperliquid.usdc' }, fromAmountRaw: '100000000' };
  const h = harness(x);
  const t = h.tab();
  const first = await t.claimPayment(x.id, owner, { hlAction: undefined });
  assert.equal(typeof first.hlNonce, 'number');
  await t.patchPaymentAttempt(x.id, first.payAttemptId, { payRequestedAt: undefined, depositFailed: true, depositFailReason: 'cancelled' });
  const second = await t.claimPayment(x.id, owner, { hlAction: undefined });
  assert.equal(second.hlNonce, first.hlNonce, 'kept');
  // A transfer Rift already has a payment for is never posted ('paid'), nor one past its window ('closed').
  const action = { destination: x.depositAddress, token: 'USDC:0x6d', amount: '1', time: second.hlNonce, r: '0x1', s: '0x2', v: 27 };
  await t.patchPaymentAttempt(x.id, second.payAttemptId, { hlAction: action });
  await t.applyStatusUpdate(x.id, { status: 'funded', rawStatus: 'funded', amountOut: null });
  assert.equal(await t.beginHyperPost(x.id, second.payAttemptId, action), 'paid');
  assert.equal(h.read().hlPostedAt, undefined);
});

test('poll stamps hold while storage refuses writes', () => {
  const h = harness(order());
  const a = h.tab();
  h.block();
  a.markPolled('abc', Date.now());
  assert.equal(a.polledWithin('abc', 60_000), true, 'this page\u2019s own stamp counts');
});

test('a refused lock says nothing was sent, whatever the browser\u2019s own message', async () => {
  const h = harness(order(), { lockRejects: true, lockError: new Error('The request was aborted.') });
  await assert.rejects(h.tab().claimPayment(h.read().id, owner), /Could not coordinate this payment across tabs\. Nothing was sent/);
});

test('two tabs creating orders at once keep both; without Web Locks nothing is written; newer records are kept', async () => {
  // Another audit, High 1: without the lock, a Bitcoin order was saved unlocked and another tab's write dropped it.
  const h0 = harness([]);
  const [x, y] = [btcOrder(), btcOrder()];
  assert.deepEqual(await Promise.all([h0.tab().upsertOrder(x, { keepOnFailure: false }), h0.tab().upsertOrder(y, { keepOnFailure: false })]), ['saved', 'saved']);
  assert.deepEqual(h0.all().map(o => o.id).sort(), [x.id, y.id].sort());
  const bare = harness([], { locksAvailable: false });
  const noLocks = bare.tab();
  assert.match(noLocks.orderStorageProblem(), /Web Locks/, 'a Bitcoin order is refused too');
  assert.equal(await noLocks.upsertOrder(btcOrder(), { keepOnFailure: false }), 'failed');
  assert.equal(bare.all().length, 0, 'nothing written without the lock');
  const blocked = harness(order());
  blocked.block();
  assert.match(blocked.tab().orderStorageProblem(), /storage is full or blocked/);
  const newer = Array.from({ length: 14 }, () => ({ id: randomUUID(), schema: 'v99' }));
  const h = harness([order(), ...newer]);
  const t = h.tab();
  await t.patchOrder(h.read().id, { notify: true });
  assert.equal(h.all().filter(r => r.schema === 'v99').length, 14);
});
