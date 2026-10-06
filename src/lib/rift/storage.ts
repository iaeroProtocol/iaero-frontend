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
import { canMoveTo, canPay, canRetryUnknown, capOrders, payWindowOpen, sanitizeOrder, sourceKindOf } from './order-state';
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
 *  what is shown). The one exception: a status poll that didn't move its order's status (a status this page
 *  doesn't know, set or cleared) is replaced by that order's next poll, so a flipping answer can't pile up.
 *  `poll`: the order such a poll is about. */
type Carried = { change: Change; poll?: string };
let unsaved: Carried[] = [];
/** Carry a change that couldn't be saved. `poll`: it is a status poll of this order, which supersedes the order's
 *  carried polls that didn't move its status; one that didn't move it either is superseded in turn. */
function carry(change: Change, before: StoredOrder[], after: StoredOrder[], poll?: string) {
  if (poll) unsaved = unsaved.filter(u => u.poll !== poll);
  const moved = poll !== undefined && before.find(o => o.id === poll)?.status !== after.find(o => o.id === poll)?.status;
  unsaved.push({ change, poll: poll !== undefined && !moved ? poll : undefined });
}
/** While storage refuses writes (with changes carried or not: a refused payment claim or new order carries none),
 *  saving is tried again this often, so the page notices storage working again even when nothing else writes. */
const RETRY_SAVE_MS = 15_000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function retryLater() {
  if (retryTimer !== undefined || (!unsaved.length && !writeFailed) || typeof setTimeout !== 'function') return;
  retryTimer = setTimeout(() => { retryTimer = undefined; void mutate(() => null); }, RETRY_SAVE_MS);
}

/** What storage holds, or null if it can't be read. One damaged record is set aside on its own (unreadableOrderIds);
 *  a value that isn't a list at all is copied to `<key>.unreadable` first, never written over unseen. */
function readStorage(): StoredOrder[] | null {
  let raw: string | null;
  try { raw = window.localStorage.getItem(KEY); } catch { return null; }
  let list: unknown = [];
  if (raw) {
    try { list = JSON.parse(raw); } catch { list = null; }
    if (!Array.isArray(list)) {
      try { window.localStorage.setItem(`${KEY}.unreadable`, raw); } catch { return null; }
      list = [];
    }
  }
  const orders: StoredOrder[] = [];
  const others: unknown[] = [];
  for (const x of list as unknown[]) {
    let o: StoredOrder | null = null;
    try { o = sanitizeOrder(x); } catch { /* damaged: kept aside, as it is */ }
    if (o) orders.push(o); else others.push(x);
  }
  foreign = others.slice(0, MAX_FOREIGN);
  return orders;
}

/** What storage holds, with this page's unsaved changes applied again; null if storage can't be read. */
function current(): StoredOrder[] | null {
  const stored = readStorage();
  if (!stored) return null;
  let list = stored;
  for (const c of unsaved) list = c.change(list) ?? list;
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

/** Why this browser can't keep an order, or null. Every order is written under a cross-tab Web Lock: without
 *  one, another tab's write could drop it (a Bitcoin order too, whose deposit address would then be lost). A new
 *  order must also be saved before its payment instructions are shown, or a payment claimed. */
export function orderStorageProblem(): string | null {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    return 'This browser can’t keep orders safely between tabs (it has no Web Locks). Use an up-to-date browser.';
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
  return !writeFailed;
}

/** What a change came to: written, nothing to write, or not written (storage refused it, or the lock could
 *  not be had). */
export type WriteResult = 'saved' | 'unchanged' | 'failed';

/** Read, change and save the list under the cross-tab lock. `change` returns null for "nothing to save".
 *  The change is applied to what storage holds now (with this page's unsaved changes); this page's copy is used
 *  only when storage can't be read. */
function mutate(change: Change, { keepOnFailure = true, poll }: { keepOnFailure?: boolean; poll?: string } = {}): Promise<WriteResult> {
  const run = (): WriteResult => {
    const stored = current();
    if (!stored) {
      // Storage can't be read: nothing is written over what it holds, unseen. A change that changes something is
      // shown on this page (over its last view) and waits, carried, for storage.
      const seen = change(memory ?? []);
      if (seen && keepOnFailure) { carry(change, memory ?? [], seen, poll); memory = seen; }
      writeFailed = true;
      retryLater();
      window.dispatchEvent(new Event(EVENT));
      return 'failed';
    }
    const base = stored;
    const next = change(base);
    if (!next) {
      memory = base;
      // Nothing new, but storage refused an earlier write: save again, over what storage holds now (never over
      // this page's copy alone), with any changes this page carries. While storage fails, a poll that only stamps
      // its time changes nothing, so this is how the page notices storage working again, before a refresh could
      // drop what it carries.
      if (unsaved.length || writeFailed) {
        if (stored && saveOrders(base)) {
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
    carry(change, base, next, poll);
    retryLater();
    window.dispatchEvent(new Event(EVENT));
    return 'failed';
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  // Without the lock nothing is written: an unlocked write could drop another tab's order or payment claim.
  if (!locks?.request) return Promise.resolve('failed');
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
export function patchOrder(
  id: string, patch: Partial<StoredOrder> | ((o: StoredOrder) => Partial<StoredOrder>), { poll = false }: { poll?: boolean } = {},
): Promise<WriteResult> {
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
  }, { poll: poll ? id : undefined });
}

/** A refusal raised here, whose message already says that nothing was sent. */
class ClaimRefused extends Error {}

/** Claim a payment under the cross-tab Web Lock before opening a wallet prompt. A payment requires durable
 *  storage: if Web Locks or localStorage are unavailable, two tabs cannot safely agree who owns the prompt.
 *  `expect`: what the stored order must still be like (compare-and-set), or there is no claim. */
export async function claimPayment(
  id: string, owner: string, extra: Partial<StoredOrder> = {}, expect?: (stored: StoredOrder) => boolean,
  { repost = false }: { repost?: boolean } = {},
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
      const now = Date.now();
      // `repost`: a HyperCore payment whose outcome is unknown, tried again (order-state.ts canRetryUnknown).
      const may = canPay(prev, sourceKindOf(prev.sourceChain), now) || (repost && canRetryUnknown(prev, now));
      if (prev.toAddress.toLowerCase() !== owner.toLowerCase() || !may) return null;
      if (expect && !expect(prev)) return null;
      const attempt: StoredOrder = {
        ...prev,
        payRequestedAt: Date.now(), payAttemptAt: Date.now(), payAttemptId: crypto.randomUUID(), payUnknown: false,
        depositFailed: false, depositFailReason: undefined, depositTxHash: undefined, depositNonce: undefined,
        depositSentAt: undefined, depositConfirmedAt: undefined, depositReceivedRaw: undefined, startEstimated: undefined,
        pastTxHashes: prev.depositTxHash ? [...(prev.pastTxHashes ?? []), prev.depositTxHash].slice(-5) : prev.pastTxHashes,
        // HyperCore: one nonce for every transfer signed for this order, fixed at its first claim (under this lock).
        ...(sourceKindOf(prev.sourceChain) === 'hypercore' ? { hlNonce: prev.hlNonce ?? prev.hlAction?.time ?? Date.now() } : {}),
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
export async function beginHyperPost(
  id: string, attemptId: string, action: { time: number; r: string },
): Promise<{ postedBefore: boolean } | 'closed' | 'paid' | null> {
  let holds = false, postedBefore = false, closed = false, paid = false;
  const r = await patchOrder(id, prev => {
    holds = prev.payAttemptId === attemptId && prev.hlAction?.time === action.time && prev.hlAction.r === action.r;
    postedBefore = prev.hlPostedAt !== undefined;
    // Rift already has a payment for it ('paid'); or its pay window has closed (a signature can come back from a
    // forgotten wallet prompt): never posted then.
    paid = holds && (prev.status !== 'awaiting_deposit' || !!prev.rawStatus);
    closed = holds && !paid && !payWindowOpen(prev, 'hypercore', Date.now());
    return holds && !closed && !paid ? { hlPostedAt: prev.hlPostedAt ?? Date.now() } : {};
  });
  if (paid) return 'paid';
  if (closed) return 'closed';
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
      // Rift has seen a deposit: whether the last payment attempt went out is no longer in doubt. Not on "expired":
      // Rift saw none, which settles nothing about a payment in doubt (it must not read as "a payment was sent").
      ...(u.status !== 'awaiting_deposit' && u.status !== 'expired' ? { payUnknown: false, payRequestedAt: undefined } : {}),
    };
  }, { poll: true });
}

/** Remove orders from this browser, each only if `canRemove` still holds for it when the change is applied (another
 *  tab may have recorded a payment since it was asked). Never carried through a storage outage: applied later, a
 *  removal could drop an order that has been paid in the meantime. */
export function removeOrders(ids: string[], canRemove: (o: StoredOrder, now: number) => boolean): Promise<WriteResult> {
  return mutate(list => {
    const now = Date.now();
    const next = list.filter(o => !(ids.includes(o.id) && canRemove(o, now)));
    return next.length === list.length ? null : next;
  }, { keepOnFailure: false });
}

// --- Poll stamps: when any tab last asked Rift about an order, so tabs and pollers do not repeat each other ---

const POLLED_KEY = 'iaero.rift.polled.v1';

/** This page's own stamps, kept too: while storage refuses writes, the stored ones go stale. */
const polledHere: Record<string, number> = {};

/** A stamp from the future (written while the clock ran ahead, then put back) is dropped: it would stop the tabs
 *  sharing polls and looks until the clock caught up. */
const fromFuture = (t: number, now: number) => t > now + 1000;

function readPolled(now = Date.now()): Record<string, number> {
  let stored: Record<string, unknown> = {};
  try { stored = JSON.parse(window.localStorage.getItem(POLLED_KEY) ?? '{}') ?? {}; } catch { /* this page's own */ }
  const out: Record<string, number> = {};
  for (const [k, t] of Object.entries(stored)) if (typeof t === 'number' && !fromFuture(t, now)) out[k] = t;
  for (const [k, t] of Object.entries(polledHere)) if (!fromFuture(t, now) && !(out[k] >= t)) out[k] = t;
  return out;
}

/** Snapshot used to serve the least recently polled orders first when Rift's budget is tight. */
export const pollStamps = () => readPolled();

export function markPolled(id: string, now = Date.now()) {
  const before = polledHere[id];
  polledHere[id] = before !== undefined && !fromFuture(before, now) ? Math.max(before, now) : now;
  for (const k of Object.keys(polledHere)) if (now - polledHere[k] > 3600_000 || fromFuture(polledHere[k], now)) delete polledHere[k];
  try {
    const m = readPolled(now);
    m[id] = now;
    // Only recent stamps matter.
    for (const k of Object.keys(m)) if (now - m[k] > 3600_000) delete m[k];
    window.localStorage.setItem(POLLED_KEY, JSON.stringify(m));
  } catch { /* storage blocked: each tab polls for itself */ }
}

/** Whether any tab polled this order less than `withinMs` ago. */
export function polledWithin(id: string, withinMs: number, now = Date.now()): boolean {
  const t = readPolled(now)[id];
  return typeof t === 'number' && now - t >= 0 && now - t < withinMs;
}

/** Live view of stored orders, across components and tabs. */
export function useStoredOrders(): StoredOrder[] {
  const [orders, setOrders] = useState<StoredOrder[]>([]);
  const refresh = useCallback(() => setOrders(loadOrders()), []);
  useEffect(() => {
    refresh();
    // Also when another tab clears all storage (key null), and when the page comes back from the browser's
    // back/forward cache: what it showed may be stale (a payment recorded meanwhile).
    const onStorage = (e: StorageEvent) => { if (e.key === KEY || e.key === null) refresh(); };
    const onShow = (e: PageTransitionEvent) => { if (e.persisted) refresh(); };
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pageshow', onShow);
    };
  }, [refresh]);
  return orders;
}

/** Try now to save what this page carries (storage working again: a refresh must not drop it). */
export const saveCarriedNow = () => mutate(() => null);
