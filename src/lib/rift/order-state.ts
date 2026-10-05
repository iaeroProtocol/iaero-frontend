// src/lib/rift/order-state.ts
//
// Rules about a stored order that the tracker, the orders list and the buy flow must agree on: where its
// payment stands, whether it may still be paid, which status changes are real, how saved records are
// checked, and which may be dropped.
// Pure, with type-only imports, so `node --test` can run it (tests/rift/).

import type { RiftOrderStatus, SourceChainKey, StoredOrder } from './types';

export type SourceKind = 'evm' | 'bitcoin' | 'hypercore';

const STATUSES: readonly RiftOrderStatus[] = ['awaiting_deposit', 'funded', 'underfunded', 'expired', 'executing', 'delivered', 'refunded', 'frozen'];
/** Statuses that never change again. */
const FINAL: readonly RiftOrderStatus[] = ['delivered', 'refunded', 'expired'];
const CHAINS: readonly SourceChainKey[] = ['ethereum', 'arbitrum', 'base', 'bitcoin', 'hyperliquid'];
const KIND_OF: Record<SourceChainKey, SourceKind> = { ethereum: 'evm', arbitrum: 'evm', base: 'evm', bitcoin: 'bitcoin', hyperliquid: 'hypercore' };
export const sourceKindOf = (chain: SourceChainKey): SourceKind => KIND_OF[chain];

/** Pay within the quote's 10-minute life: Rift fills at the price when the deposit arrives, with no
 *  minimum, so an older order is re-priced as a new one instead. Bitcoin needs time to send. */
export const PAY_WINDOW_MS = 10 * 60_000;
export const BTC_PAY_WINDOW_MS = 60 * 60_000;
/** A payment request whose marker has not been refreshed for this long (the tab that asked refreshes it
 *  every 15 s while the wallet is open) was lost: its outcome is unknown. */
export const UNKNOWN_AFTER_MS = 2 * 60_000;
/** How often the tab waiting on the wallet refreshes its marker. */
export const PAY_HEARTBEAT_MS = 15_000;
/** No paying in the last minutes before Rift stops watching the deposit address. */
const DEADLINE_MARGIN_MS = 15 * 60_000;

export type PayState = 'none' | 'requesting' | 'sent' | 'unknown' | 'failed';

/** Where this browser's payment for an order stands. */
export function payState(o: StoredOrder, now: number): PayState {
  if (o.payUnknown) return 'unknown';
  const evm = KIND_OF[o.sourceChain] === 'evm';
  // Older app versions could clear an inconclusive EVM attempt after one empty RPC read. Those saved records
  // have no proof that the wallet never broadcast a transaction and must not silently become payable again.
  if (evm && (o.depositFailReason === 'lost'
    || (o.payAttemptAt && !o.payRequestedAt && !o.depositTxHash && !o.depositFailed && !o.depositSentAt))) return 'unknown';
  if (o.depositSentAt && !o.depositFailed) return 'sent';
  if (o.payRequestedAt) return now - o.payRequestedAt > UNKNOWN_AFTER_MS ? 'unknown' : 'requesting';
  if (o.depositFailed) return !evm || ['reverted', 'cancelled', 'pre_send', 'replaced'].includes(o.depositFailReason ?? '') ? 'failed' : 'unknown';
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
  return Number.isFinite(deadline) && deadline - now > DEADLINE_MARGIN_MS;
}

/** Whether the app may ask the wallet to pay this order now. */
export function canPay(o: StoredOrder, kind: SourceKind, now: number): boolean {
  if (kind === 'bitcoin' || !payWindowOpen(o, kind, now)) return false;
  const s = payState(o, now);
  return s === 'none' || s === 'failed';
}

/** An unpaid order past its pay window: nothing was sent, and it can only expire. Safe to remove. */
export function isAbandoned(o: StoredOrder, now: number): boolean {
  const kind = KIND_OF[o.sourceChain];
  // A Bitcoin payment was seen (an older version could keep only `missing` of it): never "nothing was sent".
  if (o.status !== 'awaiting_deposit' || payWindowOpen(o, kind, now) || o.btc?.txid || o.btc?.missing) return false;
  const s = payState(o, now);
  return s === 'none' || s === 'failed';
}

