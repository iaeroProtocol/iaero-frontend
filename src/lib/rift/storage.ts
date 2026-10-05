// src/lib/rift/storage.ts
//
// Orders live in this browser's localStorage, so progress survives a refresh, a closed tab or a crash.
// - Every change is a read-modify-write of the whole list, run under a Web Lock shared by all tabs of the
//   site, so two tabs writing at once cannot undo each other's changes (without the lock, a stress test lost
//   182 of 600 updates). Changes therefore apply asynchronously; await the returned promise when the next step
//   reads the result.
// - A copy is also kept in memory: if storage is full or blocked, the order stays tracked on this page and
//   the page says so, instead of the order disappearing. A write always starts from what storage holds now,
//   never from that copy, so a tab whose save failed cannot undo another tab's payment record.
// - Saved records are checked one by one (order-state.ts). Ones this version cannot read (written by a newer
//   version, or damaged) are kept as they are, not erased by the next write.

'use client';

import { useCallback, useEffect, useState } from 'react';
import { canMoveTo, canPay, capOrders, sanitizeOrder, sourceKindOf } from './order-state';
import { ORDERS_KEY } from './keys';
import type { OrderUpdate } from './validate';
import type { StoredOrder } from './types';

const KEY = ORDERS_KEY;
const LOCK = 'iaero-rift-orders';
const EVENT = 'iaero-rift-orders';
const MAX_ORDERS = 25;
/** At most this many unreadable records are carried along. */
const MAX_FOREIGN = 10;
/** Polls refresh `lastPolledAt` at most this often, so an unchanged status does not rewrite storage. */
const POLL_STAMP_MS = 30_000;
/** A status first seen after a gap this long was not watched live: its time is not when it happened. */
const LATE_AFTER_MS = 150_000;
const PROBE_KEY = 'iaero.rift.probe';

let memory: StoredOrder[] | null = null;
let foreign: unknown[] = [];
let writeFailed = false;

function readStorage(): StoredOrder[] | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    const orders: StoredOrder[] = [];
    const others: unknown[] = [];
    for (const x of Array.isArray(list) ? list : []) {
      const o = sanitizeOrder(x);
      if (o) orders.push(o); else others.push(x);
    }
    foreign = others.slice(0, MAX_FOREIGN);
    return orders;
  } catch {
    return null;
  }
}

export function loadOrders(): StoredOrder[] {
  // After a failed write, this page shows its own copy, which has what storage could not take.
  if (writeFailed && memory) return memory;
  const stored = readStorage();
  if (stored) memory = stored;
  return memory ?? [];
}

/** True while this browser is not saving orders (storage full or blocked). */
export const storageFailing = () => writeFailed;

/** Why this browser cannot pay orders safely, or null. Payments need Web Locks (tabs agree on who opens the
 *  wallet) and storage that takes writes (the claim is saved before the wallet is asked). */
export function paymentStorageProblem(): string | null {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    return 'This browser can’t coordinate payments between tabs (it has no Web Locks). Use an up-to-date browser.';
  }
  if (writeFailed) return 'This browser isn’t saving orders right now (its storage is full or blocked). Refresh after fixing it.';
  try {
    window.localStorage.setItem(PROBE_KEY, '1');
    window.localStorage.removeItem(PROBE_KEY);
  } catch {
    return 'This browser’s storage is full or blocked, so orders can’t be tracked safely. Allow site storage and refresh.';
  }
  return null;
}

/** Ids of saved records this version cannot show (written by a newer version, or damaged). */
export function unreadableOrderIds(): string[] {
  return foreign
    .map(x => (x && typeof x === 'object' ? (x as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id));
}

function saveOrders(list: StoredOrder[]): boolean {
  const capped = capOrders(list, MAX_ORDERS, Date.now());
  memory = capped;
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...capped, ...foreign]));
    writeFailed = false;
  } catch {
    writeFailed = true;
  }
  window.dispatchEvent(new Event(EVENT));
  return !writeFailed;
}

/** What a change came to: written, nothing to write, or not written (storage refused it, or the lock could
 *  not be had). */
export type WriteResult = 'saved' | 'unchanged' | 'failed';

/** Read, change and save the list under the cross-tab lock. `change` returns null for "nothing to save".
 *  The change is applied to what storage holds now; this page's copy is used only when storage can't be read. */
