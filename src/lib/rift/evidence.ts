// src/lib/rift/evidence.ts
//
// Did a payment reach an order's deposit address? Asked when this browser does not know whether a payment
// went out (lost wallet response, closed tab, a transaction replaced after a reload). Every sign of activity
// counts as a payment. A negative EVM read is inconclusive and never authorizes another transfer; HyperCore
// retries the same saved signature, which the exchange accepts at most once.
// - EVM: Rift's vault spends a deposit as soon as it executes, leaving dust, so the balance alone says
//   nothing after execution; any transaction sent from the deposit address (its nonce), or code set on it,
//   means Rift acted on a payment.
// - HyperCore: the payer's ledger lists every spot transfer, by destination.
// The reads themselves are in payment-check.ts. Pure, with no imports, so `node --test` can run it (tests/rift/).

export type Evidence = 'arrived' | 'partial' | 'none';

export function judgeEvmDeposit(x: { balance: bigint; need: bigint; nonce: number; code?: string }): Evidence {
  if (x.balance >= x.need) return 'arrived';
  if (x.nonce > 0 || (!!x.code && x.code !== '0x')) return 'arrived';
  return x.balance > 0n ? 'partial' : 'none';
}

interface LedgerEntry { time?: unknown; hash?: unknown; delta?: { type?: unknown; token?: unknown; amount?: unknown; user?: unknown; destination?: unknown } }

/** Spot transfers from `owner` to `deposit` of `symbol` since `since` (ms), from Hyperliquid's
 *  userNonFundingLedgerUpdates. */
export function judgeHyperLedger(json: unknown, x: { owner: string; deposit: string; symbol: string; need: number; since: number }):
  { evidence: Evidence; hash?: string; time?: number } {
  if (!Array.isArray(json)) return { evidence: 'none' };
  const owner = x.owner.toLowerCase(), deposit = x.deposit.toLowerCase();
  let total = 0;
  let first: { hash?: string; time?: number } | undefined;
  for (const e of json as LedgerEntry[]) {
    const d = e?.delta;
    if (!d || (d.type !== 'spotTransfer' && d.type !== 'send')) continue;
    if (String(d.user ?? '').toLowerCase() !== owner || String(d.destination ?? '').toLowerCase() !== deposit) continue;
    if (String(d.token ?? '') !== x.symbol || !(Number(e.time) >= x.since)) continue;
    const amount = Number(d.amount);
    if (!(amount > 0)) continue;
    total += amount;
    first ??= { hash: typeof e.hash === 'string' ? e.hash : undefined, time: Number(e.time) };
  }
  if (!first) return { evidence: 'none' };
  return { evidence: total >= x.need * (1 - 1e-9) ? 'arrived' : 'partial', ...first };
}
