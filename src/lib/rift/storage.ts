// src/lib/rift/storage.ts
//
// Orders live in this browser's localStorage, so progress survives a refresh, a closed tab or a crash.
// A copy is also kept in memory: if storage is full or blocked, the order stays tracked on this page and
// the page says so, instead of the order disappearing. Saved records are checked one by one (order-state.ts)
// and damaged ones are dropped rather than rendered.

'use client';

import { useCallback, useEffect, useState } from 'react';
import { capOrders, isTerminalStatus, sanitizeOrder } from './order-state';
import type { OrderUpdate } from './validate';
import type { StoredOrder } from './types';

const KEY = 'iaero.rift.orders.v1';
const EVENT = 'iaero-rift-orders';
const MAX_ORDERS = 25;
/** Polls refresh `lastPolledAt` at most this often, so an unchanged status does not rewrite storage. */
const POLL_STAMP_MS = 30_000;
/** A status first seen after a gap this long was not watched live: its time is not when it happened. */
const LATE_AFTER_MS = 150_000;

let memory: StoredOrder[] | null = null;
let writeFailed = false;

function readStorage(): StoredOrder[] | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list.map(sanitizeOrder).filter((o): o is StoredOrder => !!o);
  } catch {
    return null;
  }
}

export function loadOrders(): StoredOrder[] {
  // After a failed write, this page's copy is newer than what storage holds.
  if (writeFailed && memory) return memory;
  const stored = readStorage();
  if (stored) memory = stored;
  return memory ?? [];
}

/** True while this browser is not saving orders (storage full or blocked). */
export const storageFailing = () => writeFailed;

function saveOrders(list: StoredOrder[]) {
  const capped = capOrders(list, MAX_ORDERS);
  memory = capped;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(capped));
    writeFailed = false;
  } catch {
    writeFailed = true;
  }
  window.dispatchEvent(new Event(EVENT));
}

/** A new order first. An order already stored under the same id keeps what this browser learned about it. */
export function upsertOrder(order: StoredOrder) {
  const list = loadOrders();
  const prev = list.find(o => o.id === order.id);
  saveOrders([prev ? { ...order, ...prev } : order, ...list.filter(o => o.id !== order.id)]);
}

/** Change one order. Nothing is written when nothing changes, and a finished status never goes back (a late
 *  poll from another tab can land after the final one). */
export function patchOrder(id: string, patch: Partial<StoredOrder> | ((o: StoredOrder) => Partial<StoredOrder>)) {
  const list = loadOrders();
  const i = list.findIndex(o => o.id === id);
  if (i < 0) return;
  const prev = list[i];
  const p = { ...(typeof patch === 'function' ? patch(prev) : patch) };
  if (p.status && isTerminalStatus(prev.status) && p.status !== prev.status) delete p.status;
  const next = { ...prev, ...p };
  if (JSON.stringify(next) === JSON.stringify(prev)) return;
  const copy = list.slice();
  copy[i] = next;
  saveOrders(copy);
}

/** Record a status poll: the status, when it was first seen (and whether that was live), the amount out. */
export function applyStatusUpdate(id: string, u: OrderUpdate, now = Date.now()) {
  patchOrder(id, prev => {
    const stamp = !prev.lastPolledAt || now - prev.lastPolledAt > POLL_STAMP_MS ? now : prev.lastPolledAt;
    if (!u.status) return { rawStatus: u.rawStatus, lastPolledAt: stamp };
    const isNew = !prev.statusTimes[u.status];
    const late = isNew && !!prev.lastPolledAt && now - prev.lastPolledAt > LATE_AFTER_MS;
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

export function removeOrders(ids: string[]) {
  saveOrders(loadOrders().filter(o => !ids.includes(o.id)));
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
