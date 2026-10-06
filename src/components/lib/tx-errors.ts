// src/components/lib/tx-errors.ts
//
// One short line for a failed wallet request. viem wraps the wallet's own error (a declined request is code 4001
// several causes deep), so the whole cause chain is checked, and its short message is used rather than the full
// multi-line one.

/** Whether the user declined the request in their wallet. */
export function isUserRejection(e: unknown): boolean {
  let x = e as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown } | null | undefined;
  for (let i = 0; x && i < 8; i++, x = x.cause as typeof x) {
    if (x.code === 4001 || x.name === 'UserRejectedRequestError' || /user (rejected|denied)|rejected the request/i.test(String(x.message ?? ''))) return true;
  }
  return false;
}

/** The message for the failures that need no guessing: declined in the wallet, or refused because the wallet is
 *  on another chain (protocol-chain.ts); null otherwise. */
export function knownTxError(e: unknown): string | null {
  if (isUserRejection(e)) return 'Cancelled in your wallet. Nothing was sent.';
  const x = e as { name?: unknown; message?: unknown } | null | undefined;
  if (x?.name === 'WalletOffProtocolChainError') return String(x.message);
  return null;
}

/** The message to show for a failed transaction: a declined request says nothing was sent; anything else gives
 *  viem's one-line reason, or `fallback`. */
export function txErrorMessage(e: unknown, fallback = 'Transaction failed'): string {
  const known = knownTxError(e);
  if (known) return known;
  const x = e as { shortMessage?: unknown; message?: unknown } | null | undefined;
  const text = String(x?.shortMessage || x?.message || '').split('\n')[0].trim();
  if (/insufficient funds/i.test(text)) return 'Not enough ETH for the network fee.';
  return (text || fallback).slice(0, 200);
}
