// src/lib/rift/notice.ts
//
// The one-line notice (toast and browser notification, watch.ts) when an order finishes or needs the user. It says
// what the order card says in the same state (OrderTracker.tsx), from the same rules (order-state.ts).

import { btcUnchecked, doubtButExpired, paidButExpired } from './order-state';
import type { StoredOrder } from './types';

const fmt = (v?: string | null) => {
  const n = Number(v);
  return v && Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '';
};

export function orderNotice(o: StoredOrder, now: number): string {
  switch (o.status) {
    case 'delivered': return `${fmt(o.amountOut)} iAERO arrived in your wallet.`;
    case 'refunded': return `Rift refunded your ${o.token.symbol}.`;
    case 'expired': return paidButExpired(o, now)
      ? o.sourceChain !== 'bitcoin' && o.sourceChain !== 'hyperliquid' && !o.depositConfirmedAt
        // Sent from this browser, never confirmed here: it may have failed. Its card reads the receipt.
        ? 'Rift closed an order whose payment wasn’t confirmed here. Open it to check that payment.'
        : 'Rift closed an order that a payment was sent to. Open it for the order ID to give Rift.'
      : o.btc?.missing
        ? 'An order expired after its Bitcoin payment disappeared from view. Check your wallet, and open the order for its ID.'
        : doubtButExpired(o, now)
          // A payment this page couldn't settle: Rift saw nothing arrive, but only the wallet can say.
          ? 'Rift closed an order without receiving a payment, so most likely nothing was taken. If your wallet shows a payment to it, open the order for its ID.'
          : btcUnchecked(o)
            ? 'An order expired. Its Bitcoin address is being checked for a payment: open the order to see.'
            : 'An order expired before a payment arrived. Nothing was taken.';
    case 'frozen': return 'Rift put an order on hold. Open it for the order ID to give Rift.';
    case 'underfunded': return 'Rift received less than an order needs. Open it for what to do next.';
    default: return '';
  }
}
