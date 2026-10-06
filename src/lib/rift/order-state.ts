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
  // A prompt stamped by a clock that ran ahead (since put back) can't be known to be open: unknown, not "requesting"
  // until the clock catches up. (An open prompt's heartbeat stamps it again.)
  if (o.payRequestedAt) return now - o.payRequestedAt > UNKNOWN_AFTER_MS || fromFuture(o.payRequestedAt, now) ? 'unknown' : 'requesting';
  if (o.depositFailed) return !evm || ['reverted', 'cancelled', 'pre_send', 'replaced'].includes(o.depositFailReason ?? '') ? 'failed' : 'unknown';
  return 'none';
}

export function payWindowMs(kind: SourceKind) {
  return kind === 'bitcoin' ? BTC_PAY_WINDOW_MS : PAY_WINDOW_MS;
}

/** A change recording that an order's pay window is closed, the first time a page sees it so (order-state.ts
 *  windowClosedAt): nothing otherwise. */
export const windowCloseChange = (o: StoredOrder, now: number): Partial<StoredOrder> =>
  (o.status === 'awaiting_deposit' && o.windowClosedAt === undefined && !payWindowOpen(o, KIND_OF[o.sourceChain], now) ? { windowClosedAt: now } : {});

/** Whether the order may still be paid: waiting for a deposit, inside its pay window, and before the deadline. */
export function payWindowOpen(o: StoredOrder, kind: SourceKind, now: number): boolean {
  if (o.status !== 'awaiting_deposit' || o.windowClosedAt !== undefined) return false;
  // A creation time from the future (made while the clock ran ahead, since put back): the window's real start can't
  // be known, so it counts as closed, never as open for hours (a Bitcoin QR code at an old price).
  if (now - o.createdAt > payWindowMs(kind) || fromFuture(o.createdAt, now)) return false;
  const deadline = Date.parse(o.depositDeadline);
  return Number.isFinite(deadline) && deadline - now > DEADLINE_MARGIN_MS;
}

/** Whether the app may ask the wallet to pay this order now. */
/** This order's own transaction took nonce `n` (mined, or replaced with nothing arriving): an earlier attempt that
 *  "failed before anything was sent" at that nonce provably sent nothing there, so the kept nonce moves past it
 *  (storage.ts preSendNonce). */
export const nonceUsed = (prev: StoredOrder, n: number | undefined) =>
  (n !== undefined && prev.preSendNonce === n ? { preSendNonce: n + 1 } : {});

/** After an attempt "failed before anything was sent" (a wallet's word, from its error), Pay waits this long: a payment
 *  sent through a private relay shows only once mined, and the re-pay checks must be able to see it. */
export const PRE_SEND_COOLDOWN_MS = 60_000;

export function canPay(o: StoredOrder, kind: SourceKind, now: number): boolean {
  // Never while Rift reports a status this page doesn't know, nor just after a "nothing was sent" failure.
  if (kind === 'bitcoin' || o.rawStatus || !payWindowOpen(o, kind, now)) return false;
  if (o.preSendAt !== undefined && now - o.preSendAt < PRE_SEND_COOLDOWN_MS && !fromFuture(o.preSendAt, now)) return false;
  const s = payState(o, now);
  return s === 'none' || s === 'failed';
}

/** A HyperCore order whose outcome is unknown, paid again after "Check payment" found nothing: by re-posting its saved
 *  signed transfer (Hyperliquid accepts one at most once, so it can't pay twice), or, when no transfer was ever saved
 *  (the page died at the prompt), by signing one: nothing can have been posted without it. */
export const canRetryUnknown = (o: StoredOrder, now: number) =>
  KIND_OF[o.sourceChain] === 'hypercore' && (!!o.hlAction || !o.hlPostedAt) && !o.rawStatus && payWindowOpen(o, 'hypercore', now)
  && payState(o, now) === 'unknown';

