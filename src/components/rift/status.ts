// src/components/rift/status.ts
import type { Phase } from '@/lib/rift/timing';

export const PHASE_STYLE: Record<Phase, { label: string; className: string }> = {
  pay: { label: 'Waiting for payment', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  confirming: { label: 'Confirming payment', className: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300' },
  detecting: { label: 'Payment confirmed', className: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300' },
  executing: { label: 'Routing to iAERO', className: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-300' },
  delivered: { label: 'Delivered', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' },
  refunded: { label: 'Refunded', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300' },
  expired: { label: 'Expired', className: 'border-slate-500/30 bg-slate-500/10 text-slate-300' },
  frozen: { label: 'On hold', className: 'border-red-500/30 bg-red-500/10 text-red-300' },
  underfunded: { label: 'Underpaid', className: 'border-red-500/30 bg-red-500/10 text-red-300' },
};

/** An unpaid order past its pay window, or one the user hid (order-state.ts isOutOfDate). */
export const STALE_STYLE = { label: 'Out of date', className: 'border-slate-500/30 bg-slate-500/10 text-slate-300' };
/** A Bitcoin payment seen earlier that is no longer visible (order-state.ts nextBtcRecord): not simply waiting. */
export const MISSING_STYLE = { label: 'Payment not visible', className: 'border-amber-500/30 bg-amber-500/10 text-amber-300' };

/** The badge for an order in `phase`. */
export const badgeStyle = (phase: Phase, stale: boolean, btcMissing: boolean) =>
  stale ? STALE_STYLE : phase === 'pay' && btcMissing ? MISSING_STYLE : PHASE_STYLE[phase];
