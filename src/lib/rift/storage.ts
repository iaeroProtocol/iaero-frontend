// src/lib/rift/storage.ts
//
// Orders live in this browser's localStorage, so progress survives a refresh, a closed tab or a crash.
// Every read and write is guarded: storage can be unavailable (private windows, blocked site data).

'use client';

import { useCallback, useEffect, useState } from 'react';
import type { StoredOrder } from './types';

const KEY = 'iaero.rift.orders.v1';
const EVENT = 'iaero-rift-orders';
const MAX_ORDERS = 25;

export function loadOrders(): StoredOrder[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(o => o && typeof o.id === 'string' && typeof o.status === 'string') : [];
  } catch {
    return [];
  }
}

function saveOrders(list: StoredOrder[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_ORDERS)));
  } catch {
    // Storage full or blocked: tracking still works for this page view.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function upsertOrder(order: StoredOrder) {
  const list = loadOrders().filter(o => o.id !== order.id);
  saveOrders([order, ...list]);
}

export function patchOrder(id: string, patch: Partial<StoredOrder> | ((o: StoredOrder) => Partial<StoredOrder>)) {
  const list = loadOrders();
  const i = list.findIndex(o => o.id === id);
  if (i < 0) return;
  const next = { ...list[i], ...(typeof patch === 'function' ? patch(list[i]) : patch) };
  list[i] = next;
  saveOrders(list);
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
