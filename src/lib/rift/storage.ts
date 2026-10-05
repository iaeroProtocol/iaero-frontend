// src/lib/rift/storage.ts
//
// Orders live in this browser's localStorage, so progress survives a refresh, a closed tab or a crash.
// - Every change is a read-modify-write of the whole list, run under a Web Lock shared by all tabs of the
//   site, so two tabs writing at once cannot undo each other's changes (without the lock, a stress test lost
//   182 of 600 updates). Changes therefore apply asynchronously; await the returned promise when the next step
//   reads the result.
// - A copy is also kept in memory: if storage is full or blocked, existing orders and payment updates stay
//   tracked on this page and the page says so. A newly created order is refused before payment if it cannot be
//   saved. Unsaved changes are applied again on top of what storage holds now, on every read and write, until a
//   save succeeds: a write never starts from an old copy, so a failed save cannot undo another tab's payment.
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
/** At most this many unreadable records (written by a newer version, or damaged) are carried along. */
const MAX_FOREIGN = 100;
/** Polls refresh `lastPolledAt` at most this often, so an unchanged status does not rewrite storage. */
const POLL_STAMP_MS = 30_000;
/** A status first seen after a gap this long was not watched live: its time is not when it happened. */
const LATE_AFTER_MS = 150_000;
const PROBE_KEY = 'iaero.rift.probe';

type Change = (list: StoredOrder[]) => StoredOrder[] | null;

let memory: StoredOrder[] | null = null;
let foreign: unknown[] = [];
let writeFailed = false;
/** Changes this page could not save, in order (storage full or blocked). Every one is kept: a later change is
 *  computed on top of the earlier ones, so dropping one could lose what it recorded (a payment seen, a hash). The
 *  list stays small because changes that record nothing new are not made while storage is failing (a poll that
 *  only stamps its time, a Bitcoin look that only moves a counter) or are no-ops (an observation that matches
 *  what is shown). */
let unsaved: Change[] = [];
/** While storage refuses writes (with changes carried or not: a refused payment claim or new order carries none),
 *  saving is tried again this often, so the page notices storage working again even when nothing else writes. */
const RETRY_SAVE_MS = 15_000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function retryLater() {
  if (retryTimer !== undefined || (!unsaved.length && !writeFailed) || typeof setTimeout !== 'function') return;
  retryTimer = setTimeout(() => { retryTimer = undefined; void mutate(() => null); }, RETRY_SAVE_MS);
}

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

/** What storage holds, with this page's unsaved changes applied again; null if storage can't be read. */
function current(): StoredOrder[] | null {
  const stored = readStorage();
  if (!stored) return null;
  let list = stored;
  for (const c of unsaved) list = c(list) ?? list;
  return list;
}

export function loadOrders(): StoredOrder[] {
  const list = current();
  if (list) memory = list;
  return memory ?? [];
}

/** True while this browser is not saving orders (storage full or blocked). */
export const storageFailing = () => writeFailed;
/** How many refused changes this page is carrying (diagnostics and tests). */
export const unsavedChanges = () => unsaved.length;

/** Why this browser can't keep an order, or null: a new order must be saved before its payment instructions are
 *  shown (a Bitcoin order, paid from another wallet, needs nothing more). */
export function orderStorageProblem(): string | null {
  if (writeFailed) return 'This browser isn’t saving orders right now (its storage is full or blocked). Refresh after fixing it.';
  try {
    window.localStorage.setItem(PROBE_KEY, '1');
    window.localStorage.removeItem(PROBE_KEY);
  } catch {
    return 'This browser’s storage is full or blocked, so orders can’t be tracked safely. Allow site storage and refresh.';
  }
  return null;
}

/** Why this browser cannot pay orders safely, or null. Payments also need Web Locks (tabs agree on who opens the
 *  wallet; the claim is saved before the wallet is asked). */
