// src/lib/rift/watch.ts
//
// Background tracking for every unfinished order of the connected wallet, not only the one open in the
// tracker (which polls its own order faster): a status poll every minute (every 10 minutes for an unpaid order
// past its pay window), and one notice per order when it
// finishes or is underpaid. Notices are deduplicated across tabs by the order's `notifiedStatus` and the
// browser notification's tag.

'use client';

import { useEffect, useRef } from 'react';
import { getOrder } from './client';
import { parseOrderUpdate } from './validate';
import { applyStatusUpdate, patchOrder } from './storage';
import { SOURCE_CHAINS } from './config';
import { isTerminalStatus, payState, payWindowOpen } from './order-state';
import type { RiftOrderStatus, StoredOrder } from './types';

const POLL_MS = 60_000;
/** An unpaid order past its pay window will only expire: checked now and then, not every minute. */
const IDLE_POLL_MS = 10 * 60_000;

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

/** Browser notification, where it works (desktop browsers; not Android's, which needs a service worker). */
export function browserNotify(title: string, body: string, tag: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try { new Notification(title, { body, tag }); } catch { /* not allowed here */ }
}

export function useOrderWatcher(
  orders: StoredOrder[],
  activeId: string | null,
  showToast: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void,
) {
  // 1. Poll unfinished orders that the tracker is not already polling.
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const now = Date.now();
      for (const o of ordersRef.current) {
        if (stop || o.id === activeId || isTerminalStatus(o.status)) continue;
        const kind = SOURCE_CHAINS[o.sourceChain].kind;
        const idle = o.status === 'awaiting_deposit' && !payWindowOpen(o, kind, now) && !o.btc?.txid
          && ['none', 'failed'].includes(payState(o, now));
        if (idle && o.lastPolledAt && now - o.lastPolledAt < IDLE_POLL_MS) continue;
        try {
          const u = parseOrderUpdate(await getOrder(o.id), o.id);
          if (!stop) applyStatusUpdate(o.id, u);
        } catch { /* next round */ }
      }
    };
    const t = setInterval(tick, POLL_MS);
    tick();
    return () => { stop = true; clearInterval(t); };
  }, [activeId]);

  // 2. One notice per order when it reaches a status worth one, seen change by change in this page.
  const seen = useRef<Map<string, RiftOrderStatus> | null>(null);
  useEffect(() => {
    if (!seen.current) { seen.current = new Map(orders.map(o => [o.id, o.status])); return; }
    for (const o of orders) {
      const before = seen.current.get(o.id);
      seen.current.set(o.id, o.status);
      if (before === undefined || before === o.status || !noticeWorthy(o.status) || o.notifiedStatus === o.status) continue;
      patchOrder(o.id, { notifiedStatus: o.status });
      const msg = message(o);
      showToast(msg, o.status === 'delivered' ? 'success' : 'warning');
      if (o.notify) browserNotify('iAERO order update', msg, `iaero-order-${o.id}`);
    }
  }, [orders, showToast]);
}