/** Shown and polled as out of date: abandoned, or hidden by the user after a check found no payment. A hidden
 *  order's payment was never proven absent, so it is not abandoned: it is never removed while it can still arrive. */
export function isOutOfDate(o: StoredOrder, now: number): boolean {
  return isAbandoned(o, now)
    || (!!o.hiddenAt && o.status === 'awaiting_deposit' && !payWindowOpen(o, KIND_OF[o.sourceChain], now));
}

/** Whether an order whose payment is in doubt may be hidden: its pay window has closed and nothing is waiting on
 *  a wallet. (The card offers it only after a check found no payment.) */
export const canHide = (o: StoredOrder, now: number) =>
  o.status === 'awaiting_deposit' && KIND_OF[o.sourceChain] !== 'bitcoin' && !payWindowOpen(o, KIND_OF[o.sourceChain], now)
  && payState(o, now) === 'unknown';

/** The payment facts the progress phases are computed from (timing.ts phaseOf), the same everywhere. A Bitcoin
 *  payment that has gone missing puts the order back to paying (the QR code returns). */
export function phaseInput(o: StoredOrder, kind: SourceKind) {
  const unknown = !!o.payUnknown;
  return {
    status: o.status,
    sourceKind: kind,
    depositSentAt: o.depositSentAt && !o.depositFailed && !unknown ? o.depositSentAt : undefined,
    depositConfirmedAt: o.depositFailed || unknown ? undefined : o.depositConfirmedAt,
    btcSeenAt: o.btc?.missing ? undefined : o.btc?.firstSeenAt,
  };
}

/** Empty answers in a row before a Bitcoin payment seen earlier counts as gone (dropped or replaced): one empty
 *  answer from a lagging mempool.space backend must not erase it. */
export const BTC_MISSING_AFTER = 3;

/** The order's Bitcoin record after a look at its deposit address. A payment seen earlier keeps its id and times
 *  (the order is never treated as unpaid because of them) and is marked missing only after several empty answers. */
export function nextBtcRecord(
  prev: StoredOrder['btc'], seen: { payments: { txid: string; confirmations: number }[]; totalSats: bigint }, now: number,
): StoredOrder['btc'] {
  if (!seen.payments.length) {
    if (!prev?.txid || prev.missing) return prev; // nothing more to record once it is missing
    const emptyChecks = (prev.emptyChecks ?? 0) + 1;
    return { ...prev, emptyChecks, ...(emptyChecks >= BTC_MISSING_AFTER ? { missing: true } : {}) };
  }
  const confirmations = Math.min(...seen.payments.map(p => p.confirmations));
  // First seen already confirmed: the page was not watching when it was sent.
  const seenLate = prev?.firstSeenAt ? prev.seenLate : confirmations > 0;
  return {
    txid: seen.payments[0].txid, confirmations, firstSeenAt: prev?.firstSeenAt ?? now, totalSats: seen.totalSats.toString(),
    payments: seen.payments.length, ...(seenLate ? { seenLate: true } : {}),
  };
}

/** Rift closed the order as expired although this browser saw a payment go to it: it needs Rift's support (and its
 *  order ID), so it is never cleared like an order that simply ran out. */
export const paidButExpired = (o: StoredOrder, now: number) =>
  o.status === 'expired' && (payState(o, now) === 'sent' || !!o.depositConfirmedAt || (!!o.btc?.txid && !o.btc.missing));

/** Frozen orders are not moving (Rift's operators decide), but they can still be refunded or delivered. */
export const isTerminalStatus = (s: RiftOrderStatus) => FINAL.includes(s) || s === 'frozen';
export const isFinalStatus = (s: RiftOrderStatus) => FINAL.includes(s);
/** Finished orders that still need the user's attention (Rift support needs the order ID). */
export const needsAttention = (s: RiftOrderStatus) => s === 'frozen' || s === 'underfunded';

/** Serve the least recently polled unfinished orders first when the shared Rift budget is full. */
export function pendingByLeastRecentPoll(orders: StoredOrder[], stamps: Record<string, number>): StoredOrder[] {
  return orders.filter(o => !isFinalStatus(o.status))
    .sort((a, b) => (stamps[a.id] ?? a.lastPolledAt ?? 0) - (stamps[b.id] ?? b.lastPolledAt ?? 0));
}