/** An unpaid order past its pay window: nothing was sent, and it can only expire. Safe to remove. */
export function isAbandoned(o: StoredOrder, now: number): boolean {
  const kind = KIND_OF[o.sourceChain];
  // A Bitcoin payment was seen (an older version could keep only `missing` of it), or Rift reports a status this page
  // doesn't know: never "nothing was sent".
  if (o.status !== 'awaiting_deposit' || o.rawStatus || payWindowOpen(o, kind, now) || o.btc?.txid || o.btc?.missing) return false;
  // Bitcoin is paid from any wallet, out of this page's sight: only a look at the address made well after the
  // window closed shows that nothing was sent.
  if (kind === 'bitcoin') return !btcUnchecked(o, now);
  const s = payState(o, now);
  return s === 'none' || s === 'failed';
}

/** Shown and polled as out of date: abandoned, or hidden by the user after a check found no payment. A hidden
 *  order's payment was never proven absent, so it is not abandoned: it is never removed while it can still arrive. */
export function isOutOfDate(o: StoredOrder, now: number): boolean {
  return isAbandoned(o, now)
    || (!!o.hiddenAt && o.status === 'awaiting_deposit' && !payWindowOpen(o, KIND_OF[o.sourceChain], now));
}

/** Shown as out of date (the orders list, the card's badge): as isOutOfDate, and also a Bitcoin order past its pay
 *  window with no payment seen, before a look has shown nothing was sent. Its card says not to pay it, so nothing says it
 *  waits for a payment; removing it, and polling it less often, still wait for that look. */
export function shownOutOfDate(o: StoredOrder, now: number): boolean {
  return isOutOfDate(o, now) || (KIND_OF[o.sourceChain] === 'bitcoin' && o.status === 'awaiting_deposit' && !o.rawStatus
    && !payWindowOpen(o, 'bitcoin', now) && !o.btc?.txid && !o.btc?.missing);
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
    // A payment recorded without its time (never written so, but a record can be damaged) still counts as seen.
    btcSeenAt: o.btc?.missing ? undefined : o.btc?.firstSeenAt ?? (o.btc?.txid ? o.createdAt : undefined),
  };
}

/** Empty answers in a row, spanning at least BTC_EMPTY_SPAN_MS, before a Bitcoin payment seen earlier counts as
 *  gone (dropped or replaced), or an address with nothing seen counts as unpaid: one answer from a lagging
 *  mempool.space backend proves nothing, and several tabs looking at once must not speed it up. */
export const BTC_MISSING_AFTER = 5;
export const BTC_EMPTY_SPAN_MS = 2 * 60_000;
/** Concurrent tabs can ask within milliseconds of each other. Count their empty answers as one look, with at least
 *  the shared lookup stamp's 15-second spacing between independent checks. */
const BTC_EMPTY_MIN_GAP_MS = 15_000;
/** A run of empty answers is one stretch of looking: an answer more than this after the run's latest one (nobody was
 *  looking, or mempool.space couldn't be reached) starts a new run, so a lagging answer from before the gap and a few
 *  quick ones after it can't make up the span between them. While a run is open (or a look past the checkpoint
 *  decides), the card and the background watcher look again soon (btcLookSoon) so that it can complete. */
export const BTC_EMPTY_GAP_MS = 2 * 60_000;

/** Whether an empty answer asked `at` continues the run in `b`: begun no later than it, with an answer within
 *  BTC_EMPTY_GAP_MS before it (a record from an older version, without the latest answer's time, starts anew). */
const continuesRun = (b: StoredOrder['btc'], at: number) =>
  b?.emptySince !== undefined && b.emptyLastAt !== undefined && at >= b.emptySince && at - b.emptyLastAt <= BTC_EMPTY_GAP_MS;
/** A look's empty answer counts only while this fresh: applied again later (a change storage refused), it is
 *  older than what other tabs may have seen since, so only a payment it saw is kept. */
export const BTC_LOOK_FRESH_MS = 10_000;

/** A Bitcoin payment seen with a confirmation. It is never treated as dropped: a confirmed transaction leaves only
 *  in a deep reorganisation, so an empty answer about it is the API's fault, and offering the QR code again could
 *  be paid twice. */