function mutate(change: (list: StoredOrder[]) => StoredOrder[] | null): Promise<WriteResult> {
  const run = (): WriteResult => {
    const stored = readStorage();
    const next = change(stored ?? memory ?? []);
    if (!next) {
      if (stored && !writeFailed) memory = stored;
      return 'unchanged';
    }
    return saveOrders(next) ? 'saved' : 'failed';
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return Promise.resolve(run());
  // Without the lock nothing is written: an unlocked write could undo a payment claim made in another tab.
  return locks.request(LOCK, run).then(r => r, (): WriteResult => 'failed');
}

/** A new order first. An order already stored under the same id keeps what this browser learned about it. */
export function upsertOrder(order: StoredOrder): Promise<WriteResult> {
  return mutate(list => {
    const prev = list.find(o => o.id === order.id);
    return [prev ? { ...order, ...prev } : order, ...list.filter(o => o.id !== order.id)];
  });
}

/** Change one order. Nothing is written when nothing changes, and statuses only move forward (a late poll
 *  from another tab can land after a newer one): order-state.ts canMoveTo. */
export function patchOrder(id: string, patch: Partial<StoredOrder> | ((o: StoredOrder) => Partial<StoredOrder>)): Promise<WriteResult> {
  return mutate(list => {
    const i = list.findIndex(o => o.id === id);
    if (i < 0) return null;
    const prev = list[i];
    const p = { ...(typeof patch === 'function' ? patch(prev) : patch) };
    if (p.status && !canMoveTo(prev.status, p.status)) delete p.status;
    const next = { ...prev, ...p };
    if (JSON.stringify(next) === JSON.stringify(prev)) return null;
    const copy = list.slice();
    copy[i] = next;
    return copy;
  });
}

/** Claim a payment under the cross-tab Web Lock before opening a wallet prompt. A payment requires durable
 *  storage: if Web Locks or localStorage are unavailable, two tabs cannot safely agree who owns the prompt. */
export async function claimPayment(id: string, owner: string, extra: Partial<StoredOrder> = {}): Promise<StoredOrder | null> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) throw new Error('This browser cannot safely coordinate payments across tabs. Use a browser with Web Locks support.');
  try {
    return await locks.request(LOCK, () => {
      if (writeFailed) throw new Error('Browser storage is not saving orders. Nothing was sent; refresh this page after fixing storage.');
      const list = readStorage();
      if (!list) throw new Error('Could not read saved orders. Nothing was sent; enable browser storage and try again.');
      memory = list;
      const i = list.findIndex(o => o.id === id);
      if (i < 0) return null;
      const prev = list[i];
      if (prev.toAddress.toLowerCase() !== owner.toLowerCase() || !canPay(prev, sourceKindOf(prev.sourceChain), Date.now())) return null;
      const attempt: StoredOrder = {
        ...prev,
        payRequestedAt: Date.now(), payAttemptAt: Date.now(), payAttemptId: crypto.randomUUID(), payUnknown: false,
        depositFailed: false, depositFailReason: undefined, depositTxHash: undefined, depositNonce: undefined,
        depositSentAt: undefined, depositConfirmedAt: undefined, depositReceivedRaw: undefined, startEstimated: undefined,
        pastTxHashes: prev.depositTxHash ? [...(prev.pastTxHashes ?? []), prev.depositTxHash].slice(-5) : prev.pastTxHashes,
        ...extra,
      };
      const next = list.slice();
      next[i] = attempt;
      if (!saveOrders(next)) {
        memory = list;
        window.dispatchEvent(new Event(EVENT));
        throw new Error('Could not save the payment attempt. Nothing was sent; enable browser storage and try again.');
      }
      return attempt;
    });
  } catch (e) {
    // A failed lock request must never fall back to an unlocked payment.
    throw e instanceof Error ? e : new Error('Could not coordinate this payment across tabs. Nothing was sent.');
  }
}

/** What became of a change to one payment attempt: also `superseded` (another tab started a newer attempt)
 *  and `missing` (the order is no longer in this browser). */
export type AttemptWrite = WriteResult | 'superseded' | 'missing';