export function paymentStorageProblem(): string | null {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    return 'This browser can’t coordinate payments between tabs (it has no Web Locks). Use an up-to-date browser.';
  }
  return orderStorageProblem();
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
  return !writeFailed;
}

/** What a change came to: written, nothing to write, or not written (storage refused it, or the lock could
 *  not be had). */
export type WriteResult = 'saved' | 'unchanged' | 'failed';

/** Read, change and save the list under the cross-tab lock. `change` returns null for "nothing to save".
 *  The change is applied to what storage holds now (with this page's unsaved changes); this page's copy is used
 *  only when storage can't be read. */
function mutate(change: Change, { keepOnFailure = true }: { keepOnFailure?: boolean } = {}): Promise<WriteResult> {
  const run = (): WriteResult => {
    const stored = current();
    const base = stored ?? memory ?? [];
    const next = change(base);
    if (!next) {
      memory = base;
      // Nothing new, but storage refused an earlier write: save again, over what storage holds now (never over
      // this page's copy alone), with any changes this page carries. While storage fails, a poll that only stamps
      // its time changes nothing, so this is how the page notices storage working again, before a refresh could
      // drop what it carries.
      if (stored && (unsaved.length || writeFailed)) {
        if (saveOrders(base)) {
          unsaved = [];
          window.dispatchEvent(new Event(EVENT));
        } else retryLater();
      }
      return 'unchanged';
    }
    if (saveOrders(next)) {
      unsaved = [];
      window.dispatchEvent(new Event(EVENT));
      return 'saved';
    }
    if (!keepOnFailure) {
      // A new order must not expose payment instructions if it would disappear on reload. Keep this page's
      // earlier unsaved changes, but discard this failed insertion from its view.
      memory = base;
      retryLater();
      window.dispatchEvent(new Event(EVENT));
      return 'failed';
    }
    // Kept for this page's lifetime, and cleared by the next successful save.
    unsaved.push(change);
    retryLater();
    window.dispatchEvent(new Event(EVENT));
    return 'failed';
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) return Promise.resolve(run());
  // Without the lock nothing is written: an unlocked write could undo a payment claim made in another tab.
  return locks.request(LOCK, run).then(r => r, (): WriteResult => 'failed');
}