export const btcConfirmed = (b: StoredOrder['btc']) => !!b?.confirmed || (b?.confirmations ?? 0) > 0;

/** The order's Bitcoin record after a look at its deposit address. A payment seen earlier keeps its id and times
 *  (the order is never treated as unpaid because of them) and is marked missing only after several empty answers
 *  in a row, and only while unconfirmed. */
export function nextBtcRecord(
  prev: StoredOrder['btc'], seen: { payments: { txid: string; confirmations: number }[]; totalSats: bigint }, now: number,
): StoredOrder['btc'] {
  if (!seen.payments.length) {
    // Nothing more to record once it is missing; a confirmed payment is never "missing".
    if (!prev?.txid || prev.missing || btcConfirmed(prev)) return prev;
    const same = continuesRun(prev, now);
    const emptyChecks = same ? (prev.emptyChecks ?? 0) + 1 : 1;
    const emptySince = same ? prev.emptySince! : now;
    const emptyLastAt = same ? Math.max(prev.emptyLastAt!, now) : now;
    const gone = emptyChecks >= BTC_MISSING_AFTER && now - emptySince >= BTC_EMPTY_SPAN_MS;
    return { ...prev, emptyChecks, emptySince, emptyLastAt, ...(gone ? { missing: true } : {}) };
  }
  const confirmations = Math.min(...seen.payments.map(p => p.confirmations));
  const confirmed = btcConfirmed(prev) || seen.payments.some(p => p.confirmations > 0);
  // First seen already confirmed: the page was not watching when it was sent.
  const seenLate = prev?.firstSeenAt ? prev.seenLate : confirmations > 0;
  return {
    txid: seen.payments[0].txid, confirmations, firstSeenAt: prev?.firstSeenAt ?? now, totalSats: seen.totalSats.toString(),
    payments: seen.payments.length, ...(seenLate ? { seenLate: true } : {}), ...(confirmed ? { confirmed: true } : {}),
  };
}

/** Changes a look may record whatever else other tabs have seen: a payment first seen, its first confirmation,
 *  a missing one back, a run of empty answers broken. Each happens at most once per run of looks, so carrying them
 *  through a storage outage can't pile up. */
export const btcPositive = (a: StoredOrder['btc'], b: StoredOrder['btc']) =>
  (!a?.txid && !!b?.txid) || (!btcConfirmed(a) && btcConfirmed(b)) || (!!a?.missing && !b?.missing) || (!!a?.emptyChecks && !b?.emptyChecks);

/** One look at a Bitcoin deposit address (OrderTracker.tsx, watch.ts): when it was asked (`at`: what looks are
 *  ordered and timed by: an answer asked before a newer sighting was recorded is older, however late it arrives) and
 *  answered (`answeredAt`, `at` if not given: how fresh it is when applied), whether storage was refusing writes
 *  then, and from when a run of empty answers counts as evidence that nothing was sent (btcCheckpoint). */
export interface BtcLook { at: number; answeredAt?: number; failing: boolean; checkpoint: number }

/** What a look found: the address's payments, or 'known': it lists none, but mempool.space still knows the payment
 *  recorded earlier (its address index can lag behind), so nothing new (bitcoin.ts lookAtBtcAddress). */
export type BtcSeen = { payments: { txid: string; confirmations: number }[]; totalSats: bigint } | 'known';

/** The change a look makes to an order's Bitcoin record (OrderTracker.tsx and watch.ts apply it; a change storage
 *  refused is applied again later, over newer records). Only a fresh look made while storage works counts its
 *  empty answers ("missing", or a run of them past the checkpoint proving nothing was sent, btcUnchecked); one
 *  applied later, or made while storage refuses writes, keeps only what it saw (btcPositive): other tabs may have
 *  seen the payment since without recording it. */