const RANK: Record<RiftOrderStatus, number> = {
  awaiting_deposit: 0, funded: 1, underfunded: 1, executing: 2, frozen: 3, delivered: 4, refunded: 4, expired: 4,
};

/**
 * Whether a polled status may replace the stored one. Final statuses never change; nothing goes back to
 * awaiting_deposit, or from executing to funded (a late answer from another poller); a frozen order can be
 * released or settled by Rift.
 */
export function canMoveTo(prev: RiftOrderStatus, next: RiftOrderStatus): boolean {
  if (prev === next) return true;
  if (FINAL.includes(prev)) return false;
  if (next === 'awaiting_deposit') return false;
  if (prev === 'frozen') return true;
  return RANK[next] >= RANK[prev];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const DECIMAL_RE = /^\d+(\.\d+)?$/;
const UINT_RE = /^\d+$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const BTC_ADDRESS_RE = /^(bc1[023456789acdefghjklmnpqrstuvwxyz]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/i;
const HYPERCORE_DECIMALS: Record<string, number> = { hype: 8, usdc: 8, btc: 10, eth: 9 };

/** Verify the saved amount against the exact base units the wallet would send, without floating point. */
function amountMatchesRaw(amount: string, raw: string, decimals: number): boolean {
  if (amount.length > 64 || raw.length > 80 || !DECIMAL_RE.test(amount) || !UINT_RE.test(raw)) return false;
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > decimals) return false;
  try {
    return BigInt(raw) > 0n && BigInt(raw) === BigInt(whole) * 10n ** BigInt(decimals)
      + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0');
  } catch { return false; }
}

function tokenMatchesSource(chain: SourceChainKey, token: StoredOrder['token']): boolean {
  const asset = token.asset.toLowerCase();
  if (chain === 'bitcoin') return asset === 'bitcoin.btc' && !token.address && token.decimals === 8;
  if (chain === 'hyperliquid') return !token.address && HYPERCORE_DECIMALS[asset.slice('hyperliquid.'.length)] === token.decimals
    && asset.startsWith('hyperliquid.');
  if (asset === `${chain}.eth`) return !token.address && token.decimals === 18;
  return !!token.address && EVM_ADDRESS_RE.test(token.address)
    && asset === `${chain}.${token.address.toLowerCase()}`;
}

/** Optional fields that must have their type when present; a wrong one is dropped, not the order. */
const OPTIONAL_NUMBERS = [
  'payRequestedAt', 'payAttemptAt', 'payNonce', 'depositNonce', 'depositSentAt', 'depositConfirmedAt', 'lastPolledAt',
  'deliveredAtChain', 'marketUsdIn', 'marketIaeroUsd', 'gasDeskUsd', 'hlPostedAt', 'hiddenAt',
] as const;
const OPTIONAL_UINTS = ['depositReceivedRaw', 'baseFromBlock', 'deliveryScannedTo'] as const;
const OPTIONAL_DECIMALS = ['expectedOut', 'amountOut'] as const;

/** A saved record, checked field by field (it may come from an older or newer version of the app, another
 *  tab, or be damaged); null if it cannot be shown or tracked safely. */
export function sanitizeOrder(x: unknown): StoredOrder | null {
  const o = x as Partial<StoredOrder> | null;
  if (!o || typeof o !== 'object') return null;
  if (!isStr(o.id) || !UUID_RE.test(o.id) || !isStr(o.quoteId) || !UUID_RE.test(o.quoteId)
    || !isNum(o.createdAt) || !CHAINS.includes(o.sourceChain as SourceChainKey)) return null;
  const t = o.token as StoredOrder['token'] | undefined;
  if (!t || !isStr(t.symbol) || !isStr(t.asset) || !Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) return null;
  if (!tokenMatchesSource(o.sourceChain!, t)) return null;
  if (!isStr(o.fromAmount) || !isStr(o.fromAmountRaw) || !amountMatchesRaw(o.fromAmount, o.fromAmountRaw, t.decimals)) return null;
  if (!isStr(o.estimatedOut) || !DECIMAL_RE.test(o.estimatedOut)
    || !Number.isFinite(Number(o.estimatedOut)) || !(Number(o.estimatedOut) > 0)) return null;
  if (!Array.isArray(o.route) || o.route.some(r => !r || !isStr(r.venue) || !isStr(r.from) || !isStr(r.to))) return null;
  if (!isStr(o.depositAddress) || !(o.sourceChain === 'bitcoin' ? BTC_ADDRESS_RE : EVM_ADDRESS_RE).test(o.depositAddress)
    || !isStr(o.depositDeadline) || !Number.isFinite(Date.parse(o.depositDeadline))
    || !isStr(o.toAddress) || !EVM_ADDRESS_RE.test(o.toAddress)) return null;
  if (!STATUSES.includes(o.status as RiftOrderStatus)) return null;

  const clean: Record<string, unknown> = { ...o };
  for (const k of OPTIONAL_NUMBERS) if (clean[k] !== undefined && !isNum(clean[k])) delete clean[k];
  for (const k of OPTIONAL_UINTS) if (clean[k] !== undefined && !(isStr(clean[k]) && UINT_RE.test(clean[k] as string))) delete clean[k];
  for (const k of OPTIONAL_DECIMALS) if (clean[k] != null && !(isStr(clean[k]) && DECIMAL_RE.test(clean[k] as string))) delete clean[k];
  if (clean.depositTxHash !== undefined && !(isStr(clean.depositTxHash) && HASH_RE.test(clean.depositTxHash as string))) delete clean.depositTxHash;
  if (clean.payAttemptId !== undefined && !(isStr(clean.payAttemptId) && /^[0-9a-f-]{36}$/i.test(clean.payAttemptId as string))) delete clean.payAttemptId;
  if (clean.pastTxHashes !== undefined) {
    const list = Array.isArray(clean.pastTxHashes) ? (clean.pastTxHashes as unknown[]).filter(h => isStr(h) && HASH_RE.test(h)) : [];
    if (list.length) clean.pastTxHashes = list.slice(-5); else delete clean.pastTxHashes;
  }
  const btc = clean.btc as StoredOrder['btc'] | undefined;
  if (btc !== undefined) {
    if (!btc || typeof btc !== 'object') delete clean.btc;
    else {
      const b: NonNullable<StoredOrder['btc']> = {};
      if (isStr(btc.txid) && /^[0-9a-f]{64}$/i.test(btc.txid)) b.txid = btc.txid;
      if (isNum(btc.confirmations)) b.confirmations = btc.confirmations;
      if (isNum(btc.firstSeenAt)) b.firstSeenAt = btc.firstSeenAt;
      if (isStr(btc.totalSats) && UINT_RE.test(btc.totalSats)) b.totalSats = btc.totalSats;
      if (isNum(btc.payments)) b.payments = btc.payments;
      if (btc.missing === true) b.missing = true;
      if (btc.seenLate === true) b.seenLate = true;
      if (isNum(btc.emptyChecks)) b.emptyChecks = btc.emptyChecks;
      clean.btc = b;
    }
  }
  const hl = clean.hlAction as StoredOrder['hlAction'] | undefined;
  if (hl !== undefined && !(hl && isStr(hl.destination) && isStr(hl.token) && isStr(hl.amount) && isNum(hl.time) && isStr(hl.r) && isStr(hl.s) && isNum(hl.v))) {
    delete clean.hlAction;
  }
  const times = o.statusTimes && typeof o.statusTimes === 'object' ? o.statusTimes : {};
  clean.statusTimes = Object.fromEntries(Object.entries(times).filter(([k, v]) => STATUSES.includes(k as RiftOrderStatus) && isNum(v)));
  return clean as unknown as StoredOrder;
}

/** Keep at most `max` orders: never drop one still in flight or needing attention; drop the oldest
 *  finished or abandoned (never paid, past their window) ones first. */
export function capOrders(list: StoredOrder[], max: number, now: number): StoredOrder[] {
  if (list.length <= max) return list;
  const droppable = (o: StoredOrder) => (isFinalStatus(o.status) && !needsAttention(o.status) && !paidButExpired(o, now)) || isAbandoned(o, now);
  const keep = new Set(list.filter(o => !droppable(o)).map(o => o.id));
  const rest = list.filter(o => !keep.has(o.id)).sort((a, b) => b.createdAt - a.createdAt);
  for (const o of rest) { if (keep.size >= max) break; keep.add(o.id); }
  return list.filter(o => keep.has(o.id));
}