/** A late wallet response or heartbeat must not change a newer attempt from another tab. */
export async function patchPaymentAttempt(id: string, attemptId: string, patch: Partial<StoredOrder> | ((o: StoredOrder) => Partial<StoredOrder>)): Promise<AttemptWrite> {
  let found = 'missing' as 'current' | 'superseded' | 'missing';
  const r = await patchOrder(id, prev => {
    if (prev.payAttemptId !== attemptId) { found = 'superseded'; return {}; }
    found = 'current';
    return typeof patch === 'function' ? patch(prev) : patch;
  });
  return r === 'failed' || found === 'current' ? r : found;
}

/** Just before a HyperCore transfer is posted, under the lock: whether this attempt is still the order's
 *  current one with exactly this saved transfer. Records that it is being posted, so a later refusal of the same
 *  transfer is not taken to mean that nothing moved (the first post may have gone through). */
export async function beginHyperPost(id: string, attemptId: string, action: { time: number; r: string }): Promise<boolean> {
  let current = false;
  const r = await patchOrder(id, prev => {
    current = prev.payAttemptId === attemptId && prev.hlAction?.time === action.time && prev.hlAction.r === action.r;
    return current ? { hlPostedAt: prev.hlPostedAt ?? Date.now() } : {};
  });
  return current && r !== 'failed';
}

/** Record a status poll: the status, when it was first seen (and whether that was live), the amount out. */
export function applyStatusUpdate(id: string, u: OrderUpdate, now = Date.now()): Promise<WriteResult> {
  markPolled(id, now);
  return patchOrder(id, prev => {
    const stamp = !prev.lastPolledAt || now - prev.lastPolledAt > POLL_STAMP_MS ? now : prev.lastPolledAt;
    if (!u.status) return { rawStatus: u.rawStatus, lastPolledAt: stamp };
    // An answer older than what is stored (two pollers, out of order): keep the newer status.
    if (!canMoveTo(prev.status, u.status)) return { lastPolledAt: stamp };
    const isNew = !prev.statusTimes[u.status];
    // Not watched live: no poll before (orders saved by older versions), or a long gap since the last one.
    const late = isNew && (!prev.lastPolledAt || now - prev.lastPolledAt > LATE_AFTER_MS);
    return {
      status: u.status,
      rawStatus: undefined,
      amountOut: u.amountOut ?? prev.amountOut,
      statusTimes: isNew ? { ...prev.statusTimes, [u.status]: now } : prev.statusTimes,
      statusLate: late ? { ...prev.statusLate, [u.status]: true } : prev.statusLate,
      lastPolledAt: isNew ? now : stamp,
      // Rift has seen a deposit: whether the last payment attempt went out is no longer in doubt.
      ...(u.status !== 'awaiting_deposit' ? { payUnknown: false, payRequestedAt: undefined } : {}),
    };
  });
}

export function removeOrders(ids: string[]): Promise<WriteResult> {
  return mutate(list => (list.some(o => ids.includes(o.id)) ? list.filter(o => !ids.includes(o.id)) : null));
}

// --- Poll stamps: when any tab last asked Rift about an order, so tabs and pollers do not repeat each other ---

const POLLED_KEY = 'iaero.rift.polled.v1';

function readPolled(): Record<string, number> {
  try { return JSON.parse(window.localStorage.getItem(POLLED_KEY) ?? '{}') ?? {}; } catch { return {}; }
}

/** Snapshot used to serve the least recently polled orders first when Rift's budget is tight. */
export const pollStamps = () => readPolled();

export function markPolled(id: string, now = Date.now()) {
  try {
    const m = readPolled();
    m[id] = now;
    // Only recent stamps matter.
    for (const k of Object.keys(m)) if (now - m[k] > 3600_000) delete m[k];
    window.localStorage.setItem(POLLED_KEY, JSON.stringify(m));
  } catch { /* storage blocked: each tab polls for itself */ }
}

/** Whether any tab polled this order less than `withinMs` ago. */
export function polledWithin(id: string, withinMs: number, now = Date.now()): boolean {
  const t = readPolled()[id];
  return typeof t === 'number' && now - t >= 0 && now - t < withinMs;
}

/** Live view of stored orders, across components and tabs. */
export function useStoredOrders(): StoredOrder[] {
  const [orders, setOrders] = useState<StoredOrder[]>([]);
  const refresh = useCallback(() => setOrders(loadOrders()), []);
  useEffect(() => {
    refresh();
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) refresh(); };
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, [refresh]);
  return orders;
}