export function btcLookPatch(prev: StoredOrder['btc'], seen: BtcSeen, look: BtcLook): Pick<StoredOrder, 'btc'> | Record<string, never> {
  const positiveOnly = look.failing || Date.now() - (look.answeredAt ?? look.at) > BTC_LOOK_FRESH_MS;
  // Times stored from the future (the clock ran ahead, then was put back) count as absent: they would stop every look
  // from counting until the clock caught up.
  const ahead = fromFuture;
  if (prev && (ahead(prev.lastSeenAt) || ahead(prev.emptySince) || ahead(prev.emptyLastAt) || ahead(prev.emptyAt))) {
    prev = { ...prev };
    if (ahead(prev.lastSeenAt)) delete prev.lastSeenAt;
    if (ahead(prev.emptySince) || ahead(prev.emptyLastAt)) { delete prev.emptySince; delete prev.emptyChecks; delete prev.emptyLastAt; }
    if (ahead(prev.emptyAt)) delete prev.emptyAt;
  }
  // A delayed "still known" answer or a repeat unconfirmed sighting must not erase another tab's newer empty
  // evidence. A first payment, replacement or confirmation is new evidence even if its answer arrives late.
  const repeatUnconfirmed = seen !== 'known' && !!prev?.txid && seen.payments.length > 0
    && seen.payments[0].txid === prev.txid && seen.payments.length === prev.payments
    && seen.totalSats.toString() === prev.totalSats && seen.payments.every(p => p.confirmations === 0);
  const firstConfirmation = seen !== 'known' && !btcConfirmed(prev) && seen.payments.some(p => p.confirmations > 0);
  if ((seen === 'known' || repeatUnconfirmed)
    && look.at < Math.max(prev?.lastSeenAt ?? 0, prev?.emptyLastAt ?? 0, prev?.emptyAt ?? 0)) return {};
  if (seen !== 'known' && !seen.payments.length && prev?.emptyLastAt !== undefined
    && look.at - prev.emptyLastAt < BTC_EMPTY_MIN_GAP_MS) return {};
  if (seen === 'known') {
    // The payment recorded is still there: a run of empty answers (or "missing") ends.
    if (!prev?.emptyChecks && !prev?.missing) return {};
    const btc = { ...prev, lastSeenAt: Math.max(look.at, prev?.lastSeenAt ?? 0) };
    delete btc.emptyChecks; delete btc.emptySince; delete btc.emptyLastAt; delete btc.missing;
    return { btc };
  }
  if (!seen.payments.length && !prev?.txid && !prev?.missing) {
    if (positiveOnly || look.at < look.checkpoint || (prev?.emptyAt ?? 0) >= look.checkpoint) return {};
    // A run of empty answers past the checkpoint: one lagging answer is not evidence that nothing was sent.
    const same = continuesRun(prev, look.at) && prev!.emptySince! >= look.checkpoint;
    const emptySince = same ? prev!.emptySince! : look.at;
    const emptyChecks = same ? (prev?.emptyChecks ?? 0) + 1 : 1;
    const emptyLastAt = same ? Math.max(prev!.emptyLastAt!, look.at) : look.at;
    const proven = emptyChecks >= BTC_MISSING_AFTER && look.at - emptySince >= BTC_EMPTY_SPAN_MS;
    return { btc: { ...prev, emptyChecks, emptySince, emptyLastAt, ...(proven ? { emptyAt: look.at } : {}) } };
  }
  // An answer older than the latest sighting recorded counts for nothing, except a first confirmation: it proves
  // the payment on-chain even when a newer address lookup saw it unconfirmed. Older empty answers cannot extend a run.
  if (look.at < (prev?.lastSeenAt ?? 0) && !firstConfirmation) return {};
  if (!seen.payments.length && prev?.emptySince !== undefined && look.at < prev.emptySince) return {};
  const btc = nextBtcRecord(prev, seen, look.at);
  if (btc === prev || (positiveOnly && !btcPositive(prev, btc))) return {};
  if (!seen.payments.length) return { btc };
  // A sighting is recorded only when it changes something. A late first confirmation keeps the newer ask time.
  const before = prev ? { ...prev } : undefined;
  if (before) delete before.lastSeenAt;
  return JSON.stringify(btc) === JSON.stringify(before) ? {} : { btc: { ...btc, lastSeenAt: Math.max(look.at, prev?.lastSeenAt ?? 0) } };
}