/** A new order first. An order already stored under the same id keeps what this browser learned about it. */
export function upsertOrder(order: StoredOrder, opts: { keepOnFailure?: boolean } = {}): Promise<WriteResult> {
  return mutate(list => {
    const prev = list.find(o => o.id === order.id);
    return [prev ? { ...order, ...prev } : order, ...list.filter(o => o.id !== order.id)];
  }, opts);
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

/** A refusal raised here, whose message already says that nothing was sent. */
class ClaimRefused extends Error {}

/** Claim a payment under the cross-tab Web Lock before opening a wallet prompt. A payment requires durable
 *  storage: if Web Locks or localStorage are unavailable, two tabs cannot safely agree who owns the prompt.
 *  `expect`: what the stored order must still be like (compare-and-set), or there is no claim. */
export async function claimPayment(
  id: string, owner: string, extra: Partial<StoredOrder> = {}, expect?: (stored: StoredOrder) => boolean,
): Promise<StoredOrder | null> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks?.request) throw new Error('This browser cannot safely coordinate payments across tabs. Use a browser with Web Locks support.');
  try {
    return await locks.request(LOCK, () => {
      if (writeFailed) throw new ClaimRefused('Browser storage is not saving orders. Nothing was sent; refresh this page after fixing storage.');
      const list = readStorage();
      if (!list) throw new ClaimRefused('Could not read saved orders. Nothing was sent; enable browser storage and try again.');
      memory = list;
      const i = list.findIndex(o => o.id === id);
      if (i < 0) return null;
      const prev = list[i];
      if (prev.toAddress.toLowerCase() !== owner.toLowerCase() || !canPay(prev, sourceKindOf(prev.sourceChain), Date.now())) return null;
      if (expect && !expect(prev)) return null;
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
        retryLater();
        window.dispatchEvent(new Event(EVENT));
        throw new ClaimRefused('Could not save the payment attempt. Nothing was sent; enable browser storage and try again.');
      }
      window.dispatchEvent(new Event(EVENT));
      return attempt;
    });
  } catch (e) {
    // A failed lock request must never fall back to an unlocked payment, and the browser's own message ("The
    // request was aborted.") would not say that nothing was sent.
    throw e instanceof ClaimRefused ? e : new Error('Could not coordinate this payment across tabs. Nothing was sent; try again in a moment.');
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

/** Just before a HyperCore transfer is posted, under the lock: null unless this attempt is still the order's
 *  current one with exactly this saved transfer. Records that it is being posted, and says whether it was posted
 *  before: a refusal of a transfer posted before does not show that nothing moved (the first post may have gone
 *  through). */
export async function beginHyperPost(id: string, attemptId: string, action: { time: number; r: string }): Promise<{ postedBefore: boolean } | null> {
  let holds = false, postedBefore = false;
  const r = await patchOrder(id, prev => {
    holds = prev.payAttemptId === attemptId && prev.hlAction?.time === action.time && prev.hlAction.r === action.r;
    postedBefore = prev.hlPostedAt !== undefined;
    return holds ? { hlPostedAt: prev.hlPostedAt ?? Date.now() } : {};
  });
  return holds && r !== 'failed' ? { postedBefore } : null;
}

/** This page's latest poll of each order. Polls that only stamp their time are not saved while storage refuses
 *  writes, so `lastPolledAt` alone would make a status first seen after a long outage look noticed late. */
const pagePolledAt = new Map<string, number>();

/** Record a status poll: the status, when it was first seen (and whether that was live), the amount out. */
export function applyStatusUpdate(id: string, u: OrderUpdate, now = Date.now()): Promise<WriteResult> {
  markPolled(id, now);
  const pagePolled = pagePolledAt.get(id);
  pagePolledAt.set(id, Math.max(pagePolled ?? 0, now));
  return patchOrder(id, prev => {
    // While storage refuses writes, a poll that only stamps its time records nothing worth carrying (see unsaved).
    const stamp = writeFailed ? prev.lastPolledAt : !prev.lastPolledAt || now - prev.lastPolledAt > POLL_STAMP_MS ? now : prev.lastPolledAt;
    if (!u.status) return { rawStatus: u.rawStatus, lastPolledAt: stamp };
    // An answer older than what is stored (two pollers, out of order): keep the newer status.
    if (!canMoveTo(prev.status, u.status)) return { lastPolledAt: stamp };
    const isNew = !prev.statusTimes[u.status];
    // Not watched live: no poll before (orders saved by older versions), or a long gap since the last one.
    const polledBefore = Math.max(prev.lastPolledAt ?? 0, pagePolled ?? 0);
    const late = isNew && (!polledBefore || now - polledBefore > LATE_AFTER_MS);
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

/** This page's own stamps, kept too: while storage refuses writes, the stored ones go stale. */
const polledHere: Record<string, number> = {};

function readPolled(): Record<string, number> {
  let stored: Record<string, number> = {};
  try { stored = JSON.parse(window.localStorage.getItem(POLLED_KEY) ?? '{}') ?? {}; } catch { /* this page's own */ }
  const out = { ...stored };
  for (const [k, t] of Object.entries(polledHere)) if (!(out[k] >= t)) out[k] = t;
  return out;
}

/** Snapshot used to serve the least recently polled orders first when Rift's budget is tight. */
export const pollStamps = () => readPolled();

export function markPolled(id: string, now = Date.now()) {
  polledHere[id] = Math.max(polledHere[id] ?? 0, now);
  for (const k of Object.keys(polledHere)) if (now - polledHere[k] > 3600_000) delete polledHere[k];
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
