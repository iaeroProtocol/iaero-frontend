// src/lib/rift/order-state.ts
//
// Rules about a stored order that the tracker, the orders list and the buy flow must agree on: where its
// payment stands, whether it may still be paid, how saved records are checked, and which may be dropped.
// Pure, with type-only imports, so `node --test` can run it (tests/rift/).

import type { RiftOrderStatus, SourceChainKey, StoredOrder } from './types';

export type SourceKind = 'evm' | 'bitcoin' | 'hypercore';

const STATUSES: readonly RiftOrderStatus[] = ['awaiting_deposit', 'funded', 'underfunded', 'expired', 'executing', 'delivered', 'refunded', 'frozen'];
const TERMINAL: readonly RiftOrderStatus[] = ['delivered', 'refunded', 'expired', 'frozen'];
const CHAINS: readonly SourceChainKey[] = ['ethereum', 'arbitrum', 'base', 'bitcoin', 'hyperliquid'];

/** Pay within the quote's 10-minute life: Rift fills at the price when the deposit arrives, with no
 *  minimum, so an older order is re-priced as a new one instead. Bitcoin needs time to send. */
export const PAY_WINDOW_MS = 10 * 60_000;
export const BTC_PAY_WINDOW_MS = 60 * 60_000;
/** A payment requested this long ago with no result recorded is treated as unknown. */
export const UNKNOWN_AFTER_MS = 2 * 60_000;
/** No paying in the last minutes before Rift stops watching the deposit address. */
const DEADLINE_MARGIN_MS = 15 * 60_000;

export type PayState = 'none' | 'requesting' | 'sent' | 'unknown' | 'failed';

/** Where this browser's payment for an order stands. */
export function payState(o: StoredOrder, now: number): PayState {
  if (o.depositSentAt && !o.depositFailed) return 'sent';
  if (o.payUnknown) return 'unknown';
  if (o.payRequestedAt) return now - o.payRequestedAt > UNKNOWN_AFTER_MS ? 'unknown' : 'requesting';
  if (o.depositFailed) return 'failed';
  return 'none';
}

export function payWindowMs(kind: SourceKind) {
  return kind === 'bitcoin' ? BTC_PAY_WINDOW_MS : PAY_WINDOW_MS;
}

/** Whether the order may still be paid: waiting for a deposit, inside its pay window, and before the deadline. */
export function payWindowOpen(o: StoredOrder, kind: SourceKind, now: number): boolean {
  if (o.status !== 'awaiting_deposit') return false;
  if (now - o.createdAt > payWindowMs(kind)) return false;
  const deadline = Date.parse(o.depositDeadline);
  return !Number.isFinite(deadline) || deadline - now > DEADLINE_MARGIN_MS;
}

/** Whether the app may ask the wallet to pay this order now. */
export function canPay(o: StoredOrder, kind: SourceKind, now: number): boolean {
  if (kind === 'bitcoin' || !payWindowOpen(o, kind, now)) return false;
  const s = payState(o, now);
  return s === 'none' || s === 'failed';
}

/** The payment facts the progress phases are computed from (timing.ts phaseOf), the same everywhere. */
export function phaseInput(o: StoredOrder, kind: SourceKind) {
  return {
    status: o.status,
    sourceKind: kind,
    depositSentAt: o.depositSentAt && !o.depositFailed ? o.depositSentAt : undefined,
    depositConfirmedAt: o.depositFailed ? undefined : o.depositConfirmedAt,
    btcSeenAt: o.btc?.firstSeenAt,
  };
}

export const isTerminalStatus = (s: RiftOrderStatus) => TERMINAL.includes(s);
/** Finished orders that still need the user's attention (Rift support needs the order ID). */
export const needsAttention = (s: RiftOrderStatus) => s === 'frozen' || s === 'underfunded';

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A saved record, checked field by field (it may come from an older version of the app, another tab, or
 *  be damaged); null if it cannot be shown or tracked safely. */
export function sanitizeOrder(x: unknown): StoredOrder | null {
  const o = x as Partial<StoredOrder> | null;
  if (!o || typeof o !== 'object') return null;
  if (!isStr(o.id) || !isStr(o.quoteId) || !isNum(o.createdAt) || !CHAINS.includes(o.sourceChain as SourceChainKey)) return null;
  const t = o.token as StoredOrder['token'] | undefined;
  if (!t || !isStr(t.symbol) || !isStr(t.asset) || !Number.isInteger(t.decimals)) return null;
  if (!isStr(o.fromAmount) || !isStr(o.fromAmountRaw) || !/^\d+$/.test(o.fromAmountRaw) || !isStr(o.estimatedOut)) return null;
  if (!Array.isArray(o.route) || o.route.some(r => !r || !isStr(r.venue) || !isStr(r.from) || !isStr(r.to))) return null;
  if (!isStr(o.depositAddress) || !isStr(o.depositDeadline) || !isStr(o.toAddress)) return null;
  if (!STATUSES.includes(o.status as RiftOrderStatus)) return null;
  const statusTimes = o.statusTimes && typeof o.statusTimes === 'object' ? o.statusTimes : {};
  return { ...(o as StoredOrder), statusTimes };
}

/** Keep at most `max` orders: never drop one still in flight or needing attention; drop the oldest
 *  finished ones first. */
export function capOrders(list: StoredOrder[], max: number): StoredOrder[] {
  if (list.length <= max) return list;
  const keep = new Set(list.filter(o => !isTerminalStatus(o.status) || needsAttention(o.status)).map(o => o.id));
  const finished = list.filter(o => !keep.has(o.id)).sort((a, b) => b.createdAt - a.createdAt);
  for (const o of finished) { if (keep.size >= max) break; keep.add(o.id); }
  return list.filter(o => keep.has(o.id));
}