/** btcLookPatch over the order as stored when the change is applied, with that order's checkpoint: Rift may have
 *  expired it since the look began, moving the checkpoint, and empty answers from before the expiry must not count
 *  towards "nothing was sent" after it. (A change applied later is positive-only, so its checkpoint is unused.) */
export const btcLookChange = (prev: StoredOrder, seen: BtcSeen, look: Omit<BtcLook, 'checkpoint'>) =>
  btcLookPatch(prev.btc, seen, { ...look, checkpoint: btcCheckpoint(prev) });

/** How often an order card looks at a Bitcoin address: every 20 s while the order can still be paid, and while a run of
 *  looks decides something (btcLookSoon: "nothing was sent" past its checkpoint, or a payment seen now gone; about two
 *  minutes; not while storage refuses writes, when that run can't complete); otherwise every 10 minutes. Failed looks
 *  back off, doubling up to 10 minutes. */
export function btcLookEveryMs(o: StoredOrder, now: number, { errors = 0, failing = false } = {}): number {
  const base = (o.status === 'awaiting_deposit' && now < o.createdAt + BTC_PAY_WINDOW_MS + BTC_GRACE_MS && !fromFuture(o.createdAt, now))
    || btcLookSoon(o, now, failing) ? 20_000 : 10 * 60_000;
  return Math.min(base * 2 ** Math.min(errors, 10), 10 * 60_000);
}

/** Whether a Bitcoin order's address is looked at again soon (every 20 s on its card, each minute in the background,
 *  rather than every few minutes): while looks past its checkpoint decide whether anything was sent, or while a run of
 *  empty answers about a payment seen (still unconfirmed) is open. Either needs answers within BTC_EMPTY_GAP_MS of
 *  each other, which looks minutes apart never give. Not while storage refuses writes: the answers wouldn't count. */
export function btcLookSoon(o: StoredOrder, now: number, failing = false): boolean {
  if (failing || KIND_OF[o.sourceChain] !== 'bitcoin') return false;
  const deciding = btcUnchecked(o, now) && now >= btcCheckpoint(o, now);
  const runOpen = !!o.btc?.txid && !o.btc.missing && !btcConfirmed(o.btc) && (o.btc.emptyChecks ?? 0) > 0;
  return deciding || runOpen;
}

/** A Bitcoin address no order card is watching is looked at this often (watch.ts; shared across tabs, `btc:<id>`
 *  stamps), */
export const BTC_WATCH_LOOK_MS = 5 * 60_000;
/** ...or, while it should be looked at soon (btcLookSoon), at each of the watcher's rounds (a minute apart), backing off
 *  to BTC_WATCH_LOOK_MS after looks that failed (`failures` in a row). */
export const btcWatchEveryMs = (o: StoredOrder, now: number, failing: boolean, failures: number) =>
  btcLookSoon(o, now, failing) ? Math.min(20_000 * 2 ** Math.min(failures, 10), BTC_WATCH_LOOK_MS) : BTC_WATCH_LOOK_MS;

/** A Bitcoin order's address is still watched this long after its pay window closes before a look finding
 *  nothing counts: a payment sent at the last minute takes a while to show. */
export const BTC_GRACE_MS = 15 * 60_000;

/** A time this page stored that is in the future: written while the clock ran ahead, since put back. It counts as
 *  absent (or is replaced), never as fresh: it would hold things up, or prove them, until the clock caught up. */
export const fromFuture = (t: number | undefined, now = Date.now()) => t !== undefined && t > now + 1000;

/** From when a look finding nothing at a Bitcoin order's address is evidence that nothing was sent: well after its
 *  pay window closed, or once Rift has expired the order (from Rift's own deadline if the expiry was recorded by a
 *  clock since put back). */
