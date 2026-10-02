// src/lib/rift/watch.ts
//
// Background tracking for every unfinished order in this browser, whichever account it belongs to (mounted on
// every tab of the page, OrderWatcher.tsx): a status poll about once a minute per order, every 10 minutes for
// an unpaid order past its pay window or one Rift has put on hold, and one notice per order when it finishes
// or is underpaid.
// - Polls are shared across tabs and with the order tracker (storage.ts poll stamps): an order any of them
//   asked about recently is skipped, so a second tab adds no traffic. They also give way in Rift's call budget
//   (client.ts).
// - Notices are deduplicated across tabs by the order's `notifiedStatus` and the browser notification's tag.

'use client';

import { useEffect, useRef } from 'react';
import { getOrder, riftBudget } from './client';
import { parseOrderUpdate } from './validate';
import { applyStatusUpdate, markPolled, patchOrder, polledWithin } from './storage';
import { isAbandoned, isFinalStatus, isTerminalStatus } from './order-state';
import type { RiftOrderStatus, StoredOrder } from './types';

const POLL_MS = 60_000;
/** Unpaid past the window (it can only expire) or on hold (Rift's operators decide): now and then. */
const IDLE_POLL_MS = 10 * 60_000;
/** The page's notification service worker (public/), registered only when notifications are turned on. */
const SW_URL = '/rift-notify-sw.js';
const SW_SCOPE = '/rift-notify/';

const fmt = (v?: string | null) => {
  const n = Number(v);
  return v && Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '';
};

function message(o: StoredOrder): string {
  switch (o.status) {
    case 'delivered': return `${fmt(o.amountOut)} iAERO arrived in your wallet.`;
    case 'refunded': return `Rift refunded your ${o.token.symbol}.`;
    case 'expired': return 'An order expired before a payment arrived. Nothing was taken.';
    case 'frozen': return 'Rift put an order on hold. Open it for the order ID to give Rift.';
    case 'underfunded': return 'Rift received less than an order needs. Open it for what to do next.';
    default: return '';
  }
}

const noticeWorthy = (s: RiftOrderStatus) => isTerminalStatus(s) || s === 'underfunded';

/** Register the notification service worker (Android's browsers show notifications only through one). */
export async function enableNotifications(): Promise<void> {
  try { await navigator.serviceWorker?.register(SW_URL, { scope: SW_SCOPE }); } catch { /* desktop notifications still work */ }
}

/** Browser notification: the page's own where allowed (desktop), else through the service worker (Android). */
export async function browserNotify(title: string, body: string, tag: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag });
    return;
  } catch { /* "Illegal constructor" on Android: use the service worker */ }
  try {
    const reg = await navigator.serviceWorker?.getRegistration(SW_SCOPE);
    await reg?.showNotification(title, { body, tag });
  } catch { /* not allowed here */ }
}

export function useOrderWatcher(
  orders: StoredOrder[],
  showToast: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void,
) {
  // 1. Poll unfinished orders no tab has asked about recently, starting as soon as the saved orders are loaded.
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  const any = orders.length > 0;
  useEffect(() => {
    if (!any) return;
    let stop = false;
    const tick = async () => {
      for (const o of ordersRef.current) {
        const now = Date.now();
        if (stop || isFinalStatus(o.status)) continue;
        const idle = o.status === 'frozen' || isAbandoned(o, now);
        if (polledWithin(o.id, idle ? IDLE_POLL_MS : POLL_MS - 5000, now)) continue;
        if (!riftBudget('poll', now)) break;
        try {
          const u = parseOrderUpdate(await getOrder(o.id, undefined, 'poll'), o.id);
          if (!stop) await applyStatusUpdate(o.id, u);
        } catch {
          markPolled(o.id); // next round, not straight away from another tab
        }
      }
    };
    const t = setInterval(tick, 20_000);
    tick();
    return () => { stop = true; clearInterval(t); };
  }, [any]);

  // 2. One notice per order when it reaches a status worth one, seen change by change in this page.
  const toastRef = useRef(showToast);
  toastRef.current = showToast;
  const seen = useRef<Map<string, RiftOrderStatus> | null>(null);
  useEffect(() => {
    if (!seen.current) { seen.current = new Map(orders.map(o => [o.id, o.status])); return; }
    for (const o of orders) {
      const before = seen.current.get(o.id);
      seen.current.set(o.id, o.status);
      if (before === undefined || before === o.status || !noticeWorthy(o.status) || o.notifiedStatus === o.status) continue;
      patchOrder(o.id, { notifiedStatus: o.status });
      const msg = message(o);
      toastRef.current(msg, o.status === 'delivered' ? 'success' : 'warning');
      if (o.notify) void browserNotify('iAERO order update', msg, `iaero-order-${o.id}`);
    }
  }, [orders]);
}