export function btcCheckpoint(o: StoredOrder, now = Date.now()): number {
  const window = o.createdAt + BTC_PAY_WINDOW_MS + BTC_GRACE_MS;
  if (o.status !== 'expired') return window;
  // (No expiry time recorded: Rift's deadline, which it expires the order at, not the order's creation.)
  const deadlineAt = Date.parse(o.depositDeadline);
  const expired = o.statusTimes.expired ?? (Number.isFinite(deadlineAt) ? deadlineAt : o.createdAt);
  if (!fromFuture(expired, now)) return expired;
  const deadline = Date.parse(o.depositDeadline);
  return Number.isFinite(deadline) && !fromFuture(deadline, now) ? Math.max(deadline, window) : window;
}

/** A Bitcoin order with no payment seen that no look past its checkpoint has shown to be unpaid: never "nothing was
 *  sent" (Dismiss, "Clear finished", "Nothing was taken" wait for that look). A proof from the future doesn't count. */
export const btcUnchecked = (o: StoredOrder, now = Date.now()) =>
  KIND_OF[o.sourceChain] === 'bitcoin' && !o.btc?.txid && !o.btc?.missing
  && ((o.btc?.emptyAt ?? 0) < btcCheckpoint(o, now) || fromFuture(o.btc?.emptyAt, now));

/** An unfinished order this long past Rift's deposit deadline is one Rift no longer settles or answers for: polled
 *  now and then, and the user may remove it. */
export const STALE_AFTER_DEADLINE_MS = 7 * 864e5;
export const pastDeadline = (o: StoredOrder, now: number) =>
  !isFinalStatus(o.status) && now - Date.parse(o.depositDeadline) > STALE_AFTER_DEADLINE_MS;

/** A payment seen for an order Rift expired is followed this long after the expiry: Bitcoin nodes drop an unconfirmed
 *  transaction from their mempool after two weeks by default, so by then it has confirmed or is gone. */
export const BTC_LOOK_AFTER_EXPIRY_MS = 14 * 24 * 3600_000;

/** Whether a Bitcoin order's address still needs looking at: until Rift has the payment; and once Rift expired the
 *  order, while a payment seen is unconfirmed or missing (it may still confirm, or vanish; for two weeks), or until
 *  a look shows that nothing was sent. */
export function btcNeedsLook(o: StoredOrder, now = Date.now()): boolean {
  if (KIND_OF[o.sourceChain] !== 'bitcoin') return false;
  // Still waiting two weeks past Rift's deposit deadline: an order Rift no longer answers for (gone stale).
  if (o.status === 'awaiting_deposit' || o.status === 'underfunded') return !(now - Date.parse(o.depositDeadline) > BTC_LOOK_AFTER_EXPIRY_MS);
  if (o.status !== 'expired') return false;
  if (!o.btc?.txid) return btcUnchecked(o, now);
  return !btcConfirmed(o.btc) && now - (o.statusTimes.expired ?? o.createdAt) < BTC_LOOK_AFTER_EXPIRY_MS;
}

/** Whether another Bitcoin order, paid as well, could buy twice with this one (Buy asks first): it still waits for its
 *  payment and its address may yet receive one. 'open': within its pay window with nothing seen; 'closed': its window
 *  closed with nothing seen, before looks have shown that nothing was sent (a payment sent in its last minutes may still
 *  arrive); 'missing': a payment seen is no longer visible, but may still confirm. Null for one whose payment is seen,
 *  or proven absent. */
export function btcStillPayable(o: StoredOrder, now: number): 'open' | 'closed' | 'missing' | null {
  if (KIND_OF[o.sourceChain] !== 'bitcoin' || o.status !== 'awaiting_deposit') return null;
  if (o.btc?.txid && !o.btc.missing) return null;
  if (payWindowOpen(o, 'bitcoin', now)) return 'open';
  if (o.btc?.missing) return 'missing';
  return btcUnchecked(o, now) ? 'closed' : null;
}

/** Rift expired the order after its Bitcoin payment went missing (most likely dropped or replaced). The user may
 *  clear it, but it is never dropped automatically: only their wallet can say the payment didn't go through. */
export const missingButExpired = (o: StoredOrder) => o.status === 'expired' && !!o.btc?.missing;

/** Rift expired an EVM or HyperCore order whose payment this browser could never settle (in doubt): Rift saw nothing
 *  arrive, which most likely means nothing was taken, but only the wallet can say. Kept out of "Clear finished" and
 *  the cap; the user may remove it. */
export const doubtButExpired = (o: StoredOrder, now: number) =>
  o.status === 'expired' && KIND_OF[o.sourceChain] !== 'bitcoin' && payState(o, now) === 'unknown';

/** Rift closed the order as expired although this browser saw a payment go to it: it needs Rift's support (and its
 *  order ID), so it is never cleared like an order that simply ran out. */
export const paidButExpired = (o: StoredOrder, now: number) =>
  o.status === 'expired' && (payState(o, now) === 'sent' || !!o.depositConfirmedAt || (!!o.btc?.txid && !o.btc.missing));

/** Orders Dismiss and "Clear finished" may remove: finished with nothing left for the user (no support case, no
 *  payment Rift closed or that went missing, no Bitcoin address still unchecked), or abandoned. Checked again when
 *  the removal is applied (storage.ts removeOrders): another tab may have recorded a payment since. */
export const clearable = (o: StoredOrder, now: number) =>
  (isFinalStatus(o.status) && !needsAttention(o.status) && !paidButExpired(o, now) && !missingButExpired(o)
    && !doubtButExpired(o, now) && !(o.status === 'expired' && btcUnchecked(o, now)))
  || isAbandoned(o, now);

/** A Bitcoin order no payment was ever seen for, still open or expired: removed only at the user's request, after a
 *  fresh look at its address (GetIaeroSection.tsx), never by the cap. */
export const btcUnpaid = (o: StoredOrder) =>
  KIND_OF[o.sourceChain] === 'bitcoin' && !o.btc?.txid && (o.status === 'awaiting_deposit' || o.status === 'expired');

/** What an explicit removal ("Remove from this browser") is judged on: the order's payment as the user saw it. A
 *  change here (a status, a payment seen, confirmed or gone) keeps the order; a look's own bookkeeping (a run of
 *  empty answers) does not. */
export const paymentFacts = (o: StoredOrder) => JSON.stringify([
  o.status, o.rawStatus ?? null, o.btc?.txid ?? null, !!o.btc?.missing, btcConfirmed(o.btc), o.depositSentAt ?? null,
  o.depositConfirmedAt ?? null, !!o.payUnknown,
]);

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
  'payRequestedAt', 'payAttemptAt', 'payNonce', 'depositNonce', 'preSendNonce', 'preSendAt', 'hlNonce', 'depositSentAt', 'depositConfirmedAt', 'lastPolledAt',
  'deliveredAtChain', 'marketUsdIn', 'marketIaeroUsd', 'gasDeskUsd', 'hlPostedAt', 'hiddenAt', 'statusAskedAt', 'windowClosedAt',
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
      if (btc.seenLate === true) b.seenLate = true;
      if (btc.confirmed === true) b.confirmed = true;
      if (isNum(btc.emptyAt)) b.emptyAt = btc.emptyAt;
      if (isNum(btc.lastSeenAt)) b.lastSeenAt = btc.lastSeenAt;
      // A confirmed payment is never missing (btcConfirmed): an older version could mark it so.
      if (!btcConfirmed(b)) {
        if (btc.missing === true) b.missing = true;
        if (isNum(btc.emptyChecks)) b.emptyChecks = btc.emptyChecks;
        if (isNum(btc.emptySince)) b.emptySince = btc.emptySince;
        if (isNum(btc.emptyLastAt)) b.emptyLastAt = btc.emptyLastAt;
      }
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
  const droppable = (o: StoredOrder) => clearable(o, now) && !btcUnpaid(o);
  const keep = new Set(list.filter(o => !droppable(o)).map(o => o.id));
  const rest = list.filter(o => !keep.has(o.id)).sort((a, b) => b.createdAt - a.createdAt);
  for (const o of rest) { if (keep.size >= max) break; keep.add(o.id); }
  return list.filter(o => keep.has(o.id));
}
